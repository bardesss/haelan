import type { PeriodChange, PeriodFigure, PeriodHigh, PeriodWindow } from '../../data/periodTypes.js'
import { formatDuration, formatShortDate } from '../../format.js'
import type { Translate } from '../../format.js'
import { directionWords } from '../../charts/base.js'
import type { PointJudged, PointStanding } from '../../charts/base.js'
import { stripBands } from '../dashboard/cardShared.js'
import { formatFigureDifference, formatFigureValue, isShortSpan, verdictLine } from './figureText.js'

// The words of an overview page (Sleep, Activity) over the /period read: PATTERNS.md's "Overview
// pages" section, beside this file. The server has already judged every figure, counted its days and
// picked its high point; this only puts them into words.

const NBSP = ' '
const SEPARATOR = ' · '

/** "for a month, last 12 months" / "voor een maand, afgelopen 12 maanden"; year: "for a year, from 2025". */
export function windowPhrase(window: PeriodWindow, t: Translate): string {
  return t(`period.window.${window.unit}`, { count: window.count, year: window.from.slice(0, 4) })
}

/**
 * verdictLine on the period figure, its usual standing in for the night page's baseline, then the
 * window that usual comes from; or, where the server gave a reason not to judge, the reason's own
 * words (no-data says nothing at all).
 */
export function periodVerdictLine(figure: PeriodFigure, language: string, t: Translate): string | null {
  if (figure.reason === 'no-data') return null
  if (figure.reason === 'too-few-days') return t('period.reason.tooFewDays')
  if (figure.reason === 'thin-usual') return t('glance.usual.thin')
  const verdict = verdictLine({ ...figure, baseline: figure.usual }, language, t)
  if (verdict === null || figure.usual === null) return verdict
  return verdict + SEPARATOR + windowPhrase(figure.usual.window, t)
}

// A day above or below its usual, in the words its unit reads in: a clock time is later or earlier
// (directionWords, the verdict's own rule), a duration longer or shorter, anything else higher or lower.
function sideWords(unit: string): { above: string, below: string } {
  if (directionWords(unit) === 'clock') return { above: 'later', below: 'earlier' }
  if (unit === 'minutes') return { above: 'longer', below: 'shorter' }
  return { above: 'higher', below: 'lower' }
}

/** "24 of 30 nights usual · 3 longer · 3 shorter"; null when no day was counted, or none judged. */
export function dayCountsLine(figure: PeriodFigure, noun: 'night' | 'day', t: Translate): string | null {
  const { within, above, below, unjudged } = figure.counts
  // No day judged covers no day at all: a figure the server never judges by day (the recovery index)
  // counts every day unjudged, and says nothing here either.
  if (within + above + below === 0) return null
  const count = within + above + below + unjudged
  const words = sideWords(figure.unit)
  const parts = [t(`period.counts.${noun === 'night' ? 'usualNights' : 'usualDays'}`, { within, count })]
  if (above > 0) parts.push(t(`period.counts.${words.above}`, { count: above }))
  if (below > 0) parts.push(t(`period.counts.${words.below}`, { count: below }))
  return parts.join(SEPARATOR)
}

// A change between two periods, signed, in the figure's own terms: a duration as a signed duration
// ("+0h 23m", PATTERNS.md's "-0h 23m"), a short span in minutes ("+3 min"), anything else through
// formatFigureDifference, taken between the two values as printed.
function changeText(figure: PeriodFigure, change: PeriodChange & { value: number, delta: number }, language: string, t: Translate): string {
  if (figure.unit === 'minutes') {
    const minutes = Math.round(change.value + change.delta) - Math.round(change.value)
    if (isShortSpan(figure.metric)) {
      return `${formatFigureDifference(figure, change.value + change.delta, change.value, language, t)}${NBSP}${t('activity.units.min')}`
    }
    const sign = minutes > 0 ? '+' : minutes < 0 ? '-' : ''
    return `${sign}${formatDuration(Math.abs(minutes), language)}`.replaceAll(' ', NBSP)
  }
  return formatFigureDifference(figure, change.value + change.delta, change.value, language, t)
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
    return new Date(`${previous.from}T00:00:00Z`).toLocaleString(language, { month: 'long', timeZone: 'UTC' })
  }
  if (previous.from.endsWith('-01-01') && previous.to === `${previous.from.slice(0, 4)}-12-31`) return previous.from.slice(0, 4)
  return t('period.standout.quarterBefore')
}

function hasChange(change: PeriodChange | null): change is PeriodChange & { value: number, delta: number } {
  return change !== null && change.delta !== null && change.value !== null
}

/**
 * The one line saying what stood out: the high point ("longest: 8h 21m on Aug 23", with ✦ when the
 * server judged it better), the change against the period before, and, when given, against the same
 * period a year earlier. Null when none of the three has anything to say.
 */
export function standoutLine(o: {
  figure: PeriodFigure, high: PeriodHigh | null, previous: PeriodChange, yearEarlier: PeriodChange | null,
  highWord: 'longest' | 'busiest', language: string, t: Translate,
}): string | null {
  const { figure, high, previous, yearEarlier, language, t } = o
  const parts: string[] = []
  if (high !== null) {
    const date = formatShortDate(high.localDate, high.localDate, language)
    const words = t(`period.standout.${o.highWord}`, { value: formatFigureValue(figure, high.value, language, t), date })
    parts.push(high.good ? `${words} ✦` : words)
  }
  if (hasChange(previous)) {
    parts.push(t('period.standout.previous', {
      delta: changeText(figure, previous, language, t), period: previousName(previous, language, t),
    }))
  }
  if (hasChange(yearEarlier)) {
    parts.push(t('period.standout.yearEarlier', { delta: changeText(figure, yearEarlier, language, t) }))
  }
  return parts.length === 0 ? null : parts.join(SEPARATOR)
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

// The figures printed as the period's total, by name: the spec's "Distance, floors and elevation show
// the period total". The server sends a total for every summed metric (time asleep among them), so a
// total on the wire is not by itself a reason to print one.
export const PERIOD_TOTAL_METRICS: readonly string[] = ['distance', 'floors', 'altitude_gain']

/**
 * The figure's value: for a total (PERIOD_TOTAL_METRICS), the period's total, with its average per day
 * in the line under it; otherwise the average alone (per night, per day, or per week), whether or not
 * the server sent a total.
 */
export function periodValueLine(figure: PeriodFigure, language: string, t: Translate): { value: string, under: string | null } {
  const value = formatFigureValue(figure, figure.value, language, t)
  if (figure.total === null || !PERIOD_TOTAL_METRICS.includes(figure.metric)) return { value, under: null }
  return { value: formatFigureValue(figure, figure.total, language, t), under: t('period.value.perDay', { value }) }
}
