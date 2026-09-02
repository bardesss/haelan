import { METRICS } from '@haelan/core/metrics'

/**
 * Rounds `value` to `precision` decimals and groups thousands per `language`, in whatever unit
 * the caller already holds it in. The primitive underneath formatMetricValue below: it takes no
 * metric id and looks nothing up, so it has no way to reach for the wrong precision on its own.
 *
 * That matters because MetricSpec.precision (metrics.ts) is declared in the unit a metric is
 * STORED in, not necessarily the unit a card displays it in: distance is stored in millimeters
 * with precision 0, and Activity.tsx shows it as kilometers with one decimal, a precision the
 * catalogue has no way to answer. A call site doing that conversion has to own the converted
 * precision itself and hand it here directly, never through a metric id, because a metric-id path
 * would silently apply the STORED unit's precision to a DISPLAYED unit's value and be wrong in
 * exactly the way #9 of the precision audit describes.
 */
export function formatNumber(value: number | null, precision: number, language: string, absent: string): string {
  if (value === null) return absent
  return value.toLocaleString(language, { minimumFractionDigits: precision, maximumFractionDigits: precision })
}

/**
 * The common case: `value` is still in the unit METRICS[metric] declares (MetricSpec.precision's
 * own doc comment: "in the unit this spec declares"). Reads precision off the catalogue so a call
 * site cannot drift from it the way the precision audit found repeatedly (Recovery.tsx's
 * threaded-literal precision, Sleep.tsx's hardcoded 0, both correct only by coincidence). Before
 * this function existed anywhere, the four call sites that skipped rounding altogether
 * (hrTooltip.ts, HeartRateRange.tsx, Sparkline.tsx, OverrideList.tsx) let a raw many-decimal float
 * reach a reader outright.
 *
 * Never for a value that has already been converted to a different display unit. See formatNumber's
 * own comment above for why: this function has no parameter for a caller-supplied precision, on
 * purpose, so a converted value has no path through here that would apply the catalogue's
 * stored-unit precision to it by accident. That guard only catches a value passed under the WRONG
 * metric id being absent from the catalogue entirely; a converted value passed under its OWN,
 * correctly spelled metric id (Activity.tsx's distance card handed 'distance' after converting to
 * kilometers, rather than before) still compiles and still silently prints the stored unit's
 * precision, because the catalogue has no way to know the caller already changed the unit. Nothing
 * short of a distinct type for "already converted" can close that path; the throw below closes the
 * other one, an unknown or misspelled metric id, which used to default to precision 0 and would
 * have quietly dropped a decimal off spo2, daily_spo2, weight, body_fat or respiratory_rate.
 */
export function formatMetricValue(value: number | null, metric: string, language: string, absent: string): string {
  const spec = METRICS[metric]
  if (spec === undefined) throw new Error(`formatMetricValue: "${metric}" is not a metric in METRICS`)
  return formatNumber(value, spec.precision, language, absent)
}

/**
 * `(value, absent) => string`, `InsightCard`'s own `formatValue` shape, for an insight card whose
 * tile carries a unit through `StatTile`'s own `unit` prop. That prop's rendering
 * (`StatTile.tsx`'s `<span> {unit}</span>`) puts a space before the unit, which this matches, so
 * an insight sentence built from the returned string reads the same as the tile beside it rather
 * than unitless.
 *
 * `format` is the caller's own non-null formatter, not a metric id: some callers read the
 * catalogue's stored-unit precision through `formatMetricValue` (resting heart rate, daily SpO2),
 * and one converts to a displayed unit first through `formatNumber` (weight's grams to kilograms,
 * `formatMetricValue`'s own comment says why that path can never go through it), so this stays
 * agnostic between the two rather than picking one.
 *
 * First extracted here after the identical `value === null ? absent : \`${...} ${unit}\`` closure
 * appeared at four separate call sites (Dashboard's resting heart rate card, and Recovery's,
 * Health's and Weight's own copies of it) with no shared owner.
 */
export function formatWithUnit(
  value: number | null, absent: string, format: (value: number) => string, unit: string,
): string {
  return value === null ? absent : `${format(value)} ${unit}`
}

/**
 * A local calendar date (`YYYY-MM-DD`, no time component) as the reader's own locale would write
 * it, e.g. "Aug 10, 2026" in English. `OverrideList.tsx`'s own date column is this app's one other
 * user facing date and takes the same `dateStyle: 'medium'` shape; this is the plain-date form of
 * it, with no `timeStyle` to carry since `date` names a day, not a moment.
 *
 * Anchored at UTC midnight and read back in UTC, not the browser's own zone: `date` is a "local
 * date" in the sense every date of this shape in this codebase already uses it (a calendar day in
 * the account's configured time zone, not the browser's), and letting `toLocaleString` interpret a
 * UTC-midnight instant in whatever zone the browser happens to sit in would print the day before
 * for a reader west of it.
 */
export function formatLocalDate(date: string, language: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleString(language, { dateStyle: 'medium', timeZone: 'UTC' })
}

// Round to whole minutes before splitting, not after: splitting first turns 419.6 into 6h and round(59.6)m ("6h 60m").
export function formatDuration(minutes: number): string {
  const total = Math.round(minutes)
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`
}

/**
 * formatDuration for a value that can be negative, which formatDuration itself was never written
 * to take: every other caller in this app (a tile's own headline, a chart's baseline note) hands
 * it a summed or averaged span of real time, which cannot go negative. An insight's delta can — a
 * period where the mean fell hands this a negative number — and formatDuration's own
 * Math.floor(total / 60) paired with a sign-carrying total % 60 (JavaScript's % keeps the
 * dividend's sign) puts the minus on both halves independently: -7 comes out "-1h -7m", not the
 * single leading minus a duration reads as. Negating before the call and reapplying the sign after
 * prints "-0h 07m" for the same -7 instead.
 *
 * Takes `absent` directly, the exact `(value, absent) => string` shape `InsightCard`'s own
 * `formatValue` prop expects, so a caller with nothing more to add can pass this function itself
 * rather than writing a one-line wrapper around it. First extracted here after the identical
 * closure, each carrying its own copy of this comment, drifted onto two pages (Dashboard's own
 * sleep card and Sleep's own asleep card) with no shared owner: a future fix to one was not a fix
 * to the other.
 */
export function formatSignedDuration(value: number | null, absent: string): string {
  if (value === null) return absent
  return value < 0 ? `-${formatDuration(-value)}` : formatDuration(value)
}

// Wrapped into the day before splitting, and wrapped in the direction that survives a negative.
// A bed time is minutes from the local midnight of the date the night ENDED (see
// packages/core/src/derive/metrics.ts on sleep_bedtime_minutes: "an 23:30 bedtime is -30"), so
// negatives reach here as ordinary values rather than as mistakes. JavaScript's % keeps the sign
// of its left operand, which rendered -40 as "-1:-40"; the double modulo below reads it as 23:20,
// which is the clock time that minute actually names.
export function formatClock(minutesPastMidnight: number): string {
  const total = ((Math.round(minutesPastMidnight) % 1440) + 1440) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export type Tone = 'good' | 'bad' | 'neutral'
export type Delta = { text: string; dir: 'up' | 'down' | 'flat'; tone?: Tone; basis?: string }

// 'neutral' means the metric's polarity is genuinely ambiguous, not that no one bothered to state it.
export type Polarity = 'higher-is-better' | 'lower-is-better' | 'neutral'

export function toneFor(dir: Delta['dir'], polarity: Polarity): Tone {
  if (dir === 'flat' || polarity === 'neutral') return 'neutral'
  const goodDirection = polarity === 'higher-is-better' ? 'up' : 'down'
  return dir === goodDirection ? 'good' : 'bad'
}

export function toneOf(delta: Delta | undefined): Tone {
  return delta?.tone ?? 'neutral'
}

// The shape react-i18next's `t` actually has, kept local rather than importing i18next's own
// type surface for one parameter: format.ts has no JSX and no hook access, so the caller (a
// component) resolves `t` and hands it down.
export type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * Whether a metric's values are positions on a clock rather than quantities, so no percentage
 * change over them means anything.
 *
 * Read off the catalogue's own `unit` rather than a list kept here, because the catalogue is where
 * the fact lives and where the next such metric will be declared:
 * packages/core/src/derive/metrics.ts gives sleep_bedtime_minutes and sleep_waketime_minutes
 * `minutes_from_local_midnight` precisely to say this, in a comment that spells out the
 * consequence ("-30 is not thirty minutes of anything, it is thirty minutes before midnight").
 * trend() over that scale rendered a fortnight moving from 23:58 to 23:30, a person going to bed
 * earlier, as "up 1400%", and 00:10 moving to 23:50 as "down 200%".
 *
 * A predicate over the metric rather than an argument at the call site: the delta was first
 * suppressed by passing null for a positional `polarity`, which meant only the one helper that
 * grew the parameter could express it, the other three page helpers could not, and the next clock
 * scaled metric would take whatever a future call site typed. This is the shape MetricCard already
 * uses for the wear clause, where coverageIsWearSignal decides inside the component and no caller
 * is asked to know.
 */
export function metricIsClockOffset(metric: string): boolean {
  return METRICS[metric]?.unit === 'minutes_from_local_midnight'
}

/**
 * The delta a card should show for a metric, which for a clock offset is none.
 *
 * Every page tile goes through this rather than calling trend() directly, so the decision is made
 * once from the metric a card already names instead of once per page helper. trend() itself keeps
 * its narrower contract (a percentage over a list of numbers, no opinion about what they mean),
 * because that is what its own unit tests hold it to and it has no metric to consult.
 */
export function deltaFor(
  t: Translate, metric: string, values: number[], polarity: Polarity,
): Delta | undefined {
  if (metricIsClockOffset(metric)) return undefined
  return trend(t, values, polarity)
}

// Flat below 1% swing: smaller reads as noise, not a real trend.
//
// Undefined rather than a Delta whose text lies: a series with fewer than two points (the "day"
// range yields exactly one) hands slice() an empty first half, and 0 reduced over nothing divided
// by a length of zero is NaN before either mean is even compared. A series whose first half
// legitimately averages to zero (a real reading, not a gap, for a metric like
// sleep_asleep_minutes on a night with no sleep) divides by that zero instead and produces
// Infinity. Both are "no percentage exists to report" rather than two different bugs, so one
// finite check after computing pct catches both without special-casing either.
export function trend(t: Translate, values: number[], polarity: Polarity = 'neutral'): Delta | undefined {
  const half = Math.floor(values.length / 2)
  const first = values.slice(0, half)
  const second = values.slice(half)
  const meanFirst = first.reduce((sum, v) => sum + v, 0) / first.length
  const meanSecond = second.reduce((sum, v) => sum + v, 0) / second.length
  const pct = ((meanSecond - meanFirst) / meanFirst) * 100
  if (!Number.isFinite(pct)) return undefined
  const dir: Delta['dir'] = Math.abs(pct) < 1 ? 'flat' : pct > 0 ? 'up' : 'down'
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→'
  return {
    text: `${arrow} ${Math.abs(pct).toFixed(0)}%`,
    dir,
    tone: toneFor(dir, polarity),
    basis: t('common.trendBasis', { recent: second.length, earlier: first.length }),
  }
}
