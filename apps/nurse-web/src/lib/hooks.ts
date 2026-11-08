import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'

/** Current time, re-rendering every `ms` (for waiting timers). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

/** Supabase auth session; `undefined` while it's still being restored from storage. */
export function useSession(): Session | null | undefined {
  const [session, setSession] = useState<Session | null>()
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])
  return session
}

/**
 * Current page from the URL hash ("#/patients" -> "patients"). Only the page name goes in the URL:
 * patient ids stay in memory so they never land in browser history, autocomplete or sync.
 */
export function useHashPage<P extends string>(pages: readonly P[], fallback: P): [P, (p: P) => void] {
  const read = useCallback(() => {
    const name = window.location.hash.replace(/^#\/?/, '').split('/')[0]
    return (pages as readonly string[]).includes(name) ? (name as P) : fallback
  }, [pages, fallback])
  const [page, setPage] = useState(read)
  useEffect(() => {
    const onHash = () => setPage(read())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [read])
  return [page, (p) => (window.location.hash = `/${p}`)]
}

const ACTIVITY = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const

/**
 * Shared-workstation privacy. After `hideAfterMs` without input the patient details are hidden;
 * after `lockAfterMs` showing them again needs the password. The session is never ended by
 * inactivity: an unattended station is exactly when alerts must stay on screen, so the privacy
 * screen keeps showing live bed status throughout. Moving the mouse doesn't reveal anything: the
 * nurse has to choose to show details again.
 */
export function usePrivacyScreen(hideAfterMs: number, lockAfterMs: number) {
  // Restored from sessionStorage so a reload (F5) or a duplicated tab can't skip the lock.
  const [initial] = useState(() => {
    const saved = readPrivacy()
    const now = Date.now()
    const idle = saved.last ? now - saved.last : 0
    const locked = saved.locked === true || idle > lockAfterMs
    return { last: saved.last ?? now, locked, hidden: locked || idle > hideAfterMs }
  })
  const last = useRef(initial.last)
  const [hidden, setHidden] = useState(initial.hidden)
  const [locked, setLocked] = useState(initial.locked)
  const hiddenRef = useRef(hidden)

  useEffect(() => {
    hiddenRef.current = hidden
  }, [hidden])
  useEffect(() => {
    writePrivacy({ last: last.current, locked })
  }, [locked])

  useEffect(() => {
    let lastSaved = 0
    const onActivity = () => {
      // Input while details are hidden doesn't count: only "Show details" (or the password) does,
      // otherwise a passer-by nudging the mouse would keep the station from ever locking.
      if (hiddenRef.current) return
      last.current = Date.now()
      if (last.current - lastSaved > 5000) {
        lastSaved = last.current
        writePrivacy({ last: last.current, locked: false })
      }
    }
    ACTIVITY.forEach((e) => window.addEventListener(e, onActivity, { passive: true }))
    const id = setInterval(() => {
      const idle = Date.now() - last.current
      if (idle > hideAfterMs) setHidden(true)
      if (idle > lockAfterMs) setLocked(true)
    }, 1000)
    return () => {
      ACTIVITY.forEach((e) => window.removeEventListener(e, onActivity))
      clearInterval(id)
    }
  }, [hideAfterMs, lockAfterMs])

  const show = useCallback(() => {
    last.current = Date.now()
    writePrivacy({ last: last.current, locked: false })
    setHidden(false)
    setLocked(false)
  }, [])
  const hide = useCallback(() => setHidden(true), [])
  return { hidden, locked, show, hide }
}

const PRIVACY_KEY = 'sappy.privacy'

function readPrivacy(): { last?: number; locked?: boolean } {
  try {
    return JSON.parse(sessionStorage.getItem(PRIVACY_KEY) ?? '{}') as { last?: number; locked?: boolean }
  } catch {
    return {}
  }
}

function writePrivacy(v: { last: number; locked: boolean }) {
  try {
    sessionStorage.setItem(PRIVACY_KEY, JSON.stringify(v))
  } catch {
    // storage unavailable (private mode): the lock still works for this page's lifetime
  }
}

/** A per-viewer on/off preference kept in localStorage (falls back to `initial` if unavailable). */
export function useStoredFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const v = localStorage.getItem(key)
      return v === null ? initial : v === '1'
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (v: boolean) => {
      setValue(v)
      try {
        localStorage.setItem(key, v ? '1' : '0')
      } catch {
        // storage unavailable: keep it for this page only
      }
    },
    [key],
  )
  return [value, set]
}

let audio: AudioContext | undefined

/** Two short tones. Browsers only allow sound after the user has interacted with the page. */
function chime() {
  try {
    audio ??= new AudioContext()
    void audio.resume()
    const t = audio.currentTime
    ;[880, 660].forEach((freq, i) => {
      const osc = audio!.createOscillator()
      const gain = audio!.createGain()
      const start = t + i * 0.2
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18)
      osc.connect(gain).connect(audio!.destination)
      osc.start(start)
      osc.stop(start + 0.2)
    })
  } catch {
    // no audio available: the visual alert is unaffected
  }
}

/**
 * Chime when a new "go now" appears (a new key in `signature`, e.g. the top alert ids of go-now
 * beds joined with "|"). Not on page load, only for alerts that arrive while the page is open.
 */
export function useAlertChime(signature: string, enabled: boolean) {
  const previous = useRef<Set<string> | null>(null)
  useEffect(() => {
    const keys = new Set(signature ? signature.split('|') : [])
    if (enabled && previous.current && [...keys].some((k) => !previous.current!.has(k))) chime()
    previous.current = keys
  }, [signature, enabled])
}

/** Element width, kept current with ResizeObserver (charts draw in real pixels so text isn't stretched). */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}
