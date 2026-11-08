"""Write simulator output to Supabase (tables in server/supabase/migrations/).

Used by `python3 server/sim/cli.py serve` when SUPABASE_URL and SUPABASE_SECRET_KEY are set
(SUPABASE_SERVICE_ROLE_KEY, the legacy name, also works):
  - on start: remove patients that aren't on this run's ward (so the tables hold exactly the ward),
    upsert the ward's patients + in-progress encounters, finish encounters from older runs
  - every tick: upsert one `vitals` row per patient, keyed on patient_id - the patient's existing
    row is updated in place, or created if it doesn't exist yet. No history accumulates.
  - per patient request (POST /patient-requests, see patient_requests.py): insert one `alerts` row.

Uses the secret key (sb_secret_..., bypasses Row Level Security), so it must only run server-side
(Render or a laptop) - never in a browser. Ground truth (which scenario is running) is NOT written:
the agent and the nurse UI only ever see the vitals stream.

The `supabase` package is imported lazily, so the rest of the simulator keeps working on the
standard library alone.
"""

from __future__ import annotations

import os
import sys
import threading
from typing import Any, Dict, List, Optional

from vitals_sim import VitalsSimulator

# VitalsReading key -> vitals column
VITALS_COLUMNS = {
    "patientId": "patient_id",
    "encounterId": "encounter_id",
    "recordedAt": "recorded_at",
    "heartRateBpm": "heart_rate_bpm",
    "systolicMmHg": "systolic_mmhg",
    "diastolicMmHg": "diastolic_mmhg",
    "spo2Percent": "spo2_percent",
    "temperatureC": "temperature_c",
    "respiratoryRate": "respiratory_rate",
    "onOxygen": "on_oxygen",
    "consciousness": "consciousness",
}

# Don't have PostgREST echo rows back - nothing reads them (postgrest's ReturnMethod is a str enum).
RETURN_MINIMAL = "minimal"

# Seconds before a Supabase request gives up (the client's default is 120 s).
REQUEST_TIMEOUT_SEC = 5.0


def vitals_row(reading: Dict[str, Any]) -> Dict[str, Any]:
    return {column: reading.get(key) for key, column in VITALS_COLUMNS.items()}


class SupabaseSink:
    def __init__(self, client: Any) -> None:
        """`client` is a supabase.Client (or a fake with the same .table() API, for tests)."""
        self.client = client

    @classmethod
    def from_env(cls) -> Optional["SupabaseSink"]:
        """Build from SUPABASE_URL + SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY);
        None if unset."""
        url = os.environ.get("SUPABASE_URL")
        key = os.environ.get("SUPABASE_SECRET_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not url or not key:
            return None
        try:
            import httpx
            from supabase import ClientOptions, create_client
        except ImportError as e:
            raise RuntimeError(
                "SUPABASE_URL is set but the supabase package isn't installed - "
                "use the venv: source .venv/bin/activate && pip install -r requirements.txt"
            ) from e
        options = ClientOptions(httpx_client=httpx.Client(timeout=REQUEST_TIMEOUT_SEC))
        return cls(create_client(url, key, options=options))

    def reset(self) -> None:
        """Delete all alerts, held readings and vitals (a fresh demo run). Patients/encounters are
        upserted anyway."""
        self.client.table("alerts").delete().not_.is_("id", "null").execute()
        self.client.table("held_readings").delete().not_.is_("id", "null").execute()
        self.client.table("vitals").delete().not_.is_("patient_id", "null").execute()

    def admit(self, sim: VitalsSimulator) -> None:
        """Make the tables match this run's ward: delete other patients (cascades to their encounters,
        vitals and alerts), upsert the ward's patients + encounters, finish their older encounters."""
        patients = [p.to_row() for p in sim.patients]
        encounters = [sim.admission(p.id).to_row(p.id) for p in sim.patients]
        table = self.client.table
        table("patients").delete().not_.in_("id", [p["id"] for p in patients]).execute()
        table("patients").upsert(patients, on_conflict="id", returning=RETURN_MINIMAL).execute()
        table("encounters").upsert(encounters, on_conflict="id", returning=RETURN_MINIMAL).execute()
        (
            table("encounters")
            .update({"status": "finished"})
            .not_.in_("id", [e["id"] for e in encounters])
            .eq("status", "in-progress")
            .execute()
        )

    def write(self, readings: List[Dict[str, Any]]) -> None:
        """Upsert each patient's latest reading: update their row, or insert it if it doesn't exist."""
        if readings:
            rows = [vitals_row(r) for r in readings]
            self.client.table("vitals").upsert(rows, on_conflict="patient_id", returning=RETURN_MINIMAL).execute()

    def insert_alert(self, row: Dict[str, Any]) -> None:
        """Insert one `alerts` row (patient_id, encounter_id, tier, news2_score, reason).
        Runs on the calling thread, so the caller learns whether it was written."""
        self.client.table("alerts").insert(row, returning=RETURN_MINIMAL).execute()


class BackgroundWriter:
    """Runs sink.write() on its own thread so a slow or stalled network never holds up the ticker.

    Only the newest batch is kept: each write overwrites every patient's row anyway, so if Supabase
    falls behind, older batches are dropped instead of queueing up.
    """

    def __init__(self, sink: Any) -> None:
        self.sink = sink
        self.failures = 0  # consecutive failed writes
        self._cond = threading.Condition()
        self._pending: Optional[list] = None
        self._closed = False
        self._thread = threading.Thread(target=self._loop, name="supabase-writer", daemon=True)
        self._thread.start()

    def submit(self, readings: list) -> None:
        with self._cond:
            self._pending = readings
            self._cond.notify()

    def close(self) -> None:
        with self._cond:
            self._closed = True
            self._cond.notify()

    def _loop(self) -> None:
        while True:
            with self._cond:
                self._cond.wait_for(lambda: self._pending is not None or self._closed)
                if self._pending is None:  # closed, nothing left to write
                    return
                batch, self._pending = self._pending, None
            self._write(batch)

    def _write(self, batch: list) -> None:
        try:
            self.sink.write(batch)
            if self.failures:
                print(f"supabase: writes recovered after {self.failures} failures", flush=True)
            self.failures = 0
        except Exception as e:  # keep going; the SSE stream still works without Supabase
            self.failures += 1
            if self.failures == 1 or self.failures % 30 == 0:
                print(f"supabase: write failed ({self.failures}x): {e}", file=sys.stderr, flush=True)
