// Activity log: every alert from the shift, grouped by hour, with response numbers alongside.
import { useState } from 'react'
import type { AlertRow, HeldReadingRow } from '@repo/shared'
import type { Ward } from '../lib/useWard'
import { SHIFT_HOURS } from '../lib/useWard'
import { describeAlert, isOpen, takenAt, TIER_LABEL } from '../lib/alerts'
import { clock, hourLabel, median, minutes } from '../lib/format'
import { BedTile, SourceTag, TierBadge } from '../components/Bits'
import { BarChart, type Bar } from '../components/Charts'

type Filter = 'all' | 'open' | 'responded' | 'vitals' | 'sappy' | 'held'

const FILTERS: { id: Filter; label: string; test: (a: AlertRow) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'open', label: 'Open', test: isOpen },
  { id: 'responded', label: 'Responded', test: (a) => !isOpen(a) },
  { id: 'vitals', label: 'Vitals', test: (a) => a.news2_score !== null },
  { id: 'sappy', label: 'Sappy', test: (a) => a.news2_score === null },
]

const responseMs = (a: AlertRow) => Math.max(0, Date.parse(takenAt(a)) - Date.parse(a.created_at))

export function ActivityPage({ ward, now, openPatient }: { ward: Ward; now: number; openPatient: (id: string) => void }) {
  const [filter, setFilter] = useState<Filter>('all')
  const test = FILTERS.find((f) => f.id === filter)?.test
  // The log covers the last 12 hours (plus anything still open), however long this page has been open.
  const cutoff = new Date(now - SHIFT_HOURS * 3600_000).toISOString()
  const alerts = ward.alerts.filter((a) => a.created_at >= cutoff || isOpen(a))
  const shown = test ? alerts.filter(test) : []
  const held = heldGroups(ward.held.filter((h) => h.created_at >= cutoff))

  // group newest-first rows by hour
  const hours: { key: string; label: string; rows: AlertRow[] }[] = []
  for (const a of shown) {
    const d = new Date(a.created_at)
    d.setMinutes(0, 0, 0)
    const key = d.toISOString()
    if (hours[hours.length - 1]?.key !== key) hours.push({ key, label: hourLabel(d), rows: [] })
    hours[hours.length - 1].rows.push(a)
  }

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Activity log</h1>
          <p className="page-head__sub">Every alert from the last {SHIFT_HOURS} hours, from vitals and from Sappy.</p>
        </div>
      </header>

      <div className="activity-grid">
        <section className="panel">
          <div className="panel__head">
            <div className="seg" role="group" aria-label="Filter alerts">
              {FILTERS.map((f) => (
                <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                  {f.label} {alerts.filter(f.test).length}
                </button>
              ))}
              <button aria-pressed={filter === 'held'} onClick={() => setFilter('held')}>
                Held back {held.reduce((n, g) => n + g.rows.length, 0)}
              </button>
            </div>
            <span className="panel__hint">Newest first</span>
          </div>

          {filter === 'held' ? (
            <HeldList groups={held} ward={ward} openPatient={openPatient} />
          ) : (
            hours.length === 0 && <p className="empty">No alerts match this filter.</p>
          )}
          {filter !== 'held' && hours.map((h) => (
            <div key={h.key} className="hour">
              <h3 className="hour__label">{h.label}</h3>
              <ul className="log">
                {h.rows.map((a) => {
                  const v = describeAlert(a)
                  const bed = ward.bedFor(a.patient_id)
                  return (
                    <li key={a.id}>
                      <button className="log__row" onClick={() => openPatient(a.patient_id)}>
                        <time className="log__time">{clock(a.created_at)}</time>
                        <BedTile label={bed?.label ?? '?'} size="sm" />
                        <span className="log__text">
                          <span className="log__title">{v.title}</span>
                          <span className="log__detail">
                            <SourceTag source={v.source} />
                            {v.contributors.length > 0 && <span>{v.detail}</span>}
                          </span>
                        </span>
                        <span className="log__meta">
                          <TierBadge tier={a.tier} />
                          <span className="log__state">
                            {isOpen(a) ? `Open ${minutes(now - Date.parse(a.created_at))}` : `Responded in ${minutes(responseMs(a))}`}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </section>

        <div className="stack">
          <ShiftNumbers ward={ward} alerts={alerts} />
          <ResponseByHour alerts={alerts} />
          <AlertsByBed ward={ward} alerts={alerts} />
        </div>
      </div>
    </>
  )
}

interface HeldGroup {
  key: string
  hour: Date
  patientId: string
  rows: HeldReadingRow[] // newest first
}

/** One group per bed per hour, so a flaky probe can't flood the log. */
function heldGroups(held: HeldReadingRow[]): HeldGroup[] {
  const groups = new Map<string, HeldGroup>()
  for (const h of held) {
    const hour = new Date(h.created_at)
    hour.setMinutes(0, 0, 0)
    const key = `${hour.toISOString()}|${h.patient_id}`
    const g = groups.get(key)
    if (g) g.rows.push(h)
    else groups.set(key, { key, hour, patientId: h.patient_id, rows: [h] })
  }
  return [...groups.values()]
}

function HeldList({ groups, ward, openPatient }: { groups: HeldGroup[]; ward: Ward; openPatient: (id: string) => void }) {
  if (groups.length === 0)
    return (
      <p className="empty">
        Nothing held back. When a single reading would have raised an alert and the next reading doesn’t confirm it,
        it’s listed here instead of alerting anyone.
      </p>
    )
  const hours: { label: string; key: string; groups: HeldGroup[] }[] = []
  for (const g of groups) {
    const key = g.hour.toISOString()
    if (hours[hours.length - 1]?.key !== key) hours.push({ key, label: hourLabel(g.hour), groups: [] })
    hours[hours.length - 1].groups.push(g)
  }
  return (
    <>
      <p className="held-intro">
        Single readings the 2-reading rule kept from alerting, because the next reading didn’t confirm them. Nobody was
        alerted. A flaky probe shows up here as a pattern.
      </p>
      {hours.map((h) => (
        <div key={h.key} className="hour">
          <h3 className="hour__label">{h.label}</h3>
          <ul className="log">
            {h.groups.map((g) => {
              const worst = g.rows.reduce((a, b) => (b.news2_score > a.news2_score ? b : a))
              const view = describeAlert({ ...worst, tier: worst.held_tier, status: 'incomplete', completed_at: null })
              const bed = ward.bedFor(g.patientId)
              const n = g.rows.length
              return (
                <li key={g.key}>
                  <button className="log__row" onClick={() => openPatient(g.patientId)}>
                    <time className="log__time">{clock(g.rows[0].created_at)}</time>
                    <BedTile label={bed?.label ?? '?'} size="sm" />
                    <span className="log__text">
                      <span className="log__title">{n === 1 ? '1 reading held back' : `${n} readings held back`}</span>
                      <span className="log__detail">
                        <span>{view.detail}</span>
                      </span>
                    </span>
                    <span className="log__meta">
                      <span className="held-tag">Would have been {TIER_LABEL[worst.held_tier]}</span>
                      <span className="log__state">Next reading didn’t confirm</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </>
  )
}

function ShiftNumbers({ ward, alerts }: { ward: Ward; alerts: AlertRow[] }) {
  const urgent = alerts.filter((a) => a.tier !== 'watch')
  const taken = urgent.filter((a) => !isOpen(a))
  const ms = median(taken.map(responseMs))
  const vitals = alerts.filter((a) => a.news2_score !== null).length
  const quiet = alerts.length - urgent.length
  return (
    <section className="panel">
      <div className="panel__head">
        <h2>This shift</h2>
        <span className="panel__hint">Last {SHIFT_HOURS} hours</span>
      </div>
      <div className="stats">
        <div className="stat"><strong>{urgent.length - taken.length}</strong><span>Urgent, waiting</span></div>
        <div className="stat"><strong>{taken.length}</strong><span>Urgent, responded</span></div>
        <div className="stat"><strong>{ms === undefined ? '–' : minutes(ms)}</strong><span>Median response</span></div>
      </div>
      <p className="stats__split">
        {vitals} from vitals (NEWS2), {alerts.length - vitals} from Sappy. {quiet} kept quiet as watch
        {ward.held.length > 0 && <>, {ward.held.length} held back as likely false {ward.held.length === 1 ? 'alarm' : 'alarms'}</>}.
      </p>
    </section>
  )
}

/** Same definition as "Median response" above: urgent alerts only (watch alerts are often taken
 *  much later, only because a nurse took the bed for something else). */
function ResponseByHour({ alerts }: { alerts: AlertRow[] }) {
  const acked = alerts.filter((a) => a.tier !== 'watch' && !isOpen(a))
  const byHour = new Map<string, { d: Date; ms: number[] }>()
  for (const a of acked) {
    const d = new Date(a.created_at)
    d.setMinutes(0, 0, 0)
    const k = d.toISOString()
    byHour.set(k, { d, ms: [...(byHour.get(k)?.ms ?? []), responseMs(a)] })
  }
  const bars: Bar[] = [...byHour.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-6)
    .map(([k, { d, ms }]) => {
      const m = median(ms)! / 60000
      return {
        key: k,
        label: hourLabel(d),
        value: m,
        valueLabel: minutes(median(ms)!),
        tip: `${hourLabel(d)}: median ${minutes(median(ms)!)} across ${ms.length} ${ms.length === 1 ? 'alert' : 'alerts'}`,
      }
    })
  const overall = median(acked.map(responseMs))
  return (
    <section className="panel">
      <div className="panel__head panel__head--top">
        <div>
          <h2>Time to respond</h2>
          <p className="panel__hint">Urgent alerts, median per hour raised. Measures the tap on “I’m on it”, not arrival at the bed.</p>
        </div>
        <strong className="headline">{overall === undefined ? '–' : minutes(overall)}</strong>
      </div>
      {bars.length ? <BarChart bars={bars} ariaLabel="Median minutes to respond, by hour" /> : <p className="empty">No responses yet.</p>}
    </section>
  )
}

function AlertsByBed({ ward, alerts }: { ward: Ward; alerts: AlertRow[] }) {
  const rows = ward.beds
    .map((b) => {
      const mine = alerts.filter((a) => a.patient_id === b.patient.id)
      return { bed: b, total: mine.length, vitals: mine.filter((a) => a.news2_score !== null) }
    })
    .sort((a, b) => b.total - a.total)
  const max = Math.max(1, ...rows.map((r) => r.total))
  const flagged = rows.find((r) => r.vitals.length >= 2)
  const firstVitals = flagged?.vitals[flagged.vitals.length - 1]
  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Alerts by bed</h2>
      </div>
      <ul className="hbars">
        {rows.map((r) => (
          <li key={r.bed.patient.id}>
            <span className="hbars__label">{r.bed.label}</span>
            <span className="hbars__track">
              <span className="hbars__fill" style={{ width: `${(r.total / max) * 100}%` }} />
            </span>
            <span className="hbars__value">{r.total}</span>
          </li>
        ))}
      </ul>
      {flagged && firstVitals && (
        <p className="aware">
          Bed {flagged.bed.label} has raised {flagged.vitals.length} vitals alerts since {clock(firstVitals.created_at)}.
          Shown for awareness only.
        </p>
      )}
    </section>
  )
}
