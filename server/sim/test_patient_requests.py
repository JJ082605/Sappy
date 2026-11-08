"""Run: python3 -m unittest discover server/sim -v

POST /patient-requests (patient_requests.py, routed by cli.py). No network and no open port: the
HTTP tests run the real request handler in memory (_testutil.call), and Supabase is a fake.

apps/patient-desktop/electron/actions.ts is the source of truth for the categories and labels:
  - MirrorDriftTests parse it and fail if the Python mirror in patient_requests.py has drifted.
  - PatientAppTests run it with Node (skipped if `node` can't run TypeScript: needs Node 22.18+):
    every body the app can send must pass the server's checks and give the same tier and reason,
    and the model's free-text item must map to the right named item.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from patient_requests import (  # noqa: E402
    CATEGORY_LABELS,
    EMERGENCY_LABEL,
    ITEM_CATEGORY_LABEL,
    MAX_BODY_BYTES,
    NAMED_ITEMS,
    NURSE_PRIORITIES,
    NURSE_REASON_LABEL,
    REASON_PREFIX,
    SAFETY_CHECK_SUFFIX,
    SOURCES,
    PatientRequests,
    alert_reason,
    alert_tier,
    bearer_matches,
    parse_request,
)
from supabase_sink import SupabaseSink  # noqa: E402
from test_supabase_sink import FakeClient  # noqa: E402
from vitals_sim import REPO_ROOT  # noqa: E402
from _testutil import call, offline_server, quiet_sim, ward  # noqa: E402

ACTIONS_TS = REPO_ROOT / "apps" / "patient-desktop" / "electron" / "actions.ts"

ITEM = {"patientId": "p0", "type": "item_request", "category": "drink", "item": "water", "source": "assistant"}
NURSE = {"patientId": "p0", "type": "nurse_call", "category": "pain", "priority": "soon", "source": "assistant"}
EMERGENCY = {"patientId": "p0", "type": "emergency", "category": "chest_pain", "source": "safety_check"}

FREE_TEXT = "my name is Jane Doe and my chest hurts"
DROP = object()


def with_(base: dict, **changes) -> dict:
    """A copy of `base` with fields changed, added, or removed (value DROP)."""
    out = {**base, **changes}
    return {k: v for k, v in out.items() if v is not DROP}


def reason(body: dict) -> str:
    return alert_reason(parse_request(body))


def tier(body: dict) -> str:
    return alert_tier(parse_request(body))


class TierAndReasonTests(unittest.TestCase):
    """Same results as alertTier() / alertReason() in actions.ts."""

    def test_item_request(self):
        self.assertEqual((tier(ITEM), reason(ITEM)), ("watch", "Patient request: water"))
        no_item = with_(ITEM, item=DROP)
        self.assertEqual((tier(no_item), reason(no_item)), ("watch", "Patient request: a drink"))

    def test_nurse_call(self):
        self.assertEqual(reason(NURSE), "Patient asked for the nurse: pain or discomfort")
        tiers = {p: tier(with_(NURSE, priority=p)) for p in NURSE_PRIORITIES}
        self.assertEqual(tiers, {"routine": "watch", "soon": "check soon", "urgent": "check soon"})

    def test_emergency(self):
        self.assertEqual(tier(EMERGENCY), "go now")
        self.assertEqual(reason(EMERGENCY), "Patient reported a possible emergency: chest pain (keyword safety check)")
        by_model = with_(EMERGENCY, source="assistant")
        self.assertEqual(reason(by_model), "Patient reported a possible emergency: chest pain")

    def test_safety_check_suffix_only_on_emergencies(self):
        self.assertEqual(reason(with_(NURSE, source="safety_check")), "Patient asked for the nurse: pain or discomfort")

    def test_every_category_is_accepted_and_labelled(self):
        base = {"item_request": with_(ITEM, item=DROP), "nurse_call": NURSE, "emergency": EMERGENCY}
        for kind, labels in CATEGORY_LABELS.items():
            for category, label in labels.items():
                with self.subTest(kind=kind, category=category):
                    r = reason(with_(base[kind], category=category, source="assistant"))
                    self.assertEqual(r, REASON_PREFIX[kind] + label)

    def test_every_named_item_is_accepted(self):
        for item in NAMED_ITEMS:
            self.assertEqual(reason(with_(ITEM, item=item)), f"Patient request: {item}")


class ValidationTests(unittest.TestCase):
    def assertRejected(self, body, *, mentions: str = ""):
        with self.assertRaises(ValueError) as cm:
            parse_request(body)
        if mentions:
            self.assertIn(mentions, str(cm.exception))
        return str(cm.exception)

    def test_valid_bodies(self):
        self.assertEqual(parse_request(NURSE).priority, "soon")
        self.assertEqual(parse_request(ITEM).item, "water")
        self.assertIsNone(parse_request(with_(ITEM, item=DROP)).item)

    def test_body_must_be_an_object(self):
        for body in ([NURSE], "nurse", None, 3):
            self.assertRejected(body, mentions="JSON object")

    def test_type_must_be_known(self):
        self.assertRejected(with_(NURSE, type="room_service"), mentions="type")
        self.assertRejected(with_(NURSE, type=DROP), mentions="type")

    def test_category_must_belong_to_the_type(self):
        self.assertRejected(with_(NURSE, category="drink"), mentions="category")
        self.assertRejected(with_(EMERGENCY, category="pain"), mentions="category")
        self.assertRejected(with_(ITEM, category="chest_pain"), mentions="category")

    def test_unknown_fields_are_rejected_not_ignored(self):
        # What the patient said, and the app's local-only fields, must never be sent.
        for field in ("patientMessage", "detail", "local", "label", "id", "createdAt", "news2_score", "reason"):
            with self.subTest(field=field):
                self.assertRejected(with_(NURSE, **{field: FREE_TEXT}), mentions="only have the fields")

    def test_priority_only_on_nurse_calls(self):
        self.assertRejected(with_(NURSE, priority=DROP), mentions="missing")
        self.assertRejected(with_(NURSE, priority="asap"), mentions="priority")
        self.assertRejected(with_(ITEM, priority="routine"), mentions="only have the fields")
        self.assertRejected(with_(EMERGENCY, priority="emergency"), mentions="only have the fields")

    def test_item_must_be_a_named_item(self):
        # The app maps the model's words to a named item (matchNamedItem in actions.ts); the server
        # only takes the exact allow-listed value, never the phrase itself.
        for phrase in ("a pony", "Water", "orange juice", "a slice of toast", "steak", "ice chips please", "pillows"):
            with self.subTest(item=phrase):
                self.assertRejected(with_(ITEM, item=phrase), mentions="item")
        self.assertRejected(with_(ITEM, item=None), mentions="item")
        self.assertRejected(with_(NURSE, item="water"), mentions="only have the fields")

    def test_source_and_patient_id(self):
        self.assertRejected(with_(NURSE, source="nurse"), mentions="source")
        self.assertRejected(with_(NURSE, source=DROP), mentions="missing")
        self.assertRejected(with_(NURSE, patientId=""), mentions="patientId")
        self.assertRejected(with_(NURSE, patientId=42), mentions="patientId")
        self.assertRejected(with_(NURSE, patientId=DROP), mentions="missing")

    def test_values_must_be_strings(self):
        for bad in (["pain"], {"pain": 1}, 1, True, None):
            with self.subTest(value=bad):
                self.assertRejected(with_(NURSE, category=bad), mentions="category")
                self.assertRejected(with_(NURSE, type=bad), mentions="type")

    def test_errors_never_repeat_the_rejected_value(self):
        for field in ("type", "category", "source", "priority", "patientMessage"):
            with self.subTest(field=field):
                message = self.assertRejected(with_(NURSE, **{field: FREE_TEXT}))
                self.assertNotIn("Jane", message)
        self.assertNotIn("Jane", self.assertRejected(with_(ITEM, item=FREE_TEXT)))


class RecordingSink:
    """Stands in for SupabaseSink.insert_alert. `fail` = how many upcoming inserts raise."""

    def __init__(self, delay: float = 0.0):
        self.rows: List[dict] = []
        self.fail = 0
        self.delay = delay

    def insert_alert(self, row: dict) -> None:
        if self.delay:
            time.sleep(self.delay)
        if self.fail:
            self.fail -= 1
            raise RuntimeError("network down")
        self.rows.append(row)


class EndpointLogicTests(unittest.TestCase):
    """PatientRequests with a fake sink and a fake clock."""

    def setUp(self):
        self.sim = quiet_sim(ward(2))
        self.now = 1000.0
        self.logs: List[str] = []
        self.sink = RecordingSink()
        self.desk = self.make_desk()

    def make_desk(self, token="pt", sink=DROP):
        return PatientRequests(token, self.sink if sink is DROP else sink,
                               lambda pid: self.sim.admission(pid).encounter_id,
                               clock=lambda: self.now, log=self.logs.append)

    def test_writes_one_alert_row(self):
        status, body = self.desk.submit(NURSE)
        reason_ = "Patient asked for the nurse: pain or discomfort"
        self.assertEqual((status, body), (201, {"ok": True, "tier": "check soon", "reason": reason_}))
        self.assertEqual(self.sink.rows, [{
            "patient_id": "p0",
            "encounter_id": self.sim.admission("p0").encounter_id,  # the in-progress encounter on the ward
            "tier": "check soon",
            "news2_score": None,
            "reason": reason_,
        }])
        self.assertEqual(self.logs, ["patient request -> alert [check soon] nurse_call/pain for patient p0"])

    def test_token(self):
        self.assertIsNone(self.desk.authorize("Bearer pt"))
        for header in (None, "", "Bearer", "Bearer ", "Bearer nope", "bearer pt", "Bearer pt ", "pt", "Bearer pté"):
            with self.subTest(header=header):
                self.assertEqual(self.desk.authorize(header)[0], 401)

    def test_disabled_without_token_never_open(self):
        desk = self.make_desk(token="")
        for header in (None, "", "Bearer", "Bearer "):
            with self.subTest(header=header):
                status, body = desk.authorize(header)
                self.assertEqual(status, 503)
                self.assertIn("PATIENT_REQUEST_TOKEN", body["error"])
        self.assertFalse(bearer_matches("Bearer ", ""))

    def test_invalid_body_is_400_and_writes_nothing(self):
        self.assertEqual(self.desk.submit(with_(NURSE, detail=FREE_TEXT))[0], 400)
        self.assertEqual(self.sink.rows, [])

    def test_patient_not_on_ward_is_404(self):
        status, body = self.desk.submit(with_(NURSE, patientId=FREE_TEXT))
        self.assertEqual(status, 404)
        self.assertNotIn("Jane", body["error"])
        self.assertEqual(self.sink.rows, [])

    def test_no_supabase_is_503(self):
        status, body = self.make_desk(sink=None).submit(NURSE)
        self.assertEqual(status, 503)
        self.assertIn("Supabase", body["error"])

    def test_identical_request_within_60s_is_dropped(self):
        self.assertEqual(self.desk.submit(NURSE)[0], 201)
        self.now += 30
        self.assertEqual(self.desk.submit(NURSE), (200, {"ok": True, "duplicate": True}))
        self.now += 29.9  # 59.9 s after the alert was written
        self.assertEqual(self.desk.submit(NURSE)[0], 200)
        self.now += 0.1  # the window counts from the alert written, not from the repeats
        self.assertEqual(self.desk.submit(NURSE)[0], 201)
        self.assertEqual(len(self.sink.rows), 2)

    def test_duplicate_means_same_patient_type_and_category(self):
        self.assertEqual(self.desk.submit(NURSE)[0], 201)
        self.assertEqual(self.desk.submit(with_(NURSE, patientId="p1"))[0], 201)
        self.assertEqual(self.desk.submit(with_(NURSE, category="bathroom"))[0], 201)
        self.assertEqual(self.desk.submit(with_(NURSE, priority="urgent"))[0], 200)  # same tier
        self.assertEqual(self.desk.submit(with_(NURSE, source="safety_check"))[0], 200)
        self.assertEqual(self.desk.submit(ITEM)[0], 201)
        self.assertEqual(self.desk.submit(with_(ITEM, item="juice"))[0], 200)  # also a drink
        self.assertEqual(len(self.sink.rows), 4)

    def test_a_more_urgent_repeat_still_goes_through(self):
        routine = with_(NURSE, priority="routine")
        self.assertEqual(self.desk.submit(routine)[0], 201)  # watch
        self.assertEqual(self.desk.submit(NURSE)[0], 201)  # soon: check soon
        self.assertEqual(self.desk.submit(routine)[0], 200)
        self.assertEqual(self.desk.submit(with_(NURSE, priority="urgent"))[0], 200)
        self.assertEqual([r["tier"] for r in self.sink.rows], ["watch", "check soon"])

    def test_failed_insert_is_502_and_a_retry_is_not_a_duplicate(self):
        self.sink.fail = 1
        status, body = self.desk.submit(EMERGENCY)
        self.assertEqual(status, 502)
        self.assertIn("insert failed", self.logs[-1])
        self.assertEqual(self.desk.submit(EMERGENCY)[0], 201)
        self.assertEqual(len(self.sink.rows), 1)

    def test_simultaneous_identical_requests_write_one_alert(self):
        self.sink.delay = 0.05  # widen the race window
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.desk.submit(EMERGENCY))) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(5)
        self.assertEqual(sorted(status for status, _ in results), [200] * 7 + [201])
        self.assertEqual(len(self.sink.rows), 1)


class HttpTests(unittest.TestCase):
    """The real request handler, run in memory (no port): routing, tokens, the Supabase insert."""

    def start(self, **kwargs):
        server = offline_server(quiet_sim(ward(2)), **kwargs)
        server.patient_requests.log = self.logs.append
        self.addCleanup(server.server_close)
        return server

    def setUp(self):
        self.logs: List[str] = []
        self.client = FakeClient()
        self.server = self.start(sink=SupabaseSink(self.client), control_token="ctl", patient_request_token="pt")

    def post(self, body, token="pt", path="/patient-requests", server=None):
        headers = {"Authorization": f"Bearer {token}"} if token is not None else {}
        return call(server or self.server, "POST", path, body, headers)

    def test_request_becomes_an_alerts_insert(self):
        status, body, _ = self.post(EMERGENCY)
        self.assertEqual((status, body["tier"]), (201, "go now"))
        self.assertEqual(self.client.log, [{
            "table": "alerts",
            "op": "insert",
            "data": {"patient_id": "p0", "encounter_id": self.server.sim.admission("p0").encounter_id,
                     "tier": "go now", "news2_score": None,
                     "reason": "Patient reported a possible emergency: chest pain (keyword safety check)"},
            "filters": [],
            "kwargs": {"returning": "minimal"},
        }])
        self.assertEqual(self.post(EMERGENCY)[:2], (200, {"ok": True, "duplicate": True}))
        self.assertEqual(len(self.client.log), 1)
        self.assertEqual(self.logs, ["patient request -> alert [go now] emergency/chest_pain for patient p0"])

    def test_tokens_are_not_interchangeable(self):
        self.assertEqual(self.post(NURSE, token="ctl")[0], 401)
        self.assertEqual(self.post(NURSE, token=None)[0], 401)
        oxygen = "/patients/p0/oxygen"
        self.assertEqual(self.post({"on": True}, token="pt", path=oxygen)[0], 401)  # can't run demo controls
        self.assertEqual(self.post({"on": True}, token="ctl", path=oxygen)[0], 200)
        self.assertEqual(self.client.log, [])

    def test_disabled_without_token_even_when_demo_controls_are_open(self):
        server = self.start(sink=SupabaseSink(FakeClient()))  # no tokens at all
        for token in (None, "", "anything"):
            status, body, _ = self.post(NURSE, token=token, server=server)
            self.assertEqual(status, 503)
            self.assertIn("disabled", body["error"])
        self.assertEqual(self.post({"on": True}, token=None, path="/patients/p0/oxygen", server=server)[0], 200)

    def test_rejected_before_reading_the_body_closes_the_connection(self):
        status, _, headers = self.post(NURSE, token="nope")
        self.assertEqual((status, headers.get("Connection")), (401, "close"))
        status, _, headers = self.post(b"x" * (MAX_BODY_BYTES + 1))
        self.assertEqual((status, headers.get("Connection")), (413, "close"))

    def test_bad_requests(self):
        self.assertEqual(self.post(b"{not json")[0], 400)
        self.assertEqual(self.post(b"\xff\xfe")[0], 400)
        self.assertEqual(self.post(b"")[0], 400)
        self.assertEqual(self.post(with_(NURSE, category="room_service"))[0], 400)
        self.assertEqual(self.post(with_(NURSE, patientId="nope"))[0], 404)
        self.assertEqual(self.post(NURSE, path="/patient-requests/p0")[0], 404)
        self.assertEqual(call(self.server, "GET", "/patient-requests")[0], 404)
        self.assertEqual(self.client.log, [])

    def test_no_supabase_is_503(self):
        server = self.start(patient_request_token="pt")
        status, body, _ = self.post(NURSE, server=server)
        self.assertEqual(status, 503)
        self.assertIn("Supabase", body["error"])


# ------------------------------------------------------------------------------------------------
# Drift: actions.ts (source of truth) vs the mirror in patient_requests.py
# ------------------------------------------------------------------------------------------------

FIX = ("update the mirror in server/sim/patient_requests.py to match "
       "apps/patient-desktop/electron/actions.ts (the source of truth), or vice versa")
_STRING = r"'([^'\\]*)'"  # a plain single-quoted TS string


def _leftover_check(name: str, inner: str, item_pattern: str) -> None:
    """Fail loudly if a TS literal has anything the simple parsers below don't understand."""
    leftover = re.sub(item_pattern, "", re.sub(r"//[^\n]*", "", inner))
    if leftover.strip(" \t\n,"):
        raise AssertionError(f"couldn't parse {name} (plain 'single-quoted' strings only); "
                             f"update test_patient_requests.py's parser. Unparsed: {leftover.strip()!r}")


def ts_string_list(src: str, name: str) -> List[str]:
    """`const NAME = ['a', 'b'] as const` -> ['a', 'b']"""
    m = re.search(rf"\bconst {name}\b[^=]*=\s*\[(.*?)\]", src, re.S)
    if not m:
        raise AssertionError(f"const {name} = [...] not found")
    _leftover_check(name, m.group(1), _STRING)
    return re.findall(_STRING, re.sub(r"//[^\n]*", "", m.group(1)))


def ts_string_record(src: str, name: str) -> Dict[str, str]:
    """`const NAME: Record<K, string> = { a: 'x', 'b c': 'y' }` -> {'a': 'x', 'b c': 'y'}"""
    m = re.search(rf"\bconst {name}\b[^=]*=\s*\{{(.*?)\}}", src, re.S)
    if not m:
        raise AssertionError(f"const {name} = {{...}} not found")
    entry = rf"(?:{_STRING}|(\w+))\s*:\s*{_STRING}"
    _leftover_check(name, m.group(1), entry)
    return {quoted or bare: value for quoted, bare, value in re.findall(entry, re.sub(r"//[^\n]*", "", m.group(1)))}


def ts_function_body(src: str, name: str) -> str:
    m = re.search(rf"\bfunction {name}\(.*?\n\}}", src, re.S)
    if not m:
        raise AssertionError(f"function {name}() not found")
    return m.group(0)


def ts_union(src: str, pattern: str) -> List[str]:
    """String literals of the first union type matched by `pattern` + a union, e.g. "source: "."""
    m = re.search(pattern + r"((?:'\w+'(?:\s*\|\s*)?)+)", src)
    if not m:
        raise AssertionError(f"union type {pattern!r} not found")
    return re.findall(_STRING, m.group(1))


class MirrorDriftTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = ACTIONS_TS.read_text(encoding="utf-8")

    def test_category_labels(self):
        for categories, labels, mirror in (
            ("ITEM_CATEGORIES", "ITEM_CATEGORY_LABEL", ITEM_CATEGORY_LABEL),
            ("NURSE_REASONS", "NURSE_REASON_LABEL", NURSE_REASON_LABEL),
            ("EMERGENCY_KINDS", "EMERGENCY_LABEL", EMERGENCY_LABEL),
        ):
            with self.subTest(labels=labels):
                self.assertEqual(ts_string_record(self.src, labels), mirror, f"{labels} drifted: {FIX}")
                self.assertEqual(sorted(ts_string_list(self.src, categories)), sorted(mirror),
                                 f"{categories} drifted: {FIX}")

    def test_named_items(self):
        self.assertEqual(sorted(ts_string_list(self.src, "NAMED_ITEMS")), sorted(NAMED_ITEMS), f"NAMED_ITEMS drifted: {FIX}")

    def test_reason_prefixes_and_safety_check_suffix(self):
        body = ts_function_body(self.src, "alertReason")
        prefixes = dict(re.findall(r"case '(\w+)':\s*return `([^`$]*)\$\{action\.label\}`", body))
        self.assertEqual(prefixes, REASON_PREFIX, f"alertReason() prefixes drifted: {FIX}")
        emergency = re.search(r"case 'emergency':\s*return ([^\n]*)", body)
        self.assertIsNotNone(emergency, "alertReason() has no emergency case")
        suffix = re.findall(rf"action\.source === 'safety_check' \? {_STRING} : ''", emergency.group(1))
        self.assertEqual(suffix, [SAFETY_CHECK_SUFFIX], f"alertReason() safety-check suffix drifted: {FIX}")

    def test_tier_rules(self):
        body = ts_function_body(self.src, "alertTier")
        rules = re.findall(rf"if \(([^)]*)\) return {_STRING}", body)
        self.assertEqual(rules, [
            ("action.type === 'emergency'", "go now"),
            ("action.type === 'nurse_call' && action.priority !== 'routine'", "check soon"),
        ], f"alertTier() changed: update alert_tier() in server/sim/patient_requests.py and this test")
        self.assertRegex(body, r"\n\s*return 'watch'\n\}$", "alertTier() changed: update alert_tier() too")

    def test_priorities_and_sources(self):
        self.assertEqual(ts_union(self.src, r"type: 'nurse_call'; priority: "), list(NURSE_PRIORITIES),
                         f"nurse_call priorities drifted: {FIX}")
        self.assertEqual(ts_union(self.src, r"\bsource: "), list(SOURCES), f"action sources drifted: {FIX}")


# ------------------------------------------------------------------------------------------------
# The patient app's own code (actions.ts), run with Node
# ------------------------------------------------------------------------------------------------

_node: Optional[str] = None


def node_for_typescript() -> Optional[str]:
    """A `node` that can import .ts files (type stripping, Node 22.18+ / 23.6+), or None."""
    global _node
    if _node is None:
        found = shutil.which("node")
        try:
            probe = found and subprocess.run([found, "-p", "process.features.typescript"],
                                             capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.SubprocessError):
            probe = None
        _node = found if probe and probe.returncode == 0 and probe.stdout.strip() in ("strip", "transform") else ""
    return _node or None


def run_actions_ts(script: str, data: Any) -> Any:
    """Run `script` as an ES module with `actions` = actions.ts and `data` = the given JSON value.
    The script prints one JSON value, which is returned."""
    prelude = (f"import * as actions from {json.dumps(ACTIONS_TS.as_uri())}\n"
               "const data = JSON.parse(process.argv[1])\n")
    out = subprocess.run([node_for_typescript(), "--input-type=module", "-e", prelude + script, json.dumps(data)],
                         capture_output=True, text=True, timeout=60, cwd=str(REPO_ROOT))
    if out.returncode != 0:
        raise AssertionError(f"node failed running actions.ts:\n{out.stderr}")
    return json.loads(out.stdout)


class PatientAppTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not node_for_typescript():
            raise unittest.SkipTest("needs a `node` that runs TypeScript (Node 22.18+ or 23.6+)")

    def test_every_body_the_app_sends_passes_the_server_and_gives_the_same_alert(self):
        script = """
const specs = []
for (const source of ['assistant', 'safety_check']) {
  for (const category of actions.ITEM_CATEGORIES) {
    specs.push([{ type: 'item_request', category }, source])
    specs.push([{ type: 'item_request', category, item: 'a big glass of water' }, source])
  }
  for (const category of actions.NURSE_REASONS)
    for (const priority of ['routine', 'soon', 'urgent']) specs.push([{ type: 'nurse_call', category, priority }, source])
  for (const category of actions.EMERGENCY_KINDS) specs.push([{ type: 'emergency', category }, source])
}
for (const item of actions.NAMED_ITEMS) specs.push([{ type: 'item_request', category: 'other', item }, 'assistant'])
console.log(JSON.stringify(specs.map(([spec, source]) => {
  const a = actions.createAction(spec, { patientId: 'p0', source, patientMessage: data, detail: data })
  return { body: actions.toRequestBody(a), tier: actions.alertTier(a), reason: actions.alertReason(a) }
})))
"""
        results = run_actions_ts(script, FREE_TEXT)
        self.assertGreater(len(results), 100)
        for r in results:
            with self.subTest(body=r["body"]):
                self.assertNotIn("Jane", json.dumps(r["body"]))  # the patient's words stay on the device
                req = parse_request(r["body"])  # raises if the server would reject what the app sends
                self.assertEqual((alert_tier(req), alert_reason(req)), (r["tier"], r["reason"]))
        sent_items = {r["body"].get("item") for r in results}
        self.assertEqual(sent_items - {None}, set(NAMED_ITEMS))  # every named item maps to itself

    def test_no_patient_id_means_nothing_to_send(self):
        script = """
const a = actions.createAction({ type: 'emergency', category: 'fall' }, { patientId: null, source: 'assistant', patientMessage: '' })
console.log(JSON.stringify(actions.toRequestBody(a)))
"""
        self.assertIsNone(run_actions_ts(script, None))

    def test_named_items_match_whole_words_longest_first(self):
        cases = {  # what the model wrote -> the named item the nurse sees (None: the category label)
            "orange juice": "juice",
            "a slice of toast": None,  # not "ice"
            "steak": None,  # not "tea"
            "ice chips": "ice chips",  # not "ice"
            "some ice chips please": "ice chips",
            "a cup of ice": "ice",
            "iced tea": "tea",
            "teapot": None,
            "Water": "water",
            "extra pillows": "pillow",
            "toothbrushes": "toothbrush",
            "TV-remote": "tv remote",
            "my reading glasses": "reading glasses",
            "glasses": None,
            "": None,
        }
        script = """
console.log(JSON.stringify(data.map((item) => {
  const a = actions.createAction({ type: 'item_request', category: 'other', item }, { patientId: null, source: 'assistant', patientMessage: '' })
  return [a.item ?? null, a.label]
})))
"""
        got = dict(zip(cases, run_actions_ts(script, list(cases))))
        expected = {text: [item, item or ITEM_CATEGORY_LABEL["other"]] for text, item in cases.items()}
        self.assertEqual(got, expected)


if __name__ == "__main__":
    unittest.main()
