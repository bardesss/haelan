import type { GlanceFigure, GlanceStepsPace } from '../../data/useGlance.js'
import type { Translate } from '../../format.js'
import { formatDuration, formatClock, formatMetricValue } from '../../format.js'

// Which of the four printable shapes a figure's number takes. Not read by formatFigure or
// usualLine as an argument - both take the figure itself and look the metric up. Module-private:
// nothing outside this file needs a figure's shape, since every caller formats through the two.
type FigureKind = 'count' | 'duration' | 'clock' | 'metric'

function figureKind(metric: string): FigureKind {
  if (metric === 'sleep_asleep_minutes') return 'duration'
  if (metric === 'sleep_bedtime_minutes' || metric === 'sleep_waketime_minutes') return 'clock'
  if (metric === 'active_minutes' || metric === 'recovery_index') return 'count'
  return 'metric'
}

// The one place that turns a raw number into the string a card prints for it, shared by
// formatFigure (the figure's own value) and usualLine (the baseline's low / high / center): the
// spec is explicit that the partial clause's `center` must read "formatted the same way as the
// value", and routing both through this rather than duplicating the switch is what keeps that true
// rather than merely documented.
function formatValue(value: number, metric: string, language: string): string {
  switch (figureKind(metric)) {
    case 'duration': return formatDuration(value)
    case 'clock': return formatClock(value)
    case 'count': return String(Math.round(value))
    case 'metric': return formatMetricValue(value, metric, language, '')
  }
}

/**
 * The figure's value as the card prints it: a duration for sleep minutes, a clock time for bed and
 * wake, a catalogue-formatted number otherwise. Null when the figure has no value, never a zero or
 * a placeholder string - the absence audit's own point (see format.ts's formatNumber), still true
 * for a glance figure that has not reported yet today.
 */
export function formatFigure(figure: GlanceFigure, language: string): string | null {
  if (figure.value === null) return null
  return formatValue(figure.value, figure.metric, language)
}

/**
 * How the figure's value compares with the person's usual, or null when there is nothing to
 * compare (no value, or no baseline at all).
 *
 * `baseline.thin` outranks everything else: too little history to say what is usual is true
 * regardless of whether today happens to sit inside, above or below the band, and regardless of
 * whether the figure is still partial.
 *
 * A partial figure (today, still running) is worded "so far", never as a shortfall against its
 * usual - the spec's own example is a figure sitting well under its low that must still read "so
 * far" rather than "below", because a day that has not finished yet is not a day that came up
 * short. That is why the partial check runs before the within/above/below comparison rather than
 * after it: a comparison computed first and then overridden would have to be trusted never to leak
 * through, where checking partial first makes leaking it structurally impossible.
 */
export function usualLine(figure: GlanceFigure, t: Translate, language: string): string | null {
  if (figure.value === null || figure.baseline === null) return null
  const baseline = figure.baseline
  if (baseline.thin) return t('glance.usual.thin')
  if (figure.partial) {
    return t('glance.usual.partial', { center: formatValue(baseline.center, figure.metric, language) })
  }
  const low = formatValue(baseline.low, figure.metric, language)
  const high = formatValue(baseline.high, figure.metric, language)
  // The verdict is the server's (GlanceFigure.standing); this only words it. A figure the server
  // left without one here is one it could not judge, which reads as within rather than inventing a side.
  if (figure.standing === 'below') return t('glance.usual.below', { low, high })
  if (figure.standing === 'above') return t('glance.usual.above', { low, high })
  return t('glance.usual.within', { low, high })
}

// The day before `today` (a YYYY-MM-DD local date), computed by stepping the UTC calendar date
// rather than subtracting 86_400_000 ms: the local dates this app hands around name a day, not an
// instant, and formatLocalDate's own convention (anchor at UTC midnight, read back in UTC) is the
// one this function has to agree with so "yesterday" names the same day that convention would.
export function yesterdayOf(today: string): string {
  const date = new Date(`${today}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

// A moment (asOfMs) as a clock time in the person's own zone, not the browser's: two people
// looking at the same glance in different zones must read different clock times for the same
// instant, the way formatClock's own callers already do for a bed or wake time computed server
// side.
// hour12: false, not left to the language's own default: English's default is a 12-hour clock with
// an AM/PM suffix ("11:32 AM"), and every other clock time this app prints (formatClock, bed and
// wake times) is 24-hour with no suffix - an as-of time in the other form beside them would read
// as a different kind of fact.
export function formatTimeOfDay(atMs: number, language: string, timezone: string): string {
  return new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone }).format(new Date(atMs))
}

// A local date as "5 Sep", the short form a "night of ..." clause reads best in - formatLocalDate's
// own `dateStyle: 'medium'` carries the year, which a night from this week does not need to state.
// Same UTC-midnight anchoring as formatLocalDate, for the same reason: the day printed must not
// depend on which zone the browser sits in.
/**
 * The pace line's key from the server's verdict; null on a thin or absent pace, where the so-far
 * line speaks instead.
 */
export function paceKey(pace: GlanceStepsPace | null): 'glance.pace.ahead' | 'glance.pace.on' | 'glance.pace.behind' | null {
  if (pace === null || pace.standing === null) return null
  return `glance.pace.${pace.standing}`
}

function formatShortDate(date: string, language: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleString(language, { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

/**
 * What the figure is current to: an instant read as a clock time ("as of 11:32") when `asOfMs` is
 * known and lands on today, a day read as today/yesterday from `asOfDate` otherwise, or - for a
 * sleep figure, whose `asOfDate` names the night rather than the moment it was read - "night of 5
 * Sep" regardless of any instant carried alongside it. Null when there is no value to be current
 * to.
 */
export function asOfLine(
  figure: GlanceFigure,
  o: { today: string, timezone: string, night?: boolean },
  t: Translate,
  language: string,
): string | null {
  if (figure.value === null) return null
  if (o.night) {
    if (figure.asOfDate === null) return null
    return t('glance.asOf.night', { date: formatShortDate(figure.asOfDate, language) })
  }
  if (figure.asOfMs !== null && figure.asOfDate === o.today) {
    return t('glance.asOf.time', { time: formatTimeOfDay(figure.asOfMs, language, o.timezone) })
  }
  if (figure.asOfDate === o.today) return t('glance.asOf.today')
  if (figure.asOfDate === yesterdayOf(o.today)) return t('glance.asOf.yesterday')
  return null
}
