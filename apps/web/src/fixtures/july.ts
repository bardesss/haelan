export type DayRow = {
  date: string
  steps: number | null
  hrMin: number | null
  hrMean: number | null
  hrMax: number | null
  sleepMinutes: number | null
  worn: boolean
}

export type Stage = 'deep' | 'light' | 'rem' | 'awake'

// Seeded so screenshots, tests and review all see identical data.
function lcg(seed: number) {
  let s = seed
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296)
}

const rnd = lcg(20260701)
const UNWORN = new Set([5, 6, 20, 24])

const days: DayRow[] = Array.from({ length: 31 }, (_, i) => {
  const date = `2026-07-${String(i + 1).padStart(2, '0')}`
  if (UNWORN.has(i + 1)) {
    return { date, steps: null, hrMin: null, hrMean: null, hrMax: null, sleepMinutes: null, worn: false }
  }
  const ill = i + 1 >= 26 && i + 1 <= 29
  const hrMean = Math.round(72 + Math.sin(i / 3.4) * 6 + rnd() * 6 + (ill ? 11 : 0))
  return {
    date,
    steps: Math.round(9000 + rnd() * 9000),
    hrMin: hrMean - Math.round(16 + rnd() * 6),
    hrMean,
    hrMax: hrMean + Math.round(48 + rnd() * 14),
    sleepMinutes: Math.round(415 + rnd() * 90 - (ill ? 35 : 0)),
    worn: true,
  }
})

const hypnogram: { stage: Stage; from: number; to: number }[] = [
  { stage: 'awake', from: 0, to: 14 }, { stage: 'light', from: 14, to: 58 },
  { stage: 'deep', from: 58, to: 92 }, { stage: 'light', from: 92, to: 120 },
  { stage: 'rem', from: 120, to: 156 }, { stage: 'light', from: 156, to: 196 },
  { stage: 'deep', from: 196, to: 226 }, { stage: 'light', from: 226, to: 262 },
  { stage: 'rem', from: 262, to: 302 }, { stage: 'light', from: 302, to: 338 },
  { stage: 'deep', from: 338, to: 362 }, { stage: 'light', from: 362, to: 404 },
  { stage: 'rem', from: 404, to: 446 }, { stage: 'light', from: 446, to: 470 },
  { stage: 'awake', from: 470, to: 488 },
]

const schedule = days.map((d, i) => {
  if (!d.worn) return { date: d.date, bed: null, wake: null, naps: [] as number[] }
  const bed = 23 * 60 + Math.round(rnd() * 70)
  return {
    date: d.date,
    bed,
    wake: bed + (d.sleepMinutes ?? 440) + Math.round(rnd() * 20),
    naps: rnd() > 0.86 ? [13 * 60 + Math.round(rnd() * 180)] : [],
  }
})

export const july = {
  days,
  hypnogram,
  schedule,
  baselines: { hrMean: { low: 68, high: 84 }, sleepMinutes: { low: 420, high: 480 } },
  excluded: ['2026-07-10'],
  events: [
    { date: '2026-07-26', endDate: '2026-07-29', type: 'illness', text: 'Head cold' },
    { date: '2026-07-18', type: 'travel', text: 'Flight to Chicago' },
    { date: '2026-07-12', type: 'alcohol', text: 'Three glasses of wine' },
  ],
}
