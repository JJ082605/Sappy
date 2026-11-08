import type { VitalsReading } from '@repo/shared'

export interface VitalDef {
  key: string
  label: string
  unit: string
  get: (r: VitalsReading) => number | undefined
  /** Printed value; blood pressure shows systolic/diastolic. */
  show: (r: VitalsReading) => string
  /**
   * Range that scores 0 on the NEWS2 chart (RCP 2017), shaded on trend charts for orientation only.
   * Scoring itself happens in the NEWS2 worker. SpO2 has none: its 0 band depends on the patient's scale.
   */
  calm?: [number, number]
}

const n = (v: number | undefined, digits = 0) => (v === undefined ? '–' : v.toFixed(digits))

export const VITALS: VitalDef[] = [
  { key: 'hr', label: 'Pulse', unit: 'bpm', get: (r) => r.heartRateBpm, show: (r) => n(r.heartRateBpm), calm: [51, 90] },
  { key: 'rr', label: 'Resp. rate', unit: '/min', get: (r) => r.respiratoryRate, show: (r) => n(r.respiratoryRate), calm: [12, 20] },
  { key: 'spo2', label: 'SpO₂', unit: '%', get: (r) => r.spo2Percent, show: (r) => n(r.spo2Percent) },
  {
    key: 'bp',
    label: 'Blood pressure',
    unit: 'mmHg',
    get: (r) => r.systolicMmHg,
    show: (r) => `${n(r.systolicMmHg)}/${n(r.diastolicMmHg)}`,
    calm: [111, 219],
  },
  { key: 'temp', label: 'Temp.', unit: '°C', get: (r) => r.temperatureC, show: (r) => n(r.temperatureC, 1), calm: [36.1, 38] },
]

export const series = (readings: VitalsReading[] | undefined, def: VitalDef) =>
  (readings ?? []).map(def.get).filter((v): v is number => v !== undefined)
