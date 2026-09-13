import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { workoutDetail } from '@haelan/core/workout-summary'
import type { WorkoutSplit } from '@haelan/core/workout-summary'
import { fillSplitHeartRate } from '@haelan/core/split-heart-rate'
import type { FilledSplit } from '@haelan/core/split-heart-rate'
import { WorkoutZones, zoneRows, SESSION_ZONE_KEYS } from '../src/pages/activity/WorkoutZones.js'
import { WorkoutSplits } from '../src/pages/activity/WorkoutSplits.js'
import { WorkoutDynamics } from '../src/pages/activity/WorkoutDynamics.js'
import { formatNumber } from '../src/format.js'
import type { Translate } from '../src/format.js'

// Neither file in this test initialises an i18next instance (this describe block's own comment,
// below, says why for the zones cases; WorkoutSplits and WorkoutDynamics are function components
// that call useTranslation() themselves and get the same uninitialised fallback). react-i18next's
// fallback in that state returns the bare key for every t() call, and leaves i18n.language exactly
// `undefined` (confirmed by reading it directly from a probe component) rather than the empty
// string or a placeholder tag - which matters here because formatNumber below is called with that
// same `undefined` so an expectation's own number formatting tracks whatever the running host's
// default locale is, instead of a decimal separator hardcoded into the test.
const NO_I18N_LANGUAGE = undefined as unknown as string
const ABSENT = 'common.absent'

// No I18nProvider: with no i18next initialised, t() returns the key it was asked for, so these
// assert which key the component chose rather than copy a catalogue is free to reword.
const t: Translate = (key: string) => key

describe('a session\'s own heart rate zones', () => {
  it('reads the four durations the provider writes on a session', () => {
    const detail = workoutDetail({
      metricsSummary: {
        heartRateZoneDurations: {
          lightTime: '600s', moderateTime: '1200s', vigorousTime: '900s', peakTime: '120s',
        },
      },
    })
    expect(zoneRows(detail.zones!, t).map((row) => [row.zone, row.minutes])).toEqual([
      ['light', 10], ['moderate', 20], ['vigorous', 15], ['peak', 2],
    ])
  })

  it('keeps the session vocabulary apart from the intraday one', () => {
    // Four zones here, three there (FAT_BURN/CARDIO/PEAK). Similar-sounding, different sets,
    // different sources. This project has already shipped enum drift that discarded real data.
    expect(SESSION_ZONE_KEYS).toEqual(['light', 'moderate', 'vigorous', 'peak'])
    const keys = zoneRows(
      workoutDetail({ metricsSummary: { heartRateZoneDurations: { lightTime: '60s' } } }).zones!, t,
    ).map((row) => row.label)
    for (const key of keys) {
      expect(key.startsWith('activity.workout.zones.')).toBe(true)
      expect(key).not.toContain('activeZoneMinutes')
    }
  })

  it('keeps a zone the session recorded as zero, and drops one it did not record', () => {
    const detail = workoutDetail({
      metricsSummary: { heartRateZoneDurations: { lightTime: '0s', peakTime: '120s' } },
    })
    expect(zoneRows(detail.zones!, t).map((row) => row.zone)).toEqual(['light', 'peak'])
    expect(zoneRows(detail.zones!, t)[0]!.minutes).toBe(0)
  })

  it('renders no card at all when the session recorded no zones', () => {
    const detail = workoutDetail({ metricsSummary: {} })
    expect(renderToStaticMarkup(<WorkoutZones detail={detail} />)).toBe('')
  })
})

const split = (over: Record<string, unknown> = {}) => ({
  startTime: '2026-08-03T06:00:00Z', endTime: '2026-08-03T06:05:00Z',
  splitType: 'DISTANCE', activeDuration: '300s',
  metricsSummary: { distanceMillimeters: 1_000_000, averagePaceSecondsPerMeter: 0.3, averageHeartRateBeatsPerMinute: '150' },
  ...over,
})

// Each Card's own label span, in document order. Extracted rather than searched for with
// `toContain`, because `lapLabel` is a literal prefix of `lapLabelTyped` - a substring check for
// the untyped key would also match the typed one silently, and a test written that way would
// still pass against a component that always rendered the typed key. Reading the exact label
// text out of each card is the assertion that actually distinguishes the two.
const labelsIn = (html: string): string[] =>
  [...html.matchAll(/<span class="label">([^<]*)<\/span>/g)].map((match) => match[1]!)

/** Every value cell in a split row, in column order: #, distance, duration, pace, heart rate. */
const cellsIn = (html: string): string[] =>
  [...html.matchAll(/<td>([^<]*)<\/td>/g)].map((match) => match[1]!)

/**
 * The value and unit StatTile rendered for one WorkoutDynamics tile, named by its own label key -
 * or null when that tile is absent. Anchored on `</span></header>` right after the label so this
 * never matches the *card's* own label (`activity.workout.dynamics.label`, rendered by Card.tsx
 * with no following `</header>` at all), only a tile's.
 */
const dynamicsTile = (html: string, key: string): { value: string, unit: string } | null => {
  const match = html.match(new RegExp(
    `<span class="label">activity\\.workout\\.dynamics\\.${key}</span></header>`
    + `<div class="value">([^<]*)(?:<span[^>]*> ([^<]*)</span>)?</div>`,
  ))
  return match ? { value: match[1]!, unit: match[2] ?? '' } : null
}

/**
 * Runs a decoded WorkoutSplit[] through the real fillSplitHeartRate with no trace minutes at all,
 * so a provider value stays 'provider' and an absent one stays null - the same shape
 * readWorkoutSplits hands the component in production, without hand-building a FilledSplit for
 * every fixture below. Task 11's own suite (split-heart-rate.test.ts) already covers the fill
 * logic itself; this file is only testing what WorkoutSplits does with the result.
 */
function fill(rows: readonly WorkoutSplit[]): FilledSplit[] {
  return fillSplitHeartRate(rows, [])
}

function renderWorkout(props: { autoSplits?: readonly FilledSplit[], laps?: readonly FilledSplit[] }): string {
  return renderToStaticMarkup(
    <WorkoutSplits autoSplits={props.autoSplits ?? []} laps={props.laps ?? []} />,
  )
}

describe('the splits card', () => {
  // Four workouts in five have no splits at all: 37 of 197 measured. The absent state is the
  // common case, not the exception, which is why it is asserted first.
  it('renders nothing for the four sessions in five that recorded neither', () => {
    expect(renderWorkout({})).toBe('')
  })

  it('renders the provider\'s automatic splits when the session carries them', () => {
    const detail = workoutDetail({ splits: [split(), split()] })
    const html = renderWorkout({ autoSplits: fill(detail.autoSplits) })
    expect(labelsIn(html)).toEqual(['activity.workout.splits.autoLabel'])
    expect(html.match(/<table/g) ?? []).toHaveLength(1)
  })

  it('labels recorded laps by their own split type, and never merges them with automatic splits', () => {
    // A manual lap and an automatic kilometre are different claims about the same run. No device in
    // this household has ever written a lap (0 of 197, every splitType DISTANCE), so this is mapped
    // for the schema rather than on evidence - and it still must not fold into the other table.
    const detail = workoutDetail({ splits: [split()], splitSummaries: [split({ splitType: 'MANUAL' })] })
    const html = renderWorkout({ autoSplits: fill(detail.autoSplits), laps: fill(detail.laps) })
    expect(labelsIn(html)).toEqual([
      'activity.workout.splits.autoLabel',
      'activity.workout.splits.lapLabelTyped',
    ])
    const tables = html.match(/<table/g) ?? []
    expect(tables).toHaveLength(2)
  })

  it('renders a lap table alone when only laps were recorded, labelled by their own type', () => {
    const detail = workoutDetail({ splitSummaries: [split()] })
    const html = renderWorkout({ laps: fill(detail.laps) })
    expect(labelsIn(html)).toEqual(['activity.workout.splits.lapLabelTyped'])
    expect(html.match(/<table/g) ?? []).toHaveLength(1)
  })

  it('falls back to the untyped label when a recorded lap carries no split type at all', () => {
    const detail = workoutDetail({ splitSummaries: [split({ splitType: null })] })
    const html = renderWorkout({ laps: fill(detail.laps) })
    expect(labelsIn(html)).toEqual(['activity.workout.splits.lapLabel'])
  })

  it('leaves a cell out rather than printing a zero for a split that recorded nothing there', () => {
    const bare = { startTime: '2026-08-03T06:00:00Z', endTime: '2026-08-03T06:05:00Z' }
    const detail = workoutDetail({ splits: [bare] })
    const html = renderWorkout({ autoSplits: fill(detail.autoSplits) })
    // Final review finding: `not.toContain('>0<')` was the only assertion here, and it can never
    // fail. Every value cell already appends a unit after its number (`0.00 km`, `0 min`, `0 bpm`),
    // so the literal text `>0<` is unreachable for ANY input, recorded-zero or absent alike - a
    // `SplitTable` written with truthiness instead of `!== null` (the very defect the `cell` helper
    // exists to prevent) would pass this unchanged. Asserting the four measured cells positively,
    // by name, is what actually pins the absent marker: only the row number is a real value.
    expect(cellsIn(html)).toEqual(['1', ABSENT, ABSENT, ABSENT, ABSENT])
  })

  it('prints a recorded zero as a zero quantity, never as the absent marker', () => {
    // Pairs with the case above: that one proves an unrecorded cell is left out, this one proves a
    // cell recorded as an actual zero is not swept into the same absence by a truthiness check.
    const zeroDistance = {
      startTime: '2026-08-03T06:00:00Z', endTime: '2026-08-03T06:05:00Z',
      metricsSummary: { distanceMillimeters: 0 },
    }
    const detail = workoutDetail({ splits: [zeroDistance] })
    const html = renderWorkout({ autoSplits: fill(detail.autoSplits) })
    const cells = cellsIn(html)
    // The same conversion SplitTable performs (millimetres to km, two decimal places) through the
    // same formatNumber it calls, so this expectation tracks the runtime's own number formatting
    // (NO_I18N_LANGUAGE's own comment above) rather than a decimal separator guessed at here.
    expect(cells[1]).toBe(`${formatNumber(0, 2, NO_I18N_LANGUAGE, '')} activity.units.km`)
    // The other three cells recorded nothing at all, and stay absent - a recorded zero in one
    // field must not turn every field on the row into a zero.
    expect(cells.slice(2)).toEqual([ABSENT, ABSENT, ABSENT])
  })
})

// A minimal FilledSplit fixture, decoded-shape rather than provider-shape (unlike `split()`
// above), since these cases are testing what the component does with an already-filled row, not
// the decoder. startMs/endMs are null throughout: fillSplitHeartRate is not in play here (the
// fixtures below set averageHeartRateBpmSource directly), and the table never reads either field.
const FILLED_SPLIT: FilledSplit = {
  startMs: null, endMs: null, splitType: 'DISTANCE', activeDurationSeconds: 300,
  distanceMeters: 1000, paceSecondsPerKm: 300, averageHeartRateBpm: null, averageHeartRateBpmSource: null,
}

describe('marking a heart rate filled from the trace', () => {
  it('marks a heart rate filled from the trace, and says so once under the table', () => {
    const html = renderWorkout({
      autoSplits: [{ ...FILLED_SPLIT, averageHeartRateBpm: 176, averageHeartRateBpmSource: 'trace' }],
    })
    // The whole cell, never a substring: getByText/toContain('176') would also match the unmarked
    // cell the next test renders, and would not have caught the marker's absence.
    expect(cellsIn(html).at(-1)).toBe('176† activity.units.bpm')
    expect(html).toContain('activity.workout.splits.filledFromTrace')
  })

  it('does not mark a heart rate the watch sent, and carries no footnote for it', () => {
    const html = renderWorkout({
      autoSplits: [{ ...FILLED_SPLIT, averageHeartRateBpm: 176, averageHeartRateBpmSource: 'provider' }],
    })
    expect(cellsIn(html).at(-1)).toBe('176 activity.units.bpm')
    expect(html).not.toContain('activity.workout.splits.filledFromTrace')
  })

  // The footnote is per table, not per page: a table of provider values must not carry a note
  // about a fill that did not happen anywhere in it.
  it('carries no footnote under a table where nothing was filled', () => {
    const html = renderWorkout({
      autoSplits: [{ ...FILLED_SPLIT, averageHeartRateBpm: 150, averageHeartRateBpmSource: 'provider' }],
      laps: [{ ...FILLED_SPLIT, averageHeartRateBpm: 160, averageHeartRateBpmSource: 'provider' }],
    })
    expect(html).not.toContain('activity.workout.splits.filledFromTrace')
  })

  // The mirror of the case above: one table filled and the other not must not let the filled
  // table's footnote leak onto the table that has nothing to explain.
  it('foots only the table that actually filled a row, not its sibling', () => {
    const html = renderWorkout({
      autoSplits: [{ ...FILLED_SPLIT, averageHeartRateBpm: 176, averageHeartRateBpmSource: 'trace' }],
      laps: [{ ...FILLED_SPLIT, averageHeartRateBpm: 160, averageHeartRateBpmSource: 'provider' }],
    })
    expect(html.match(/activity\.workout\.splits\.filledFromTrace/g) ?? []).toHaveLength(1)
  })
})

describe('the running dynamics card', () => {
  it('is absent on the sessions that are not advanced runs', () => {
    // 35 of 197 carry mobilityMetrics: absent by design rather than by failure.
    expect(renderToStaticMarkup(<WorkoutDynamics detail={workoutDetail({})} />)).toBe('')
  })

  it('shows the five metrics an advanced run records', () => {
    const detail = workoutDetail({
      metricsSummary: {
        mobilityMetrics: {
          avgCadenceStepsPerMinute: 172, avgStrideLengthMillimeters: 1150,
          avgGroundContactTimeDuration: '0.24s', avgVerticalOscillationMillimeters: 82,
          avgVerticalRatio: 7.1,
        },
      },
    })
    const html = renderToStaticMarkup(<WorkoutDynamics detail={detail} />)
    for (const key of ['cadence', 'stride', 'groundContact', 'oscillation', 'verticalRatio']) {
      expect(html).toContain(`activity.workout.dynamics.${key}`)
    }
  })

  it('renders only the tiles a partial reading actually recorded, each with its converted value and unit', () => {
    // Ground contact time and vertical oscillation are the two fields mobilityFrom (core's own
    // decoder) converts to a different unit than the one the provider wrote - seconds to
    // milliseconds and metres to centimetres - and nothing asserted either conversion until this
    // case. Final review finding. Cadence, stride and vertical ratio are left out of the fixture
    // on purpose, to prove absence per-field (mobilityFrom's own "not null-if-any" rule) rather
    // than per-session: a session that records some of the five still gets tiles for exactly those.
    const detail = workoutDetail({
      metricsSummary: {
        mobilityMetrics: {
          avgGroundContactTimeDuration: '0.242s',
          avgVerticalOscillationMillimeters: 85,
        },
      },
    })
    const html = renderToStaticMarkup(<WorkoutDynamics detail={detail} />)

    for (const key of ['cadence', 'stride', 'verticalRatio']) {
      expect(dynamicsTile(html, key)).toBeNull()
    }
    // 0.242s * 1000 = 242ms, rounded to a whole number (WorkoutDynamics' own precision for this
    // tile).
    expect(dynamicsTile(html, 'groundContact')).toEqual({
      value: formatNumber(242, 0, NO_I18N_LANGUAGE, ''), unit: 'activity.units.ms',
    })
    // 85mm -> 0.085m (mobilityFrom's own conversion) * 100 = 8.5cm, one decimal place.
    expect(dynamicsTile(html, 'oscillation')).toEqual({
      value: formatNumber(8.5, 1, NO_I18N_LANGUAGE, ''), unit: 'activity.units.cm',
    })
  })
})
