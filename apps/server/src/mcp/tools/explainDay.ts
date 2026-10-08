import { z } from 'zod'
import {
  ConfigError, localMidnightMs, readHrvDeviation, shiftLocalDate, standingOf, toGlanceBaseline, workoutSummary,
} from '@haelan/core'
import type { Glance, GlanceBaseline, GlanceFigure, PersonQuery } from '@haelan/core'
import { HRV_RUN } from './hrvDeviation.ts'
import { hrvRunSentence } from './hrvRunWords.ts'

/**
 * `explain`'s `day` chain: what on one finished day sits away from this person's own usual, and
 * what was lived beside it. See explain.ts for the tool.
 *
 * Built on the dashboard's glance for that day, so a reading the dashboard calls usual is one this
 * calls usual - the same 60-day baselines, the same thin rule, the same stale sources.
 *
 * Gates first, and they stop: a day nothing arrived on, a source that stopped before the day, a
 * day whose own HRV is filled in, and a day with no baseline thick enough to judge anything are
 * all days the data cannot carry an interpretation of, so none is interpreted.
 *
 * Then the first reading away from its usual, in a fixed order - the morning's body readings
 * (resting heart rate, HRV, breathing rate), then the night, then the day's movement - and for
 * that reading, the lived factors in the fixed order FACTORS names. The order is a choice, made
 * once and written down here rather than ranked per day, because a ranking by size would read as
 * a claim about which factor mattered. A factor is reported beside the reading as an association,
 * never as why: the sentence says so.
 *
 * A stretch of the seven-day HRV average on one side of its band is added to whichever of those
 * findings answers after the gates, as a sentence of its own. The gates return unchanged: a day the
 * data cannot carry an interpretation of gets none from a stretch either.
 */

export const DAY_LINKS = [
  'dayEmpty', 'sourceStopped', 'hrvFilled', 'thinBaselines', 'nothingAway',
  'shortNight', 'lateBedtime', 'heavyYesterday', 'workoutThatDay', 'loggedEvent', 'noLivedFactor',
] as const

export type DayLink = typeof DAY_LINKS[number]

type FigureKey = 'restingHeartRate' | 'hrv' | 'respiratoryRate' | 'asleep' | 'steps' | 'activeMinutes'
type Factor = 'shortNight' | 'lateBedtime' | 'heavyYesterday' | 'workoutThatDay' | 'loggedEvent'

// The order a reading away from its usual is looked for in: the first found is the one explained.
const FIGURE_ORDER: readonly FigureKey[] = ['restingHeartRate', 'hrv', 'respiratoryRate', 'asleep', 'steps', 'activeMinutes']

/**
 * For each reading, and only in the direction named, the lived factors looked at beside it, in
 * order. A body reading on the side its metric reads as worse is looked at against the night
 * before, its bedtime and the day before's hard minutes; the other side of it is not, since a short
 * night beside a lower resting heart rate is not an association the data suggests. A short night
 * against its bedtime; more movement against a workout that day. A logged event is looked at last
 * for every reading, and is named without its free text.
 */
const FACTORS: Readonly<Record<FigureKey, { direction: 'above' | 'below', factors: readonly Factor[] }>> = {
  restingHeartRate: { direction: 'above', factors: ['shortNight', 'lateBedtime', 'heavyYesterday', 'loggedEvent'] },
  hrv: { direction: 'below', factors: ['shortNight', 'lateBedtime', 'heavyYesterday', 'loggedEvent'] },
  respiratoryRate: { direction: 'above', factors: ['shortNight', 'lateBedtime', 'heavyYesterday', 'loggedEvent'] },
  asleep: { direction: 'below', factors: ['lateBedtime', 'loggedEvent'] },
  steps: { direction: 'above', factors: ['workoutThatDay', 'loggedEvent'] },
  activeMinutes: { direction: 'above', factors: ['workoutThatDay', 'loggedEvent'] },
}

const NAMES: Readonly<Record<FigureKey, string>> = {
  restingHeartRate: 'Resting heart rate', hrv: 'HRV', respiratoryRate: 'Breathing rate',
  asleep: 'Sleep', steps: 'Steps', activeMinutes: 'Active minutes',
}

const BAND = z.object({ low: z.number(), high: z.number(), thin: z.boolean() }).nullable()

export const DAY_EVIDENCE = z.object({
  localDate: z.string(),
  today: z.string(),
  figures: z.array(z.object({
    key: z.string(),
    value: z.number().nullable(),
    usual: BAND,
    standing: z.enum(['within', 'above', 'below']).nullable(),
  })).nullable().describe('The day\'s readings against their own 60-day usual, as the dashboard judges them.'),
  stoppedSources: z.array(z.object({ sourceId: z.string(), lastReportedDate: z.string() })).nullable().describe(
    'Sources feeding one of the day\'s readings that had stopped reporting before it, by their own cadence as of the day itself.',
  ),
  hrvFilled: z.boolean().nullable(),
  away: z.string().nullable().describe('The first reading away from its usual, in the fixed order the chain looks in.'),
  factor: z.object({ value: z.number().nullable(), usual: BAND }).nullable().describe(
    'The lived factor the walk stopped on, where it is a reading with a usual of its own.',
  ),
  workouts: z.array(z.object({ sessionId: z.string(), exerciseType: z.string().nullable() })).nullable(),
  eventIds: z.array(z.string()).nullable().describe('Events logged on the day or the day before; read them with get_events.'),
  hrvRun: HRV_RUN.describe('The stretch of the seven-day HRV average on one side of its band as of the day, where the walk got past the gates; null before that or when there is none.'),
})

type Evidence = z.infer<typeof DAY_EVIDENCE>
type Band = NonNullable<Evidence['figures']>[number]['usual']

interface Context {
  q: PersonQuery
  glance: Glance
  evidence: Evidence
  /** Every reading the glance answered for the day, a value or not. */
  all: GlanceFigure[]
  judged: Map<FigureKey, GlanceFigure>
  away: { key: FigureKey, figure: GlanceFigure } | null
}

const bandOf = (b: GlanceBaseline | null): Band => (b === null ? null : { low: b.low, high: b.high, thin: b.thin })

function hoursMinutes(minutes: number): string {
  const whole = Math.round(minutes)
  return `${Math.floor(whole / 60)}h${String(whole % 60).padStart(2, '0')}`
}

function clockTime(minutes: number): string {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`
}

function show(key: FigureKey | 'bedtime' | 'vigorous', value: number): string {
  switch (key) {
    case 'restingHeartRate': return `${Math.round(value)} bpm`
    case 'hrv': return `${Math.round(value)} ms`
    case 'respiratoryRate': return `${value.toFixed(1)} breaths a minute`
    case 'asleep': return `${hoursMinutes(value)} asleep`
    case 'bedtime': return clockTime(value)
    case 'steps': return `${Math.round(value)} steps`
    case 'activeMinutes': case 'vigorous': return `${Math.round(value)} minutes`
  }
}

const usualWords = (key: FigureKey | 'bedtime' | 'vigorous', band: GlanceBaseline): string =>
  `${show(key, band.low)} to ${show(key, band.high)}`

function readingSentence(c: Context): string {
  const { key, figure } = c.away!
  return `${NAMES[key]} on ${c.evidence.localDate} was ${show(key, figure.value!)}, ${figure.standing} its usual `
    + `${usualWords(key, figure.baseline!)}.`
}

const ASSOCIATION = ' The two are reported side by side as an association, not as the reason for it.'

/** A sentence when the link accounts for the day, null to walk on. */
type Link = (c: Context) => string | null

const LINKS: Record<Exclude<DayLink, 'noLivedFactor'>, Link> = {
  dayEmpty: (c) => {
    if (c.q.daysWithData({ from: c.evidence.localDate, to: c.evidence.localDate }).length > 0) return null
    return `None of the day's headline readings arrived on ${c.evidence.localDate}, so there is nothing to read the day by.`
  },
  sourceStopped: (c) => {
    const stopped = new Map<string, string>()
    // Every figure, not only those with a value: a source that stopped is most often why a value is
    // missing. The glance judges a past day's staleness as of that day, so a source named here had
    // already gone quiet by it; one that stopped afterwards is not named at all.
    for (const figure of c.all) {
      for (const s of figure.staleSources) stopped.set(s.sourceId, s.lastReportedDate)
    }
    c.evidence.stoppedSources = [...stopped].map(([sourceId, lastReportedDate]) => ({ sourceId, lastReportedDate }))
    if (stopped.size === 0) return null
    const last = [...stopped.values()].sort().at(-1)!
    return `A source that feeds the day's readings had stopped reporting by ${c.evidence.localDate} (last on ${last}), `
      + 'so the day is missing part of what it is usually read from and is not interpreted.'
  },
  hrvFilled: (c) => {
    const point = c.q.series({ metric: 'daily_hrv', agg: 'last', from: c.evidence.localDate, to: c.evidence.localDate }).points[0]
    c.evidence.hrvFilled = point?.filled ?? null
    if (point?.filled !== true) return null
    return `The HRV on ${c.evidence.localDate} is the day's intraday average standing in for a measured daily reading, `
      + 'so the day is not read as measured and is not interpreted further.'
  },
  thinBaselines: (c) => {
    const judgeable = [...c.judged.values()].some((f) => f.baseline !== null && !f.baseline.thin)
    if (judgeable) return null
    return `None of the readings on ${c.evidence.localDate} has enough earlier days behind it for a usual to stand on, `
      + 'so nothing is judged. A thin baseline is low confidence, not evidence of nothing.'
  },
  nothingAway: (c) => {
    for (const key of FIGURE_ORDER) {
      const figure = c.judged.get(key)
      if (figure !== undefined && (figure.standing === 'above' || figure.standing === 'below')) {
        c.away = { key, figure }
        c.evidence.away = key
        return null
      }
    }
    return `Every reading on ${c.evidence.localDate} with a usual to stand on sits within it.`
  },
  shortNight: (c) => {
    const asleep = c.glance.sleep?.asleep
    if (asleep === undefined || asleep.standing !== 'below') return null
    c.evidence.factor = { value: asleep.value, usual: bandOf(asleep.baseline) }
    return `${readingSentence(c)} The night filed under that morning was ${show('asleep', asleep.value!)}, below its usual `
      + `${usualWords('asleep', asleep.baseline!)}.${ASSOCIATION}`
  },
  lateBedtime: (c) => {
    const bedtime = c.glance.sleep?.bedtime
    if (bedtime === undefined || bedtime.standing !== 'above') return null
    c.evidence.factor = { value: bedtime.value, usual: bandOf(bedtime.baseline) }
    return `${readingSentence(c)} Bedtime that night was ${show('bedtime', bedtime.value!)}, later than its usual `
      + `${usualWords('bedtime', bedtime.baseline!)}.${ASSOCIATION}`
  },
  heavyYesterday: (c) => {
    const yesterday = shiftLocalDate(c.evidence.localDate, -1)
    const value = c.q.series({ metric: 'active_minutes_vigorous', agg: 'sum', from: yesterday, to: yesterday }).points[0]?.value ?? null
    const band = toGlanceBaseline(c.q.baseline({ metric: 'active_minutes_vigorous', agg: 'sum', on: yesterday }))
    if (standingOf(value, band, false) !== 'above') return null
    c.evidence.factor = { value, usual: bandOf(band) }
    return `${readingSentence(c)} The day before had ${show('vigorous', value!)} of vigorous activity, above its usual `
      + `${usualWords('vigorous', band!)}.${ASSOCIATION}`
  },
  workoutThatDay: (c) => {
    const kept = c.glance.day.workouts.filter((w) => !w.excluded)
    c.evidence.workouts = kept.map((w) => ({ sessionId: w.id, exerciseType: workoutSummary(w.attrs).exerciseType }))
    if (kept.length === 0) return null
    const types = [...new Set(c.evidence.workouts.map((w) => (w.exerciseType ?? 'untyped').toLowerCase().replaceAll('_', ' ')))]
    return `${readingSentence(c)} ${kept.length === 1 ? 'A workout' : `${kept.length} workouts`} (${types.join(', ')}) `
      + `${kept.length === 1 ? 'was' : 'were'} recorded that day.${ASSOCIATION}`
  },
  loggedEvent: (c) => {
    const events = c.q.events({ from: shiftLocalDate(c.evidence.localDate, -1), to: c.evidence.localDate })
    c.evidence.eventIds = events.map((e) => e.id)
    if (events.length === 0) return null
    // The event's kind and note are free text a person typed, so neither is put in the sentence:
    // the ids are in the evidence, and get_events answers them in labelled, untrusted fields.
    return `${readingSentence(c)} ${events.length === 1 ? 'An event was' : `${events.length} events were`} logged on `
      + `that day or the day before; get_events answers what.${ASSOCIATION}`
  },
}

const FACTOR_WORDS: Readonly<Record<Factor, string>> = {
  shortNight: 'the night before', lateBedtime: 'its bedtime', heavyYesterday: 'the day before\'s vigorous minutes',
  workoutThatDay: 'a workout that day', loggedEvent: 'a logged event',
}

function listOf(words: readonly string[]): string {
  return words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`
}

export function walkDay(q: PersonQuery, localDate: string, today: string): {
  finding: string, stoppedAt: DayLink, walked: DayLink[], evidence: Evidence
} {
  // Refused rather than answered: without a clock the tool cannot know a day is still running, and
  // a running day's steps judged against whole days' usual would read as a quiet day.
  if (localDate >= today) throw new ConfigError(`localDate '${localDate}' is not before today '${today}': only a finished day is explained`)
  const person = q.describe()
  // The home zone: a finished day's end bounds nothing a reader sees (the glance route says why).
  const dayEndMs = localMidnightMs(shiftLocalDate(localDate, 1), person.timezone) - 1
  const glance = q.glance({ today, nowMs: dayEndMs, day: localDate, dayEndMs })

  const figures: Record<FigureKey, GlanceFigure | null | undefined> = {
    restingHeartRate: glance.recovery.restingHeartRate, hrv: glance.recovery.hrv,
    respiratoryRate: glance.recovery.respiratoryRate, asleep: glance.sleep?.asleep,
    steps: glance.day.steps, activeMinutes: glance.day.activeMinutes,
  }
  // Only a reading of this day itself: a finished day never falls back to the one before, but the
  // check costs nothing and keeps a borrowed value from being explained as this day's.
  const judged = new Map<FigureKey, GlanceFigure>()
  for (const key of FIGURE_ORDER) {
    const figure = figures[key]
    if (figure !== null && figure !== undefined && figure.value !== null && figure.asOfDate === localDate) judged.set(key, figure)
  }

  const evidence: Evidence = {
    localDate, today,
    figures: [...judged].map(([key, f]) => ({ key, value: f.value, usual: bandOf(f.baseline), standing: f.standing })),
    stoppedSources: null, hrvFilled: null, away: null, factor: null, workouts: null, eventIds: null, hrvRun: null,
  }
  const all = Object.values(figures).filter((f): f is GlanceFigure => f !== null && f !== undefined)
  const c: Context = { q, glance, evidence, all, judged, away: null }

  const walked: DayLink[] = []
  const walk = (link: Exclude<DayLink, 'noLivedFactor'>): string | null => {
    walked.push(link)
    return LINKS[link](c)
  }
  // Read once, and only once the first four gates are past: a stretch is only ever added to an
  // interpretation, and the finding that nothing is away from its usual is one.
  const named = (finding: string): string => {
    const run = readHrvDeviation(q, { from: localDate, to: localDate }).run
    evidence.hrvRun = run
    return run === null ? finding : finding + hrvRunSentence(run)
  }
  for (const gate of ['dayEmpty', 'sourceStopped', 'hrvFilled', 'thinBaselines', 'nothingAway'] as const) {
    const finding = walk(gate)
    if (finding !== null) return { finding: gate === 'nothingAway' ? named(finding) : finding, stoppedAt: gate, walked, evidence }
  }

  const { key, figure } = c.away!
  const table = FACTORS[key]
  // Only the reading's own side of its usual is looked at against lived factors; see FACTORS.
  const factors = figure.standing === table.direction ? table.factors : []
  for (const factor of factors) {
    const finding = walk(factor)
    if (finding !== null) return { finding: named(finding), stoppedAt: factor, walked, evidence }
  }
  walked.push('noLivedFactor')
  const looked = factors.length === 0
    ? ' No lived factor is looked at beside a reading on this side of its usual.'
    : ` None of ${listOf(factors.map((f) => FACTOR_WORDS[f]))} was away from its usual or on record.`
  return { finding: named(`${readingSentence(c)}${looked}`), stoppedAt: 'noLivedFactor', walked, evidence }
}
