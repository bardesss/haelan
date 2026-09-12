import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { workoutDetail } from '@haelan/core/workout-summary'
import { WorkoutZones, zoneRows, SESSION_ZONE_KEYS } from '../src/pages/activity/WorkoutZones.js'
import { WorkoutSplits } from '../src/pages/activity/WorkoutSplits.js'
import { WorkoutDynamics } from '../src/pages/activity/WorkoutDynamics.js'
import type { Translate } from '../src/format.js'

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

describe('the splits card', () => {
  // Four workouts in five have no splits at all: 37 of 197 measured. The absent state is the
  // common case, not the exception, which is why it is asserted first.
  it('renders nothing for the four sessions in five that recorded neither', () => {
    expect(renderToStaticMarkup(<WorkoutSplits detail={workoutDetail({})} />)).toBe('')
  })

  it('renders the provider\'s automatic splits when the session carries them', () => {
    const html = renderToStaticMarkup(<WorkoutSplits detail={workoutDetail({ splits: [split(), split()] })} />)
    expect(labelsIn(html)).toEqual(['activity.workout.splits.autoLabel'])
    expect(html.match(/<table/g) ?? []).toHaveLength(1)
  })

  it('labels recorded laps by their own split type, and never merges them with automatic splits', () => {
    // A manual lap and an automatic kilometre are different claims about the same run. No device in
    // this household has ever written a lap (0 of 197, every splitType DISTANCE), so this is mapped
    // for the schema rather than on evidence - and it still must not fold into the other table.
    const detail = workoutDetail({ splits: [split()], splitSummaries: [split({ splitType: 'MANUAL' })] })
    const html = renderToStaticMarkup(<WorkoutSplits detail={detail} />)
    expect(labelsIn(html)).toEqual([
      'activity.workout.splits.autoLabel',
      'activity.workout.splits.lapLabelTyped',
    ])
    const tables = html.match(/<table/g) ?? []
    expect(tables).toHaveLength(2)
  })

  it('renders a lap table alone when only laps were recorded, labelled by their own type', () => {
    const html = renderToStaticMarkup(<WorkoutSplits detail={workoutDetail({ splitSummaries: [split()] })} />)
    expect(labelsIn(html)).toEqual(['activity.workout.splits.lapLabelTyped'])
    expect(html.match(/<table/g) ?? []).toHaveLength(1)
  })

  it('falls back to the untyped label when a recorded lap carries no split type at all', () => {
    const html = renderToStaticMarkup(
      <WorkoutSplits detail={workoutDetail({ splitSummaries: [split({ splitType: null })] })} />,
    )
    expect(labelsIn(html)).toEqual(['activity.workout.splits.lapLabel'])
  })

  it('leaves a cell out rather than printing a zero for a split that recorded nothing there', () => {
    const bare = { startTime: '2026-08-03T06:00:00Z', endTime: '2026-08-03T06:05:00Z' }
    const html = renderToStaticMarkup(<WorkoutSplits detail={workoutDetail({ splits: [bare] })} />)
    expect(html).not.toContain('>0<')
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
})
