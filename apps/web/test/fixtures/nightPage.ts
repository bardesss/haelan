import { morningSummaryOfMorning } from '@haelan/core'
import type { GlanceBaseline, GlanceFigure, GlanceStanding } from '../../src/data/useGlance.js'
import type { NightPageData, NightTrace, PageFigure } from '../../src/data/useNightPage.js'

// One whole night page (GET /p/:personId/night/:localDate) in the wire shape the route sends:
// packages/core/src/query/nightPage.ts's NightPage after apps/server/src/routes/v1/detail.ts's
// roundNightPage (every figure at its own precision, stage shares whole percents, the balance
// taken again from the rounded strip) plus the day's `log`. Every section is populated, so a test
// about one section starts from a page where every other section has something to draw, and blanks
// only what it is about with the helpers at the bottom.
//
// Synthetic numbers, shaped like the approved A4 mockup: a Sunday night slept 00:08 to 07:09 in
// Europe/Amsterdam (two hours ahead of UTC), filed under the date it ended on.

export const NIGHT_DATE = '2026-09-06'
export const NIGHT_PREVIOUS = '2026-09-05'
export const NIGHT_NEXT = '2026-09-07'
/** The server's today on this payload's log: the day after the night's own date. */
export const NIGHT_TODAY = '2026-09-07'

/** The seven nights a strip covers, this one last. */
export const STRIP_DATES = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', NIGHT_DATE]

const OFFSET = 120
// 00:08 and 07:09 local, as UTC instants.
const START = Date.UTC(2026, 8, 5, 22, 8)
const END = Date.UTC(2026, 8, 6, 5, 9)
const at = (minutesAfterStart: number) => START + minutesAfterStart * 60_000

function standingOf(value: number | null, band: GlanceBaseline | null): GlanceStanding | null {
  if (value === null || band === null || band.thin) return null
  return value < band.low ? 'below' : value > band.high ? 'above' : 'within'
}

// The server's own rule (pageFigure.ts's judge), applied to the fixture's own numbers so the
// fixture cannot carry a verdict that contradicts its standing. The page itself never does this.
function judgedOf(standing: GlanceStanding | null, direction: PageFigure['direction']): PageFigure['judged'] {
  if (standing === null || standing === 'within' || direction === 'neutral') return null
  return (standing === 'above') === (direction === 'up') ? 'better' : 'worse'
}

function figure(o: {
  metric: string, unit: string, precision?: number, direction: PageFigure['direction'],
  value: number | null, baseline: GlanceBaseline | null, strip?: (number | null)[],
}): PageFigure {
  const standing = standingOf(o.value, o.baseline)
  return {
    metric: o.metric, value: o.value, unit: o.unit, precision: o.precision ?? 0, direction: o.direction,
    baseline: o.baseline, standing, judged: judgedOf(standing, o.direction),
    // Each strip day judged against the same usual as the night itself: the real server gives each
    // day its own, which for a fixture this size would only add numbers nothing reads.
    strip: o.strip === undefined ? null : STRIP_DATES.map((localDate, i) => {
      const value = o.strip![i] ?? null
      const dayStanding = standingOf(value, o.baseline)
      return { localDate, value, band: o.baseline, standing: dayStanding, judged: judgedOf(dayStanding, o.direction) }
    }),
  }
}

const band = (center: number, low: number, high: number): GlanceBaseline => ({ center, low, high, thin: false })

function glanceFigure(o: Pick<GlanceFigure, 'metric' | 'unit' | 'value'> & { baseline?: GlanceBaseline | null }): GlanceFigure {
  const baseline = o.baseline ?? null
  return {
    metric: o.metric, value: o.value, unit: o.unit, baseline, asOfDate: NIGHT_DATE, asOfMs: null, partial: false,
    staleSources: [], strip: [], standing: standingOf(o.value, baseline), judged: null,
  }
}

function trace(metric: string, unit: string, precision: number, direction: PageFigure['direction'], o: {
  lowest: { value: number, atMs: number }, highest: { value: number, atMs: number }, mean: number,
  usualLowest: GlanceBaseline, usualMean: GlanceBaseline,
}): NightTrace {
  return {
    metric,
    stat: { lowest: o.lowest, highest: o.highest, mean: o.mean },
    lowestFigure: figure({ metric, unit, precision, direction, value: o.lowest.value, baseline: o.usualLowest }),
    meanFigure: figure({ metric, unit, precision, direction, value: o.mean, baseline: o.usualMean }),
  }
}

const ASLEEP_STRIP = [372, 414, 351, 402, 330, 441, 396]
const ZERO_LINE = 450

export function nightPageFixture(): NightPageData {
  const page = nightPageBase()
  // Counted by core's own list of what counts, so a figure added there is counted here too.
  return { ...page, morningSummary: morningSummaryOfMorning(page.morning) }
}

function nightPageBase(): NightPageData {
  const differences = ASLEEP_STRIP.map((minutes) => minutes - ZERO_LINE)
  return {
    localDate: NIGHT_DATE,
    sourceId: 'watch',
    night: {
      localDate: NIGHT_DATE, sourceId: 'watch', sessionIds: ['s1'],
      startMs: START, endMs: END, startOffsetMinutes: OFFSET, endOffsetMinutes: OFFSET,
      naps: [],
      segments: [
        { stage: 'LIGHT', startMs: at(0), endMs: at(52) },
        { stage: 'DEEP', startMs: at(52), endMs: at(116) },
        { stage: 'LIGHT', startMs: at(116), endMs: at(175) },
        { stage: 'REM', startMs: at(175), endMs: at(298) },
        { stage: 'AWAKE', startMs: at(298), endMs: at(323) },
        { stage: 'LIGHT', startMs: at(323), endMs: at(421) },
      ],
      excludedSessions: [],
    },
    nav: { previous: NIGHT_PREVIOUS, next: NIGHT_NEXT },
    figures: {
      asleep: figure({ metric: 'sleep_asleep_minutes', unit: 'minutes', direction: 'up', value: 396, baseline: band(387, 306, 468), strip: ASLEEP_STRIP }),
      efficiency: figure({ metric: 'sleep_efficiency', unit: 'percent', direction: 'up', value: 94, baseline: band(92, 88, 96), strip: [91, 93, 90, 95, 89, 94, 94] }),
      deep: figure({ metric: 'sleep_deep_minutes', unit: 'minutes', direction: 'up', value: 64, baseline: band(85, 70, 100), strip: [82, 90, 77, 95, 71, 88, 64] }),
      rem: figure({ metric: 'sleep_rem_minutes', unit: 'minutes', direction: 'up', value: 123, baseline: band(110, 90, 130), strip: [104, 118, 96, 112, 93, 126, 123] }),
      light: figure({ metric: 'sleep_light_minutes', unit: 'minutes', direction: 'neutral', value: 209, baseline: band(210, 180, 240), strip: [186, 206, 178, 195, 166, 227, 209] }),
      awake: figure({ metric: 'sleep_awake_minutes', unit: 'minutes', direction: 'down', value: 25, baseline: band(25, 10, 40), strip: [30, 22, 35, 18, 38, 20, 25] }),
      inBed: figure({ metric: 'sleep_in_bed_minutes', unit: 'minutes', direction: 'neutral', value: 421, baseline: band(430, 360, 500), strip: [402, 436, 386, 420, 368, 461, 421] }),
      // Minutes from the wake date's midnight, negative before it (derive/sleep.ts's convention):
      // -20 is 23:40 the evening before.
      bedtime: figure({ metric: 'sleep_bedtime_minutes', unit: 'minutes_from_local_midnight', direction: 'neutral', value: 8, baseline: band(-5, -30, 20), strip: [-20, -10, 5, -25, 30, -15, 8] }),
      waketime: figure({ metric: 'sleep_waketime_minutes', unit: 'minutes_from_local_midnight', direction: 'neutral', value: 429, baseline: band(420, 390, 450), strip: [382, 426, 391, 395, 398, 446, 429] }),
      napCount: figure({ metric: 'sleep_nap_count', unit: 'count', direction: 'neutral', value: 0, baseline: band(0, 0, 1), strip: [0, 1, 0, 0, 0, 0, 0] }),
      napMinutes: figure({ metric: 'sleep_nap_minutes', unit: 'minutes', direction: 'neutral', value: null, baseline: band(5, 0, 20), strip: [null, 25, null, null, null, null, null] }),
      minutesToFallAsleep: figure({ metric: 'sleep_latency_minutes', unit: 'minutes', direction: 'down', value: 12, baseline: band(12, 5, 20) }),
      awakenings: figure({ metric: 'sleep_awakenings', unit: 'count', direction: 'down', value: 14, baseline: band(13, 8, 18) }),
      minutesAfterWakeUp: figure({ metric: 'sleep_after_wake_minutes', unit: 'minutes', direction: 'neutral', value: 4, baseline: band(4, 0, 10) }),
      bedtimeVariability: figure({ metric: 'sleep_bedtime_variability', unit: 'minutes', direction: 'down', value: 28, baseline: band(27, 20, 35) }),
    },
    stagePercent: { deep: 16, light: 53, rem: 31 },
    balance: {
      zeroLine: { minutes: ZERO_LINE, source: 'target' },
      nights: STRIP_DATES.map((localDate, i) => ({ localDate, difference: differences[i]! })),
      total: differences.reduce((sum, d) => sum + d, 0),
    },
    traces: {
      heartRate: trace('heart_rate', 'bpm', 0, 'down', {
        lowest: { value: 47, atMs: at(292) }, highest: { value: 71, atMs: at(300) }, mean: 60,
        usualLowest: band(48, 44, 52), usualMean: band(60, 56, 64),
      }),
      hrv: trace('hrv', 'milliseconds', 0, 'up', {
        lowest: { value: 31, atMs: at(400) }, highest: { value: 62, atMs: at(142) }, mean: 47,
        usualLowest: band(30, 24, 36), usualMean: band(48, 42, 54),
      }),
      spo2: trace('spo2', 'percent', 1, 'up', {
        lowest: { value: 94, atMs: at(202) }, highest: { value: 98.1, atMs: at(60) }, mean: 96.2,
        usualLowest: band(93.5, 92, 95), usualMean: band(96, 95.2, 96.8),
      }),
    },
    // From the segments above: deep began 52 minutes in (01:00), REM 175 (03:03), and there was one REM episode.
    stageTiming: {
      firstDeepAtMs: at(52),
      firstRemAtMs: at(175),
      firstDeep: figure({ metric: 'sleep_first_deep_minutes', unit: 'minutes', direction: 'neutral', value: 52, baseline: band(45, 25, 65) }),
      firstRem: figure({ metric: 'sleep_first_rem_minutes', unit: 'minutes', direction: 'neutral', value: 175, baseline: band(95, 70, 120) }),
      cycles: figure({ metric: 'sleep_cycles', unit: 'count', direction: 'neutral', value: 1, baseline: band(3, 2, 4) }),
    },
    // The morning's six judged figures below: skin temperature above its usual, the rest within.
    morningSummary: { outside: 1, of: 6 },
    morning: {
      recovery: {
        index: glanceFigure({ metric: 'recovery_index', unit: 'score', value: 68 }),
        band: 'usual',
        missing: null,
        restingHeartRate: glanceFigure({ metric: 'resting_heart_rate', unit: 'bpm', value: 54, baseline: band(54, 51, 57) }),
        hrv: glanceFigure({ metric: 'daily_hrv', unit: 'milliseconds', value: 49, baseline: band(51, 42, 60) }),
        respiratoryRate: glanceFigure({ metric: 'respiratory_rate', unit: 'breaths_per_minute', value: 14.2, baseline: band(14.3, 13, 15.5) }),
      },
      restingHeartRate: figure({ metric: 'resting_heart_rate', unit: 'bpm', direction: 'down', value: 54, baseline: band(54, 51, 57), strip: [55, 53, 56, 54, 57, 53, 54] }),
      hrv: figure({ metric: 'daily_hrv', unit: 'milliseconds', direction: 'up', value: 49, baseline: band(51, 42, 60), strip: [50, 53, 47, 55, 44, 52, 49] }),
      breathing: figure({ metric: 'sleep_respiratory_rate', unit: 'breaths_per_minute', precision: 1, direction: 'neutral', value: 14.2, baseline: band(14.3, 13, 15.5), strip: [14.1, 14.4, 14.6, 14.0, 14.8, 14.3, 14.2] }),
      spo2: figure({ metric: 'daily_spo2', unit: 'percent', precision: 1, direction: 'up', value: 95.4, baseline: band(95.8, 94.5, 97), strip: [95.9, 96.1, 95.7, 96.0, 95.5, 95.8, 95.4] }),
      skinTemperature: figure({ metric: 'sleep_temperature', unit: 'celsius', precision: 1, direction: 'neutral', value: 33.6, baseline: band(33, 32.7, 33.3), strip: [33.0, 32.9, 33.1, 33.0, 33.2, 33.4, 33.6] }),
      skinTemperatureDeviation: 0.6,
      // The heart-rate trace's lowest 47 against resting 54: (54 - 47) / 54, 13 % as sent.
      heartRateDip: figure({ metric: 'sleep_heart_rate_dip', unit: 'percent', direction: 'up', value: 13, baseline: band(12, 9, 16) }),
    },
    day: {
      localDate: NIGHT_PREVIOUS,
      steps: figure({ metric: 'steps', unit: 'count', direction: 'up', value: 11240, baseline: band(8250, 6000, 10500) }),
      activeMinutes: figure({ metric: 'active_minutes', unit: 'minutes', direction: 'up', value: 48, baseline: band(42, 25, 60) }),
      workouts: [{
        id: 'w1', sourceId: 'watch',
        // 16:10 to 17:02 local on the day before the night.
        startMs: Date.UTC(2026, 8, 5, 14, 10), endMs: Date.UTC(2026, 8, 5, 15, 2),
        startOffsetMinutes: OFFSET, endOffsetMinutes: OFFSET, localDate: NIGHT_PREVIOUS,
        attrs: { exerciseType: 'BIKING', averageHeartRate: 131 },
        excluded: false, excludeReason: null, sources: ['watch'], alternateIds: [],
      }],
    },
    log: {
      presets: ['illness', 'travel', 'alcohol', 'medication', 'injury', 'caffeine'],
      mood: 4,
      counts: { alcohol: 2 },
      note: 'Birthday, home late.',
      today: NIGHT_TODAY,
    },
  }
}

type FigureKey = keyof NightPageData['figures']

/**
 * A figure the night has no reading for, as the server sends one: no value, so no standing and no
 * verdict, and the strip's own last day empty with it. The usual stays, as it does on the wire:
 * the nights before this one still have one whether or not this night was measured.
 */
export function blankFigure(figure: PageFigure): PageFigure {
  return {
    ...figure, value: null, standing: null, judged: null,
    strip: figure.strip === null ? null : figure.strip.map((day, i, all) => (
      i === all.length - 1 ? { ...day, value: null, standing: null } : day)),
  }
}

/** The fixture with the named figures blanked (blankFigure) and everything else as it was. */
export function withBlankFigures(page: NightPageData, keys: readonly FigureKey[]): NightPageData {
  const figures = { ...page.figures }
  for (const key of keys) figures[key] = blankFigure(figures[key])
  return { ...page, figures }
}
