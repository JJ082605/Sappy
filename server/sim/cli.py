"""Command-line entry point for the vitals simulator.

    python3 server/sim/cli.py demo                      # scripted demo, fast-forwarded, printed every 15 sim-min
    python3 server/sim/cli.py serve --demo              # scripted demo live: 1 tick / 2 s = 15 hospital min
    python3 server/sim/cli.py serve --demo --reset      # ...and clear Supabase vitals/alerts/held readings first
    python3 server/sim/cli.py serve --speed 30          # free-running (random events) on http://127.0.0.1:8765
    python3 server/sim/cli.py stream --speed 30         # JSON lines on stdout (one batch per line)

Patients come from server/data/clean/ (scrubbed by server/Synthea_Gen/transform.py). Only the 5-patient ward
(DEMO_WARD in vitals_sim.py, or --patient-ids / SIM_PATIENT_IDS=id1,id2,...) is simulated. Each is
admitted to a bed; the bed label is display-only - key everything on patientId / encounterId.

`serve` also writes every tick to Supabase (sim/supabase_sink.py) when SUPABASE_URL and
SUPABASE_SECRET_KEY are set (needs the venv: pip install -r requirements.txt).

Server endpoints. CORS is open; on a public host (Render) set SIM_CONTROL_TOKEN so the demo-control
POSTs (/patients/<id>/...) need `Authorization: Bearer <token>`:
    GET  /health                       {"ok": true, "supabase": bool} (Render health check)
    GET  /patients                     patients (+ encounter/bed, baseline, active events)
    GET  /scenarios                    available scenario names
    GET  /vitals                       latest batch of readings
    GET  /stream                       Server-Sent Events: one `data: [readings...]` per tick
    POST /patients/<id>/trigger        body: {"scenario": "sepsis", "severity"?: 1, "holdMin"?: 30, "untilResolved"?: true}
    POST /patients/<id>/resolve        body (optional): {"scenario": "sepsis"}
    POST /patients/<id>/oxygen         body: {"on": true}
    POST /patients/<id>/consciousness  body: {"level": "C"}   ("A"|"C"|"V"|"P"|"U", or null = automatic)
    POST /patients/<id>/artifact       body (optional): {"vital": "spo2Percent", "value": 75}  one-off bad reading

Patient app (Sappy) requests -> Supabase `alerts` rows. Uses its own token, PATIENT_REQUEST_TOKEN (never
SIM_CONTROL_TOKEN), and is disabled when that isn't set. Body and responses: see patient_requests.py.
    POST /patient-requests             body: {"patientId": "...", "type": "nurse_call", "category": "pain",
                                              "priority": "soon", "source": "assistant"}

From the browser:
    const es = new EventSource('http://127.0.0.1:8765/stream')
    es.onmessage = (e) => setVitals(JSON.parse(e.data))   // VitalsReading[]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vitals_sim import (  # noqa: E402  (also puts the repo root on sys.path for pylib)
    DEFAULT_CLEAN_DIR,
    DEMO_FALSE_ALARM_AT_MIN,
    DEMO_INTERVAL_SEC,
    DEMO_SEPSIS_AT_MIN,
    DEMO_SPEED,
    DEMO_TICK_MIN,
    DEMO_WARD,
    REPO_ROOT,
    SCENARIOS,
    VitalsSimulator,
    load_clean_patients,
    schedule_demo,
    select_ward,
)
from pylib.env import load_dotenv  # noqa: E402
from patient_requests import MAX_BODY_BYTES, PatientRequests, bearer_matches  # noqa: E402
from supabase_sink import BackgroundWriter, SupabaseSink  # noqa: E402


# ------------------------------------------------------------------------------------------------
# demo / stream
# ------------------------------------------------------------------------------------------------

def load_ward(args: argparse.Namespace) -> list:
    """The patients to simulate: DEMO_WARD (5 patients), or --patient-ids if given."""
    ids = tuple(i.strip() for i in args.patient_ids.split(",") if i.strip()) or DEMO_WARD
    ward, found = select_ward(load_clean_patients(args.clean_dir), ids)
    if not found:
        print(f"warning: ward patient ids not in {args.clean_dir}; using the first {len(ward)} by id instead",
              file=sys.stderr, flush=True)
    return ward


def cmd_demo(args: argparse.Namespace) -> None:
    patients = load_ward(args)
    start = datetime(2026, 1, 1, 8, tzinfo=timezone.utc).timestamp()
    sim = VitalsSimulator(patients, seed=args.seed, start_time=start, event_rate_per_hour=0)
    truth = schedule_demo(sim)
    role = {pid: name for name, pid in truth.items()}

    print(f"{'time':<6}{'bed':<6}{'patient':<20}{'HR':<5}{'BP':<9}{'RR':<4}{'SpO2':<9}{'Temp':<6}{'AVPU':<6}ground truth")
    for _ in range(args.hours * 60 // DEMO_TICK_MIN):
        readings = sim.step(DEMO_TICK_MIN * 60)
        artifacts = {(a["patientId"], a["recordedAt"]) for a in sim.artifact_log}
        clock = datetime.fromtimestamp(sim.now, timezone.utc).strftime("%H:%M")
        for i, (p, r) in enumerate(zip(patients, readings)):
            truth_note = role.get(p.id, "")
            if (p.id, r["recordedAt"]) in artifacts:
                truth_note += "  <- loose probe (artifact)"
            spo2 = f"{r['spo2Percent']}%" + (" O2" if r["onOxygen"] else "")
            label = f"{p.id[:8]} {p.age_band} {p.gender[0].upper()}"
            print(
                f"{clock if i == 0 else '':<6}{sim.admission(p.id).bed_label:<6}{label:<20}{r['heartRateBpm']:<5}"
                f"{str(r['systolicMmHg']) + '/' + str(r['diastolicMmHg']):<9}{r['respiratoryRate']:<4}{spo2:<9}"
                f"{r['temperatureC']:<6}{r['consciousness']:<6}{truth_note}"
            )
        print()


def cmd_stream(args: argparse.Namespace) -> None:
    sim = VitalsSimulator(load_ward(args), seed=args.seed, event_rate_per_hour=args.event_rate)
    try:
        for readings in sim.stream(interval_sec=args.interval, speed=args.speed):
            print(json.dumps(readings), flush=True)
    except (KeyboardInterrupt, BrokenPipeError):
        pass


# ------------------------------------------------------------------------------------------------
# serve
# ------------------------------------------------------------------------------------------------

class SimServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, sim: VitalsSimulator, interval_sec: float, speed: float,
                 sink=None, control_token: str = "", patient_request_token: str = "",
                 bind_and_activate: bool = True):
        self.sim = sim
        self.sink = sink  # SupabaseSink or None
        self.writer = BackgroundWriter(sink) if sink is not None else None
        self.control_token = control_token
        self.patient_requests = PatientRequests(patient_request_token, sink, self.encounter_id)
        self.lock = threading.Lock()  # guards self.sim
        self.tick = threading.Condition()  # guards latest / latest_frame / seq
        self.latest: list = []
        self.latest_frame = b""  # latest batch as an SSE frame, encoded once for every client
        self.seq = 0
        self.stopped = threading.Event()
        self._ticker = threading.Thread(target=self._run, args=(interval_sec, speed), daemon=True)
        # Last: if binding fails (port in use), socketserver calls server_close(), which needs the above.
        super().__init__(address, Handler, bind_and_activate)

    def start_ticking(self) -> None:
        self._ticker.start()

    def encounter_id(self, patient_id: str) -> str:
        """The patient's in-progress encounter on this ward. KeyError if they aren't on it."""
        with self.lock:
            return self.sim.admission(patient_id).encounter_id

    def _run(self, interval_sec: float, speed: float) -> None:
        next_tick = time.monotonic()
        while not self.stopped.is_set():
            with self.lock:
                readings = self.sim.step(interval_sec * speed)
            frame = f"data: {json.dumps(readings)}\n\n".encode()
            with self.tick:
                self.latest, self.latest_frame, self.seq = readings, frame, self.seq + 1
                self.tick.notify_all()
            if self.writer:
                self.writer.submit(readings)
            next_tick += interval_sec
            now = time.monotonic()
            if next_tick < now - interval_sec:  # fell behind (e.g. laptop slept): skip, don't replay
                next_tick = now
            self.stopped.wait(max(0.0, next_tick - now))

    def server_close(self) -> None:
        self.stopped.set()
        if self.writer:
            self.writer.close()
        super().server_close()


# POST /patients/<id>/<action> handlers: validate the body, act, return a JSON body (None = {"ok": true}).
# ValueError -> 400, KeyError (unknown patient) -> 404.

def _post_trigger(sim: VitalsSimulator, patient_id: str, body: dict) -> Optional[dict]:
    if "scenario" not in body:
        raise ValueError(f"body needs 'scenario', one of {sorted(SCENARIOS)}")
    return sim.trigger(
        patient_id,
        body["scenario"],
        severity=float(body.get("severity", 1)),
        hold_min=math.inf if body.get("untilResolved") else body.get("holdMin"),
    ).to_json()


def _post_resolve(sim: VitalsSimulator, patient_id: str, body: dict) -> None:
    sim.resolve(patient_id, body.get("scenario"))


def _post_oxygen(sim: VitalsSimulator, patient_id: str, body: dict) -> None:
    if not isinstance(body.get("on"), bool):
        raise ValueError("body needs 'on': true or false")
    sim.set_oxygen(patient_id, body["on"])


def _post_consciousness(sim: VitalsSimulator, patient_id: str, body: dict) -> None:
    if "level" not in body:
        raise ValueError("body needs 'level': one of A, C, V, P, U, or null for automatic")
    sim.set_consciousness(patient_id, body["level"])


def _post_artifact(sim: VitalsSimulator, patient_id: str, body: dict) -> None:
    kwargs: Dict[str, Any] = {}
    if "vital" in body:
        kwargs["vital"] = body["vital"]
    if body.get("value") is not None:
        kwargs["value"] = float(body["value"])
    sim.inject_artifact(patient_id, **kwargs)


POST_ACTIONS: Dict[str, Callable[[VitalsSimulator, str, dict], Optional[dict]]] = {
    "trigger": _post_trigger,
    "resolve": _post_resolve,
    "oxygen": _post_oxygen,
    "consciousness": _post_consciousness,
    "artifact": _post_artifact,
}
_POST_ROUTE = re.compile(rf"/patients/([^/]+)/({'|'.join(POST_ACTIONS)})")


class Handler(BaseHTTPRequestHandler):
    server: SimServer
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # silence the default per-request stderr line
        pass

    # -- helpers --------------------------------------------------------------------------------

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def _json(self, status: int, body, close: bool = False) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        if close:  # e.g. the request body was left unread; this also sets self.close_connection
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        return json.loads(self.rfile.read(length))

    # -- routes ---------------------------------------------------------------------------------

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        sim, path = self.server.sim, self.path.split("?")[0]
        if path == "/health":
            self._json(200, {"ok": True, "supabase": self.server.sink is not None})
        elif path == "/patients":
            with self.server.lock:
                body = [
                    {
                        **p.to_json(),
                        "encounter": sim.admission(p.id).to_json(),
                        "baseline": sim.baseline(p.id),
                        "events": [e.to_json() for e in sim.active_events(p.id)],
                        "onOxygen": sim.on_oxygen(p.id),
                        "consciousnessOverride": sim.consciousness_override(p.id),
                    }
                    for p in sim.patients
                ]
            self._json(200, body)
        elif path == "/scenarios":
            self._json(200, {k: v.label for k, v in SCENARIOS.items()})
        elif path == "/vitals":
            with self.server.tick:
                latest = self.server.latest
            self._json(200, latest)  # send outside the lock so a slow client can't stall the ticker
        elif path == "/stream":
            self._sse()
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        path = self.path.split("?")[0]
        if path == "/patient-requests":
            return self._patient_request()
        # Answers sent before reading the body close the connection: on a keep-alive connection the
        # unread body would otherwise be parsed as the next request.
        m = _POST_ROUTE.fullmatch(path)
        if not m:
            return self._json(404, {"error": "not found"}, close=True)
        patient_id, action = m.groups()
        token = self.server.control_token
        if token and not bearer_matches(self.headers.get("Authorization"), token):
            return self._json(401, {"error": "missing or wrong Authorization: Bearer <SIM_CONTROL_TOKEN>"}, close=True)
        try:
            body = self._body()
            with self.server.lock:
                result = POST_ACTIONS[action](self.server.sim, patient_id, body)
            self._json(200, {"ok": True} if result is None else result)
        except KeyError as e:  # unknown patient id
            self._json(404, {"error": str(e).strip("'\"")})
        except (ValueError, json.JSONDecodeError) as e:
            self._json(400, {"error": str(e)})

    def _patient_request(self) -> None:
        """POST /patient-requests from the patient app (patient_requests.py). The token is checked
        before the body is read; answers that leave the body unread close the connection."""
        desk = self.server.patient_requests
        denied = desk.authorize(self.headers.get("Authorization"))
        if denied:
            return self._json(*denied, close=True)
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length > MAX_BODY_BYTES:
            return self._json(413, {"error": f"body is over {MAX_BODY_BYTES} bytes"}, close=True)
        if length <= 0:
            return self._json(400, {"error": "body must be a JSON object (with a Content-Length)"}, close=True)
        try:
            body = json.loads(self.rfile.read(length))
        except ValueError:  # JSONDecodeError, or bytes that aren't UTF-8
            return self._json(400, {"error": "body must be JSON"})
        self._json(*desk.submit(body))

    def _sse(self) -> None:
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        self.close_connection = True
        seen = -1
        try:
            while not self.server.stopped.is_set():
                with self.server.tick:
                    self.server.tick.wait_for(lambda: self.server.seq != seen or self.server.stopped.is_set(), timeout=15)
                    seq, frame = self.server.seq, self.server.latest_frame
                if seq == seen:
                    self.wfile.write(b": keep-alive\n\n")
                else:
                    seen = seq
                    self.wfile.write(frame)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


def cmd_serve(args: argparse.Namespace) -> None:
    sim = VitalsSimulator(load_ward(args), seed=args.seed, event_rate_per_hour=args.event_rate)
    truth = schedule_demo(sim) if args.demo else None

    sink = None if args.no_supabase else SupabaseSink.from_env()
    if sink:
        try:
            if args.reset:
                sink.reset()
            sink.admit(sim)
        except Exception as e:
            sys.exit(f"Supabase: setup failed: {getattr(e, 'message', None) or e}\n"
                     "Have the tables been created? Apply server/supabase/migrations/ (see CLAUDE.md -> Deployment), "
                     "or run with --no-supabase.")
        print(f"Supabase: admitted {len(sim.patients)} patients, writing vitals every tick", flush=True)
    else:
        print("Supabase: off (set SUPABASE_URL + SUPABASE_SECRET_KEY to enable)", flush=True)
    if not args.patient_request_token:
        print("Patient requests: off (set PATIENT_REQUEST_TOKEN to accept POST /patient-requests)", flush=True)
    elif not sink:
        print("Patient requests: token set, but Supabase is off, so POST /patient-requests answers 503", flush=True)
    else:
        print("Patient requests: on (POST /patient-requests -> alerts)", flush=True)

    server = SimServer((args.host, args.port), sim, args.interval, args.speed, sink=sink,
                       control_token=args.control_token, patient_request_token=args.patient_request_token)
    server.start_ticking()
    print(f"Vitals simulator on http://{args.host}:{server.server_address[1]}  "
          f"({len(sim.patients)} patients, every {args.interval}s, speed x{args.speed:g})  Ctrl-C to stop", flush=True)
    if truth:
        beds = {name: sim.admission(pid).bed_label for name, pid in truth.items()}
        print(f"Demo script: sepsis from +{DEMO_SEPSIS_AT_MIN / 60:g} h in bed {beds['sepsis']}, loose SpO2 probe "
              f"at +{DEMO_FALSE_ALARM_AT_MIN / 60:g} h in bed {beds['falseAlarm']} "
              "(ground truth - keep off the nurse UI)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


# ------------------------------------------------------------------------------------------------

# Defaults for --interval / --speed / --event-rate; flags given on the command line always win.
_FREE_RUNNING = {"interval": 2.0, "speed": 1.0, "event_rate": 0.15}
_DEMO = {"interval": DEMO_INTERVAL_SEC, "speed": DEMO_SPEED, "event_rate": 0.0}  # CLAUDE.md demo timing


def main(argv=None) -> None:
    load_dotenv(REPO_ROOT / ".env")
    env = os.environ.get
    parser = argparse.ArgumentParser(description="Synthea-based bedside vitals simulator")
    parser.add_argument("--clean-dir", default=str(DEFAULT_CLEAN_DIR), help="scrubbed patients (server/Synthea_Gen/transform.py)")
    parser.add_argument("--seed", type=int, default=int(env("SIM_SEED", 1984)))
    parser.add_argument("--patient-ids", default=env("SIM_PATIENT_IDS", ""),
                        help="comma-separated ward patient ids, in bed order (default: DEMO_WARD)")
    sub = parser.add_subparsers(dest="command", required=True)

    demo = sub.add_parser("demo", help="fast-forward the scripted demo and print a ward table")
    demo.add_argument("--hours", type=int, default=8)
    demo.set_defaults(func=cmd_demo)

    for name, func, help_ in (("stream", cmd_stream, "JSON lines to stdout"), ("serve", cmd_serve, "HTTP/SSE server")):
        p = sub.add_parser(name, help=help_)
        p.add_argument("--interval", type=float, help="real seconds between readings (default 2)")
        p.add_argument("--speed", type=float, help="sim seconds per real second (default 1)")
        p.add_argument("--event-rate", type=float, help="random events per patient per sim-hour (default 0.15)")
        p.set_defaults(func=func, demo=False)
        if name == "serve":
            p.add_argument("--demo", action="store_true",
                           help=f"scripted demo: {DEMO_INTERVAL_SEC:g} s ticks = {DEMO_TICK_MIN} sim-min, random events off")
            p.add_argument("--reset", action="store_true",
                           help="delete Supabase vitals, alerts + held readings before starting")
            p.add_argument("--no-supabase", action="store_true", help="don't write to Supabase even if configured")
            p.add_argument("--host", default=env("SIM_HOST", "127.0.0.1"))
            p.add_argument("--port", type=int, default=int(env("SIM_PORT", 8765)))
            p.add_argument("--control-token", default=env("SIM_CONTROL_TOKEN", ""),
                           help="require `Authorization: Bearer <token>` on the demo-control POSTs")
            p.add_argument("--patient-request-token", default=env("PATIENT_REQUEST_TOKEN", ""),
                           help="token the patient app sends to POST /patient-requests (unset = endpoint off)")

    args = parser.parse_args(argv)
    for key, value in (_DEMO if args.__dict__.get("demo") else _FREE_RUNNING).items():
        if args.__dict__.get(key, value) is None:
            setattr(args, key, value)
    args.func(args)


if __name__ == "__main__":
    main()
