import type { PeriodChange, PeriodFigure, PeriodHigh, PeriodRange, PeriodStripPoint, PeriodWindow } from '../../data/periodTypes.js'
import { formatSignedDuration, formatSignedNumber, formatWeekdayDate } from '../../format.js'
import type { Translate } from '../../format.js'
import { directionWords, standingShort } from '../../charts/base.js'
import type { PointJudged, PointStanding } from '../../charts/base.js'
import { stripBands } from '../dashboard/cardShared.js'
import { deviationVerdictLine, formatFigureDifference, formatFigureRange, formatFigureValue, isShortSpan, verdictLine } from './figureText.js'

// The words of an overview page (Sleep, Activity) over the /period read: PATTERNS.md's "Overview
// pages" section, beside this file. The server has already judged every figure, counted its days and
// picked its high point; this only puts them into words.

const NBSP = ' '
const SEPARATOR = ' · '

/** "for a month, last 12 months" / "voor een maand, afgelopen 12 maanden"; year: "for a year, from 2025". */
export function windowPhrase(window: PeriodWindow, t: Translate): string {
  return t(`period.window.${window.unit}`, { count: window.count, year: window.from.slice(0, 4) })
}

/** The period by its length, as a caption names it: "this month" / "deze maand", "this year" / "dit jaar". */
export function thisPeriod(range: PeriodRange, t: Translate): string {
  return t(`period.this.${range}`)
}

/**
 * verdictLine on the period figure, its usual standing in for the night page's baseline; or, where
 * the server gave a reason not to judge, the reason's own words (no-data says nothing at all).
 *
 * With `window` the window the usual comes from follows the range after a plain space ("... 6h 40m
 * - 7h 35m for a month, last 12 months"): a page names it once, in the hero, and every other
 * figure's verdict is the verdict and its range alone.
 */
export function periodVerdictLine(figure: PeriodFigure, language: string, t: Translate, o: { window?: boolean } = {}): string | null {
  if (figure.reason === 'no-data') return null
  if (figure.reason === 'too-few-days') return t('period.reason.tooFewDays')
  if (figure.reason === 'thin-usual') return t('glance.usual.thin')
  const judged = asPrinted(figure)
  const whole = judged !== figure
  // A per-period figure or a total the server left unjudged with a usual to judge by is a running
  // period: its count or total so far beside a whole period's usual ("so far; usual 1 - 5 a
  // month"), no verdict.
  if ((figure.per === 'period' || whole) && judged.standing === null && judged.value !== null && judged.usual !== null && !judged.usual.thin) {
    const { low, high } = formatFigureRange(judged, judged.usual.low, judged.usual.high, language, t)
    // A usual with no width is one value; "0 - 0" reads as a typo for it (as in verdictLine).
    const single = formatFigureValue(judged, judged.usual.low, language, t) === high
    const soFar = single
      ? t(`period.soFarSingle.${judged.usual.window.unit}`, { value: high })
      : t(`period.soFar.${judged.usual.window.unit}`, { low, high })
    return o.window === true ? `${soFar} ${windowPhrase(judged.usual.window, t)}` : soFar
  }
  const line = verdictLine({ ...judged, baseline: judged.usual }, language, t)
  if (line === null || judged.usual === null) return line
  const { unit } = judged.usual.window
  // A total's range is a whole period's total, and says so ("880 - 1,150 for a month"); the window
  // phrase names the period's length itself ("for a month, last 12 months"), so with it no more.
  if (whole) return `${line} ${o.window === true ? windowPhrase(judged.usual.window, t) : t(`period.for.${unit}`)}`
  // A per-period figure's range is a whole period's worth ("1 - 5 a month"), and a per-week
  // figure's a week's worth ("190 - 280 min per week"), and each says so.
  const verdict = figure.per === 'period' ? `${line} ${t(`period.per.${unit}`)}`
    : figure.per === 'week' ? `${line} ${t('period.per.week')}` : line
  if (o.window !== true) return verdict
  return `${verdict} ${windowPhrase(judged.usual.window, t)}`
}

// A day above or below its usual, in the words its unit reads in: a clock time is later or earlier
// (directionWords, the verdict's own rule), a duration longer or shorter, anything else higher or lower.
function sideWords(unit: string): { above: string, below: string } {
  if (directionWords(unit) === 'clock') return { above: 'later', below: 'earlier' }
  if (unit === 'minutes') return { above: 'longer', below: 'shorter' }
  return { above: 'higher', below: 'lower' }
}

// The counted noun's key: nights, days, mornings (the mornings after a period's nights), or none at
// all where a card of one kind of day says it once for every row ("26 of 30 usual").
const COUNT_KEYS = { night: 'usualNights', day: 'usualDays', morning: 'usualMornings', none: 'usual' } as const
export type CountNoun = keyof typeof COUNT_KEYS

/**
 * One point's verdict in words, without its range, as the point panel lists it beside the value:
 * standingShort's words outside the usual ("below your usual", "later than your usual"), "within
 * your usual" inside it, and nothing for a point the server did not judge.
 */
export function pointVerdictWords(standing: PeriodStripPoint['standing'], unit: string, t: Translate): string {
  if (standing === 'within') return t('period.panel.within')
  return standing === null ? '' : standingShort(standing, unit, t)
}

/** "24 of 30 nights usual · 3 longer · 3 shorter"; null when no day was counted, or none judged. */
export function dayCountsLine(figure: PeriodFigure, noun: CountNoun, t: Translate): string | null {
  const { within, above, below, unjudged } = figure.counts
  // No day judged covers no day at all: a figure the server never judges by day (the recovery index)
  // counts every day unjudged, and says nothing here either.
  if (within + above + below === 0) return null
  const count = within + above + below + unjudged
  const words = sideWords(figure.unit)
  const parts = [t(`period.counts.${COUNT_KEYS[noun]}`, { within, count })]
  if (above > 0) parts.push(t(`period.counts.${words.above}`, { count: above }))
  if (below > 0) parts.push(t(`period.counts.${words.below}`, { count: below }))
  return parts.join(SEPARATOR)
}

// A change between two periods, signed, in the figure's own terms: a duration as a signed duration
// ("+0h 23m", PATTERNS.md's "-0h 23m"), a short span in minutes ("+3 min"), anything else through
// formatFigureDifference, taken between the two values as printed.
function changeText(figure: PeriodFigure, change: PeriodChange & { value: number, delta: number }, language: string, t: Translate): string {
  if (figure.unit === 'minutes') {
    if (isShortSpan(figure.metric)) {
      return `${formatFigureDifference(figure, change.value + change.delta, change.value, language, t)}${NBSP}${t('activity.units.min')}`
    }
    // formatSignedDuration signs only a negative; a change reads with its "+" as well.
    const minutes = Math.round(change.value + change.delta) - Math.round(change.value)
    return `${minutes > 0 ? '+' : ''}${formatSignedDuration(minutes, '', language)}`.replaceAll(' ', NBSP)
  }
  return formatFigureDifference(figure, change.value + change.delta, change.value, language, t)
}

/**
 * A month by its name alone ("augustus", "August"), from its "YYYY-MM" or any date inside it, anchored
 * at UTC so no zone moves it: the period before in a standout line, and a month's heading in an
 * overview's grouped list.
 */
export function monthName(month: string, language: string): string {
  return new Date(`${month.slice(0, 7)}-01T00:00:00Z`).toLocaleString(language, { month: 'long', timeZone: 'UTC' })
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
}

// The period before, named by its length, which its own bounds carry: a week (seven days), a
// calendar month by its name, a calendar year by its number, and 3 months otherwise.
function previousName(previous: PeriodChange, language: string, t: Translate): string {
  const days = daysBetween(previous.from, previous.to)
  if (days <= 7) return t('period.standout.weekBefore')
  if (previous.from.slice(0, 7) === previous.to.slice(0, 7)) {
    return monthName(previous.from, language)
  }
  if (previous.from.endsWith('-01-01') && previous.to === `${previous.from.slice(0, 4)}-12-31`) return previous.from.slice(0, 4)
  return t('period.standout.quarterBefore')
}

function hasChange(change: PeriodChange | null): change is PeriodChange & { value: number, delta: number } {
  return change !== null && change.delta !== null && change.value !== null
}

/** A line in runs of plain and emphasised text: the figures a sentence turns on are set bold. */
export type Emphasised = { text: string, strong: boolean }[]

// A mark no catalogue string contains, either side of the index of each emphasised value.
const MARK = '\u0000'

/**
 * A catalogue sentence with the values named in `strong` emphasised: each is interpolated as a
 * mark, the sentence split at the marks, and the value put back as a run of its own. The words
 * around a value stay the catalogue's, whatever order a language puts them in.
 */
export function emphasise(t: Translate, key: string, params: Record<string, string | number>, strong: readonly string[]): Emphasised {
  const marked: Record<string, string | number> = { ...params }
  strong.forEach((name, index) => { marked[name] = `${MARK}${index}${MARK}` })
  // The marked indexes land at the odd positions of the split.
  return t(key, marked).split(MARK).flatMap((piece, index): Emphasised => {
    if (index % 2 === 0) return piece === '' ? [] : [{ text: piece, strong: false }]
    return [{ text: String(params[strong[Number(piece)]!]), strong: true }]
  })
}

/** A line's text with its emphasis dropped. */
export function plainText(line: Emphasised): string {
  return line.map((run) => run.text).join('')
}

/**
 * What stood out, a line each: the high point ("longest: **8h 21m** on Sun, Aug 23", with ✦ when
 * the server judged it better), the change against the period before ("**+0h 23m** against July"),
 * and, when given, against the same period a year earlier. Empty when none of the three has
 * anything to say.
 */
export function standoutLines(o: {
  figure: PeriodFigure, high: PeriodHigh | null, previous: PeriodChange, yearEarlier: PeriodChange | null,
  highWord: 'longest' | 'busiest', language: string, t: Translate,
  /** Whether a change is a day's worth, and says so ("+612 a day against August"): an average per day
   *  of a figure a reader adds up (steps), where a night's average reads as a night's without it. */
  perDay?: boolean,
}): Emphasised[] {
  const { figure, high, previous, yearEarlier, language, t } = o
  const perDay = o.perDay === true
  const lines: Emphasised[] = []
  if (high !== null) {
    const date = formatWeekdayDate(high.localDate, language)
    const line = emphasise(t, `period.standout.${o.highWord}`, { value: formatFigureValue(figure, high.value, language, t), date }, ['value'])
    lines.push(high.good ? [...line, { text: ' ✦', strong: false }] : line)
  }
  if (hasChange(previous)) {
    lines.push(emphasise(t, perDay ? 'period.standout.previousPerDay' : 'period.standout.previous', {
      delta: changeText(figure, previous, language, t), period: previousName(previous, language, t),
    }, ['delta']))
  }
  // On the year range the period before is the previous calendar year, and so is the same period a
  // year earlier: one change, said once.
  if (hasChange(yearEarlier) && !(yearEarlier.from === previous.from && yearEarlier.to === previous.to)) {
    lines.push(emphasise(t, perDay ? 'period.standout.yearEarlierPerDay' : 'period.standout.yearEarlier', { delta: changeText(figure, yearEarlier, language, t) }, ['delta']))
  }
  return lines
}

/**
 * A period figure's strip in the shape stripOf hands a sparkline (figureText.ts): its weekly points
 * where the server sent them (3 months and a year), its daily points otherwise, each labelled by the
 * date it starts on and shaded with its own usual. Picks the points only: a per-week figure's weekly
 * points are already per week and its daily points per day, as the server sends them. Null below
 * two points with a value, since one dot joins nothing.
 */
export function periodStripOf(figure: PeriodFigure): {
  values: (number | null)[], labels: string[], bands: ({ low: number, high: number } | null)[] | undefined
  pointStandings: PointStanding[], pointJudged: PointJudged[], weekly: boolean
} | null {
  const points = figure.weekly ?? figure.daily
  if (points.filter((point) => point.value !== null).length < 2) return null
  return {
    values: points.map((point) => point.value),
    labels: points.map((point) => point.from),
    bands: stripBands(points),
    pointStandings: points.map((point) => point.standing),
    pointJudged: points.map((point) => point.judged),
    weekly: figure.weekly !== null,
  }
}

/**
 * The usual of the most recent point that has one, a point's own (PATTERNS.md: strips shade each day's
 * own usual) rather than the period's usual for an average. A thin one is passed over, as stripBands
 * leaves it unshaded: it judges nothing. Null with none.
 */
export function latestBand(points: readonly PeriodStripPoint[] | undefined): PeriodStripPoint['band'] {
  if (points === undefined) return null
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const band = points[index]!.band
    if (band !== null && !band.thin) return band
  }
  return null
}

// The figures printed as the period's total, by name: the spec's "Distance, floors and elevation show
// the period total", and the Activity mockup's active zone minutes, workout time and time in the hard
// heart-rate zones. The server sends a total for every summed metric (time asleep among them), so a
// total on the wire is not by itself a reason to print one.
export const PERIOD_TOTAL_METRICS: readonly string[] = [
  'distance', 'floors', 'altitude_gain', 'active_zone_minutes', 'workout_minutes', 'hard_zone_minutes',
]

/**
 * The figure as the page judges what it prints: a total (PERIOD_TOTAL_METRICS) with a usual for its
 * total is that total against it ("880 - 1,150 for a month"), the server's `totalStanding` its
 * verdict, tone and bar; anything else is the figure itself, its average against its usual.
 */
export function asPrinted(figure: PeriodFigure): PeriodFigure {
  if (figure.total === null || figure.usualTotal === null || !PERIOD_TOTAL_METRICS.includes(figure.metric)) return figure
  return { ...figure, value: figure.total, usual: figure.usualTotal, standing: figure.totalStanding, judged: figure.totalJudged }
}

/**
 * The figure's value: for a total (PERIOD_TOTAL_METRICS), the period's total, with its average per day
 * in the line under it; for a per-period figure (the nap count), the period's total alone (its count
 * so far while the period runs, which the server leaves unjudged); otherwise the average alone (per night, per day, or per
 * week), whether or not the server sent a total.
 */
export function periodValueLine(figure: PeriodFigure, language: string, t: Translate): { value: string, under: string | null } {
  if (figure.per === 'period' && figure.total !== null) return { value: formatFigureValue(figure, figure.total, language, t), under: null }
  const value = formatFigureValue(figure, figure.value, language, t)
  if (figure.total === null || !PERIOD_TOTAL_METRICS.includes(figure.metric)) return { value, under: null }
  return { value: formatFigureValue(figure, figure.total, language, t), under: t('period.value.perDay', { value }) }
}

/**
 * Skin temperature on an overview page, worded as the night page words it (NightMorning): the
 * period's average as a signed deviation from its usual's centre ("+0.3 °C"), and the usual as a
 * deviation too (deviationVerdictLine), with no window: a row's verdict is the verdict and its range
 * alone, the window said once, in the hero. Null without a usual worth deviating from
 * (none, or thin), or where the server gave a reason not to judge: the figure then reads as its
 * reading, through periodValueLine and periodVerdictLine, never as "— °C".
 */
export function periodDeviationLine(figure: PeriodFigure, language: string, t: Translate): { value: string, verdict: string | null } | null {
  const { usual } = figure
  if (figure.value === null || figure.reason !== null || usual === null || usual.thin) return null
  const deviation = formatSignedNumber(figure.value - usual.center, figure.precision, language, t('common.absent'))
  return {
    value: `${deviation}${NBSP}${t('charts.units.celsius')}`,
    verdict: deviationVerdictLine({ ...figure, baseline: usual, strip: null }, language, t),
  }
}
