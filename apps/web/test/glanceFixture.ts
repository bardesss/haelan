import type { Glance, GlanceFigure } from '../src/data/useGlance.js'

// One whole glance payload, shared by every test that mounts the glance Dashboard (glance-page,
// pages, chart-lifecycle), so the three agree on what a full answer looks like and a change to the
// payload's shape is one edit rather than three. Europe/Amsterdam is two hours ahead of UTC on these
// dates, which is what the clock times in the comments below read.

export const GLANCE_TODAY = '2026-09-23'

const DATES = ['2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23']

function strip(values: (number | null)[]): GlanceFigure['strip'] {
  return DATES.map((localDate, i) => ({ localDate, value: values[i] ?? null, band: null, standing: null }))
}

export function glanceFigure(over: Partial<GlanceFigure> & Pick<GlanceFigure, 'metric'>): GlanceFigure {
  return {
    value: null, unit: 'count', baseline: null, asOfDate: GLANCE_TODAY, asOfMs: null, partial: false,
    staleSources: [], strip: [], standing: null,
    ...over,
  }
}

// 23:10 to 06:52 local, the night keyed under the date it ended on.
const NIGHT_START = Date.UTC(2026, 8, 22, 21, 10)
const NIGHT_END = Date.UTC(2026, 8, 23, 4, 52)

export function glanceBody(): Glance {
  return {
    today: GLANCE_TODAY,
    sleep: {
      localDate: GLANCE_TODAY, sourceId: 'watch',
      startMs: NIGHT_START, endMs: NIGHT_END, startOffsetMinutes: 120, endOffsetMinutes: 120,
      segments: [
        { stage: 'LIGHT', startMs: NIGHT_START, endMs: NIGHT_START + 3_600_000 },
        { stage: 'DEEP', startMs: NIGHT_START + 3_600_000, endMs: NIGHT_START + 3 * 3_600_000 },
        { stage: 'REM', startMs: NIGHT_START + 3 * 3_600_000, endMs: NIGHT_END },
      ],
      asleep: glanceFigure({
        metric: 'sleep_asleep_minutes', value: 393, unit: 'minutes',
        baseline: { center: 410, low: 365, high: 440, thin: false }, asOfMs: NIGHT_END,
        strip: strip([420, 380, 450, 400, 415, 390, 393]),
      }),
      efficiency: glanceFigure({ metric: 'sleep_efficiency', value: 91, unit: 'percent', asOfMs: NIGHT_END }),
      // Minutes from the wake date's midnight, negative before it: 23:10 the evening before is -50,
      // the convention derive/sleep.ts writes sleep_bedtime_minutes in.
      bedtime: glanceFigure({ metric: 'sleep_bedtime_minutes', value: -50, unit: 'minutes', asOfMs: NIGHT_END }),
      waketime: glanceFigure({ metric: 'sleep_waketime_minutes', value: 412, unit: 'minutes', asOfMs: NIGHT_END }),
    },
    recovery: {
      index: glanceFigure({
        metric: 'recovery_index', value: 42, unit: 'score',
        // Null, as core always sends it: the index is already a comparison with the person's usual,
        // and the band below is what the card says about it.
        baseline: null,
        strip: strip([50, 44, 48, 46, 41, 43, 42]),
      }),
      band: 'usual',
      missing: null,
      restingHeartRate: glanceFigure({
        metric: 'resting_heart_rate', value: 62, unit: 'bpm', baseline: { center: 56, low: 52, high: 60, thin: false },
        standing: 'above',
      }),
      hrv: glanceFigure({ metric: 'daily_hrv', value: 51, unit: 'milliseconds', baseline: { center: 50, low: 44, high: 56, thin: false } }),
      respiratoryRate: null,
    },
    day: {
      steps: glanceFigure({
        metric: 'steps', value: 4820, unit: 'count', partial: true,
        baseline: { center: 8700, low: 8000, high: 9500, thin: false },
        // 09:32 UTC, 11:32 in Amsterdam.
        asOfMs: Date.UTC(2026, 8, 23, 9, 32),
        strip: strip([8900, 7400, 10100, 8300, 9700, 8800, 4820]),
      }),
      stepsPace: null,
      activeMinutes: glanceFigure({ metric: 'active_minutes', value: 18, unit: 'minutes', partial: true }),
      heartRate: {
        points: [
          { sourceId: 'watch', utcMs: Date.UTC(2026, 8, 23, 6, 0), min: 58, mean: 62, max: 70, n: 1, excluded: false },
          { sourceId: 'watch', utcMs: Date.UTC(2026, 8, 23, 9, 38), min: 64, mean: 71, max: 80, n: 1, excluded: false },
        ],
        // 09:38 UTC, 11:38 in Amsterdam: later than the steps' own as-of, so the span line can be
        // told apart from a page that read the wrong one.
        asOfMs: Date.UTC(2026, 8, 23, 9, 38),
        staleSources: [],
      },
      // None by default, so every test that is not about the workouts card sees the page it saw
      // before the card existed; glance-page.test.tsx's own workout cases add one.
      workouts: [],
    },
    // total is the whole strip's sum (8900+7400+10100+8300+9700+8800+4820), today's so-far included.
    week: { steps: { perDay: 8000, days: 6, total: 58020 }, activeMinutes: null, asleep: null },
    // The M9c fields (day navigation): every existing test here is a today glance, so false and no
    // neighbours is the honest default; a finished-day test overrides both.
    finished: false,
    nav: { previous: null, next: null },
  }
}
