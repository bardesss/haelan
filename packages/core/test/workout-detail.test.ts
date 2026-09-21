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

  it('reports a withheld route as true, and every silent session as false', () => {
    // A boolean rather than a third null state, unlike hasGps: only the companion app can say this,
    // and it only says it when Health Connect refused to release a track it has. Everything else -
    // every Google session, every indoor workout - is a plain false, which the page reads as
    // nothing worth a sentence.
    expect(workoutDetail({ routeConsentRequired: true }).routeConsentRequired).toBe(true)
    expect(workoutDetail({}).routeConsentRequired).toBe(false)
  })

  it('is not fooled by a value that merely looks true', () => {
    // attrs is parsed from an archived body, so anything can be in this field. A truthy string
    // would otherwise tell a household their route was withheld on the strength of a typo.
    expect(workoutDetail({ routeConsentRequired: 'true' }).routeConsentRequired).toBe(false)
    expect(workoutDetail({ routeConsentRequired: 1 }).routeConsentRequired).toBe(false)
  })

  it('reports hasGps null rather than false when the metadata is absent, false when the provider said so itself', () => {
    // Task 7: a companion session with no exerciseMetadata at all is not a session Google told us
    // carried no route - it is a session this app has no metadata for, and false would claim the
    // certainty null instead states honestly. A provider that sent an explicit false is a
    // different fact and survives as one.
    expect(EMPTY.hasGps).toBeNull()
    expect(workoutDetail({ exerciseMetadata: { hasGps: false } }).hasGps).toBe(false)
    expect(workoutDetail({ exerciseMetadata: {} }).hasGps).toBeNull()
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

  it('answers null zones for an object carrying no readable zone, not four nulls', () => {
    // The caller's question is "is there a breakdown to render?", and it asks it as
    // `zones === null`. An object of four nulls would answer yes and then render four blanks, so
    // every call site would need a second any-non-null test - the branch this module exists to
    // spare them.
    expect(workoutDetail({ metricsSummary: { heartRateZoneDurations: {} } }).zones).toBeNull()
    expect(workoutDetail({
      metricsSummary: { heartRateZoneDurations: { lightTime: 'not a duration' } },
    }).zones).toBeNull()
  })

  it('answers null mobility for an object carrying no readable metric, by the same rule', () => {
    expect(workoutDetail({ metricsSummary: { mobilityMetrics: {} } }).mobility).toBeNull()
  })

  it('keeps zones when one member is readable and the rest are absent', () => {
    // The rule is "every member null", not "any member null": a device that recorded only time in
    // the peak zone still recorded something, and dropping it would lose a real measurement.
    const zones = workoutDetail({
      metricsSummary: { heartRateZoneDurations: { peakTime: '120s' } },
    }).zones
    expect(zones).not.toBeNull()
    expect(zones?.peakSeconds).toBe(120)
    expect(zones?.lightSeconds).toBeNull()
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

  it('reads a marker of any type the v4 schema allows, keeping the type the device wrote', () => {
    // Both types here are read because the schema has both, not because this archive holds both:
    // across 197 measured sessions it holds 44 PAUSE, 96 START and 117 STOP, and not one RESUME or
    // AUTO variant. The page therefore marks each PAUSE instant and gets total paused time as
    // elapsed minus activeDuration, since an interval needs two ends and the data supplies one.
    // The decoder still reads every type, because another device may write what this one does not.
    const d = workoutDetail({
      exerciseEvents: [
        { eventTime: '2026-08-18T06:10:00Z', eventUtcOffset: '7200s', exerciseEventType: 'PAUSE' },
        { eventTime: '2026-08-18T06:12:00Z', eventUtcOffset: '7200s', exerciseEventType: 'RESUME' },
      ],
    })
    expect(d.events).toEqual([
      { atMs: Date.parse('2026-08-18T06:10:00Z'), kind: 'PAUSE' },
      { atMs: Date.parse('2026-08-18T06:12:00Z'), kind: 'RESUME' },
    ])
  })

  it('keeps an event whose time will not parse, rather than dropping the marker', () => {
    // atMs null means the chart cannot place the shading, which the page can handle. Dropping the
    // entry instead would silently turn a paused run into one that never stopped, and a reader
    // counting pauses would be told a different story than the device recorded.
    const d = workoutDetail({ exerciseEvents: [{ eventTime: 'not a time', exerciseEventType: 'PAUSE' }] })
    expect(d.events).toEqual([{ atMs: null, kind: 'PAUSE' }])
  })

  it('drops an event entry that is not an object', () => {
    expect(workoutDetail({ exerciseEvents: ['nonsense', null, 7] }).events).toEqual([])
  })

  it('drops an event with neither a readable time nor a type, which is evidence of nothing', () => {
    // { atMs: null, kind: null } says something unnamed happened at no particular moment. It
    // cannot be shaded, labelled or counted as a pause, so keeping it would put an unexplainable
    // marker in the array rather than preserve a fact about the workout.
    const d = workoutDetail({
      exerciseEvents: [{ eventTime: 'not a time' }, {}, { exerciseEventType: 7 }],
    })
    expect(d.events).toEqual([])
  })

  it('keeps an event with only one of the two, in either direction', () => {
    // The other direction of the same rule, which is where the line is actually drawn: either
    // half alone still says something true, so either half alone is kept. A typed event with a
    // broken clock is the case this protects, and PAUSE is the only mid-session type this
    // household's archive holds.
    const d = workoutDetail({
      exerciseEvents: [
        { eventTime: 'not a time', exerciseEventType: 'PAUSE' },
        { eventTime: '2026-08-18T06:12:00Z' },
      ],
    })
    expect(d.events).toEqual([
      { atMs: null, kind: 'PAUSE' },
      { atMs: Date.parse('2026-08-18T06:12:00Z'), kind: null },
    ])
  })

  it('answers an empty events array for a workout that recorded none', () => {
    expect(EMPTY.events).toEqual([])
  })

  it('answers empty arrays, never null, for a workout with no splits', () => {
    // An empty array is what a caller can map over without a guard. The distinction the mapper
    // preserves - no array against an empty array - has no consumer at this layer, because both
    // render the same absent table.
    expect(EMPTY.autoSplits).toEqual([])
    expect(EMPTY.laps).toEqual([])
  })

  it('drops a split entry carrying nothing readable, and keeps one carrying anything', () => {
    // A row of seven nulls renders as a lap that happened at no time, for no distance, at no
    // pace. One readable member is enough to keep the row, because then the table has something
    // to say.
    const d = workoutDetail({ splits: [{}, { metricsSummary: {} }, { splitType: 'DISTANCE' }] })
    expect(d.autoSplits).toHaveLength(1)
    expect(d.autoSplits[0]?.splitType).toBe('DISTANCE')
    expect(d.autoSplits[0]?.distanceMeters).toBeNull()
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
      expect(d.hasGps).toBeNull()
    }
  })
})
