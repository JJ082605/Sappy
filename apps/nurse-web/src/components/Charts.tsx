// Two hand-drawn SVG charts: a vital-sign trend (line + crosshair) and a single-series bar chart.
// Single series each, so no legend: the card title names it. Values are printed, color isn't the only cue.
import { useState, type PointerEvent } from 'react'
import type { VitalsReading } from '@repo/shared'
import { useWidth } from '../lib/hooks'
import { clock } from '../lib/format'
import type { VitalDef } from '../lib/vitals'

const PAD = { l: 34, r: 8, t: 8, b: 20 }

export function VitalChart({ def, readings }: { def: VitalDef; readings: VitalsReading[] }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const points = readings.flatMap((r) => {
    const v = def.get(r)
    return v === undefined ? [] : [{ r, v }]
  })
  const latest = readings[readings.length - 1]
  const h = 104

  let body = null
  if (width > 0 && points.length >= 2) {
    const vals = points.map((p) => p.v)
    let lo = Math.min(...vals)
    let hi = Math.max(...vals)
    if (def.calm) {
      // keep the calm band edge in view when values are near it
      lo = Math.min(lo, Math.max(def.calm[0], lo - (hi - lo)))
      hi = Math.max(hi, Math.min(def.calm[1], hi + (hi - lo)))
    }
    const pad = (hi - lo) * 0.15 || 1
    lo -= pad
    hi += pad
    const iw = width - PAD.l - PAD.r
    const ih = h - PAD.t - PAD.b
    const x = (i: number) => PAD.l + (i / (points.length - 1)) * iw
    const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * ih
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('')
    const band = def.calm && {
      y1: y(Math.min(hi, def.calm[1])),
      y2: y(Math.max(lo, def.calm[0])),
    }
    const hp = hover !== null ? points[hover] : null
    // Whole-number ticks inside the plotted range; a range narrower than 1 gets one decimal tick.
    let ticks = [...new Set([Math.ceil(lo), Math.floor(hi)])].filter((t) => t >= lo && t <= hi)
    if (ticks.length === 0) ticks = [Number(((lo + hi) / 2).toFixed(1))]

    const onMove = (e: PointerEvent<SVGRectElement>) => {
      const box = e.currentTarget.getBoundingClientRect()
      const i = Math.round(((e.clientX - box.left) / box.width) * (points.length - 1))
      setHover(Math.max(0, Math.min(points.length - 1, i)))
    }

    body = (
      <>
        <svg width={width} height={h} className="vchart__svg" role="img" aria-label={`${def.label} trend, ${points.length} readings`}>
          {band && band.y2 > band.y1 && (
            <rect x={PAD.l} width={iw} y={band.y1} height={band.y2 - band.y1} className="vchart__calm" />
          )}
          {ticks.map((t) => (
            <text key={t} x={PAD.l - 6} y={y(t) + 4} className="vchart__tick" textAnchor="end">
              {t}
            </text>
          ))}
          <text x={PAD.l} y={h - 4} className="vchart__tick">{clock(points[0].r.recordedAt)}</text>
          <text x={width - PAD.r} y={h - 4} className="vchart__tick" textAnchor="end">
            {clock(points[points.length - 1].r.recordedAt)}
          </text>
          <path d={d} className="vchart__line" />
          {hp ? (
            <>
              <line x1={x(hover!)} x2={x(hover!)} y1={PAD.t} y2={PAD.t + ih} className="vchart__cross" />
              <circle cx={x(hover!)} cy={y(hp.v)} r="4.5" className="vchart__dot" />
            </>
          ) : (
            <circle cx={x(points.length - 1)} cy={y(points[points.length - 1].v)} r="4" className="vchart__dot" />
          )}
          <rect
            x={PAD.l}
            y={0}
            width={iw}
            height={h}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {hp && (
          <div className="tip" style={{ left: Math.min(Math.max(x(hover!), 60), width - 60), top: 0 }}>
            <strong>{def.show(hp.r)}</strong> {def.unit}
            <span>{clock(hp.r.recordedAt)}</span>
          </div>
        )}
      </>
    )
  }

  return (
    <div className="vchart">
      <div className="vchart__head">
        <span className="vchart__label">{def.label}</span>
        <span className="vchart__value">
          {latest ? def.show(latest) : '–'}
          <small>{def.unit}</small>
        </span>
      </div>
      <div ref={ref} className="vchart__plot" style={{ height: h }}>
        {body ?? <p className="vchart__wait">Trend builds as readings arrive</p>}
      </div>
    </div>
  )
}

export interface Bar {
  key: string
  label: string
  value: number
  /** Printed above the bar, e.g. "3.5m". */
  valueLabel: string
  tip: string
}

export function BarChart({ bars, ariaLabel }: { bars: Bar[]; ariaLabel: string }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const h = 150
  const top = 22
  const bottom = 24
  const max = Math.max(1, ...bars.map((b) => b.value))
  const slot = bars.length ? width / bars.length : 0
  const bw = Math.min(40, slot * 0.5)
  return (
    <div ref={ref} className="bars" style={{ height: h }}>
      {width > 0 && (
        <svg width={width} height={h} role="img" aria-label={ariaLabel}>
          <line x1={0} x2={width} y1={h - bottom} y2={h - bottom} className="bars__base" />
          {bars.map((b, i) => {
            const bh = Math.max(2, (b.value / max) * (h - top - bottom))
            const cx = slot * i + slot / 2
            const y = h - bottom - bh
            return (
              <g key={b.key} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
                <rect x={cx - slot / 2} y={0} width={slot} height={h} fill="transparent" />
                <path
                  className={`bars__bar ${hover === i ? 'is-hover' : ''}`}
                  d={`M${cx - bw / 2},${h - bottom}V${y + 4}q0,-4 4,-4h${bw - 8}q4,0 4,4V${h - bottom}z`}
                />
                <text x={cx} y={y - 6} textAnchor="middle" className="bars__value">{b.valueLabel}</text>
                <text x={cx} y={h - 6} textAnchor="middle" className="bars__label">{b.label}</text>
              </g>
            )
          })}
        </svg>
      )}
      {hover !== null && bars[hover] && (
        <div className="tip" style={{ left: Math.min(Math.max(slot * hover + slot / 2, 70), width - 70), top: 0 }}>
          {bars[hover].tip}
        </div>
      )}
    </div>
  )
}
