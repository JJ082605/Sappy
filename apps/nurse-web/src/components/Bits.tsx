// Small shared pieces: bed tile, tier badge, source tag, sparkline.
import type { AlertTier } from '@repo/shared'
import { takenAt, TIER_LABEL, tone, type BedState, type TierTone } from '../lib/alerts'
import { bedParts, elapsed } from '../lib/format'
import { PulseIcon, SappyIcon } from './Icons'

/** The bed label set large, toned by the most urgent open alert. The ward's main landmark. */
export function BedTile({ label, tier, size = 'md' }: { label: string; tier?: AlertTier; size?: 'sm' | 'md' | 'lg' }) {
  const { ward, num } = bedParts(label)
  return (
    <div className={`bed bed--${tone(tier)} bed--${size}`} aria-label={`Bed ${label}`}>
      <span className="bed__num">{num}</span>
      {size !== 'sm' && <span className="bed__ward">Bed {ward}</span>}
    </div>
  )
}

/** Status shapes so tier never relies on color alone: triangle, diamond, ring. */
export function TierMark({ t }: { t: TierTone }) {
  if (t === 'go') return <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M5 1 9.5 9h-9z" fill="currentColor" /></svg>
  if (t === 'soon') return <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M5 .8 9.2 5 5 9.2.8 5z" fill="currentColor" /></svg>
  if (t === 'watch') return <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>
  return <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><circle cx="5" cy="5" r="3.6" fill="currentColor" /></svg>
}

export function TierBadge({ tier, suffix }: { tier?: AlertTier; suffix?: string }) {
  const t = tone(tier)
  return (
    <span className={`badge badge--${t}`}>
      <TierMark t={t} />
      {tier ? TIER_LABEL[tier] : 'No open alerts'}
      {suffix && <span className="badge__suffix">{suffix}</span>}
    </span>
  )
}

/**
 * One status badge for a bed, used on every screen so a bed can never look "all clear" in one
 * place and urgent in another. Taken beds keep their tier, outlined, with how long ago.
 */
export function BedStatus({ state, now }: { state: BedState; now: number }) {
  switch (state.kind) {
    case 'open':
      return <TierBadge tier={state.tier} suffix={`waiting ${elapsed(now - Date.parse(state.group.since))}`} />
    case 'taken': {
      const t = tone(state.tier)
      return (
        <span className={`badge badge--taken badge--taken-${t}`}>
          <TierMark t={t} />
          {TIER_LABEL[state.tier]}
          <span className="badge__suffix">on it {elapsed(now - Date.parse(takenAt(state.alert)))}</span>
        </span>
      )
    }
    case 'watch':
      return <TierBadge tier="watch" />
    case 'quiet':
      return <TierBadge />
  }
}

export function SourceTag({ source, score }: { source: 'vitals' | 'sappy'; score?: number | null }) {
  return source === 'vitals' ? (
    <span className="source">
      <PulseIcon width={15} height={15} /> Vitals{score != null && <>, NEWS2 {score}</>}
    </span>
  ) : (
    <span className="source">
      <SappyIcon width={15} height={15} /> Sappy
    </span>
  )
}

/** Tiny trend line; decorative (the value is always printed next to it). */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return <svg className={`spark ${className ?? ''}`} aria-hidden />
  const w = 100
  const h = 28
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 3 - ((v - lo) / span) * (h - 6)])
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
  const [lx, ly] = pts[pts.length - 1]
  return (
    <svg className={`spark ${className ?? ''}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <path d={d} vectorEffect="non-scaling-stroke" />
      {/* zero-length round-capped stroke: a round dot that survives the non-uniform scaling */}
      <path d={`M${lx.toFixed(1)},${ly.toFixed(1)}h0.01`} className="spark__end" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
