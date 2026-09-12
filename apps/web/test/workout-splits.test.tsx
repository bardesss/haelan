import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { workoutDetail } from '@haelan/core/workout-summary'
import { WorkoutZones, zoneRows, SESSION_ZONE_KEYS } from '../src/pages/activity/WorkoutZones.js'
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
