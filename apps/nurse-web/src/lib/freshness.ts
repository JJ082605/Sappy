// Is the data on screen still arriving? Readings carry the simulator's clock, so freshness is
// judged by when they ARRIVED in this browser. Pure helpers (no Supabase import) so they're testable.

/** A bed whose vitals haven't updated for this long is shown as possibly out of date. */
export const STALE_MS = 30_000

export interface Freshness {
  live: 'connecting' | 'live' | 'offline'
  /** patientId -> browser time the latest reading arrived live (the initial fetch doesn't count). */
  seen: Record<string, number>
  /** Browser time the ward finished loading. */
  readyAt?: number
  /** Whether the live NEWS2 feed exists, and when a score last arrived live (worker heartbeat). */
  scoresAvailable?: boolean
  scoresSeen?: number
}

/**
 * True when a bed's vitals have stopped arriving, or never arrived live since loading. Offline is
 * stale at once; "connecting" (first connect, or a reconnect) only once the data is actually old, so
 * a page that has just loaded isn't flagged while Realtime is still connecting.
 */
export function isStale(f: Freshness, patientId: string, now: number): boolean {
  if (f.live === 'offline') return true
  const last = f.seen[patientId] ?? f.readyAt
  return last !== undefined && now - last > STALE_MS
}

/**
 * The scoring worker has stopped while vitals keep arriving: the most dangerous silent failure,
 * because the screen looks live but no new alert can appear. Returns how long scores have been
 * missing (ms), or undefined when scoring looks fine or can't be judged.
 */
export function scoringStalledFor(f: Freshness, patientIds: string[], now: number): number | undefined {
  if (!f.scoresAvailable || f.readyAt === undefined || f.live !== 'live') return undefined
  const vitalsAge = wardDataAge(f, patientIds, now)
  if (vitalsAge === undefined || vitalsAge > STALE_MS) return undefined // the vitals banner covers it
  const scoresAge = now - Math.max(f.readyAt, f.scoresSeen ?? f.readyAt)
  return scoresAge > STALE_MS ? scoresAge : undefined
}

/** Milliseconds since ANY bed's vitals last arrived (or since loading), or undefined before loading. */
export function wardDataAge(f: Freshness, patientIds: string[], now: number): number | undefined {
  if (f.readyAt === undefined) return undefined
  const arrivals = patientIds.map((id) => f.seen[id] ?? f.readyAt!)
  return now - Math.max(f.readyAt, ...arrivals)
}
