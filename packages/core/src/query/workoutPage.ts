// The workout page (M10a): one workout, every figure judged against the earlier sessions of its
// own type, beside the day it was done on and the night after it. Computed on read from existing
// rows, like the night page, so nothing is stored and no install rebuilds on upgrade.
import { shiftLocalDate } from '../derive/localDay.ts'
import { ConfigError } from '../errors.ts'
import type { PersonQuery } from './personQuery.ts'
import { INTRADAY_WINDOW_MAX_HOURS, INTRADAY_WINDOW_MAX_MS } from './intraday.ts'
import { activeMinutesFigure, contextFor, dailyFigure, standingOf } from './glance.ts'
import type { GlanceStanding, Judged } from './glance.ts'
import { judge, pageFigureOf, usualOf } from './pageFigure.ts'
import type { FigureDirection, PageFigure } from './pageFigure.ts'
import type { WorkoutSession } from './sessions.ts'
import { oneNightPerDate } from '../api/nights.ts'
import { workoutDetail, workoutSummary } from '../api/workoutSummary.ts'
import type { WorkoutDetail, WorkoutSplit, WorkoutSummary } from '../api/workoutSummary.ts'
import { edwardsLoadFromSeconds } from '../api/cardioLoad.ts'
import type { ZoneBounds } from '../api/cardioLoad.ts'
import { compareWorkout, sameTypeWindow } from '../api/workoutComparison.ts'
import type { WorkoutComparison } from '../api/workoutComparison.ts'
import { sessionForRecords, sessionRecordsOf } from '../api/sessionRecords.ts'
import type { SessionRecordKind } from '../api/sessionRecords.ts'

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
  previous: { sessionId: string, localDate: string, values: Partial<Record<'pace' | 'speed' | 'distance' | 'averageHeartRate' | 'cardioLoad', number>> } | null
  best: { fastestKmSeconds: RecordRef | null, furthestMeters: RecordRef | null, longestMs: RecordRef | null }
  day: { steps: PageFigure, activeMinutes: PageFigure, otherWorkouts: WorkoutSession[] }
  after: { night: { localDate: string, asleep: PageFigure, deep: PageFigure } | null, restingHeartRate: PageFigure | null }
  /** Seconds per km the second half of the automatic splits was faster than the first (negative:
   *  slower); null below two usable splits. */
  splitTrend: { secondHalfFasterBySecondsPerKm: number } | null
  /** Where the heart rate zones above light begin, for the bands behind the trace. */
  zoneBounds: ZoneBounds | null
}

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
    const history = window.flatMap((r) => { const v = spec.of(r); return v === null ? [] : [v] })
    // Banister and highest heart rate are read for the subject alone (readingOf's default), so
    // their history is empty and usualOf answers no band: no verdict is claimed on them.
    const baseline = usualOf(history, WORKOUT_BAND_MIN)
    const standing = standingOf(value, baseline, false)
    const pointOf = (session: WorkoutSession, v: number | null): WorkoutStripPoint => {
      const pointStanding = standingOf(v, baseline, false)
      return { sessionId: session.id, localDate: session.localDate, value: v, standing: pointStanding, judged: judge(pointStanding, spec.direction) }
    }
    figures[spec.key] = {
      key: spec.key, metric: spec.key, value, unit: spec.unit, precision: spec.precision, direction: spec.direction,
      baseline, standing, judged: judge(standing, spec.direction),
      strip: [
        ...stripped.map((r) => pointOf(r.session, spec.of(r))),
        pointOf(subject.session, value),
      ],
    }
  }
  return figures
}

// Answers: the figure the page leads with, chosen by type: pace on foot, speed on a bike, time otherwise.
function heroOf(exerciseType: string | null, figures: WorkoutPage['figures']): WorkoutFigureKey {
  const type = exerciseType ?? ''
  if (/RUN|WALK|HIK/.test(type) && figures.pace !== undefined) return 'pace'
  if (/BIK|CYCL/.test(type) && figures.speed !== undefined) return 'speed'
  return figures.movingTime !== undefined ? 'movingTime' : 'elapsed'
}

// Answers: the latest earlier session of this type the person did not exclude, however long ago,
// with the values the comparison table's rows read: speed as well as pace, since a ride's rows follow its hero.
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
  put('averageHeartRate', r.summary.averageHeartRateBpm)
  put('cardioLoad', r.edwards)
  return { sessionId: latest.id, localDate: latest.localDate, values }
}

// Answers: this type's fastest kilometre, furthest and longest session, the Records page's own
// rule and parsing, over every session of the type up to today rather than up to this workout.
function bestOf(everSameType: readonly WorkoutSession[]): WorkoutPage['best'] {
  const records = sessionRecordsOf(everSameType.filter((s) => !s.excluded).map(sessionForRecords))
  const ref = (kind: SessionRecordKind, scale: number): RecordRef | null => {
    const record = records.find((r) => r.kind === kind)
    return record === undefined ? null : { value: record.value / scale, sessionId: record.sessionId, localDate: record.localDate }
  }
  return { fastestKmSeconds: ref('fastest-km', 1), furthestMeters: ref('furthest', 1000), longestMs: ref('longest', 1) }
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
function dayOf(q: PersonQuery, subject: WorkoutSession, input: WorkoutPageInput): WorkoutPage['day'] {
  const { localDate } = subject
  const ctx = contextFor(q, { today: localDate, nowMs: input.nowMs, nameOf: input.nameOf, finished: localDate < input.today })
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
  // One read of the type, up to today (or the workout's own date, should that ever lie later):
  // the Records best is over all of it, and every comparison over what was done by this
  // workout's date, the list the comparison and the previous run have always been given.
  const everSameType = sameTypeSessions(q, exerciseType, input.today > session.localDate ? input.today : session.localDate)
  const candidates = everSameType.filter((s) => s.localDate <= session.localDate)
  const window = sameTypeWindow(session, candidates).map((s) => readingOf(s))
  const figures = figuresOf(subject, window)

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
    best: bestOf(everSameType),
    day: dayOf(q, session, input),
    after: afterOf(q, session, input),
    splitTrend: splitTrendOf(subject.detail.autoSplits),
    zoneBounds: q.workoutZoneBounds({ sessionId: session.id }),
  }
}
