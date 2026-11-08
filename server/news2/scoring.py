"""NEWS2 (National Early Warning Score 2, Royal College of Physicians 2017) - plain local scoring.

No model, no dependencies: each of the 7 inputs is scored 0-3 from the NEWS2 chart, summed, and
mapped to a clinical risk band and our alert tier. A small persistence rule on top (News2Monitor)
stops a single implausible reading - e.g. a loose SpO2 probe - from escalating an alert.

Standard library only; Python 3.9+.

    from scoring import News2Monitor, score_reading

    result = score_reading(reading)                  # one reading -> News2Result
    monitor = News2Monitor.from_patients(sim.patients)
    for readings in sim.stream(...):
        for r in readings:
            out = monitor.update(r)                  # -> MonitorResult (confirmed tier)

Readings are the dicts produced by server/sim/vitals_sim.py (camelCase keys).
"""

from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Dict, Iterable, List, Optional

# Keys NEWS2 scores, as they appear in simulator readings.
NEWS2_INPUTS = (
    "respiratoryRate",
    "spo2Percent",
    "onOxygen",
    "systolicMmHg",
    "heartRateBpm",
    "consciousness",
    "temperatureC",
)
CONSCIOUSNESS_LEVELS = ("A", "C", "V", "P", "U")

# Alert tiers, lowest to highest.
TIERS = ("none", "watch", "check soon", "go now")
_TIER_RANK = {t: i for i, t in enumerate(TIERS)}

# NEWS2 clinical risk -> recommended response (RCP 2017, abbreviated).
RESPONSES = {
    "low": "Routine monitoring; ward nurse to assess.",
    "low-medium": "Urgent ward-based review by a clinician (single parameter scored 3).",
    "medium": "Urgent review by a clinician skilled in acute illness; at least hourly observations.",
    "high": "Emergency assessment by a critical care team; continuous monitoring.",
}

# SpO2 Scale 2 is for patients with (or at risk of) hypercapnic respiratory failure, with a
# prescribed target of 88-92%. COPD is the common case. Asthma is deliberately NOT included.
_HYPERCAPNIC_RISK = re.compile(
    r"copd|chronic obstructive|emphysema|hypercapni|chronic respiratory failure|obesity hypoventilation",
    re.I,
)


# ------------------------------------------------------------------------------------------------
# Per-parameter scores
#
# Each band is "value <= upper edge", so values between chart rows (e.g. 38.05 C) fall into the
# next band up rather than slipping through.
# ------------------------------------------------------------------------------------------------

def score_respiratory_rate(rr: float) -> int:
    if rr <= 8:
        return 3
    if rr <= 11:
        return 1
    if rr <= 20:
        return 0
    if rr <= 24:
        return 2
    return 3


def score_spo2_scale1(spo2: float) -> int:
    if spo2 <= 91:
        return 3
    if spo2 <= 93:
        return 2
    if spo2 <= 95:
        return 1
    return 0


def score_spo2_scale2(spo2: float, on_oxygen: bool) -> int:
    if spo2 <= 83:
        return 3
    if spo2 <= 85:
        return 2
    if spo2 <= 87:
        return 1
    if spo2 <= 92 or not on_oxygen:  # 88-92 is the target range; >=93 on air is fine
        return 0
    if spo2 <= 94:  # above target while on oxygen -> risk of over-oxygenation
        return 1
    if spo2 <= 96:
        return 2
    return 3


def score_air_or_oxygen(on_oxygen: bool) -> int:
    return 2 if on_oxygen else 0


def score_systolic(sbp: float) -> int:
    if sbp <= 90:
        return 3
    if sbp <= 100:
        return 2
    if sbp <= 110:
        return 1
    if sbp <= 219:
        return 0
    return 3


def score_pulse(hr: float) -> int:
    if hr <= 40:
        return 3
    if hr <= 50:
        return 1
    if hr <= 90:
        return 0
    if hr <= 110:
        return 1
    if hr <= 130:
        return 2
    return 3


def score_consciousness(level: str) -> int:
    if level not in CONSCIOUSNESS_LEVELS:
        raise ValueError(f"unknown consciousness level {level!r}; expected one of {CONSCIOUSNESS_LEVELS}")
    return 0 if level == "A" else 3


def score_temperature(temp: float) -> int:
    if temp <= 35.0:
        return 3
    if temp <= 36.0:
        return 1
    if temp <= 38.0:
        return 0
    if temp <= 39.0:
        return 1
    return 2


# ------------------------------------------------------------------------------------------------
# Aggregate
# ------------------------------------------------------------------------------------------------

def spo2_scale_for(conditions: Iterable[str]) -> int:
    """2 if any condition indicates hypercapnic respiratory failure risk (e.g. COPD), else 1."""
    return 2 if any(_HYPERCAPNIC_RISK.search(c) for c in conditions) else 1


def risk_for(total: int, any_three: bool) -> str:
    if total >= 7:
        return "high"
    if total >= 5:
        return "medium"
    if any_three:
        return "low-medium"
    return "low"


def tier_for(total: int, risk: str) -> str:
    if risk == "high":
        return "go now"
    if risk in ("medium", "low-medium"):
        return "check soon"
    return "watch" if total >= 1 else "none"


@dataclass(frozen=True)
class News2Result:
    patient_id: Optional[str]
    recorded_at: Optional[str]
    total: int
    scores: Dict[str, int]  # per NEWS2 input key
    spo2_scale: int
    risk: str  # "low" | "low-medium" | "medium" | "high"
    tier: str  # "none" | "watch" | "check soon" | "go now"
    reasons: List[str]  # plain-language, one per non-zero input, highest score first

    @property
    def response(self) -> str:
        return RESPONSES[self.risk]

    def to_json(self) -> dict:
        return {
            "patientId": self.patient_id,
            "recordedAt": self.recorded_at,
            "total": self.total,
            "scores": dict(self.scores),
            "spo2Scale": self.spo2_scale,
            "risk": self.risk,
            "tier": self.tier,
            "reasons": list(self.reasons),
            "response": self.response,
        }


def score_reading(reading: dict, spo2_scale: int = 1) -> News2Result:
    """Score one reading. Raises ValueError if a NEWS2 input is missing or invalid."""
    if spo2_scale not in (1, 2):
        raise ValueError(f"spo2_scale must be 1 or 2, got {spo2_scale!r}")
    missing = [k for k in NEWS2_INPUTS if reading.get(k) is None]
    if missing:
        raise ValueError(f"reading is missing NEWS2 inputs: {missing}")
    if not isinstance(reading["onOxygen"], bool):
        raise ValueError(f"onOxygen must be true/false, got {reading['onOxygen']!r}")

    r = reading
    on_o2 = r["onOxygen"]
    scores = {
        "respiratoryRate": score_respiratory_rate(r["respiratoryRate"]),
        "spo2Percent": (
            score_spo2_scale2(r["spo2Percent"], on_o2) if spo2_scale == 2 else score_spo2_scale1(r["spo2Percent"])
        ),
        "onOxygen": score_air_or_oxygen(on_o2),
        "systolicMmHg": score_systolic(r["systolicMmHg"]),
        "heartRateBpm": score_pulse(r["heartRateBpm"]),
        "consciousness": score_consciousness(r["consciousness"]),
        "temperatureC": score_temperature(r["temperatureC"]),
    }
    total = sum(scores.values())
    risk = risk_for(total, any(s == 3 for s in scores.values()))
    return News2Result(
        patient_id=r.get("patientId"),
        recorded_at=r.get("recordedAt"),
        total=total,
        scores=scores,
        spo2_scale=spo2_scale,
        risk=risk,
        tier=tier_for(total, risk),
        reasons=_reasons(r, scores, spo2_scale),
    )


def _reasons(r: dict, scores: Dict[str, int], spo2_scale: int) -> List[str]:
    labels = {
        "respiratoryRate": f"Respiratory rate {r['respiratoryRate']}/min",
        "spo2Percent": f"SpO2 {r['spo2Percent']}%" + (" (Scale 2)" if spo2_scale == 2 else ""),
        "onOxygen": "On supplemental oxygen",
        "systolicMmHg": f"Systolic BP {r['systolicMmHg']} mmHg",
        "heartRateBpm": f"Pulse {r['heartRateBpm']} bpm",
        "consciousness": f"Consciousness {r['consciousness']} (not alert)",
        "temperatureC": f"Temperature {r['temperatureC']} °C",
    }
    nonzero = sorted((k for k in NEWS2_INPUTS if scores[k]), key=lambda k: -scores[k])
    return [f"{labels[k]} (+{scores[k]})" for k in nonzero]


# ------------------------------------------------------------------------------------------------
# Persistence rule: fewer, better alerts
# ------------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class MonitorResult:
    news2: News2Result  # score of this reading alone
    alert_tier: str  # confirmed tier (see News2Monitor)
    suppressed: bool  # True when this reading alone would alert higher than alert_tier
    confirmed_score: int = 0  # NEWS2 total, confirmed by the same rule as alert_tier
    confirmed_scores: Dict[str, int] = field(default_factory=dict)  # each NEWS2 input, same rule

    def to_json(self) -> dict:
        return {**self.news2.to_json(), "alertTier": self.alert_tier, "suppressed": self.suppressed}


@dataclass
class _PatientHistory:
    spo2_scale: int = 1
    recent: Deque[News2Result] = field(default_factory=deque)  # the last `window` readings' scores


class News2Monitor:
    """Scores readings per patient and only escalates once a tier is confirmed.

    A tier is confirmed when the latest reading reaches it and so do at least `confirm_readings`
    of the last `window` readings (default: 2 of the last 3). One bad reading (loose probe, patient
    moving) is reported as `suppressed` instead of raising the alert, while a deterioration that
    dips back across a band edge now and then (NEWS2 7, 6, 7) still confirms. De-escalation is
    immediate: the confirmed tier never exceeds the latest reading's. The same rule gives
    `confirmed_score` (NEWS2 total) and `confirmed_scores` (each input).

    A brand-new patient counts as all zeros ("none") for the readings before their first, so their
    first reading can't escalate on its own either. confirm_readings=2, window=2 is "2 in a row".
    """

    def __init__(self, confirm_readings: int = 2, window: int = 3) -> None:
        if not 1 <= confirm_readings <= window:
            raise ValueError("need 1 <= confirm_readings <= window")
        self.confirm_readings = confirm_readings
        self.window = window
        self._patients: Dict[str, _PatientHistory] = {}

    @classmethod
    def from_patients(cls, patients: Iterable, confirm_readings: int = 2, window: int = 3) -> "News2Monitor":
        """Build from objects with `.id` and `.conditions` (e.g. sim's SimPatient), choosing
        each patient's SpO2 scale from their conditions."""
        monitor = cls(confirm_readings, window)
        for p in patients:
            monitor.set_spo2_scale(p.id, spo2_scale_for(p.conditions))
        return monitor

    def set_spo2_scale(self, patient_id: str, scale: int) -> None:
        if scale not in (1, 2):
            raise ValueError(f"spo2 scale must be 1 or 2, got {scale!r}")
        self._history(patient_id).spo2_scale = scale

    def spo2_scale(self, patient_id: str) -> int:
        return self._history(patient_id).spo2_scale

    def update(self, reading: dict) -> MonitorResult:
        pid = reading.get("patientId")
        if not pid:
            raise ValueError("reading has no patientId")
        h = self._history(pid)
        result = score_reading(reading, h.spo2_scale)

        h.recent.append(result)
        while len(h.recent) > self.window:
            h.recent.popleft()
        recent = list(h.recent)
        alert_tier = TIERS[self._confirmed([_TIER_RANK[r.tier] for r in recent])]
        return MonitorResult(
            news2=result,
            alert_tier=alert_tier,
            suppressed=_TIER_RANK[result.tier] > _TIER_RANK[alert_tier],
            confirmed_score=self._confirmed([r.total for r in recent]),
            confirmed_scores={k: self._confirmed([r.scores[k] for r in recent]) for k in NEWS2_INPUTS},
        )

    def _confirmed(self, values: List[int]) -> int:
        """The highest value that the latest reading reaches and at least `confirm_readings` of the
        last `window` readings reach. `values` are oldest first; missing older readings count as 0."""
        padded = [0] * (self.window - len(values)) + values
        return min(padded[-1], sorted(padded, reverse=True)[self.confirm_readings - 1])

    def reset(self, patient_id: str) -> None:
        """Forget a patient's recent readings (e.g. after transfer); keeps their SpO2 scale."""
        self._history(patient_id).recent.clear()

    def _history(self, patient_id: str) -> _PatientHistory:
        return self._patients.setdefault(patient_id, _PatientHistory())
