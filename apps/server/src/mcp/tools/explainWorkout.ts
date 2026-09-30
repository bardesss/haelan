import { z } from 'zod'
import { ConfigError, kilometreSplitsOf, standingOf, usualOf } from '@haelan/core'
import type { PersonQuery, WorkoutFigure, WorkoutFigureKey, WorkoutPage } from '@haelan/core'
import { workoutDetail } from '@haelan/core/workout-summary'

/**
 * `explain`'s `workout` chain: what stands out about one exercise session against this person's own
 * earlier sessions of its type. See explain.ts for the tool.
 *
 * Built on the workout page's own reader, so a figure the page calls usual is one this calls usual:
 * the same same-type window (sameTypeWindow: 90 days, at most twenty, the excluded left out), the
 * same five-session minimum, the same band. Nothing here judges a figure a second way.
 *
 * Facts about the session, never about a next one. The links are ordered as the page reads: the
 * figure it leads with, then the minutes spent in the two hardest zones, then the session's own last
 * kilometre against its earlier ones, then any other figure outside its usual. Gates first: an
 * excluded session is not judged at all, and a lead figure with too few earlier sessions behind it
 * stops the walk, so no later link claims a standing the history cannot carry.
 */

export const WORKOUT_LINKS = ['excluded', 'thinHistory', 'hero', 'hardMinutes', 'lastKilometre', 'otherFigure', 'withinUsual'] as const

export type WorkoutLink = typeof WORKOUT_LINKS[number]

// The band the session's own kilometres need before its last one is judged against them. Three,
// COMPARISON_MIN's number: fewer earlier kilometres than that is not a usual pace for the session.
const KILOMETRE_MIN = 3

const STANDING = z.enum(['within', 'above', 'below'])

export const WORKOUT_EVIDENCE = z.object({
  sessionId: z.string(),
  localDate: z.string(),
  exerciseType: z.string().nullable(),
  excluded: z.boolean(),
  earlierSessions: z.number().nullable().describe(
    'How many earlier sessions of the type, in the 90 days before this one and not excluded, the '
    + 'usual ranges are drawn from (at most twenty).',
  ),
  hero: z.string().nullable().describe('The figure the workout page leads with for this type.'),
  figures: z.array(z.object({
    key: z.string(),
    value: z.number(),
    unit: z.string(),
    usualLow: z.number().nullable(),
    usualHigh: z.number().nullable(),
    thin: z.boolean().nullable(),
    standing: STANDING.nullable().describe('Null when the usual is too thin to judge against, or absent.'),
  })).nullable(),
  peakMinutes: z.number().nullable().describe('Minutes in the peak heart rate zone, from the session\'s own zone clocks.'),
  lastKilometre: z.object({
    seconds: z.number(),
    usualLow: z.number().nullable(),
    usualHigh: z.number().nullable(),
    standing: STANDING.nullable(),
    earlierKilometres: z.number(),
  }).nullable().describe(
    'The last full kilometre split against the session\'s own earlier full kilometres. Null without '
    + 'one; `standing` null with fewer than three earlier ones.',
  ),
  secondHalfFasterBySecondsPerKm: z.number().nullable().describe(
    'How much faster the second half of the splits went than the first, in s/km (negative: slower).',
  ),
  standsOut: z.string().nullable().describe('The figure the walk stopped on, when it stopped on one.'),
})

type Evidence = z.infer<typeof WORKOUT_EVIDENCE>

interface Context {
  page: WorkoutPage | null
  evidence: Evidence
}

/** A sentence when the link accounts for the session, null to walk on. */
type Link = (c: Context) => string | null

const NAMES: Partial<Record<WorkoutFigureKey, string>> = {
  pace: 'pace', speed: 'speed', distance: 'distance', movingTime: 'moving time', elapsed: 'time',
  averageHeartRate: 'average heart rate', highestHeartRate: 'highest heart rate', cardioLoad: 'cardio load',
  banister: 'cardio load', calories: 'calories', steps: 'steps', activeZoneMinutes: 'active zone minutes',
  elevationGain: 'elevation gain', hardZoneMinutes: 'minutes in the vigorous and peak zones', cadence: 'cadence',
  strideLength: 'stride length', groundContact: 'ground contact time', verticalOscillation: 'vertical oscillation',
  verticalRatio: 'vertical ratio', vo2max: 'VO2max', swimLengths: 'swim lengths',
}

function clock(seconds: number): string {
  const whole = Math.round(seconds)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

// A figure's value in the words a person reads it in. The units are the page's own FIGURES units.
function show(unit: string, precision: number, value: number): string {
  switch (unit) {
    case 'seconds_per_km': return `${clock(value)}/km`
    case 'meters_per_second': return `${(value * 3.6).toFixed(1)} km/h`
    case 'meters': return value >= 1000 ? `${(value / 1000).toFixed(2)} km` : `${value.toFixed(precision)} m`
    case 'seconds': return clock(value)
    case 'minutes': return `${Math.round(value)} min`
    case 'bpm': return `${Math.round(value)} bpm`
    default: return value.toFixed(precision)
  }
}

// Which way a figure sits, in words that describe it rather than grade it: a lower pace is faster, a
// longer distance is longer, and nothing is "better" - the judged field the page carries is left out.
function outside(key: WorkoutFigureKey, standing: 'above' | 'below'): string {
  const up = standing === 'above'
  if (key === 'pace') return up ? 'slower' : 'faster'
  if (key === 'speed') return up ? 'faster' : 'slower'
  if (key === 'distance' || key === 'movingTime' || key === 'elapsed') return up ? 'longer' : 'shorter'
  return up ? 'higher' : 'lower'
}

const typeWords = (type: string | null): string => (type === null ? 'workout' : type.toLowerCase().replaceAll('_', ' '))

function figureSentence(c: Context, figure: WorkoutFigure): string {
  const range = `${show(figure.unit, figure.precision, figure.baseline!.low)} to ${show(figure.unit, figure.precision, figure.baseline!.high)}`
  return `This ${typeWords(c.evidence.exerciseType)} session on ${c.evidence.localDate}: ${NAMES[figure.key] ?? figure.key} `
    + `${show(figure.unit, figure.precision, figure.value!)}, ${outside(figure.key, figure.standing as 'above' | 'below')} than `
    + `the usual ${range} over its ${c.evidence.earlierSessions} earlier sessions of the type.`
}

const isOutside = (figure: WorkoutFigure | undefined): figure is WorkoutFigure =>
  figure !== undefined && (figure.standing === 'above' || figure.standing === 'below')

const LINKS: Record<WorkoutLink, Link> = {
  excluded: (c) => {
    if (!c.evidence.excluded) return null
    return `The ${typeWords(c.evidence.exerciseType)} session on ${c.evidence.localDate} was excluded by hand, so it is not judged against the others.`
  },
  thinHistory: (c) => {
    const page = c.page!
    if (page.exerciseType === null) {
      return `The session on ${c.evidence.localDate} has no exercise type, so there are no sessions of its type to compare it against.`
    }
    const hero = page.figures[page.hero]
    if (hero !== undefined && hero.baseline !== null && !hero.baseline.thin) return null
    const n = c.evidence.earlierSessions ?? 0
    return `Only ${n} earlier ${typeWords(page.exerciseType)} ${n === 1 ? 'session' : 'sessions'} in the 90 days before `
      + `${c.evidence.localDate}, too few for a usual ${NAMES[page.hero] ?? page.hero} to stand on, so nothing is judged `
      + 'against it. A thin history is low confidence, not evidence of nothing.'
  },
  hero: (c) => {
    const figure = c.page!.figures[c.page!.hero]
    if (!isOutside(figure)) return null
    c.evidence.standsOut = figure.key
    return figureSentence(c, figure)
  },
  hardMinutes: (c) => {
    const figure = c.page!.figures.hardZoneMinutes
    if (!isOutside(figure)) return null
    c.evidence.standsOut = figure.key
    return figureSentence(c, figure)
  },
  lastKilometre: (c) => {
    const last = c.evidence.lastKilometre
    if (last === null || last.standing === null || last.standing === 'within') return null
    return `The last full kilometre of the ${typeWords(c.evidence.exerciseType)} session on ${c.evidence.localDate} took `
      + `${clock(last.seconds)}, ${last.standing === 'below' ? 'faster' : 'slower'} than its ${last.earlierKilometres} earlier `
      + `kilometres, which usually took ${clock(last.usualLow!)} to ${clock(last.usualHigh!)}.`
  },
  otherFigure: (c) => {
    const page = c.page!
    // The lead figure and the hard minutes need no leaving out: had either been outside its usual,
    // the walk would already have stopped on it.
    const figure = Object.values(page.figures).find(isOutside)
    if (figure === undefined) return null
    c.evidence.standsOut = figure.key
    return figureSentence(c, figure)
  },
  withinUsual: (c) =>
    `Nothing in the ${typeWords(c.evidence.exerciseType)} session on ${c.evidence.localDate} sits outside its usual range `
    + `against its ${c.evidence.earlierSessions} earlier sessions of the type.`,
}

// The session's last full kilometre against its earlier full ones, on the band a figure uses.
function lastKilometreOf(attrs: unknown): Evidence['lastKilometre'] {
  const kilometres = kilometreSplitsOf(attrs)
  const last = kilometres.at(-1)
  if (last === undefined) return null
  const earlier = kilometres.slice(0, -1).map((k) => k.seconds)
  const band = usualOf(earlier, KILOMETRE_MIN)
  return {
    seconds: last.seconds,
    usualLow: band?.low ?? null,
    usualHigh: band?.high ?? null,
    standing: standingOf(last.seconds, band, false),
    earlierKilometres: earlier.length,
  }
}

export function walkWorkout(q: PersonQuery, sessionId: string): {
  finding: string, stoppedAt: WorkoutLink, walked: WorkoutLink[], evidence: Evidence
} {
  const session = q.sessionById({ sessionId })
  // The same refusal get_workout makes for an id naming nothing this person owns, and for a night.
  if (session === null || session.kind !== 'exercise') throw new ConfigError(`no workout named '${sessionId}'`)

  const evidence: Evidence = {
    sessionId: session.id, localDate: session.localDate, exerciseType: null, excluded: session.excluded,
    earlierSessions: null, hero: null, figures: null, peakMinutes: null, lastKilometre: null,
    secondHalfFasterBySecondsPerKm: null, standsOut: null,
  }
  const c: Context = { page: null, evidence }

  const walked: WorkoutLink[] = []
  for (const link of WORKOUT_LINKS) {
    walked.push(link)
    // Read once the excluded gate has passed: an excluded session is never judged, so the page's
    // reads (routes, heart rate, every earlier session of the type) are not paid for it. The page is
    // read as of the workout's own date, the only clock a workout's comparison needs: its window
    // ends at the session, and nothing later than it enters a figure's usual.
    if (link === 'thinHistory') readPage(q, c, session.localDate, session.endMs, session.attrs)
    const finding = LINKS[link](c)
    if (finding !== null) return { finding, stoppedAt: link, walked, evidence }
  }
  throw new Error(`the workout chain ended without a finding for ${sessionId}`)
}

function readPage(q: PersonQuery, c: Context, localDate: string, nowMs: number, attrs: unknown): void {
  const page = q.workoutPage({ sessionId: c.evidence.sessionId, today: localDate, nowMs })!
  c.page = page
  const e = c.evidence
  e.exerciseType = page.exerciseType
  e.earlierSessions = page.comparison.of
  e.hero = page.hero
  // figuresOf only keeps a figure that has a value, so the null its type allows is never there.
  e.figures = Object.values(page.figures).flatMap((f) => (f.value === null ? [] : [{
    key: f.key, value: f.value, unit: f.unit, usualLow: f.baseline?.low ?? null, usualHigh: f.baseline?.high ?? null,
    thin: f.baseline?.thin ?? null, standing: f.standing,
  }]))
  const peak = workoutDetail(attrs).zones?.peakSeconds ?? null
  e.peakMinutes = peak === null ? null : Math.round(peak / 60)
  e.lastKilometre = lastKilometreOf(attrs)
  e.secondHalfFasterBySecondsPerKm = page.splitTrend?.secondHalfFasterBySecondsPerKm ?? null
}
