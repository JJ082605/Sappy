"""Run: python3 -m unittest discover server/sim -v

The real-client test needs the venv (pip install -r requirements.txt); it points the actual
supabase-py client at a local fake PostgREST server, so it never touches a real project.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from supabase_sink import VITALS_COLUMNS, BackgroundWriter, SupabaseSink, vitals_row  # noqa: E402
from _testutil import quiet_sim, request, start_server, stop_server, ward  # noqa: E402

MINIMAL = {"returning": "minimal"}


class FakeQuery:
    """Records a supabase-py style call chain: table(..).op(..).filters(..).execute()."""

    def __init__(self, log: list, table: str):
        self.call: dict[str, object] = {
            "table": table,
            "op": None,
            "data": None,
            "filters": [],
            "kwargs": {},
        }
        self._negate = False
        log.append(self.call)

    def _op(self, op, data=None, **kwargs):
        self.call.update(op=op, data=data, kwargs=kwargs)
        return self

    def insert(self, data, **kw):
        return self._op("insert", data, **kw)

    def upsert(self, data, **kw):
        return self._op("upsert", data, **kw)

    def update(self, data, **kw):
        return self._op("update", data, **kw)

    def delete(self, **kw):
        return self._op("delete", **kw)

    @property
    def not_(self):
        self._negate = True
        return self

    def _filter(self, name, column, value):
        self.call["filters"].append((("not." if self._negate else "") + name, column, value))
        self._negate = False
        return self

    def eq(self, column, value):
        return self._filter("eq", column, value)

    def in_(self, column, values):
        return self._filter("in", column, list(values))

    def is_(self, column, value):
        return self._filter("is", column, value)

    def execute(self):
        return None


class FakeClient:
    def __init__(self):
        self.log: list = []

    def table(self, name):
        return FakeQuery(self.log, name)


class RowMappingTests(unittest.TestCase):
    def test_vitals_row_matches_reading(self):
        sim = quiet_sim(ward(2))
        (r, _) = sim.step(5)
        row = vitals_row(r)
        self.assertEqual(set(row), set(VITALS_COLUMNS.values()))
        self.assertEqual(row["patient_id"], "p0")
        self.assertEqual(row["encounter_id"], sim.admission("p0").encounter_id)
        self.assertEqual(row["spo2_percent"], r["spo2Percent"])
        self.assertEqual(row["on_oxygen"], False)
        self.assertEqual(row["consciousness"], "A")

    def test_every_reading_key_is_mapped(self):
        (r, _) = quiet_sim(ward(2)).step(5)
        self.assertEqual(set(r), set(VITALS_COLUMNS))

    def test_patient_and_encounter_rows_have_no_identifying_fields(self):
        sim = quiet_sim(ward(2))
        self.assertEqual(set(sim.patients[0].to_row()), {"id", "age_band", "gender", "conditions", "medications"})
        enc = sim.admission("p1").to_row("p1")
        self.assertEqual(
            (enc["patient_id"], enc["status"], enc["class"], enc["bed_label"]), ("p1", "in-progress", "IMP", "4W-02")
        )


class SinkTests(unittest.TestCase):
    def setUp(self):
        self.client = FakeClient()
        self.sink = SupabaseSink(self.client)
        self.sim = quiet_sim(ward(2))

    def test_admit_prunes_other_patients_upserts_then_finishes_old_encounters(self):
        self.sink.admit(self.sim)
        ops = [(c["table"], c["op"]) for c in self.client.log]
        self.assertEqual(ops, [("patients", "delete"), ("patients", "upsert"), ("encounters", "upsert"),
                               ("encounters", "update")])
        self.assertEqual(self.client.log[0]["filters"], [("not.in", "id", ["p0", "p1"])])
        self.assertEqual(self.client.log[1]["kwargs"], {"on_conflict": "id", **MINIMAL})
        finish = self.client.log[3]
        ids = [self.sim.admission(f"p{i}").encounter_id for i in range(2)]
        self.assertEqual(finish["data"], {"status": "finished"})
        self.assertEqual(finish["filters"], [("not.in", "id", ids), ("eq", "status", "in-progress")])

    def test_write_upserts_one_row_per_patient_keyed_on_patient(self):
        self.sink.write(self.sim.step(5))
        (call,) = self.client.log
        self.assertEqual((call["table"], call["op"], len(call["data"])), ("vitals", "upsert", 2))
        self.assertEqual(call["kwargs"], {"on_conflict": "patient_id", **MINIMAL})
        self.sink.write([])
        self.assertEqual(len(self.client.log), 1)  # empty batch: no request

    def test_reset_clears_alerts_held_readings_then_vitals(self):
        self.sink.reset()
        self.assertEqual([(c["table"], c["op"], c["filters"]) for c in self.client.log], [
            ("alerts", "delete", [("not.is", "id", "null")]),
            ("held_readings", "delete", [("not.is", "id", "null")]),
            ("vitals", "delete", [("not.is", "patient_id", "null")]),
        ])

    def test_insert_alert_inserts_one_row(self):
        row = {"patient_id": "p0", "encounter_id": self.sim.admission("p0").encounter_id, "tier": "watch",
               "news2_score": None, "reason": "Patient request: water"}
        self.sink.insert_alert(row)
        self.assertEqual(self.client.log, [
            {"table": "alerts", "op": "insert", "data": row, "filters": [], "kwargs": MINIMAL},
        ])

    def test_from_env_none_when_unconfigured(self):
        with mock.patch.dict(os.environ, {"SUPABASE_URL": "", "SUPABASE_SECRET_KEY": "", "SUPABASE_SERVICE_ROLE_KEY": ""}):
            self.assertIsNone(SupabaseSink.from_env())

    def test_simulator_ground_truth_never_written(self):
        self.sim.trigger("p0", "sepsis")
        self.sink.admit(self.sim)
        self.sink.write(self.sim.step(5))
        self.assertNotIn("sepsis", json.dumps([c["data"] for c in self.client.log]))


class BackgroundWriterTests(unittest.TestCase):
    def test_keeps_only_the_newest_batch_while_a_write_is_in_flight(self):
        import time
        started, release, written = threading.Event(), threading.Event(), []

        class SlowSink:
            def write(self, batch):
                started.set()
                release.wait(5)
                written.append(batch)

        writer = BackgroundWriter(SlowSink())
        self.addCleanup(writer.close)
        writer.submit([1])
        started.wait(5)  # first write is blocked on the "network"
        for batch in ([2], [3], [4]):
            writer.submit(batch)
        release.set()
        deadline = time.time() + 3
        while len(written) < 2 and time.time() < deadline:
            time.sleep(0.01)
        self.assertEqual(written, [[1], [4]])  # [2] and [3] were superseded, never sent


class ServerSinkTests(unittest.TestCase):
    def start(self, sink=None, token=""):
        server, base = start_server(quiet_sim(ward(2)), sink=sink, control_token=token)
        self.addCleanup(stop_server, server)
        return server, base

    def request(self, url, body=None, headers=None):
        return request(url, body, headers)

    def test_ticks_written_to_sink_and_health_reports_it(self):
        client = FakeClient()
        server, base = self.start(sink=SupabaseSink(client))
        self.assertEqual(self.request(base + "/health"), (200, {"ok": True, "supabase": True}))
        import time
        deadline = time.time() + 3
        while not client.log and time.time() < deadline:
            time.sleep(0.02)
        self.assertEqual(client.log[0]["table"], "vitals")

    def test_sink_failure_does_not_stop_ticking(self):
        class Broken:
            def write(self, readings):
                raise RuntimeError("network down")

        import io, time
        with mock.patch("sys.stderr", new=io.StringIO()):
            server, base = self.start(sink=Broken())
            first = server.seq
            time.sleep(0.3)
        self.assertGreater(server.seq, first + 2)
        self.assertGreater(server.writer.failures, 0)

    def test_control_token_required_for_post(self):
        _, base = self.start(token="s3cret")
        url = base + "/patients/p0/oxygen"
        self.assertEqual(self.request(url, {"on": True})[0], 401)
        self.assertEqual(self.request(url, {"on": True}, {"Authorization": "Bearer nope"})[0], 401)
        self.assertEqual(self.request(url, {"on": True}, {"Authorization": "Bearer s3cret"})[0], 200)
        self.assertEqual(self.request(base + "/health")[0], 200)  # GETs stay open


try:
    # Import a real name: the repo's supabase/ folder (migrations) can masquerade as an empty
    # namespace package called "supabase" when the library isn't installed.
    from supabase import create_client  # noqa: F401
    HAS_SUPABASE = True
except ImportError:
    HAS_SUPABASE = False


@unittest.skipUnless(HAS_SUPABASE, "supabase package not installed (use the venv)")
class RealClientTests(unittest.TestCase):
    """Real supabase-py client -> local fake PostgREST; checks the HTTP requests it sends."""

    def setUp(self):
        requests = self.requests = []
        tables = self.tables = {}  # table -> {conflict key value: row}

        class FakePostgrest(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _handle(self):
                length = int(self.headers.get("Content-Length") or 0)
                url = urlparse(self.path)
                req = {
                    "method": self.command,
                    "path": url.path,
                    "query": {k: v[0] for k, v in parse_qs(url.query).items()},
                    "body": json.loads(self.rfile.read(length)) if length else None,
                    "auth": self.headers.get("Authorization", ""),
                    "prefer": self.headers.get("Prefer", ""),
                }
                requests.append(req)
                # Minimal table semantics for POST: upsert replaces by on_conflict key, insert appends.
                if self.command == "POST":
                    table = tables.setdefault(url.path.rsplit("/", 1)[-1], {})
                    key = req["query"].get("on_conflict")
                    for row in req["body"]:
                        if key and "resolution=merge-duplicates" in req["prefer"]:
                            table[row[key]] = row
                        else:
                            table[len(table)] = row
                payload = b"[]"
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = do_POST = do_PATCH = do_DELETE = _handle

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakePostgrest)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        env = {"SUPABASE_URL": f"http://127.0.0.1:{self.server.server_address[1]}",
               "SUPABASE_SECRET_KEY": "sb_secret_" + "x" * 32}
        with mock.patch.dict(os.environ, env):
            self.sink = SupabaseSink.from_env()

    def test_requests_sent_to_postgrest(self):
        sim = quiet_sim(ward(2))
        self.sink.reset()
        self.sink.admit(sim)
        self.sink.write(sim.step(5))
        got = [(r["method"], r["path"]) for r in self.requests]
        self.assertEqual(got, [
            ("DELETE", "/rest/v1/alerts"), ("DELETE", "/rest/v1/held_readings"), ("DELETE", "/rest/v1/vitals"),
            ("DELETE", "/rest/v1/patients"), ("POST", "/rest/v1/patients"), ("POST", "/rest/v1/encounters"),
            ("PATCH", "/rest/v1/encounters"), ("POST", "/rest/v1/vitals"),
        ])
        self.assertEqual(self.requests[1]["query"], {"id": "not.is.null"})
        self.assertEqual(self.requests[2]["query"], {"patient_id": "not.is.null"})
        self.assertEqual(self.requests[3]["query"], {"id": "not.in.(p0,p1)"})
        self.assertEqual(self.requests[4]["query"]["on_conflict"], "id")
        ids = ",".join(sim.admission(f"p{i}").encounter_id for i in range(2))
        self.assertEqual(self.requests[6]["query"], {"id": f"not.in.({ids})", "status": "eq.in-progress"})
        self.assertEqual(self.requests[6]["body"], {"status": "finished"})
        vitals = self.requests[7]
        self.assertEqual(vitals["query"]["on_conflict"], "patient_id")
        self.assertIn("resolution=merge-duplicates", vitals["prefer"])  # upsert, not plain insert
        self.assertEqual(len(vitals["body"]), 2)
        self.assertEqual(set(vitals["body"][0]), set(VITALS_COLUMNS.values()))
        self.assertTrue(all(r["auth"].startswith("Bearer ") for r in self.requests))

    def test_repeated_ticks_update_one_row_per_patient(self):
        sim = quiet_sim(ward(2))
        self.sink.admit(sim)
        for _ in range(10):
            last = sim.step(5)
            self.sink.write(last)
        vitals = self.tables["vitals"]
        self.assertEqual(sorted(vitals), ["p0", "p1"])  # still 2 rows after 10 ticks
        self.assertEqual(vitals["p0"]["recorded_at"], last[0]["recordedAt"])  # holds the latest reading


@unittest.skipUnless(HAS_SUPABASE, "supabase package not installed (use the venv)")
class RealClientInProcessTests(unittest.TestCase):
    """Real supabase-py client -> httpx.MockTransport: checks the HTTP request without opening a port."""

    def test_insert_alert_request(self):
        import httpx
        from supabase import ClientOptions, create_client

        requests = []

        def postgrest(req):
            requests.append(req)
            return httpx.Response(201)

        http = httpx.Client(transport=httpx.MockTransport(postgrest))
        self.addCleanup(http.close)
        sink = SupabaseSink(create_client("http://supabase.test", "sb_secret_" + "x" * 32,
                                          options=ClientOptions(httpx_client=http)))
        row = {"patient_id": "p0", "encounter_id": "e0", "tier": "go now", "news2_score": None,
               "reason": "Patient reported a possible emergency: a fall"}
        sink.insert_alert(row)
        (req,) = requests
        self.assertEqual((req.method, req.url.path, dict(req.url.params)), ("POST", "/rest/v1/alerts", {}))
        self.assertEqual(req.headers["Prefer"], "return=minimal")  # a plain insert: no upsert/merge
        self.assertEqual(json.loads(req.content), row)


if __name__ == "__main__":
    unittest.main()
