// The workout page (M10a): one workout, every figure judged against the earlier sessions of its
// own type, beside the day it was done on and the night after it. Computed on read from existing
// rows, like the night page, so nothing is stored and no install rebuilds on upgrade.
import { shiftLocalDate } from '../derive/localDay.ts'
import { ConfigError } from '../errors.ts'
import type { PersonQuery } from './personQuery.ts'
import { INTRADAY_WINDOW_MAX_HOURS, INTRADAY_WINDOW_MAX_MS } from './intraday.ts'
import { activeMinutesFigure, contextFor, dailyFigure, readRecovery, standingOf } from './glance.ts'
import type { GlanceContext, GlanceRecovery, GlanceStanding, Judged } from './glance.ts'
import { figureFromValues, judge, pageFigureOf, usualOf } from './pageFigure.ts'
import type { FigureDirection, PageFigure } from './pageFigure.ts'
import type { WorkoutSession } from './sessions.ts'
import { NO_THINNING } from './sessionHeartRate.ts'
import { cadenceSeries, paceSeries } from './workoutThrough.ts'
import type { MinuteSeries, PaceSeries } from './workoutThrough.ts'
import { oneNightPerDate } from '../api/nights.ts'
import { workoutDetail, workoutSummary } from '../api/workoutSummary.ts'
import type { WorkoutDetail, WorkoutSplit, WorkoutSummary } from '../api/workoutSummary.ts'
import { edwardsLoadFromSeconds } from '../api/cardioLoad.ts'
import type { ZoneBounds } from '../api/cardioLoad.ts'
import { compareWorkout, sameTypeWindow } from '../api/workoutComparison.ts'
import type { WorkoutComparison } from '../api/workoutComparison.ts'
import { RECORD_KINDS_BY_CATEGORY, kilometreSplitsOf, readsEfforts, sessionForRecords, sessionRecordsOf } from '../api/sessionRecords.ts'
import type { SessionForRecords, SessionRecord, SessionRecordKind } from '../api/sessionRecords.ts'
import { routeSignature, sameRoute as onSameRoute } from '../api/routeMatch.ts'
import { effortDistancesOf, effortSeconds, fastestEffortsAlong } from '../api/fastestEfforts.ts'
import type { Effort, Efforts } from '../api/fastestEfforts.ts'
import { countsForDistanceRecords, exerciseCategory } from '../api/exerciseCategory.ts'
import type { ExerciseCategory } from '../api/exerciseCategory.ts'
import type { RoutePoint, RouteSummary } from './workoutDerived.ts'

// Five, not the night page's sixty: a person runs a few times a week, and five same-type sessions
// is the least evidence a usual range for a workout can honestly stand on.
export const WORKOUT_BAND_MIN = 5
export const WORKOUT_STRIP = 10

export type WorkoutFigureKey = 'pace' | 'speed' | 'distance' | 'movingTime' | 'elapsed' | 'averageHeartRate'
  | 'highestHeartRate' | 'cardioLoad' | 'banister' | 'calories' | 'steps' | 'activeZoneMinutes'
  | 'elevationGain' | 'hardZoneMinutes' | 'cadence' | 'strideLength' | 'groundContact'
  | 'verticalOscillation' | 'verticalRatio' | 'vo2max' | 'swimLengths'

/**
 * One session on a figure's strip, with where it stood against the figure's own usual and that read
 * through the figure's direction, so its dot takes the tone its verdict line would (verdictTone).
 * The usual is the one the page judges this workout by, not one of the session's own day: there is
 * one band behind the whole strip, and a thin one judges no point.
 */
export interface WorkoutStripPoint {
  sessionId: string, localDate: string, value: number | null, standing: GlanceStanding | null, judged: Judged
}
export interface WorkoutFigure extends Omit<PageFigure, 'strip'> { key: WorkoutFigureKey, strip: WorkoutStripPoint[] }
export interface RecordRef { value: number, sessionId: string, localDate: string }

export interface WorkoutPage {
  sessionId: string
  sourceId: string
  localDate: string
  exerciseType: string | null
  hero: WorkoutFigureKey
  nav: { previous: string | null, next: string | null }
  figures: Partial<Record<WorkoutFigureKey, WorkoutFigure>>
  comparison: WorkoutComparison
  previous: { sessionId: string, localDate: string, values: Partial<Record<'pace' | 'speed' | 'distance' | 'movingTime' | 'elapsed' | 'averageHeartRate' | 'cardioLoad', number>> } | null
  /**
   * The Records bests of this workout's category (a trail run's are the run category's), one per
   * kind the category keeps (RECORD_KINDS_BY_CATEGORY), null for one no session holds; `longest`,
   * `furthest` and `most-climb` are always present, null where the category keeps none. Values in
   * the records' own units: milliseconds for `longest`, whole metres for `furthest` and
   * `most-climb`, whole seconds for each `fastest-*`.
   */
  best: Record<SessionRecordKind, RecordRef | null>
  day: { steps: PageFigure, activeMinutes: PageFigure, otherWorkouts: WorkoutSession[] }
  after: { night: { localDate: string, asleep: PageFigure, deep: PageFigure } | null, restingHeartRate: PageFigure | null }
  /** How far heart rate fell one and two minutes after the end, against the earlier sessions of the type; null without the minutes.
   *  `readings` are the minute means each fall is taken between: the last full minute, and each minute after. */
  heartRateRecovery: {
    oneMinute: PageFigure, twoMinutes: PageFigure
    readings: { endBpm: number, oneMinuteBpm: number | null, twoMinutesBpm: number | null }
    /** How many earlier workouts of the type have a fall in either minute: what the usual is built from. */
    history: number
  } | null
  /** The night ending on the workout's own date and that morning's recovery; null for each with no value. */
  before: { night: { localDate: string, asleep: PageFigure, deep: PageFigure } | null, recovery: GlanceRecovery | null, restingHeartRate: PageFigure | null }
  /** The minute series drawn under the heart rate trace, on its elapsed axis. */
  through: { pace: PaceSeries | null, cadence: MinuteSeries | null }
  /** Seconds per km the second half of the automatic splits was faster than the first (negative:
   *  slower); null below two usable splits. */
  splitTrend: { secondHalfFasterBySecondsPerKm: number } | null
  /** Where the heart rate zones above light begin, for the bands behind the trace. */
  zoneBounds: ZoneBounds | null
  /**
   * This workout's time against the earlier times on the same route (routeMatch.ts), lower being
   * better; null without a route or with no earlier workout on it. `times` is how many times the
   * route was done, this workout counted in, as the caption says it.
   */
  sameRoute: {
    times: number
    /** The date of the oldest of the earlier workouts on the route. */
    since: string
    time: WorkoutFigure
    /** This workout's pace against the earlier paces on the route (every match that has one); null without a pace of its own. */
    pace: WorkoutFigure | null
    previous: { sessionId: string, localDate: string, seconds: number } | null
  } | null
  /**
   * The fastest stretch over each of the category's effort distances inside the route, keyed as
   * EFFORT_DISTANCES_BY_CATEGORY keys them, shortest first (a run's kilometre a split when a split
   * beat the GPS, as Records takes it, and `source` says which), each beside the Records best of the
   * category up to today (as `best` reads it) and the best set before this workout (`previousBest`,
   * what a new best beat); `fromMeters` is how far along the route the stretch began. Null for a
   * distance the route is shorter than, and null altogether without a route, for a category with no
   * distances, and for a type that holds no speed record (a treadmill run, an indoor ride).
   */
  efforts: Efforts<{
    seconds: number, fromMeters: number, source: EffortSource, best: RecordRef | null, previousBest: RecordRef | null, isBest: boolean
  } | null> | null
}

/** Where an effort's time came from: the GPS route, or (a kilometre only) the watch's own split. */
export type EffortSource = 'gps' | 'split'

export interface WorkoutPageInput { sessionId: string, today: string, nowMs: number, nameOf: (id: string) => string }

/**
 * Everything a figure reads from one session. `banister` and `highestHr` are null for every session
 * but the subject: both read heart rate, and a samples read per earlier session is too much to pay
 * for a usual range on a page read.
 */
interface Reading {
  summary: WorkoutSummary
  detail: WorkoutDetail
  session: WorkoutSession
  edwards: number | null
  banister: number | null
  highestHr: number | null
}

interface FigureSpec {
  key: WorkoutFigureKey
  unit: string
  precision: number
  direction: FigureDirection
  of: (r: Reading) => number | null
}

const mobility = (pick: (m: NonNullable<WorkoutDetail['mobility']>) => number | null) =>
  (r: Reading) => (r.detail.mobility === null ? null : pick(r.detail.mobility))

// Faster pace, higher speed and a higher VO2max are better; everything else is neither, since more
// distance, heart rate, load or cadence is not better by itself (the spec's direction table).
const FIGURES: readonly FigureSpec[] = [
  { key: 'pace', unit: 'seconds_per_km', precision: 0, direction: 'down', of: (r) => r.summary.paceSecondsPerKm },
  { key: 'speed', unit: 'meters_per_second', precision: 2, direction: 'up', of: (r) => r.detail.averageSpeedMetersPerSecond },
  { key: 'distance', unit: 'meters', precision: 0, direction: 'neutral', of: (r) => r.summary.distanceMeters },
  { key: 'movingTime', unit: 'seconds', precision: 0, direction: 'neutral', of: (r) => r.detail.activeDurationSeconds },
  { key: 'elapsed', unit: 'seconds', precision: 0, direction: 'neutral', of: (r) => (r.session.endMs - r.session.startMs) / 1000 },
  { key: 'averageHeartRate', unit: 'bpm', precision: 0, direction: 'neutral', of: (r) => r.summary.averageHeartRateBpm },
  { key: 'highestHeartRate', unit: 'bpm', precision: 0, direction: 'neutral', of: (r) => r.highestHr },
  { key: 'cardioLoad', unit: 'trimp', precision: 0, direction: 'neutral', of: (r) => r.edwards },
  { key: 'banister', unit: 'trimp', precision: 0, direction: 'neutral', of: (r) => r.banister },
  { key: 'calories', unit: 'kcal', precision: 0, direction: 'neutral', of: (r) => r.summary.caloriesKcal },
  { key: 'steps', unit: 'count', precision: 0, direction: 'neutral', of: (r) => r.summary.steps },
  { key: 'activeZoneMinutes', unit: 'minutes', precision: 0, direction: 'neutral', of: (r) => r.summary.activeZoneMinutes },
  { key: 'elevationGain', unit: 'meters', precision: 0, direction: 'neutral', of: (r) => r.summary.elevationGainMeters },
  {
    key: 'hardZoneMinutes', unit: 'minutes', precision: 0, direction: 'neutral',
    of: (r) => {
      const zones = r.detail.zones
      if (zones === null || (zones.vigorousSeconds === null && zones.peakSeconds === null)) return null
      return ((zones.vigorousSeconds ?? 0) + (zones.peakSeconds ?? 0)) / 60
    },
  },
  { key: 'cadence', unit: 'steps_per_minute', precision: 0, direction: 'neutral', of: mobility((m) => m.cadenceStepsPerMinute) },
  { key: 'strideLength', unit: 'meters', precision: 2, direction: 'neutral', of: mobility((m) => m.strideLengthMeters) },
  { key: 'groundContact', unit: 'seconds', precision: 3, direction: 'neutral', of: mobility((m) => m.groundContactTimeSeconds) },
  { key: 'verticalOscillation', unit: 'meters', precision: 3, direction: 'neutral', of: mobility((m) => m.verticalOscillationMeters) },
  { key: 'verticalRatio', unit: 'ratio', precision: 1, direction: 'neutral', of: mobility((m) => m.verticalRatio) },
  { key: 'vo2max', unit: 'ml_per_kg_min', precision: 0, direction: 'up', of: (r) => r.detail.runVo2Max },
  { key: 'swimLengths', unit: 'count', precision: 0, direction: 'neutral', of: (r) => r.detail.totalSwimLengths },
]

// intradayWindow's own span cap, and a minute's reading each across it, so thinning never drops the peak.
const MAX_HR_WINDOW_MS = INTRADAY_WINDOW_MAX_MS
const MAX_HR_POINTS = INTRADAY_WINDOW_MAX_HOURS * 60

function readingOf(session: WorkoutSession, hr: { banister: number | null, highestHr: number | null } = { banister: null, highestHr: null }): Reading {
  const detail = workoutDetail(session.attrs)
  return { summary: workoutSummary(session.attrs), detail, session, edwards: edwardsLoadFromSeconds(detail.zones), ...hr }
}

// Answers: the highest heart rate inside the session, from its own source, else from any source.
function highestHeartRate(q: PersonQuery, session: WorkoutSession): number | null {
  if (session.endMs - session.startMs > MAX_HR_WINDOW_MS) return null
  const read = (sourceId?: string) => q.intradayWindow({
    metric: 'heart_rate', startMs: session.startMs, endMs: session.endMs, points: MAX_HR_POINTS, sourceId,
  }).points.flatMap((p) => (p.excluded || p.max === null ? [] : [p.max]))
  const own = read(session.sourceId)
  const values = own.length > 0 ? own : read()
  return values.length === 0 ? null : Math.max(...values)
}

const MINUTE_MS = 60_000

/**
 * Answers: how far heart rate fell from the session's last full minute to the minute starting one
 * and two minutes after its end, in bpm; null where either minute has no reading. Heart rate is
 * stored per minute, keyed on the minute's start (downsample.ts), so the minutes are the stored ones
 * around the end's own minute. One read over them, from the session's own source, else from any
 * source, the rule highestHeartRate follows; several sources in one minute are averaged. Each
 * minute's mean is rounded to whole bpm before the fall is taken, so the readings the page prints
 * and the fall it prints between them always agree (160.6 and 139.4 fall 22, printed 161 and 139).
 */
function recoveryOf(q: PersonQuery, session: WorkoutSession): { one: number | null, two: number | null, last: number | null, afterOne: number | null, afterTwo: number | null } {
  const endMinute = Math.floor(session.endMs / MINUTE_MS) * MINUTE_MS
  const read = (sourceId?: string) => q.intradayWindow({
    metric: 'heart_rate', startMs: endMinute - MINUTE_MS, endMs: endMinute + 3 * MINUTE_MS, points: NO_THINNING, sourceId,
  }).points.filter((p) => !p.excluded && p.mean !== null)
  const own = read(session.sourceId)
  const points = own.length > 0 ? own : read()
  const meanAt = (minuteMs: number) => {
    const means = points.flatMap((p) => (p.utcMs >= minuteMs && p.utcMs < minuteMs + MINUTE_MS && p.mean !== null ? [p.mean] : []))
    return means.length === 0 ? null : Math.round(means.reduce((sum, v) => sum + v, 0) / means.length)
  }
  const last = meanAt(endMinute - MINUTE_MS)
  const afterOne = meanAt(endMinute + MINUTE_MS)
  const afterTwo = meanAt(endMinute + 2 * MINUTE_MS)
  const fall = (after: number | null) => (last === null || after === null ? null : last - after)
  return { one: fall(afterOne), two: fall(afterTwo), last, afterOne, afterTwo }
}

// Answers: the subject's heart-rate recovery, judged against the latest WORKOUT_STRIP sessions of
// the page's own same-type window: one small read each, so the usual stays cheap on a page read.
function heartRateRecoveryOf(q: PersonQuery, subject: WorkoutSession, window: readonly Reading[]): WorkoutPage['heartRateRecovery'] {
  const own = recoveryOf(q, subject)
  if (own.one === null && own.two === null) return null
  const earlier = window.slice(0, WORKOUT_STRIP).map((r) => recoveryOf(q, r.session))
  const figure = (metric: string, key: 'one' | 'two') => figureFromValues({
    metric, unit: 'bpm', precision: 0, direction: 'up', value: own[key], minN: WORKOUT_BAND_MIN,
    history: earlier.flatMap((r) => { const v = r[key]; return v === null ? [] : [v] }),
  })
  return {
    oneMinute: figure('heart_rate_recovery_1min', 'one'), twoMinutes: figure('heart_rate_recovery_2min', 'two'),
    // A fall has a value only with the last minute's, so `last` is there whenever either is, and a
    // reading after the end has a value exactly when its fall does.
    readings: { endBpm: own.last!, oneMinuteBpm: own.afterOne, twoMinutesBpm: own.afterTwo },
    history: earlier.filter((r) => r.one !== null || r.two !== null).length,
  }
}

// Answers: the pace and cadence minute series. Pace from the route (a merged workout's first
// member with one, readRoutesFor's rule, read with the page's other routes); cadence from the
// workout's own device's steps rows, each point a minute's sum (mean times readings), since the
// window read groups raw rows by minute.
function throughOf(q: PersonQuery, session: WorkoutSession, route: readonly RoutePoint[]): WorkoutPage['through'] {
  const cadence = session.endMs - session.startMs > MAX_HR_WINDOW_MS ? null : cadenceSeries(
    q.intradayWindow({ metric: 'steps', startMs: session.startMs, endMs: session.endMs, points: NO_THINNING, sourceId: session.sourceId })
      .points.flatMap((p) => (p.excluded || p.mean === null ? [] : [{ utcMs: p.utcMs, value: p.mean * p.n }])),
    session.startMs, session.endMs,
  )
  return { pace: paceSeries(route, session.startMs, session.endMs), cadence }
}

// Answers: every session of this type up to a date. A type outside EXERCISE_TYPES is
// one the query refuses to filter on, and a type nothing else shares compares against nothing.
function sameTypeSessions(q: PersonQuery, exerciseType: string | null, to: string): WorkoutSession[] {
  if (exerciseType === null) return []
  try {
    return q.sessions({ kind: 'exercise', from: '1970-01-01', to, type: exerciseType })
  } catch (error) {
    if (error instanceof ConfigError) return []
    throw error
  }
}

// Answers: each figure the subject has, against the same-type window, with a strip of up to nine
// earlier sessions (oldest first) ending in this one.
function figuresOf(subject: Reading, window: readonly Reading[]): WorkoutPage['figures'] {
  const figures: WorkoutPage['figures'] = {}
  const stripped = window.slice(0, WORKOUT_STRIP - 1).reverse()
  for (const spec of FIGURES) {
    const value = spec.of(subject)
    if (value === null) continue
    // Banister and highest heart rate are read for the subject alone (readingOf's default), so
    // their history is empty and usualOf answers no band: no verdict is claimed on them.
    const history = window.flatMap((r) => { const v = spec.of(r); return v === null ? [] : [v] })
    figures[spec.key] = workoutFigureOf({ ...spec, metric: spec.key }, value, history, [
      ...stripped.map((r) => ({ session: r.session, value: spec.of(r) })),
      { session: subject.session, value },
    ])
  }
  return figures
}

// Answers: one figure judged against its history's usual (WORKOUT_BAND_MIN), each strip point
// judged against that same usual. The strip is given oldest first, ending in the subject.
function workoutFigureOf(
  spec: { key: WorkoutFigureKey, metric: string, unit: string, precision: number, direction: FigureDirection },
  value: number, history: readonly number[], strip: readonly { session: WorkoutSession, value: number | null }[],
): WorkoutFigure {
  const baseline = usualOf(history, WORKOUT_BAND_MIN)
  const standing = standingOf(value, baseline, false)
  const pointOf = ({ session, value: v }: { session: WorkoutSession, value: number | null }): WorkoutStripPoint => {
    const pointStanding = standingOf(v, baseline, false)
    return { sessionId: session.id, localDate: session.localDate, value: v, standing: pointStanding, judged: judge(pointStanding, spec.direction) }
  }
  return {
    key: spec.key, metric: spec.metric, value, unit: spec.unit, precision: spec.precision, direction: spec.direction,
    baseline, standing, judged: judge(standing, spec.direction), strip: strip.map(pointOf),
  }
}

const elapsedOf = (r: Reading) => (r.session.endMs - r.session.startMs) / 1000

/**
 * Answers: this workout's time against the earlier times on the same route. The candidates are the
 * kept same-type sessions the page already read (the caller leaves out the excluded), those before
 * this one whose route matches (start, end, distance and direction: routeMatch.ts), each compared
 * by its signature alone. Lower is better, since it is one course.
 *
 * Like with like: a workout that recorded a moving time is set against the earlier ones that did
 * too, and one that did not against everyone's elapsed time, so a clock time with its stops never
 * sits in a usual of moving times. The key says which of the two it is.
 */
function sameRouteOf(
  subject: Reading, ownRoute: readonly RoutePoint[], kept: readonly WorkoutSession[], summaries: ReadonlyMap<string, RouteSummary>,
): WorkoutPage['sameRoute'] {
  const own = routeSignature(ownRoute)
  if (own === null) return null
  const moving = subject.detail.activeDurationSeconds
  const timeOf = moving === null ? elapsedOf : (r: Reading) => r.detail.activeDurationSeconds
  const onRoute = kept
    .filter((s) => s.startMs < subject.session.startMs)
    .filter((s) => {
      const signature = summaries.get(s.id)?.signature ?? null
      return signature !== null && onSameRoute(own, signature)
    })
    .sort((a, b) => b.startMs - a.startMs)
    .map((session) => readingOf(session))
  // Latest first, each with the reading `of` gives it; a match without one is not in its history.
  const valued = (of: (r: Reading) => number | null) =>
    onRoute.flatMap((r) => { const value = of(r); return value === null ? [] : [{ session: r.session, value }] })
  const matches = valued(timeOf)
  const latest = matches[0]
  const oldest = matches.at(-1)
  if (latest === undefined || oldest === undefined) return null
  const value = moving ?? elapsedOf(subject)
  const key = moving === null ? 'elapsed' : 'movingTime'
  const time = workoutFigureOf(
    { key, metric: key, unit: 'seconds', precision: 0, direction: 'down' },
    value, matches.map((m) => m.value),
    [...matches.slice(0, WORKOUT_STRIP - 1).reverse(), { session: subject.session, value }],
  )
  return {
    times: matches.length + 1, since: oldest.session.localDate, time, pace: routePaceOf(subject, valued),
    previous: { sessionId: latest.session.id, localDate: latest.session.localDate, seconds: latest.value },
  }
}

const PACE = FIGURES.find((spec) => spec.key === 'pace')!

// Answers: the subject's pace against the earlier paces on its route, the page's own pace figure
// over the route's history rather than the type's; null when the subject has no pace.
function routePaceOf(
  subject: Reading, valued: (of: (r: Reading) => number | null) => { session: WorkoutSession, value: number }[],
): WorkoutFigure | null {
  const value = PACE.of(subject)
  if (value === null) return null
  const history = valued(PACE.of)
  return workoutFigureOf({ ...PACE, metric: PACE.key }, value, history.map((h) => h.value),
    [...history.slice(0, WORKOUT_STRIP - 1).reverse(), { session: subject.session, value }])
}

const refOf = (records: readonly SessionRecord[], kind: SessionRecordKind): RecordRef | null => {
  const record = records.find((r) => r.kind === kind)
  return record === undefined ? null : { value: record.value, sessionId: record.sessionId, localDate: record.localDate }
}

// Answers: the fastest efforts inside the route over the category's distances, each beside the
// category's Records best; null without efforts of its own (no route, a category with no
// distances, or a type that holds no speed record). A run's kilometre is the quicker of the GPS and
// the splits, Records' own rule, so the row prints the time Records holds and says where that
// kilometre began; a ride's split never counts, as it never makes a record.
function effortsOf(
  subject: Reading, category: ExerciseCategory, own: Efforts<Effort | null> | null,
  records: readonly SessionRecord[], earlier: readonly SessionRecord[],
): WorkoutPage['efforts'] {
  if (own === null) return null
  const sourced = (effort: Effort | null, source: EffortSource) => (effort === null ? null : { ...effort, source })
  const fastestOf = (key: string): (Effort & { source: EffortSource }) | null => {
    const gps = sourced(own[key] ?? null, 'gps')
    // Only a run has a 1 km distance, so a ride's splits never compete.
    if (key !== '1k') return gps
    return [
      ...(gps === null ? [] : [gps]),
      ...kilometreSplitsOf(subject.session.attrs).map((split) => sourced(split, 'split')!),
    ].reduce<(Effort & { source: EffortSource }) | null>((best, e) => (best === null || e.seconds < best.seconds ? e : best), null)
  }
  const efforts: NonNullable<WorkoutPage['efforts']> = {}
  for (const { key } of effortDistancesOf(category)) {
    const effort = fastestOf(key)
    const kind: SessionRecordKind = `fastest-${key}`
    const best = refOf(records, kind)
    efforts[key] = effort === null ? null : {
      seconds: effort.seconds, fromMeters: effort.fromMeters, source: effort.source,
      best, previousBest: refOf(earlier, kind), isBest: best?.sessionId === subject.session.id,
    }
  }
  return efforts
}

// Answers: the figure the page leads with, chosen by type: pace on foot, speed on a bike, time otherwise.
function heroOf(exerciseType: string | null, figures: WorkoutPage['figures']): WorkoutFigureKey {
  const type = exerciseType ?? ''
  if (/RUN|WALK|HIK/.test(type) && figures.pace !== undefined) return 'pace'
  if (/BIK|CYCL/.test(type) && figures.speed !== undefined) return 'speed'
  return figures.movingTime !== undefined ? 'movingTime' : 'elapsed'
}

// Answers: the latest earlier session of this type the person did not exclude, however long ago,
// with the values the comparison table's rows read: speed as well as pace, since a ride's rows follow its hero,
// and moving and elapsed time, since a time hero leads the table with its own row.
function previousOf(subject: WorkoutSession, candidates: readonly WorkoutSession[]): WorkoutPage['previous'] {
  const earlier = candidates.filter((s) => s.id !== subject.id && !s.excluded && s.startMs < subject.startMs)
  const latest = earlier.reduce<WorkoutSession | null>((best, s) => (best === null || s.startMs > best.startMs ? s : best), null)
  if (latest === null) return null
  const r = readingOf(latest)
  const values: NonNullable<WorkoutPage['previous']>['values'] = {}
  const put = (key: keyof typeof values, v: number | null) => { if (v !== null) values[key] = v }
  put('pace', r.summary.paceSecondsPerKm)
  put('speed', r.detail.averageSpeedMetersPerSecond)
  put('distance', r.summary.distanceMeters)
  put('movingTime', r.detail.activeDurationSeconds)
  put('elapsed', (latest.endMs - latest.startMs) / 1000)
  put('averageHeartRate', r.summary.averageHeartRateBpm)
  put('cardioLoad', r.edwards)
  return { sessionId: latest.id, localDate: latest.localDate, values }
}

// Answers: this category's session records, the Records page's own rule and parsing (GPS efforts
// included), over every kept session of the category up to today rather than up to this workout:
// the subject as the caller parsed it, efforts off its own full route, every other one's off its summary.
function recordsOf(
  kept: readonly WorkoutSession[], subject: SessionForRecords, summaries: ReadonlyMap<string, RouteSummary>,
): SessionRecord[] {
  return sessionRecordsOf(kept.map((s) => {
    if (s.id === subject.sessionId) return subject
    const parsed = sessionForRecords(s)
    const summary = summaries.get(s.id)
    return summary === undefined ? parsed : { ...parsed, efforts: summary.efforts }
  }))
}

// Answers: every best this category keeps, from its records; the three every category's page may
// read present even where the category keeps none, as null.
function bestOf(category: ExerciseCategory, records: readonly SessionRecord[]): WorkoutPage['best'] {
  const best: WorkoutPage['best'] = { longest: null, furthest: null, 'most-climb': null }
  for (const kind of RECORD_KINDS_BY_CATEGORY[category]) best[kind] = refOf(records, kind)
  return best
}

// Answers: every workout of the category up to `to`, whatever its exact type, as the Records page
// groups them; one read, filtered on the category the payload's type maps to.
function categorySessions(q: PersonQuery, category: ExerciseCategory, to: string): WorkoutSession[] {
  return q.sessions({ kind: 'exercise', from: '1970-01-01', to })
    .filter((s) => exerciseCategory(sessionForRecords(s).exerciseType) === category)
}

// Answers: the nearest workouts either side of this one, of any type, by (startMs, id); never past today.
function navOf(q: PersonQuery, subject: WorkoutSession, today: string): WorkoutPage['nav'] {
  const before = (a: WorkoutSession, b: WorkoutSession) => a.startMs < b.startMs || (a.startMs === b.startMs && a.id < b.id)
  const all = q.sessions({ kind: 'exercise', from: '1970-01-01', to: today })
  let previous: WorkoutSession | null = null
  let next: WorkoutSession | null = null
  for (const s of all) {
    if (before(s, subject) && (previous === null || before(previous, s))) previous = s
    if (before(subject, s) && (next === null || before(s, next))) next = s
  }
  return { previous: previous?.id ?? null, next: next?.id ?? null }
}

// Answers: the day the workout was done on, as the glance tells it.
function dayOf(q: PersonQuery, subject: WorkoutSession, input: WorkoutPageInput, ctx: GlanceContext): WorkoutPage['day'] {
  const { localDate } = subject
  return {
    steps: pageFigureOf(dailyFigure(ctx, { metric: 'steps', agg: 'sum', on: localDate, partial: localDate === input.today, asOfMs: null }), false),
    activeMinutes: pageFigureOf(activeMinutesFigure(ctx), false),
    otherWorkouts: q.sessions({ kind: 'exercise', from: localDate, to: localDate }).filter((s) => s.id !== subject.id),
  }
}

// Answers: the night filed under the next day and that morning's resting heart rate; nothing before it has come.
function afterOf(q: PersonQuery, subject: WorkoutSession, input: WorkoutPageInput): WorkoutPage['after'] {
  const nextDay = shiftLocalDate(subject.localDate, 1)
  if (nextDay > input.today) return { night: null, restingHeartRate: null }
  const ctx = contextFor(q, { today: nextDay, nowMs: input.nowMs, nameOf: input.nameOf, finished: nextDay < input.today })
  const night = oneNightPerDate(q.sleepNights({ from: nextDay, to: nextDay }))[0]
  const figure = (metric: string, agg: string, asOfMs: number | null) =>
    pageFigureOf(dailyFigure(ctx, { metric, agg, on: nextDay, partial: false, asOfMs }), false)
  return {
    night: night === undefined ? null : {
      localDate: nextDay,
      asleep: figure('sleep_asleep_minutes', 'sum', night.endMs),
      deep: figure('sleep_deep_minutes', 'sum', night.endMs),
    },
    restingHeartRate: figure('resting_heart_rate', 'last', null),
  }
}

// Answers: the night ending on the workout's own date and that morning's recovery, as afterOf reads
// the next day's; resting heart rate judged with its strip, the way the night page's morning has it.
function beforeOf(q: PersonQuery, subject: WorkoutSession, ctx: GlanceContext): WorkoutPage['before'] {
  const { localDate } = subject
  const night = oneNightPerDate(q.sleepNights({ from: localDate, to: localDate }))[0]
  const figure = (metric: string, asOfMs: number) =>
    pageFigureOf(dailyFigure(ctx, { metric, agg: 'sum', on: localDate, partial: false, asOfMs }), false)
  const recovery = readRecovery(ctx)
  const restingHeartRate = pageFigureOf(recovery.restingHeartRate, true)
  return {
    night: night === undefined ? null : {
      localDate,
      asleep: figure('sleep_asleep_minutes', night.endMs),
      deep: figure('sleep_deep_minutes', night.endMs),
    },
    recovery: recovery.index.value === null ? null : recovery,
    restingHeartRate: restingHeartRate.value === null ? null : restingHeartRate,
  }
}

/**
 * Answers: how much faster the second half of the splits went than the first, in s/km. Halves by
 * count, the middle split left out of an odd one; each half's pace weighted by distance, so the
 * short last split a run usually ends on counts for its fifth of a kilometre and not for a whole
 * one. A split with no pace or no distance says nothing about either half and is skipped.
 */
export function splitTrendOf(splits: readonly WorkoutSplit[]): WorkoutPage['splitTrend'] {
  const usable = splits.flatMap((s) => (s.paceSecondsPerKm === null || s.distanceMeters === null || s.distanceMeters <= 0
    ? [] : [{ pace: s.paceSecondsPerKm, km: s.distanceMeters / 1000 }]))
  if (usable.length < 2) return null
  const half = Math.floor(usable.length / 2)
  const paceOf = (part: typeof usable) =>
    part.reduce((sum, s) => sum + s.pace * s.km, 0) / part.reduce((sum, s) => sum + s.km, 0)
  return { secondHalfFasterBySecondsPerKm: paceOf(usable.slice(0, half)) - paceOf(usable.slice(usable.length - half)) }
}

export function readWorkoutPage(q: PersonQuery, input: WorkoutPageInput): WorkoutPage | null {
  const session = q.sessionById({ sessionId: input.sessionId })
  if (session === null || session.kind !== 'exercise') return null
  const subject = readingOf(session, {
    banister: q.cardioLoad({ sessionId: session.id })?.banister ?? null,
    highestHr: highestHeartRate(q, session),
  })
  const exerciseType = subject.summary.exerciseType
  const category = exerciseCategory(exerciseType)
  const until = input.today > session.localDate ? input.today : session.localDate
  // One read of the type, up to today (or the workout's own date, should that ever lie later):
  // every comparison is over what was done by this workout's date, the list the comparison and the
  // previous run have always been given.
  const everSameType = sameTypeSessions(q, exerciseType, until)
  const candidates = everSameType.filter((s) => s.localDate <= session.localDate)
  const window = sameTypeWindow(session, candidates).map((s) => readingOf(s))
  const kept = everSameType.filter((s) => !s.excluded)
  // The Records bests are the category's, as the Records page keeps them: a trail run's are every
  // run's, up to today.
  const keptInCategory = categorySessions(q, category, until).filter((s) => !s.excluded)
  // Efforts only for a category with distances, and only off a type that holds speed records.
  const readsOwnEfforts = readsEfforts(category) && countsForDistanceRecords(exerciseType)
  // This workout's full route, for its pace, efforts and route match; every other one only as a
  // signature and efforts, read in bounded chunks: the earlier ones of its type for the same-route
  // times, and, for a category with efforts, every one of the category that can hold a speed
  // record, later ones included, for the Records bests. Any other category reads the routes before
  // this one alone.
  const ownRoute = q.workoutRoute({ sessionId: session.id }) ?? []
  const summarised = new Map<string, WorkoutSession>()
  for (const s of kept) if (s.id !== session.id && s.startMs < session.startMs) summarised.set(s.id, s)
  if (readsOwnEfforts) {
    for (const s of keptInCategory) {
      if (s.id !== session.id && countsForDistanceRecords(sessionForRecords(s).exerciseType)) summarised.set(s.id, s)
    }
  }
  const summaries = q.workoutRouteSummaries({
    sessions: [...summarised.values()].sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1)),
    efforts: readsOwnEfforts,
  })
  // This workout's efforts, found once: its row on the page and its entry in both sets of records.
  const ownEfforts = readsOwnEfforts && ownRoute.length >= 2 ? fastestEffortsAlong(ownRoute, category) : null
  const parsed = sessionForRecords(session)
  const ownRecord = ownEfforts === null ? parsed : { ...parsed, efforts: effortSeconds(ownEfforts) }
  const records = recordsOf(keptInCategory, ownRecord, summaries)
  // The same records over what was done before this workout alone: what a new best of its beat.
  const earlierRecords = recordsOf(keptInCategory.filter((s) => s.startMs < session.startMs), ownRecord, summaries)
  const figures = figuresOf(subject, window)
  // The glance's view of the workout's own day, shared by the day card and the morning before it.
  const dayCtx = contextFor(q, { today: session.localDate, nowMs: input.nowMs, nameOf: input.nameOf, finished: session.localDate < input.today })

  return {
    sessionId: session.id,
    sourceId: session.sourceId,
    localDate: session.localDate,
    exerciseType,
    hero: heroOf(exerciseType, figures),
    nav: navOf(q, session, input.today),
    figures,
    comparison: compareWorkout(session, candidates),
    previous: previousOf(session, candidates),
    // The Records best, so it may be a session done after this one.
    best: bestOf(category, records),
    day: dayOf(q, session, input, dayCtx),
    after: afterOf(q, session, input),
    heartRateRecovery: heartRateRecoveryOf(q, session, window),
    before: beforeOf(q, session, dayCtx),
    through: throughOf(q, session, ownRoute),
    splitTrend: splitTrendOf(subject.detail.autoSplits),
    zoneBounds: q.workoutZoneBounds({ sessionId: session.id }),
    sameRoute: sameRouteOf(subject, ownRoute, kept, summaries),
    efforts: effortsOf(subject, category, ownEfforts, records, earlierRecords),
  }
}
