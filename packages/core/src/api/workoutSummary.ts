// The only module allowed to open a WorkoutSession's attrs blob, now that two apps read it: the
// dashboard's activity list and the agent surface's workout tools.
//
// It imports nothing from ../db/ and must not start. apps/web reaches it through the
// `@haelan/core/workout-summary` subpath rather than the root barrel, and the root barrel pulls
// better-sqlite3, which cannot enter a browser bundle.

export interface WorkoutSummary {
  exerciseType: string | null
  caloriesKcal: number | null
  averageHeartRateBpm: number | null
  distanceMeters: number | null
  steps: number | null
  paceSecondsPerKm: number | null
  elevationGainMeters: number | null
  activeZoneMinutes: number | null
}

const ALL_NULL_SUMMARY: WorkoutSummary = {
  exerciseType: null,
  caloriesKcal: null,
  averageHeartRateBpm: null,
  distanceMeters: null,
  steps: null,
  paceSecondsPerKm: null,
  elevationGainMeters: null,
  activeZoneMinutes: null,
}

const MILLIMETERS_PER_METER = 1000
const METERS_PER_KM = 1000

/**
 * The provider mixes JSON types inside one object: caloriesKcal and distanceMillimeters arrive as
 * numbers, while averageHeartRateBeatsPerMinute, steps and activeZoneMinutes arrive as strings.
 * Roughly half the fields are absent on any given session, and only 97 of 192 real sessions carry a
 * distance at all.
 *
 * Presence is tested before the value is coerced, never after. Number(null) is 0 and Number('') is
 * 0, so a reader that coerces first turns a field the session never recorded into a printed zero,
 * and "no distance recorded" and "0 km" are different statements about a workout.
 *
 * A recorded zero survives, from either type. A guard written as `value ? Number(value) : null`
 * would satisfy the absence cases above and silently discard a real zero, which is why the tests
 * assert both directions.
 *
 * Negative zero is normalised on the way out. It is a value JSON can carry and Number('-0')
 * produces, and the formatters do not clean it up: (-0).toLocaleString('nl', {
 * maximumFractionDigits: 0 }) is "-0", so a session recording a signed zero would print a minus
 * sign in front of it. Nothing in the live data carries one, which makes this cheap insurance
 * rather than a fix, but M3e-2 already found the same signed zero reaching a reader through the
 * weight deltas and the same care applies here.
 */
export function numberOrNull(value: unknown): number | null {
  // `n === 0 ? 0 : n` rather than an isNegativeZero test: -0 === 0 is true, so this returns the
  // positive zero literal for both and leaves every other value alone.
  const finite = (n: number): number | null => (Number.isFinite(n) ? (n === 0 ? 0 : n) : null)
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return finite(value)
  if (typeof value !== 'string' || value.trim() === '') return null
  return finite(Number(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The route answers attrs as whatever was stored for that session, and this app has no error
 * boundary: a reader that throws here unmounts the whole page rather than dropping one row. attrs
 * is also one shape across both session kinds, so an exercise row carries the sleep fields present
 * and set to null; narrowing to a record and reading through numberOrNull handles that without
 * asserting a type.
 */
export function workoutSummary(attrs: unknown): WorkoutSummary {
  if (!isRecord(attrs)) return ALL_NULL_SUMMARY

  const exerciseType = typeof attrs.exerciseType === 'string' ? attrs.exerciseType : null
  const metrics = isRecord(attrs.metricsSummary) ? attrs.metricsSummary : {}

  const distanceMillimeters = numberOrNull(metrics.distanceMillimeters)
  const elevationGainMillimeters = numberOrNull(metrics.elevationGainMillimeters)
  const averagePaceSecondsPerMeter = numberOrNull(metrics.averagePaceSecondsPerMeter)

  return {
    exerciseType,
    caloriesKcal: numberOrNull(metrics.caloriesKcal),
    averageHeartRateBpm: numberOrNull(metrics.averageHeartRateBeatsPerMinute),
    distanceMeters: distanceMillimeters === null ? null : distanceMillimeters / MILLIMETERS_PER_METER,
    steps: numberOrNull(metrics.steps),
    paceSecondsPerKm: averagePaceSecondsPerMeter === null
      ? null
      : averagePaceSecondsPerMeter * METERS_PER_KM,
    elevationGainMeters: elevationGainMillimeters === null
      ? null
      : elevationGainMillimeters / MILLIMETERS_PER_METER,
    activeZoneMinutes: numberOrNull(metrics.activeZoneMinutes),
  }
}

export interface WorkoutSplit {
  startMs: number | null
  endMs: number | null
  splitType: string | null
  activeDurationSeconds: number | null
  distanceMeters: number | null
  paceSecondsPerKm: number | null
  averageHeartRateBpm: number | null
}
export interface WorkoutEvent {
  atMs: number | null
  /** `START`, `STOP`, `PAUSE`, `RESUME`, `AUTO_PAUSE`, `AUTO_RESUME`, or the unspecified member. */
  kind: string | null
}
export interface HeartRateZoneDurations {
  lightSeconds: number | null
  moderateSeconds: number | null
  vigorousSeconds: number | null
  peakSeconds: number | null
}
export interface MobilityMetrics {
  cadenceStepsPerMinute: number | null
  strideLengthMeters: number | null
  groundContactTimeSeconds: number | null
  verticalOscillationMeters: number | null
  verticalRatio: number | null
}
export interface WorkoutDetail {
  displayName: string | null
  notes: string | null
  activeDurationSeconds: number | null
  hasGps: boolean
  poolLengthMeters: number | null
  runVo2Max: number | null
  averageSpeedMetersPerSecond: number | null
  totalSwimLengths: number | null
  zones: HeartRateZoneDurations | null
  mobility: MobilityMetrics | null
  autoSplits: WorkoutSplit[]
  laps: WorkoutSplit[]
  /**
   * The markers the device wrote, of whichever types it wrote. They belong on the heart rate
   * trace, so a run with a five minute traffic light stop reads as one run rather than as a
   * mysterious dip - as a mark at each `PAUSE` instant rather than as shading from a pause to its
   * resume, because an interval needs two ends and this archive supplies one: 44 pauses across 197
   * measured sessions and not a single `RESUME`. Total paused time is elapsed minus
   * `activeDuration` instead, which needs no second marker.
   *
   * An earlier draft declared `WorkoutEvent` and then left it out of this shape, which made the
   * interface an export nothing consumed.
   */
  events: WorkoutEvent[]
}

/**
 * The provider writes durations as a protobuf Duration string: a decimal number of seconds with a
 * trailing 's' ('1680s', '0.256s'). Number('1680s') is NaN, so every duration on a session has to
 * come through here rather than through numberOrNull directly.
 *
 * A duration that is already a number is taken as seconds, so a future payload that drops the
 * suffix does not silently read as absent.
 */
export function durationSecondsOrNull(value: unknown): number | null {
  if (typeof value === 'number') return numberOrNull(value)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  return numberOrNull(trimmed.endsWith('s') ? trimmed.slice(0, -1) : trimmed)
}

// Date.parse answers NaN for anything it cannot read, and NaN reaching a chart's x axis is worse
// than a missing point, because it silently collapses a scale.
function instantOrNull(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * A decoded shape whose every member is null is not a thin record, it is an absent one. The
 * provider's empty object and a field it never sent are the same statement about the workout, and
 * answering the first as an object while answering the second as null would leave every call site
 * writing its own "is any of this non-null?" test before it could render anything - which is the
 * exact branch this module exists to spare them. One rule, applied at each decoder that builds a
 * fixed-member shape, rather than three call sites each remembering it.
 *
 * Object.values, not a hand-written list of members: a member added to one of these shapes later
 * is then covered without this function having to be edited to know about it.
 */
function nullIfAllNull<T extends object>(shape: T): T | null {
  return Object.values(shape).every((member) => member === null) ? null : shape
}

// An entry carrying nothing readable at all is dropped for the same reason zonesFrom answers null
// for an empty object: a row of seven nulls is a row a lap table would render as blank cells,
// which says a lap happened and says nothing about it. One readable member is enough to keep it.
function splitFrom(entry: unknown): WorkoutSplit | null {
  if (!isRecord(entry)) return null
  const metrics = isRecord(entry.metricsSummary) ? entry.metricsSummary : {}
  const distanceMillimeters = numberOrNull(metrics.distanceMillimeters)
  const paceSecondsPerMeter = numberOrNull(metrics.averagePaceSecondsPerMeter)
  return nullIfAllNull({
    startMs: instantOrNull(entry.startTime),
    endMs: instantOrNull(entry.endTime),
    splitType: typeof entry.splitType === 'string' ? entry.splitType : null,
    activeDurationSeconds: durationSecondsOrNull(entry.activeDuration),
    distanceMeters: distanceMillimeters === null ? null : distanceMillimeters / MILLIMETERS_PER_METER,
    paceSecondsPerKm: paceSecondsPerMeter === null ? null : paceSecondsPerMeter * METERS_PER_KM,
    averageHeartRateBpm: numberOrNull(metrics.averageHeartRateBeatsPerMinute),
  })
}

// An entry that is not an object is dropped rather than thrown on, as is one that decoded to
// nothing readable (splitFrom's own comment says why), and an absent array reads the same as an
// empty one: both render no table, and a caller that had to distinguish them would write the same
// branch at every call site.
function splitsFrom(value: unknown): WorkoutSplit[] {
  if (!Array.isArray(value)) return []
  return value.map(splitFrom).filter((split): split is WorkoutSplit => split !== null)
}

// null for an object carrying no readable zone at all, not four nulls: `zones === null` is already
// how a caller asks "is there a zone breakdown to render?", and an empty object answering an
// object would make that question wrong in exactly the case it is asked about.
function zonesFrom(value: unknown): HeartRateZoneDurations | null {
  if (!isRecord(value)) return null
  return nullIfAllNull({
    lightSeconds: durationSecondsOrNull(value.lightTime),
    moderateSeconds: durationSecondsOrNull(value.moderateTime),
    vigorousSeconds: durationSecondsOrNull(value.vigorousTime),
    peakSeconds: durationSecondsOrNull(value.peakTime),
  })
}

// Same rule as zonesFrom: `mobility === null` means "not an advanced run, render no card", and an
// empty object is that same workout.
function mobilityFrom(value: unknown): MobilityMetrics | null {
  if (!isRecord(value)) return null
  const strideMillimeters = numberOrNull(value.avgStrideLengthMillimeters)
  const oscillationMillimeters = numberOrNull(value.avgVerticalOscillationMillimeters)
  return nullIfAllNull({
    cadenceStepsPerMinute: numberOrNull(value.avgCadenceStepsPerMinute),
    strideLengthMeters: strideMillimeters === null ? null : strideMillimeters / MILLIMETERS_PER_METER,
    groundContactTimeSeconds: durationSecondsOrNull(value.avgGroundContactTimeDuration),
    verticalOscillationMeters: oscillationMillimeters === null
      ? null
      : oscillationMillimeters / MILLIMETERS_PER_METER,
    verticalRatio: numberOrNull(value.avgVerticalRatio),
  })
}

/**
 * Kept even when the instant will not parse, unlike splitFrom's non-object guard: an event whose
 * time is unreadable is still evidence the device recorded a pause, and dropping it would turn a
 * paused run into one that never stopped. A non-object entry carries no such evidence.
 *
 * The line is drawn at neither half surviving. An entry with no parseable time *and* no event
 * type decodes to `{ atMs: null, kind: null }` - something unnamed happened at no particular
 * moment - which is evidence of nothing and cannot be rendered as anything: an unlabelled marker
 * at an unknown place on the trace. Either half alone is kept, because either half alone still
 * says something true. That asymmetry is deliberate and it is the whole rule: a marker is worth
 * keeping while any part of it is still readable.
 *
 * What makes the kept-with-a-broken-time case the one worth protecting: `PAUSE` is the only
 * mid-session event type this household's archive has ever held - 44 of 257 entries, the rest
 * `START` 96 and `STOP` 117, with no `RESUME`, `AUTO_PAUSE` or `AUTO_RESUME` anywhere - so the
 * entry whose timestamp broke is likely to be the pause a workout page most wants. Every measured
 * entry did carry a type, so the dropped case is defensive rather than observed. Decoding stays as
 * wide as the v4 schema regardless: a type this device never writes is not a type to stop reading,
 * since another device may write it.
 */
function eventsFrom(value: unknown): WorkoutEvent[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map((entry) => ({
    atMs: instantOrNull(entry.eventTime),
    kind: typeof entry.exerciseEventType === 'string' ? entry.exerciseEventType : null,
  })).filter((event) => event.atMs !== null || event.kind !== null)
}

/**
 * Everything a detail page needs from a session's attrs that workoutSummary does not already
 * answer. Lives here, and not in a module of its own, because workoutSummary.ts's opening line
 * claims to be the only module allowed to open a WorkoutSession's attrs, and a second reader
 * elsewhere would quietly retire that rule rather than change it.
 *
 * The same discipline applies throughout: presence is tested before a value is coerced, a
 * recorded zero survives, and a field the provider never sent stays null rather than becoming a
 * printed zero. See workoutSummary's own comment for why that distinction is the point.
 *
 * hasGps is the one deliberate exception, a boolean rather than a tri-state: see its test.
 */
export function workoutDetail(attrs: unknown): WorkoutDetail {
  const record = isRecord(attrs) ? attrs : {}
  const metrics = isRecord(record.metricsSummary) ? record.metricsSummary : {}
  const metadata = isRecord(record.exerciseMetadata) ? record.exerciseMetadata : {}
  const poolLengthMillimeters = numberOrNull(metadata.poolLengthMillimeters)
  const speedMillimetersPerSecond = numberOrNull(metrics.averageSpeedMillimetersPerSecond)

  return {
    displayName: typeof record.displayName === 'string' ? record.displayName : null,
    notes: typeof record.notes === 'string' ? record.notes : null,
    activeDurationSeconds: durationSecondsOrNull(record.activeDuration),
    hasGps: metadata.hasGps === true,
    poolLengthMeters: poolLengthMillimeters === null
      ? null
      : poolLengthMillimeters / MILLIMETERS_PER_METER,
    runVo2Max: numberOrNull(metrics.runVo2Max),
    averageSpeedMetersPerSecond: speedMillimetersPerSecond === null
      ? null
      : speedMillimetersPerSecond / MILLIMETERS_PER_METER,
    totalSwimLengths: numberOrNull(metrics.totalSwimLengths),
    zones: zonesFrom(metrics.heartRateZoneDurations),
    mobility: mobilityFrom(metrics.mobilityMetrics),
    // splits is the provider's automatic 1 km or 1 mile; splitSummaries is recorded laps. Named
    // for what they are rather than mirroring the provider's own two nouns, which do not say
    // which is which.
    autoSplits: splitsFrom(record.splits),
    laps: splitsFrom(record.splitSummaries),
    events: eventsFrom(record.exerciseEvents),
  }
}
