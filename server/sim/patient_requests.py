"""Requests from Sappy, the patient's bedside assistant (apps/patient-desktop), turned into `alerts` rows.

The patient app sends each action it takes to the simulator server (cli.py), and this module owns
the mapping to an alert:

    POST /patient-requests
    Authorization: Bearer <PATIENT_REQUEST_TOKEN>
    {"patientId": "8398b128-...", "type": "nurse_call", "category": "pain", "priority": "soon",
     "source": "assistant"}

    type          category                     extra field
    item_request  a key of ITEM_CATEGORY_LABEL "item": one of NAMED_ITEMS (optional)
    nurse_call    a key of NURSE_REASON_LABEL  "priority": "routine" | "soon" | "urgent" (required)
    emergency     a key of EMERGENCY_LABEL     -
    every type:   "patientId" (a patient on the simulator's ward), "source": "assistant" | "safety_check"

Privacy (CLAUDE.md): a request carries only the pseudonymous patient id and fixed values, never what
the patient said. Anything outside the allow-lists, including unknown fields, is rejected (400)
rather than ignored, so a client that tries to send free text fails loudly. Error messages never
repeat the rejected value. The alert's tier and reason are rebuilt here from the fixed values.

Responses (JSON):
    201 {"ok": true, "tier": ..., "reason": ...}  alert written (news2_score null)
    200 {"ok": true, "duplicate": true}  same patient + type + category already written in the
        last DUPLICATE_WINDOW_SEC: not repeated (alert fatigue). A more urgent repeat (a routine
        nurse call followed by an urgent one) still goes through.
    400 invalid body   401 missing or wrong token   404 patient not on the ward   413 body too large
    502 the Supabase insert failed (nothing recorded, so a retry isn't treated as a duplicate)
    503 PATIENT_REQUEST_TOKEN isn't set (endpoint disabled, never open), or Supabase isn't configured

PATIENT_REQUEST_TOKEN is separate from SIM_CONTROL_TOKEN, so a patient device can never trigger
demo scenarios.

Standard library only; Python 3.9+.
"""

from __future__ import annotations

import hmac
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Tuple

# Identical requests (same patient, type and category) within this many real seconds are dropped.
DUPLICATE_WINDOW_SEC = 60.0

# A request is about 200 bytes; anything much bigger isn't one.
MAX_BODY_BYTES = 4096

TIER_RANK = {"watch": 1, "check soon": 2, "go now": 3}

# =================================================================================================
# MIRROR of apps/patient-desktop/electron/actions.ts, which is the SOURCE OF TRUTH.
# Change both files together: test_patient_requests.py parses (and runs) actions.ts and fails if
# anything below drifts. The nurse dashboard parses the reasons too (apps/nurse-web/src/lib/alerts.ts,
# checked against actions.ts by its own tests), so they must stay byte-identical to alertReason().
# =================================================================================================

# ITEM_CATEGORIES -> ITEM_CATEGORY_LABEL
ITEM_CATEGORY_LABEL = {
    "drink": "a drink",
    "food": "food",
    "comfort": "a comfort item",
    "hygiene": "a hygiene item",
    "other": "an item",
}

# NURSE_REASONS -> NURSE_REASON_LABEL
NURSE_REASON_LABEL = {
    "bathroom": "help to the bathroom",
    "pain": "pain or discomfort",
    "mobility": "help moving or getting up",
    "equipment": "equipment alarm or problem",
    "medication": "a medication question",
    "comfort": "comfort or repositioning",
    "talk": "wants to talk to the nurse",
    "other": "needs the nurse",
}

# EMERGENCY_KINDS -> EMERGENCY_LABEL
EMERGENCY_LABEL = {
    "chest_pain": "chest pain",
    "breathing": "trouble breathing",
    "fall": "a fall",
    "stroke_signs": "possible stroke signs",
    "bleeding": "heavy bleeding",
    "seizure": "a seizure",
    "fainting": "fainting or about to faint",
    "severe_pain": "sudden severe pain",
    "self_harm": "thoughts of self-harm",
    "other": "other symptoms",
}

# NAMED_ITEMS: items an item request may name. Otherwise it's reported by its category label.
NAMED_ITEMS = (
    "ice chips", "water", "ice", "juice", "coffee", "tea", "milk", "snack", "meal", "blanket", "pillow",
    "tissues", "towel", "toothbrush", "toothpaste", "lip balm", "socks", "reading glasses", "phone charger",
    "tv remote",
)

# PatientAction: a nurse call's priority, and who decided on the action.
NURSE_PRIORITIES = ("routine", "soon", "urgent")
SOURCES = ("assistant", "safety_check")

# alertReason(): prefix + label, and the suffix on emergencies raised by the keyword safety check.
REASON_PREFIX = {
    "item_request": "Patient request: ",
    "nurse_call": "Patient asked for the nurse: ",
    "emergency": "Patient reported a possible emergency: ",
}
SAFETY_CHECK_SUFFIX = " (keyword safety check)"

# alertTier() is mirrored by alert_tier() below.

# =================================================================================================
# end of mirror
# =================================================================================================

CATEGORY_LABELS = {"item_request": ITEM_CATEGORY_LABEL, "nurse_call": NURSE_REASON_LABEL, "emergency": EMERGENCY_LABEL}

# Fields every request has, and the extra ones per type: name -> (allowed values, required).
COMMON_FIELDS = ("patientId", "type", "category", "source")
EXTRA_FIELDS: Dict[str, Dict[str, Tuple[Tuple[str, ...], bool]]] = {
    "item_request": {"item": (NAMED_ITEMS, False)},
    "nurse_call": {"priority": (NURSE_PRIORITIES, True)},
    "emergency": {},
}


@dataclass(frozen=True)
class PatientRequest:
    """A validated request: allow-listed values only, never free text."""

    patient_id: str  # pseudonymous Patient.id
    type: str  # "item_request" | "nurse_call" | "emergency"
    category: str  # a key of CATEGORY_LABELS[type]
    source: str  # "assistant" | "safety_check"
    priority: Optional[str] = None  # nurse_call only
    item: Optional[str] = None  # item_request only, one of NAMED_ITEMS


def _one_of(value: Any, allowed: Any) -> bool:
    return isinstance(value, str) and value in allowed


def parse_request(body: Any) -> PatientRequest:
    """Check a decoded JSON body against the allow-lists. Raises ValueError (-> 400) naming the
    field, but never repeating the rejected value, which could be free text."""
    if not isinstance(body, dict):
        raise ValueError("body must be a JSON object")
    kind = body.get("type")
    if not _one_of(kind, CATEGORY_LABELS):
        raise ValueError(f"type must be one of {list(CATEGORY_LABELS)}")
    extra = EXTRA_FIELDS[kind]
    allowed = (*COMMON_FIELDS, *extra)
    if any(key not in allowed for key in body):
        raise ValueError(f"a {kind} may only have the fields {list(allowed)}: fixed values, never free text")
    missing = [f for f in (*COMMON_FIELDS, *(n for n, (_, required) in extra.items() if required)) if f not in body]
    if missing:
        raise ValueError(f"missing field(s) for {kind}: {missing}")

    patient_id = body["patientId"]
    if not isinstance(patient_id, str) or not patient_id:
        raise ValueError("patientId must be a non-empty string")
    labels = CATEGORY_LABELS[kind]
    if not _one_of(body["category"], labels):
        raise ValueError(f"category for {kind} must be one of {list(labels)}")
    if not _one_of(body["source"], SOURCES):
        raise ValueError(f"source must be one of {list(SOURCES)}")
    for name, (values, required) in extra.items():
        if name in body and not _one_of(body[name], values):
            raise ValueError(f"{name} must be one of {list(values)}" + ("" if required else ", or left out"))
    return PatientRequest(patient_id, kind, body["category"], body["source"], body.get("priority"), body.get("item"))


def alert_tier(req: PatientRequest) -> str:
    """Mirror of alertTier(): the NEWS2 tier scale, so the dashboard sorts requests with vitals alerts."""
    if req.type == "emergency":
        return "go now"
    if req.type == "nurse_call" and req.priority != "routine":
        return "check soon"
    return "watch"


def alert_label(req: PatientRequest) -> str:
    """Mirror of the action `label` set by createAction(): the named item, else the category label."""
    if req.type == "item_request" and req.item:
        return req.item
    return CATEGORY_LABELS[req.type][req.category]


def alert_reason(req: PatientRequest) -> str:
    """Mirror of alertReason(): built only from fixed labels, never patient free text."""
    reason = REASON_PREFIX[req.type] + alert_label(req)
    if req.type == "emergency" and req.source == "safety_check":
        reason += SAFETY_CHECK_SUFFIX
    return reason


def bearer_matches(authorization: Optional[str], token: str) -> bool:
    """Constant-time check of an `Authorization: Bearer <token>` header. Always False for an empty token."""
    if not token:
        return False
    given = (authorization or "").encode("utf-8", "replace")
    return hmac.compare_digest(given, f"Bearer {token}".encode("utf-8", "replace"))


def _print(line: str) -> None:
    print(line, flush=True)


class PatientRequests:
    """POST /patient-requests without the HTTP: token check, validation, duplicate guard, `alerts` insert.

    Thread-safe: the server handles each request on its own thread.
    """

    def __init__(
        self,
        token: str,
        sink: Any,
        encounter_id: Callable[[str], str],
        window_sec: float = DUPLICATE_WINDOW_SEC,
        clock: Callable[[], float] = time.monotonic,
        log: Callable[[str], None] = _print,
    ) -> None:
        """
        :param token: PATIENT_REQUEST_TOKEN; empty disables the endpoint (it is never open)
        :param sink: anything with insert_alert(row), e.g. SupabaseSink; None if Supabase isn't configured
        :param encounter_id: patient id -> their in-progress encounter id; KeyError if not on the ward
        """
        self.token = token
        self.sink = sink
        self.encounter_id = encounter_id
        self.window_sec = window_sec
        self.clock = clock
        self.log = log
        self._lock = threading.Lock()  # makes the duplicate check + insert atomic
        self._written: Dict[Tuple[str, str, str], Tuple[float, str]] = {}  # (patient, type, category) -> (time, tier)

    def authorize(self, authorization: Optional[str]) -> Optional[Tuple[int, dict]]:
        """None if the request may go ahead, else the (status, body) to answer with."""
        if not self.token:
            return 503, {"error": "patient requests are disabled: PATIENT_REQUEST_TOKEN isn't set on the simulator"}
        if not bearer_matches(authorization, self.token):
            return 401, {"error": "missing or wrong Authorization: Bearer <PATIENT_REQUEST_TOKEN>"}
        return None

    def submit(self, body: Any) -> Tuple[int, dict]:
        """Validate an authorized request's decoded JSON body and write its alert. Returns (status, body)."""
        try:
            req = parse_request(body)
        except ValueError as e:
            return 400, {"error": str(e)}
        try:
            encounter_id = self.encounter_id(req.patient_id)
        except KeyError:
            return 404, {"error": "patientId is not a patient on the simulator's ward (check PATIENT_ID on the device)"}
        if self.sink is None:
            return 503, {"error": "Supabase isn't configured on the simulator (SUPABASE_URL + SUPABASE_SECRET_KEY), "
                                  "so the request can't reach the nurses"}

        tier, reason = alert_tier(req), alert_reason(req)
        key = (req.patient_id, req.type, req.category)
        with self._lock:
            now = self.clock()
            self._written = {k: v for k, v in self._written.items() if now - v[0] < self.window_sec}
            earlier = self._written.get(key)
            if earlier is not None and TIER_RANK[tier] <= TIER_RANK[earlier[1]]:
                return 200, {"ok": True, "duplicate": True}
            row = {"patient_id": req.patient_id, "encounter_id": encounter_id, "tier": tier,
                   "news2_score": None, "reason": reason}
            try:
                self.sink.insert_alert(row)
            except Exception as e:  # network or database error: report it, record nothing
                self.log(f"supabase: patient request alert insert failed: {e}")
                return 502, {"error": "couldn't write the alert to Supabase, so it wasn't delivered; try again"}
            self._written[key] = (now, tier)
        self.log(f"patient request -> alert [{tier}] {req.type}/{req.category} for patient {req.patient_id}")
        return 201, {"ok": True, "tier": tier, "reason": reason}
