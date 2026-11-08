"""Shared fixtures for the sim/ tests.

Not a test module itself: `unittest discover` only collects files matching test*.py.
"""

from __future__ import annotations

import io
import json
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vitals_sim import SimPatient, VitalsSimulator  # noqa: E402

START = 1767254400.0  # 2026-01-01T08:00:00Z


def make_patient(**overrides: Any) -> SimPatient:
    """A healthy 40-49 year old with normal Synthea vitals; override any SimPatient field."""
    fields: Dict[str, Any] = dict(
        id="p1", age_band="40-49", gender="female",
        conditions=[], last_vitals={"heartRateBpm": 70, "systolicMmHg": 120, "diastolicMmHg": 78},
    )
    fields.update(overrides)
    return SimPatient(**fields)


def ward(n: int) -> List[SimPatient]:
    """n healthy patients with ids p0..p{n-1}."""
    return [make_patient(id=f"p{i}") for i in range(n)]


def quiet_sim(patients: List[SimPatient], seed: int = 1984) -> VitalsSimulator:
    """Simulator with random events off, so only explicitly triggered scenarios run."""
    return VitalsSimulator(patients, seed=seed, start_time=START, event_rate_per_hour=0)


def run(sim: VitalsSimulator, minutes: float, dt: float = 5) -> list:
    """Run `minutes` of sim time in `dt` second steps and return every reading."""
    out = []
    for _ in range(int(minutes * 60 / dt)):
        out.extend(sim.step(dt))
    return out


def start_server(sim: VitalsSimulator, **kwargs: Any) -> Tuple[Any, str]:
    """Start a SimServer on a free port, ticking every 50 ms. Returns (server, base_url);
    call stop_server(server) when done (e.g. via addCleanup)."""
    from cli import SimServer

    server = SimServer(("127.0.0.1", 0), sim, interval_sec=0.05, speed=1, **kwargs)
    server.start_ticking()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def stop_server(server: Any) -> None:
    server.shutdown()
    server.server_close()


def request(url: str, body: Optional[dict] = None, headers: Optional[dict] = None) -> Tuple[int, Any]:
    """GET (body None) or POST JSON; returns (status, decoded JSON body) for success and errors."""
    req = urllib.request.Request(
        url,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


# --- Without a port: some sandboxes and CI runners don't allow binding one ----------------------

def offline_server(sim: VitalsSimulator, **kwargs: Any) -> Any:
    """A SimServer that isn't bound to a port and isn't ticking; send it requests with call().
    Call server.server_close() when done (e.g. via addCleanup)."""
    from cli import SimServer

    return SimServer(("127.0.0.1", 0), sim, interval_sec=0.05, speed=1, bind_and_activate=False, **kwargs)


class _MemoryConnection:
    """Just enough of a socket for the request handler: it reads the request from memory and
    collects the response."""

    def __init__(self, request: bytes):
        self._request = io.BytesIO(request)
        self.response = bytearray()

    def makefile(self, mode: str, *args: Any) -> io.BytesIO:
        return self._request  # only asked for 'rb'; responses go through sendall()

    def sendall(self, data: bytes) -> None:
        self.response += data

    def settimeout(self, *args: Any) -> None:
        pass

    def setsockopt(self, *args: Any) -> None:
        pass


def call(server: Any, method: str, path: str, body: Any = None,
         headers: Optional[dict] = None) -> Tuple[int, Any, Dict[str, str]]:
    """Run one HTTP request through the server's real Handler, in memory. `body` is JSON-encoded
    unless it's bytes. Returns (status, decoded JSON body, response headers)."""
    from cli import Handler

    data = b"" if body is None else body if isinstance(body, bytes) else json.dumps(body).encode()
    head = [f"{method} {path} HTTP/1.1", "Host: test", "Content-Type: application/json",
            f"Content-Length: {len(data)}", *(f"{k}: {v}" for k, v in (headers or {}).items())]
    conn = _MemoryConnection(("\r\n".join(head) + "\r\n\r\n").encode("latin-1") + data)
    Handler(conn, ("127.0.0.1", 0), server)  # handles the request, then stops at end of input
    raw_head, _, rest = bytes(conn.response).partition(b"\r\n\r\n")
    status_line, *header_lines = raw_head.decode("latin-1").split("\r\n")
    response_headers = dict(line.split(": ", 1) for line in header_lines)
    length = int(response_headers["Content-Length"])
    if rest[length:]:
        raise AssertionError("more than one response to one request (was an unread body parsed as another "
                             f"request?): {rest[length:][:120]!r}")
    return int(status_line.split()[1]), json.loads(rest[:length]), response_headers
