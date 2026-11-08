// Patients: every bed on the ward, and one patient in detail (live vitals, context, alert history).
// Patients are selected by pseudonymous id (held in memory, never in the URL). The bed label is only
// what's shown. The list is visible to anyone near the station, so it carries bed + age band only;
// sex, conditions and medications appear in the detail view after a deliberate click, and nothing is
// opened by default.
import { useEffect, useRef, useState } from 'react'
import type { Ward } from '../lib/useWard'
import { isStale } from '../lib/freshness'
import { bedState, describeAlert, displayTier, isOpen, openGroups, TIER_RANK, type BedState, type OpenGroup } from '../lib/alerts'
import { ACVPU, clinicalConditions, clock, elapsed, patientMeta, shortId, shortMed } from '../lib/format'
import { VITALS } from '../lib/vitals'
import { BedStatus, BedTile, SourceTag, TierBadge } from '../components/Bits'
import { VitalChart } from '../components/Charts'
import { CheckIcon, SearchIcon } from '../components/Icons'

interface Props {
  ward: Ward
  now: number
  selectedId?: string
  select: (patientId: string) => void
  take: (group: OpenGroup) => void
}

/** List order: waiting beds first (by tier), then beds a nurse is on, then watch, then quiet. */
function rank(s: BedState): number {
  if (s.kind === 'open') return 10 + TIER_RANK[s.tier]
  if (s.kind === 'taken') return 5 + TIER_RANK[s.tier]
  return s.kind === 'watch' ? 1 : 0
}

export function PatientsPage({ ward, now, selectedId, select, take }: Props) {
  const [query, setQuery] = useState('')
  const groups = openGroups(ward.alerts)
  const stateOf = (id: string) => bedState(ward.alerts, groups, id)

  const q = query.trim().toLowerCase()
  const beds = ward.beds
    .filter((b) => !q || b.label.toLowerCase().includes(q) || b.patient.id.toLowerCase().startsWith(q))
    .sort(
      (a, b) =>
        rank(stateOf(b.patient.id)) - rank(stateOf(a.patient.id)) ||
        a.label.localeCompare(b.label, undefined, { numeric: true }),
    )
  const selected = ward.beds.find((b) => b.patient.id === selectedId)

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Patients</h1>
          <p className="page-head__sub">
            {ward.beds.length} on the ward, most urgent first. Shown by bed and age band only.
          </p>
        </div>
        <label className="search">
          <SearchIcon />
          <span className="sr-only">Search by bed or patient ID</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Bed or patient ID" />
        </label>
      </header>

      <div className="patients-grid">
        <section className="panel">
          <div className="panel__head">
            <h2>On the ward</h2>
          </div>
          <ul className="plist">
            {beds.map((b) => {
              const s = stateOf(b.patient.id)
              const isSelected = selected?.patient.id === b.patient.id
              return (
                <li key={b.patient.id}>
                  <button
                    className={`pcard ${isSelected ? 'is-selected' : ''}`}
                    onClick={() => select(b.patient.id)}
                    aria-current={isSelected}
                  >
                    <BedTile label={b.label} tier={displayTier(s, ward.scores[b.patient.id])} size="sm" />
                    <span className="pcard__text">
                      <span className="pcard__title">Bed {b.label}</span>
                      <span className="pcard__meta">
                        Age {b.patient.ageBand}
                        {ward.scores[b.patient.id] && <>, NEWS2 {ward.scores[b.patient.id].score}</>}
                      </span>
                    </span>
                    {s.kind !== 'quiet' && <BedStatus state={s} now={now} />}
                  </button>
                </li>
              )
            })}
            {beds.length === 0 && <li className="empty">No bed matches “{query}”.</li>}
          </ul>
        </section>

        {selected ? (
          <PatientDetail key={selected.patient.id} ward={ward} now={now} patientId={selected.patient.id} take={take} />
        ) : (
          <section className="panel pick">
            <h2>Choose a bed</h2>
            <p>Vitals trends, conditions, medications and alert history open here. Nothing is shown until you pick a bed.</p>
          </section>
        )}
      </div>
    </>
  )
}

function PatientDetail({ ward, now, patientId, take }: {
  ward: Ward; now: number; patientId: string; take: (group: OpenGroup) => void
}) {
  const bed = ward.bedFor(patientId)!
  const groups = openGroups(ward.alerts)
  const state = bedState(ward.alerts, groups, patientId)
  const group = groups.find((g) => g.patientId === patientId)
  const latest = ward.latest[patientId]
  const history = ward.history[patientId] ?? []
  const conditions = clinicalConditions(bed.patient)
  const meds = (bed.patient.medications ?? []).map(shortMed)
  const [tab, setTab] = useState<'open' | 'all'>('all')
  const mine = ward.alerts.filter((a) => a.patient_id === patientId)
  const shown = tab === 'open' ? mine.filter(isOpen) : mine
  const stale = isStale(ward, patientId, now)
  const lastSeen = ward.seen[patientId] ?? ward.readyAt
  const score = ward.scores[patientId]

  // Bring the details into view (on narrow screens they sit below the list) and move focus there.
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [])

  return (
    <div className="detail">
      <section className="panel phead">
        <BedTile label={bed.label} tier={displayTier(state, score)} size="lg" />
        <div className="phead__text">
          <h2 ref={heading} tabIndex={-1}>Bed {bed.label}</h2>
          <p>{patientMeta(bed.patient)}</p>
          <p className="phead__id">Patient ID {shortId(patientId)}</p>
          {score && (
            <p className="phead__score">
              Now NEWS2 {score.score}
              {score.spo2_scale === 2 && <span className="scale2">SpO₂ scale 2</span>}
            </p>
          )}
        </div>
        <div className="phead__side">
          <BedStatus state={state} now={now} />
          {group && (
            <button className="btn btn--ghost" onClick={() => take(group)}>
              <CheckIcon /> I’m on it
            </button>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel__head">
          <h2>Live vitals</h2>
          <span className={`panel__hint ${stale ? 'panel__hint--warn' : ''}`}>
            {stale
              ? `No new vitals ${lastSeen ? `for ${elapsed(now - lastSeen)}` : 'yet'}`
              : latest
                ? `Last reading ${clock(latest.recordedAt)} (simulated clock)`
                : 'Waiting for the first reading'}
          </span>
        </div>
        <div className={`vgrid ${stale ? 'is-stale' : ''}`}>
          {VITALS.map((def) => (
            <VitalChart key={def.key} def={def} readings={history} />
          ))}
          <div className="vchart vchart--facts">
            <div>
              <span className="vchart__label">Breathing</span>
              <span className="fact">{latest ? (latest.onOxygen ? 'On supplemental oxygen' : 'Room air') : '–'}</span>
            </div>
            <div>
              <span className="vchart__label">Consciousness</span>
              <span className="fact">{latest?.consciousness ? ACVPU[latest.consciousness] : '–'}</span>
            </div>
          </div>
        </div>
        <p className="footnote">
          Shaded bands mark the range that scores 0 on NEWS2{score?.spo2_scale === 2 ? ' (SpO₂ uses scale 2 for this patient)' : ''}.
          Trends start when this page opens; chart times are the simulator’s clock.
        </p>
      </section>

      <div className="detail__pair">
        <section className="panel">
          <div className="panel__head">
            <h2>Before you go in</h2>
          </div>
          <h3 className="sub">Active conditions</h3>
          {conditions.length ? (
            <ul className="facts">{conditions.slice(0, 8).map((c) => <li key={c}>{c}</li>)}</ul>
          ) : (
            <p className="empty">None recorded.</p>
          )}
          <h3 className="sub">Medications</h3>
          {meds.length ? (
            <ul className="facts">
              {meds.slice(0, 6).map((m, i) => <li key={`${m}-${i}`}>{m}</li>)}
              {meds.length > 6 && <li className="facts__more">and {meds.length - 6} more</li>}
            </ul>
          ) : (
            <p className="empty">None recorded.</p>
          )}
        </section>

        <section className="panel">
          <div className="panel__head">
            <h2>Alerts for this bed</h2>
            <div className="seg" role="group" aria-label="Which alerts">
              <button aria-pressed={tab === 'all'} onClick={() => setTab('all')}>All {mine.length}</button>
              <button aria-pressed={tab === 'open'} onClick={() => setTab('open')}>Open {mine.filter(isOpen).length}</button>
            </div>
          </div>
          {shown.length ? (
            <ul className="hist">
              {shown.map((a) => {
                const v = describeAlert(a)
                return (
                  <li key={a.id} className="hist__row">
                    <time className="hist__time">{clock(a.created_at)}</time>
                    <span className="hist__text">
                      <span className="hist__title">{v.title}</span>
                      <span className="hist__detail">
                        <SourceTag source={v.source} />
                        {v.contributors.length > 0 && <span>{v.detail}</span>}
                      </span>
                    </span>
                    <span className="hist__meta">
                      <TierBadge tier={a.tier} />
                      <span className="hist__state">{isOpen(a) ? 'Open' : 'Responded'}</span>
                    </span>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="empty">{tab === 'open' ? 'Nothing open for this bed.' : 'No alerts in the last 12 hours.'}</p>
          )}
        </section>
      </div>
    </div>
  )
}
