"""NEWS2 alert worker: watches the `vitals` table in Supabase, scores readings, writes `alerts`
(and `held_readings`, see below).

    python3 server/news2/alert_worker.py

Needs SUPABASE_URL + SUPABASE_SECRET_KEY (legacy SUPABASE_SERVICE_ROLE_KEY also works), from the
environment or the repo-root .env. The secret key bypasses Row Level Security, so this must only
run server-side (Render worker or a laptop), never in a browser.

`vitals` holds only the LATEST reading per patient: the simulator overwrites each patient's row
every tick (2 s). So every poll reads all rows and scores the ones whose `recorded_at` changed.
Polling at 1 s (twice per tick) means a slightly late poll doesn't miss a reading.

Alert rule (fewer, better alerts):
  - News2Monitor confirms a tier only after it has held for 2 readings (one bad reading is suppressed).
  - An `alerts` row is written only when a patient's confirmed tier rises above the last tier we
    alerted for. Holding a tier doesn't repeat the alert.
  - The bar only drops after the patient has stayed below it for RESET_AFTER readings, so a vital
    wobbling across a band edge (pulse 90 <-> 91) doesn't re-alert every few minutes.

Held readings (never alerts; the nurse dashboard shows them quietly):
  - A suppressed reading waits for the patient's next scored reading. If that one reaches the same
    tier, the escalation was real (it alerts as above) and nothing is held. If it's back below that
    tier (e.g. a loose SpO2 probe), the suppressed reading - its own time, tier, score and reasons -
    is written to `held_readings`. Dropped if the patient starts over or never has another reading.
  - Only "check soon" and "go now" are kept; watch-level blips (e.g. systolic 110 once) are not.
  - Best effort: written after the alerts, and a failed insert is only logged.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

SERVER_DIR = Path(__file__).resolve().parent.parent  # server/
REPO_ROOT = SERVER_DIR.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
if str(SERVER_DIR) not in sys.path:
    sys.path.append(str(SERVER_DIR))  # for server/pylib/

from scoring import News2Monitor, spo2_scale_for  # noqa: E402
from pylib.env import load_dotenv  # noqa: E402

log = logging.getLogger("alert-worker")

POLL_SECONDS = 1.0  # the simulator writes every 2 s; polling twice per tick never misses one
RESET_AFTER = 8  # readings below the last alerted tier before it can alert again (8 ticks = 2 h sim)

TIER_RANK = {"none": 0, "watch": 1, "check soon": 2, "go now": 3}

# vitals column -> VitalsReading key (what scoring.py expects)
READING_KEYS = {
    "patient_id": "patientId",
    "recorded_at": "recordedAt",
    "heart_rate_bpm": "heartRateBpm",
    "systolic_mmhg": "systolicMmHg",
    "diastolic_mmhg": "diastolicMmHg",
    "spo2_percent": "spo2Percent",
    "temperature_c": "temperatureC",
    "respiratory_rate": "respiratoryRate",
    "on_oxygen": "onOxygen",
    "consciousness": "consciousness",
}


def reading_from_row(row: Dict[str, Any]) -> Dict[str, Any]:
    reading = {key: row.get(col) for col, key in READING_KEYS.items()}
    if reading["temperatureC"] is not None:  # numeric(4,1) can arrive as a string
        reading["temperatureC"] = float(reading["temperatureC"])
    return reading


class AlertWorker:
    def __init__(self, client: Any) -> None:
        """`client` is a supabase.Client (or a fake with the same .table() API, for tests)."""
        self.client = client
        self.monitor = News2Monitor()
        self.known_patients: set = set()
        self.last_seen: Dict[str, str] = {}  # patient_id -> recorded_at of the last reading scored
        self.last_alerted: Dict[str, str] = {}  # patient_id -> tier of the last alert written
        self.below_count: Dict[str, int] = {}  # patient_id -> readings in a row below last_alerted
        self.pending_held: Dict[str, dict] = {}  # patient_id -> held_readings row awaiting next reading

    # --- Supabase reads/writes -----------------------------------------------------------------

    def load_patients(self, ids: Optional[Iterable[str]] = None) -> None:
        """Set each patient's SpO2 scale from their conditions (all patients, or just `ids`)."""
        q = self.client.table("patients").select("id,conditions")
        if ids is not None:
            q = q.in_("id", list(ids))
        for p in q.execute().data:
            self.monitor.set_spo2_scale(p["id"], spo2_scale_for(p.get("conditions") or []))
            self.known_patients.add(p["id"])

    def fetch_vitals(self) -> List[dict]:
        return self.client.table("vitals").select("*").execute().data

    def write_alerts(self, alerts: List[dict]) -> None:
        if alerts:
            self.client.table("alerts").insert(alerts).execute()

    def write_held(self, held: List[dict]) -> None:
        """Best effort: a failed insert is logged and the rows are dropped. Never raises, so
        held_readings can't stop the worker or cost an alert."""
        if not held:
            return
        try:
            self.client.table("held_readings").insert(held).execute()
        except Exception:
            log.exception("couldn't write %d held reading(s); dropped", len(held))

    # --- Scoring -------------------------------------------------------------------------------

    def forget(self, pid: str) -> None:
        """Start a patient over (e.g. the simulator restarted and its clock went back)."""
        self.monitor.reset(pid)
        for state in (self.last_alerted, self.below_count, self.pending_held):
            state.pop(pid, None)

    def process(self, rows: List[dict]) -> Tuple[List[dict], List[dict]]:
        """Score rows whose reading is new since the last poll.
        Returns (alerts rows, held_readings rows) to insert."""
        new = [r for r in rows if r["recorded_at"] != self.last_seen.get(r["patient_id"])]
        new.sort(key=lambda r: r["recorded_at"])

        unknown = {r["patient_id"] for r in new} - self.known_patients
        if unknown:
            self.load_patients(unknown)

        alerts, held = [], []
        for row in new:
            pid = row["patient_id"]
            prev_seen = self.last_seen.get(pid)
            self.last_seen[pid] = row["recorded_at"]
            if prev_seen is not None and row["recorded_at"] < prev_seen:
                log.info("clock went back for %s (simulator restart?); starting over", pid)
                self.forget(pid)
            try:
                res = self.monitor.update(reading_from_row(row))
            except ValueError as e:
                log.warning("skipping vitals for %s at %s: %s", pid, row["recorded_at"], e)
                continue

            # Settle the reading suppressed last time: this reading reaching its tier too confirms
            # the escalation (nothing held); back below it means it was held back for good.
            pending = self.pending_held.pop(pid, None)
            if pending and TIER_RANK[res.news2.tier] < TIER_RANK[pending["held_tier"]]:
                log.info("held %s: %s (NEWS2 %d) at %s, not confirmed by the next reading",
                         pid, pending["held_tier"], pending["news2_score"], pending["recorded_at"])
                held.append(pending)

            if res.suppressed:
                log.info("suppressed %s: %s (NEWS2 %d) held at %s",
                         pid, res.news2.tier, res.news2.total, res.alert_tier)
            # Watch-level blips aren't stored: they'd be clutter, and storing less is privacy-first.
            if res.suppressed and TIER_RANK[res.news2.tier] >= TIER_RANK["check soon"]:
                self.pending_held[pid] = {  # written by the next reading if that doesn't confirm it
                    "patient_id": pid,
                    "encounter_id": row["encounter_id"],
                    "recorded_at": row["recorded_at"],
                    "held_tier": res.news2.tier,  # the tier this reading alone would have raised
                    "news2_score": res.news2.total,
                    "reason": "; ".join(res.news2.reasons),
                }

            tier, bar = res.alert_tier, self.last_alerted.get(pid, "none")
            if TIER_RANK[tier] > TIER_RANK[bar]:
                alerts.append({
                    "patient_id": pid,
                    "encounter_id": row["encounter_id"],
                    "tier": tier,
                    "news2_score": res.news2.total,
                    "reason": "; ".join(res.news2.reasons) or "NEWS2 tier confirmed",
                })
                log.info("ALERT %s: %s (NEWS2 %d)", pid, tier, res.news2.total)
                self.last_alerted[pid], self.below_count[pid] = tier, 0
            elif TIER_RANK[tier] < TIER_RANK[bar]:
                self.below_count[pid] = self.below_count.get(pid, 0) + 1
                if self.below_count[pid] >= RESET_AFTER:
                    self.last_alerted[pid], self.below_count[pid] = tier, 0
            else:
                self.below_count[pid] = 0
        return alerts, held

    def poll_once(self) -> int:
        alerts, held = self.process(self.fetch_vitals())
        self.write_alerts(alerts)
        self.write_held(held)  # after the alerts, and never raises
        return len(alerts)

    def run(self, interval: float) -> None:
        self.load_patients()
        # Don't score whatever is already in the table: it may be minutes old.
        for row in self.fetch_vitals():
            self.last_seen[row["patient_id"]] = row["recorded_at"]
        log.info("watching vitals for %d patients, polling every %gs", len(self.known_patients), interval)
        while True:
            try:
                self.poll_once()
            except Exception:  # network blips shouldn't kill the worker
                log.exception("poll failed; retrying")
            time.sleep(interval)


# --- Entry point -------------------------------------------------------------------------------

def make_client() -> Any:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SECRET_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit("SUPABASE_URL and SUPABASE_SECRET_KEY must be set (environment or .env)")
    from supabase import create_client  # imported lazily so tests run without the package
    return create_client(url, key)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--interval", type=float, default=POLL_SECONDS,
                    help=f"seconds between polls (default {POLL_SECONDS:g})")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # supabase's per-request logs (1/s)
    load_dotenv(REPO_ROOT / ".env")
    AlertWorker(make_client()).run(args.interval)


if __name__ == "__main__":
    main()
