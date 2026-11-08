"""Tests for the NEWS2 alert worker, using an in-memory fake of the supabase client.

    python3 -m unittest server/news2/test_alert_worker.py -v
"""

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from alert_worker import RESET_AFTER, AlertWorker, reading_from_row  # noqa: E402


class FakeQuery:
    def __init__(self, db, table):
        self.db, self.table, self.filters = db, table, []

    def select(self, _cols):
        return self

    def in_(self, col, values):
        self.filters.append(lambda r: r[col] in values)
        return self

    def insert(self, rows):
        self.db.setdefault(self.table, []).extend(rows)
        return self

    def execute(self):
        rows = [r for r in self.db.get(self.table, []) if all(f(r) for f in self.filters)]
        return type("Resp", (), {"data": rows})()


class FakeClient:
    def __init__(self, db):
        self.db = db

    def table(self, name):
        return FakeQuery(self.db, name)


class FailingInsertClient(FakeClient):
    """A FakeClient whose inserts into one table raise (network error, table not migrated yet, ...)."""

    def __init__(self, db, failing_table):
        super().__init__(db)
        self.failing_table = failing_table

    def table(self, name):
        q = super().table(name)
        if name == self.failing_table:
            def insert(_rows):
                raise RuntimeError(f"insert into {name} failed")
            q.insert = insert
        return q


NORMAL = dict(heart_rate_bpm=75, systolic_mmhg=125, diastolic_mmhg=80, spo2_percent=97,
              temperature_c="36.8", respiratory_rate=16, on_oxygen=False, consciousness="A")
SEPTIC = dict(NORMAL, heart_rate_bpm=125, systolic_mmhg=95, temperature_c="39.2",
              respiratory_rate=26, spo2_percent=93)  # NEWS2 >= 7
PULSE_91 = dict(NORMAL, heart_rate_bpm=91)  # NEWS2 1 -> watch
LOOSE_PROBE = dict(NORMAL, spo2_percent=78)  # one implausible SpO2, pulse normal: NEWS2 3 -> check soon

START = datetime(2026, 1, 1, 8, tzinfo=timezone.utc)


class AlertWorkerTest(unittest.TestCase):
    def setUp(self):
        self.db = {
            "patients": [{"id": "p1", "conditions": []},
                         {"id": "copd", "conditions": ["Chronic obstructive bronchitis (disorder)"]}],
            "vitals": [],  # latest reading per patient, like the real table
            "alerts": [],
            "held_readings": [],
        }
        self.worker = AlertWorker(FakeClient(self.db))
        self.worker.load_patients()
        self.tick = {}

    def put(self, pid, **vitals):
        """One simulator tick for `pid`: overwrite their vitals row (no poll). Returns the row."""
        self.tick[pid] = self.tick.get(pid, 0) + 1
        at = (START + timedelta(minutes=15 * self.tick[pid])).isoformat()
        row = {"patient_id": pid, "encounter_id": f"enc-{pid}", "recorded_at": at, **vitals}
        self.db["vitals"] = [r for r in self.db["vitals"] if r["patient_id"] != pid] + [row]
        return row

    def add(self, pid, **vitals):
        """One simulator tick for `pid`: overwrite their vitals row, then poll. Returns the row."""
        row = self.put(pid, **vitals)
        self.worker.poll_once()
        return row

    def tiers(self):
        return [a["tier"] for a in self.db["alerts"]]

    def held(self):
        return self.db["held_readings"]

    def test_reading_from_row_maps_to_camel_case(self):
        r = reading_from_row({"patient_id": "p1", **NORMAL})
        self.assertEqual(r["patientId"], "p1")
        self.assertEqual(r["temperatureC"], 36.8)
        self.assertIs(r["onOxygen"], False)

    def test_stable_patient_never_alerts(self):
        for _ in range(5):
            self.add("p1", **NORMAL)
        self.assertEqual(self.tiers(), [])

    def test_single_bad_reading_is_suppressed(self):
        self.add("p1", **NORMAL)
        self.add("p1", **dict(NORMAL, spo2_percent=82))  # loose probe
        self.add("p1", **NORMAL)
        self.assertEqual(self.tiers(), [])

    def test_sustained_deterioration_alerts_once(self):
        for _ in range(4):
            self.add("p1", **SEPTIC)
        self.assertEqual(self.tiers(), ["go now"])
        alert = self.db["alerts"][0]
        self.assertEqual(alert["encounter_id"], "enc-p1")
        self.assertGreaterEqual(alert["news2_score"], 7)
        self.assertIn("Respiratory rate", alert["reason"])

    def test_unchanged_row_is_not_scored_twice(self):
        self.add("p1", **SEPTIC)
        self.worker.poll_once()  # same row, polled again (worker polls twice per tick)
        self.assertEqual(self.tiers(), [])  # one reading only: still suppressed

    def test_wobble_across_band_edge_alerts_once(self):
        for v in (PULSE_91, PULSE_91, NORMAL, PULSE_91, PULSE_91, NORMAL, PULSE_91, PULSE_91):
            self.add("p1", **v)
        self.assertEqual(self.tiers(), ["watch"])

    def test_re_escalation_after_real_recovery_alerts_again(self):
        for v in [SEPTIC, SEPTIC] + [NORMAL] * RESET_AFTER + [SEPTIC, SEPTIC]:
            self.add("p1", **v)
        self.assertEqual(self.tiers(), ["go now", "go now"])

    def test_escalating_above_last_alert_is_immediate(self):
        for v in (PULSE_91, PULSE_91, SEPTIC, SEPTIC):
            self.add("p1", **v)
        self.assertEqual(self.tiers(), ["watch", "go now"])

    def test_simulator_restart_starts_patient_over(self):
        self.add("p1", **SEPTIC)
        self.add("p1", **SEPTIC)
        self.tick["p1"] = 0  # sim restarted: clock goes back
        self.add("p1", **SEPTIC)
        self.add("p1", **SEPTIC)
        self.assertEqual(self.tiers(), ["go now", "go now"])

    def test_copd_patient_uses_scale_2(self):
        self.assertEqual(self.worker.monitor.spo2_scale("copd"), 2)
        for _ in range(3):
            self.add("copd", **dict(NORMAL, spo2_percent=89))  # fine on Scale 2
        self.assertEqual(self.tiers(), [])

    def test_unknown_patient_is_loaded_on_first_reading(self):
        self.db["patients"].append({"id": "late", "conditions": ["Emphysema (disorder)"]})
        self.add("late", **NORMAL)
        self.assertEqual(self.worker.monitor.spo2_scale("late"), 2)

    def test_missing_input_is_skipped_not_fatal(self):
        self.add("p1", **dict(NORMAL, spo2_percent=None))
        self.add("p1", **NORMAL)
        self.assertEqual(self.tiers(), [])

    # --- held_readings: suppressed readings that the next reading did not confirm ---------------

    def test_loose_probe_writes_one_held_reading_and_no_alert(self):
        self.add("p1", **NORMAL)
        probe = self.add("p1", **LOOSE_PROBE)
        self.worker.poll_once()  # same row polled again: not a next reading
        self.assertEqual(self.held(), [])  # pending: the next reading decides
        self.add("p1", **NORMAL)  # back below "check soon": not confirmed -> written now
        self.add("p1", **NORMAL)
        self.assertEqual(self.tiers(), [])
        self.assertEqual(self.held(), [{
            "patient_id": "p1",
            "encounter_id": "enc-p1",
            "recorded_at": probe["recorded_at"],  # the probe reading's values, not the next one's
            "held_tier": "check soon",  # SpO2 78% scores 3 on its own
            "news2_score": 3,
            "reason": "SpO2 78% (+3)",
        }])

    def test_watch_level_blip_is_not_held(self):
        self.add("p1", **NORMAL)
        self.add("p1", **dict(NORMAL, systolic_mmhg=110))  # NEWS2 1 ("watch") for one reading
        self.add("p1", **NORMAL)
        self.add("p1", **NORMAL)
        self.assertEqual(self.tiers(), [])
        self.assertEqual(self.held(), [])  # only "check soon" / "go now" are stored

    def test_sustained_deterioration_writes_alerts_and_no_held_readings(self):
        for v in (NORMAL, SEPTIC, SEPTIC, SEPTIC):
            self.add("p1", **v)
        self.assertEqual(self.tiers(), ["go now"])
        self.assertEqual(self.held(), [])

    def test_stepwise_escalation_writes_no_held_readings(self):
        # Starts with p1's first-ever reading, which is suppressed too (no history yet).
        for v in (PULSE_91, PULSE_91, SEPTIC, SEPTIC):
            self.add("p1", **v)
        self.assertEqual(self.tiers(), ["watch", "go now"])
        self.assertEqual(self.held(), [])

    def test_partly_confirmed_escalation_holds_the_unconfirmed_tier(self):
        spike = self.add("p1", **SEPTIC)  # "go now" on its own: suppressed
        self.add("p1", **dict(NORMAL, spo2_percent=82))  # "check soon": below "go now"
        self.assertEqual(self.tiers(), ["check soon"])  # both readings reached "check soon"
        self.assertEqual([(h["recorded_at"], h["held_tier"]) for h in self.held()],
                         [(spike["recorded_at"], "go now")])

    def test_simulator_restart_drops_a_pending_held_reading(self):
        self.add("p1", **NORMAL)
        self.add("p1", **LOOSE_PROBE)
        self.tick["p1"] = 0  # sim restarted: clock goes back, p1 starts over
        self.add("p1", **NORMAL)
        self.assertEqual(self.held(), [])

    def test_held_reading_insert_failure_does_not_stop_alerts(self):
        self.db["patients"].append({"id": "p2", "conditions": []})
        self.worker.client = FailingInsertClient(self.db, "held_readings")
        self.put("p1", **SEPTIC)
        self.put("p2", **LOOSE_PROBE)
        self.worker.poll_once()
        # One poll that confirms p1's alert and writes p2's held reading, which fails.
        self.put("p1", **SEPTIC)
        self.put("p2", **NORMAL)
        with self.assertLogs("alert-worker", level="ERROR"):
            self.worker.poll_once()  # logs, doesn't raise
        self.assertEqual(self.tiers(), ["go now"])
        self.assertEqual(self.held(), [])
        self.add("p2", **SEPTIC)  # the worker carries on afterwards
        self.add("p2", **SEPTIC)
        self.assertEqual(self.tiers(), ["go now", "go now"])


if __name__ == "__main__":
    unittest.main()
