import { describe, expect, it } from 'vitest'
import { workoutDetail } from '../src/api/workoutSummary.ts'

const EMPTY = workoutDetail({})

describe('workoutDetail', () => {
  it('reads the plain fields the mapper now carries', () => {
    const d = workoutDetail({
      displayName: 'Evening Run',
      notes: 'legs felt heavy',
      activeDuration: '1680s',
      exerciseMetadata: { hasGps: true, poolLengthMillimeters: '25000' },
    })
    expect(d.displayName).toBe('Evening Run')
    expect(d.notes).toBe('legs felt heavy')
    expect(d.activeDurationSeconds).toBe(1680)
    expect(d.hasGps).toBe(true)
    expect(d.poolLengthMeters).toBe(25)
  })

  it('reports hasGps false rather than null when the metadata is absent', () => {
    // A tri-state here would make every call site write the same three-way branch to render one
    // sentence. False means "no reason to say a route was recorded", which is the only thing the
    // page does with it.
    expect(EMPTY.hasGps).toBe(false)
    expect(workoutDetail({ exerciseMetadata: { hasGps: false } }).hasGps).toBe(false)
  })

  it('reads the four session zones, which are not the three intraday ones', () => {
    const d = workoutDetail({
      metricsSummary: {
        heartRateZoneDurations: {
          lightTime: '600s', moderateTime: '900s', vigorousTime: '300s', peakTime: '60s',
        },
      },
    })
    expect(d.zones).toEqual({
      lightSeconds: 600, moderateSeconds: 900, vigorousSeconds: 300, peakSeconds: 60,
    })
  })

  it('keeps a zone the device did not record as null, not as zero seconds', () => {
    const d = workoutDetail({
      metricsSummary: { heartRateZoneDurations: { lightTime: '600s' } },
    })
    expect(d.zones?.lightSeconds).toBe(600)
    expect(d.zones?.peakSeconds).toBeNull()
  })

  it('keeps a recorded zero as zero', () => {
    const d = workoutDetail({
      metricsSummary: { heartRateZoneDurations: { peakTime: '0s' } },
    })
    // "Never reached the peak zone" is a measurement. A guard written as `value ? x : null` would
    // discard it, which is the distinction workoutSummary's own tests already pin.
    expect(d.zones?.peakSeconds).toBe(0)
  })

  it('answers null zones when the summary carries none at all', () => {
    expect(EMPTY.zones).toBeNull()
  })

  it('reads the five mobility metrics, converting the millimetre ones', () => {
    const d = workoutDetail({
      metricsSummary: {
        mobilityMetrics: {
          avgCadenceStepsPerMinute: 168,
          avgStrideLengthMillimeters: '1180',
          avgGroundContactTimeDuration: '0.256s',
          avgVerticalOscillationMillimeters: '92',
          avgVerticalRatio: 7.8,
        },
      },
    })
    expect(d.mobility).toEqual({
      cadenceStepsPerMinute: 168,
      strideLengthMeters: 1.18,
      groundContactTimeSeconds: 0.256,
      verticalOscillationMeters: 0.092,
      verticalRatio: 7.8,
    })
  })

  it('answers null mobility on a workout that is not an advanced run', () => {
    expect(EMPTY.mobility).toBeNull()
  })

  it('reads the remaining scalars off metricsSummary', () => {
    const d = workoutDetail({
      metricsSummary: {
        runVo2Max: 48.2,
        averageSpeedMillimetersPerSecond: 2_640,
        totalSwimLengths: 24,
      },
    })
    expect(d.runVo2Max).toBe(48.2)
    expect(d.averageSpeedMetersPerSecond).toBe(2.64)
    expect(d.totalSwimLengths).toBe(24)
  })

  it('reads both split arrays into one shape, keeping them apart', () => {
    const d = workoutDetail({
      splits: [{
        startTime: '2026-08-18T06:00:00Z', endTime: '2026-08-18T06:06:19Z',
        activeDuration: '379s', splitType: 'DISTANCE',
        metricsSummary: { distanceMillimeters: 1_000_000, averagePaceSecondsPerMeter: 0.379 },
      }],
      splitSummaries: [{
        startTime: '2026-08-18T06:00:00Z', endTime: '2026-08-18T06:15:00Z',
        activeDuration: '900s', splitType: 'MANUAL',
        metricsSummary: { distanceMillimeters: 2_400_000, averageHeartRateBeatsPerMinute: '154' },
      }],
    })

    expect(d.autoSplits).toHaveLength(1)
    expect(d.autoSplits[0]).toEqual({
      startMs: Date.parse('2026-08-18T06:00:00Z'),
      endMs: Date.parse('2026-08-18T06:06:19Z'),
      splitType: 'DISTANCE',
      activeDurationSeconds: 379,
      distanceMeters: 1000,
      paceSecondsPerKm: 379,
      averageHeartRateBpm: null,
    })

    // A manual lap and an automatic kilometre are different claims about the same run, so they
    // stay in different arrays rather than being concatenated into one table.
    expect(d.laps).toHaveLength(1)
    expect(d.laps[0]?.splitType).toBe('MANUAL')
    expect(d.laps[0]?.averageHeartRateBpm).toBe(154)
    expect(d.laps[0]?.paceSecondsPerKm).toBeNull()
  })

  it('answers empty arrays, never null, for a workout with no splits', () => {
    // An empty array is what a caller can map over without a guard. The distinction the mapper
    // preserves - no array against an empty array - has no consumer at this layer, because both
    // render the same absent table.
    expect(EMPTY.autoSplits).toEqual([])
    expect(EMPTY.laps).toEqual([])
  })

  it('drops a split entry that is not an object rather than throwing', () => {
    // This app has no error boundary around a reader: a throw here unmounts the page rather than
    // dropping one row, which is what workoutSummary's own file comment says about attrs.
    const d = workoutDetail({ splits: ['nonsense', null, 42] })
    expect(d.autoSplits).toEqual([])
  })

  it('returns the all-absent shape for attrs that is not an object at all', () => {
    for (const attrs of [null, undefined, 'string', 42, []]) {
      const d = workoutDetail(attrs)
      expect(d.displayName).toBeNull()
      expect(d.autoSplits).toEqual([])
      expect(d.hasGps).toBe(false)
    }
  })
})
