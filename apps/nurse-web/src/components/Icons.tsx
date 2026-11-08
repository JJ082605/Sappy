// Stroke icons, 20px grid, drawn to share one weight with the type.
import type { SVGProps } from 'react'

const base = {
  width: 20,
  height: 20,
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

type P = SVGProps<SVGSVGElement>

export const BellIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M5 13.5V9a5 5 0 0 1 10 0v4.5l1.5 1.5h-13z" />
    <path d="M8.2 17a2 2 0 0 0 3.6 0" />
  </svg>
)

export const BedIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M2.5 15.5V5M2.5 12h15v3.5M17.5 12V9.5a2 2 0 0 0-2-2H9v4.5" />
    <circle cx="5.7" cy="9.3" r="1.5" />
  </svg>
)

export const LogIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3.5 10a6.5 6.5 0 1 0 2-4.7" />
    <path d="M3 3v3.2h3.2M10 6.5V10l2.5 1.6" />
  </svg>
)

export const SignOutIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M8 4H5a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 5 16h3M12.5 13.5 16 10l-3.5-3.5M16 10H8" />
  </svg>
)

export const SearchIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="9" cy="9" r="5.5" />
    <path d="m13 13 3.5 3.5" />
  </svg>
)

export const CheckIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="m4.5 10.5 3.5 3.5 7.5-8" />
  </svg>
)

/** Sappy, the patient assistant: a speech bubble. */
export const SappyIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 4.5h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H9l-3.5 3v-3H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" />
    <path d="M7 9h.01M10 9h.01M13 9h.01" strokeWidth="2.2" />
  </svg>
)

/** Vitals: a pulse trace. */
export const PulseIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M2 10.5h3.5l2-5 3.5 9 2-4h5" />
  </svg>
)

/** Hide the screen (privacy): an eye with a slash. */
export const EyeOffIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3 10s2.5-5 7-5c1.3 0 2.4.4 3.4 1M17 10s-2.5 5-7 5c-1.3 0-2.4-.4-3.4-1" />
    <path d="M8.3 11.7a2.4 2.4 0 0 1 3.4-3.4M3.5 16.5l13-13" />
  </svg>
)

/** Speaker, with a cross when muted. */
export const SoundIcon = ({ muted, ...p }: P & { muted?: boolean }) => (
  <svg {...base} {...p}>
    <path d="M3.5 8v4h3l4 3.5v-11L6.5 8z" />
    {muted ? <path d="m13.5 8 4 4M17.5 8l-4 4" /> : <path d="M13.5 7.5a3.5 3.5 0 0 1 0 5M15.5 5.5a6.4 6.4 0 0 1 0 9" />}
  </svg>
)
