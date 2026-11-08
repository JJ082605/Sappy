// Alerts: what needs a nurse right now.
//   - every "go now" bed gets its own hero card (two deteriorating patients are equally urgent)
//   - "check soon" beds queue below: most urgent first, then longest waiting
//   - "watch" alerts (low scores, routine requests) stay folded away: fewer, better alerts
// Shown on a shared station screen, so cards carry bed + age band only; details are a click away.
import type { Bed, Ward } from '../lib/useWard'
import { isStale } from '../lib/freshness'
import { bedState, describeAlert, displayTier, openGroups, outranks, previousScore, takenAt, tone, type OpenGroup } from '../lib/alerts'
import { ACVPU, clock, elapsed } from '../lib/format'
import { VITALS, series } from '../lib/vitals'
import { BedTile, SourceTag, Sparkline, TierBadge, TierMark } from '../components/Bits'
import { CheckIcon } from '../components/Icons'

interface Props {
  ward: Ward
  now: number
  openPatient: (patientId: string) => void
  /** "I'm on it" for a bed: the app shows confirmation with Undo. */
  take: (group: OpenGroup) => void
}

export function AlertsPage({ ward, now, openPatient, take }: Props) {
  const groups = openGroups(ward.alerts)
  const heroes = groups.filter((g) => g.top.tier === 'go now')
  const queue = groups.filter((g) => g.top.tier === 'check soon')
  const quiet = groups.filter((g) => g.top.tier === 'watch')

  const needYou = heroes.length + queue.length
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Alerts</h1>
          <p className="page-head__sub">
            {needYou === 0
              ? 'No bed needs you right now.'
              : `${needYou} ${needYou === 1 ? 'bed needs' : 'beds need'} you. Most urgent first, then longest waiting.`}
          </p>
        </div>
      </header>

      {heroes.length > 0 ? (
        heroes.map((g) => (
          <HeroAlert
            key={g.patientId}
            group={g}
            bed={ward.bedFor(g.patientId)}
            ward={ward}
            now={now}
            onTake={() => take(g)}
            onOpen={() => openPatient(g.patientId)}
          />
        ))
      ) : (
        <section className="calm">
          <h2>No bed needs you urgently</h2>
          <p>
            {queue.length > 0
              ? `${queue.length} ${queue.length === 1 ? 'bed is' : 'beds are'} waiting below.`
              : 'A bed appears here the moment its NEWS2 score reaches 7, or a patient reports a possible emergency to Sappy.'}
          </p>
        </section>
      )}

      <div className="alerts-grid">
        <section className="panel">
          <div className="panel__head">
            <h2>Up next</h2>
            <span className="panel__hint">{queue.length ? `${queue.length} waiting` : 'Nothing else waiting'}</span>
          </div>
          {queue.length > 0 && (
            <ul className="queue">
              {queue.map((g) => (
                <QueueItem key={g.patientId} group={g} bed={ward.bedFor(g.patientId)} now={now} onTake={() => take(g)} onOpen={() => openPatient(g.patientId)} />
              ))}
            </ul>
          )}
          {quiet.length > 0 && (
            <details className="quiet">
              <summary>
                {quiet.length} watch {quiet.length === 1 ? 'alert' : 'alerts'}, kept quiet
              </summary>
              <p className="quiet__note">Low NEWS2 scores and routine requests. Worth a look on your next round.</p>
              <ul className="queue queue--quiet">
                {quiet.map((g) => (
                  <QueueItem key={g.patientId} group={g} bed={ward.bedFor(g.patientId)} now={now} onTake={() => take(g)} onOpen={() => openPatient(g.patientId)} />
                ))}
              </ul>
            </details>
          )}
        </section>

        <WardBoard ward={ward} groups={groups} now={now} openPatient={openPatient} />
      </div>
    </>
  )
}

function HeroAlert({ group, bed, ward, now, onTake, onOpen }: {
  group: OpenGroup; bed?: Bed; ward: Ward; now: number; onTake: () => void; onOpen: () => void
}) {
  const view = describeAlert(group.top)
  const latest = ward.latest[group.patientId]
  const history = ward.history[group.patientId]
  const prev = group.top.news2_score !== null ? previousScore(ward.alerts, group.top) : undefined
  const rising = prev && prev.news2_score !== null && prev.news2_score < group.top.news2_score!
  const stale = isStale(ward, group.patientId, now)
  const lastSeen = ward.seen[group.patientId] ?? ward.readyAt
  const score = ward.scores[group.patientId]
  const others = group.alerts.filter((a) => a.id !== group.top.id).sort((a, b) => outranks(b, a))
  return (
    <article className={`hero hero--${tone(group.top.tier)}`} aria-label={`Bed ${bed?.label ?? ''}: ${view.title}`}>
      <div className="hero__main">
        <BedTile label={bed?.label ?? '?'} tier={group.top.tier} size="lg" />
        <div className="hero__body">
          <div className="hero__tags">
            <TierBadge tier={group.top.tier} />
            <SourceTag source={view.source} score={group.top.news2_score} />
            {bed && <span className="hero__age">Age {bed.patient.ageBand}</span>}
            {score && (
              <span className="hero__live">
                Now NEWS2 {score.score}
                {score.spo2_scale === 2 && <span className="scale2">SpO₂ scale 2</span>}
              </span>
            )}
          </div>
          <h2>
            {view.title}
            {rising && (
              <span className="hero__trend">
                <span className="sr-only">, </span>
                <span aria-hidden>▲ </span>Up from {prev.news2_score} at {clock(prev.created_at)}
              </span>
            )}
          </h2>
          {view.contributors.length > 0 ? (
            <>
              <p className="hero__scored">Scored at {clock(group.top.created_at)}:</p>
              <ul className="chips" aria-label={`What raised the score at ${clock(group.top.created_at)}`}>
                {view.contributors.map((c) => (
                  <li key={c.label} className={`chip chip--p${c.points}`}>
                    {c.label} <b>+{c.points}</b>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="hero__detail">{view.detail}</p>
          )}
          {view.response && <p className="hero__response">{view.response}</p>}
          {others.length > 0 && (
            <div className="hero__also">
              <p>Also open for this bed (taking it covers these too):</p>
              <ul>
                {others.map((a) => {
                  const v = describeAlert(a)
                  return (
                    <li key={a.id}>
                      <TierMark t={tone(a.tier)} /> {v.title}{' '}
                      <span className="hero__also-meta">
                        {v.source === 'vitals' ? `NEWS2 ${a.news2_score}` : 'Sappy'}, {clock(a.created_at)}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>
        <div className="hero__side">
          <div className="hero__timer">
            <span>Waiting</span>
            <strong>{elapsed(now - Date.parse(group.since))}</strong>
          </div>
          <div className="hero__actions">
            <button className="btn btn--primary" onClick={onTake}>
              <CheckIcon /> I’m on it
            </button>
            <button className="btn btn--ghost" onClick={onOpen}>Open patient</button>
          </div>
        </div>
      </div>

      <dl className={`hero__vitals ${stale ? 'is-stale' : ''}`} aria-label="Live vitals">
        {stale && (
          <p className="hero__stale">
            No new vitals {lastSeen ? `for ${elapsed(now - lastSeen)}` : 'yet'}. These values may be out of date.
          </p>
        )}
        {VITALS.map((def) => (
          <div key={def.key} className="hv">
            <dt>{def.label}</dt>
            <dd>
              <span className="hv__value">{latest ? def.show(latest) : '–'}</span>
              <span className="hv__unit">{def.unit}</span>
            </dd>
            <Sparkline values={series(history, def).slice(-40)} className="hv__spark" />
          </div>
        ))}
        <div className="hv hv--text">
          <dt>Breathing</dt>
          <dd className="hv__textval">{latest ? (latest.onOxygen ? 'On oxygen' : 'Room air') : '–'}</dd>
          <dt>Responds</dt>
          <dd className="hv__textval">{latest?.consciousness ? ACVPU[latest.consciousness] : '–'}</dd>
        </div>
      </dl>
    </article>
  )
}

function QueueItem({ group, bed, now, onTake, onOpen }: {
  group: OpenGroup; bed?: Bed; now: number; onTake: () => void; onOpen: () => void
}) {
  const view = describeAlert(group.top)
  const top3 = view.contributors.find((c) => c.points === 3)
  return (
    <li className={`qi qi--${tone(group.top.tier)}`}>
      <button className="qi__open" onClick={onOpen}>
        <BedTile label={bed?.label ?? '?'} tier={group.top.tier} size="sm" />
        <span className="qi__text">
          <span className="qi__title">{view.title}</span>
          <span className="qi__detail">
            <SourceTag source={view.source} />
            <span>
              {top3 ? `${top3.label} scored 3` : view.contributors[0]?.label ?? (bed ? `Age ${bed.patient.ageBand}` : '')}
            </span>
          </span>
        </span>
        <span className="qi__meta">
          <span className="qi__wait">{elapsed(Math.max(0, now - Date.parse(group.since)))}</span>
          <TierBadge tier={group.top.tier} />
        </span>
      </button>
      <button className="btn btn--small" onClick={onTake} aria-label={`I’m on it: bed ${bed?.label ?? ''}`}>
        I’m on it
      </button>
    </li>
  )
}

function WardBoard({ ward, groups, now, openPatient }: {
  ward: Ward; groups: OpenGroup[]; now: number; openPatient: (id: string) => void
}) {
  const wardName = ward.beds[0]?.label.split('-')[0]
  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Ward {wardName}</h2>
        <span className="panel__hint">{ward.beds.length} beds, live</span>
      </div>
      <ul className="board">
        {ward.beds.map((b) => {
          const s = bedState(ward.alerts, groups, b.patient.id)
          const score = ward.scores[b.patient.id]
          const tier = displayTier(s, score)
          const r = ward.latest[b.patient.id]
          const stale = isStale(ward, b.patient.id, now)
          const status =
            s.kind === 'open'
              ? `${s.tier} alert waiting`
              : s.kind === 'taken'
                ? `${s.tier}, a nurse is on it`
                : s.kind === 'watch'
                  ? 'watch alert open'
                  : 'no open alerts'
          return (
            <li key={b.patient.id}>
              <button
                className={`tile tile--${tone(tier)} ${s.kind === 'taken' ? 'tile--handled' : ''} ${stale ? 'is-stale' : ''}`}
                onClick={() => openPatient(b.patient.id)}
              >
                <span className="tile__bed">
                  {b.label}
                  {tier && <TierMark t={tone(tier)} />}
                </span>
                {score && (
                  <span className="tile__score">
                    NEWS2 {score.score}
                    {score.spo2_scale === 2 && <span className="scale2" title="SpO₂ scale 2">S2</span>}
                  </span>
                )}
                <span className="tile__vals">
                  <span>{r?.heartRateBpm ?? '–'}<small> bpm</small></span>
                  <span>{r?.spo2Percent ?? '–'}<small>%</small></span>
                </span>
                {stale ? (
                  <span className="tile__note">No new vitals</span>
                ) : s.kind === 'taken' ? (
                  <span className="tile__note">On it, {elapsed(now - Date.parse(takenAt(s.alert)))}</span>
                ) : (
                  <Sparkline values={series(ward.history[b.patient.id], VITALS[0]).slice(-30)} className="tile__spark" />
                )}
                <span className="sr-only">{status}{stale ? ', vitals not updating' : ''}</span>
              </button>
            </li>
          )
        })}
      </ul>
      <ul className="legend" aria-label="Legend">
        <li><TierBadge tier="go now" /></li>
        <li><TierBadge tier="check soon" /></li>
        <li><TierBadge tier="watch" /></li>
        <li><span className="legend__handled">Outlined: a nurse is on it</span></li>
      </ul>
    </section>
  )
}
