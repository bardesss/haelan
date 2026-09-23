import { METRICS } from '../derive/metrics.ts'
import { shiftLocalDate } from '../derive/localDay.ts'
import type { PersonQuery, DailyPoint } from './personQuery.ts'

/**
 * The glance: last night, today's recovery and today so far, as one person bound read (M9a).
 *
 * The payload is the contract, not a page. The web dashboard (M9b) and the native app (M12)
 * render it, so anything either client would otherwise compute - a baseline, which night counts
 * as last night, whether a source has gone quiet - is decided here once. Everything is computed
 * on read from existing rows; nothing is stored, so no install rebuilds on upgrade.
 *
 * Every figure says what it is current to in two ways, because they answer different questions.
 * `asOfDate` is the day the value belongs to, which a once-a-day reading (HRV, resting heart
 * rate) always has. `asOfMs` is the instant of the last reading behind it, which only a figure
 * built from samples (steps, today's heart rate) or from a night (its end) can name. Neither is
 * ever `daily.updated_at_ms`: that is when derivation ran, and after a rebuild it would call a
 * week-old number fresh.
 */

/** A source feeding a figure that has gone quiet by its own cadence (M6a's rule), with its name. */
export interface GlanceStaleSource { sourceId: string, name: string, lastReportedDate: string, medianGapDays: number | null }

/** A figure's baseline as the band a client draws: centre, and one spread either side. */
export interface GlanceBaseline { center: number, low: number, high: number, thin: boolean }

export interface GlanceStripDay { localDate: string, value: number | null }

export interface GlanceFigure {
  metric: string
  value: number | null
  unit: string
  baseline: GlanceBaseline | null
  /** The local date `value` belongs to; null when there is no value. */
  asOfDate: string | null
  /** The instant of the last reading behind `value`, where one exists; never a write time. */
  asOfMs: number | null
  /** True while the day `value` belongs to is still running. */
  partial: boolean
  staleSources: GlanceStaleSource[]
  /** Seven entries, oldest first, ending on the figure's own date. */
  strip: GlanceStripDay[]
}

/** What every section reads: the person's query, their today, now, and who has gone quiet. */
export interface GlanceContext {
  q: PersonQuery
  today: string
  nowMs: number
  /** Stale sources by id, from sourceActivity, judged against `today`. */
  stale: ReadonlyMap<string, { lastReportedDate: string, medianGapDays: number | null }>
  nameOf: (sourceId: string) => string
}

const STRIP_DAYS = 7

export function contextFor(
  q: PersonQuery, input: { today: string, nowMs: number, nameOf: (id: string) => string },
): GlanceContext {
  const stale = new Map<string, { lastReportedDate: string, medianGapDays: number | null }>()
  for (const activity of q.sourceActivity({ today: input.today })) {
    if (activity.status !== 'stale' || activity.lastReportedDate === null) continue
    stale.set(activity.sourceId, { lastReportedDate: activity.lastReportedDate, medianGapDays: activity.medianGapDays })
  }
  return { q, today: input.today, nowMs: input.nowMs, stale, nameOf: input.nameOf }
}

/** The sources a merged row names in its mix, or the row's own source when it is a device row. */
function sourcesOf(point: DailyPoint): string[] {
  if (point.sourceMix === null) return point.source === 'merged' || point.source === 'provider' ? [] : [point.source]
  try {
    const parsed: unknown = JSON.parse(point.sourceMix)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((entry) => (entry !== null && typeof entry === 'object' ? (entry as { source?: unknown }).source : undefined))
      .filter((source): source is string => typeof source === 'string')
  } catch {
    // A malformed mix is a temporarily incomplete source list, never a failed payload.
    return []
  }
}

export function staleFeeding(ctx: GlanceContext, sourceIds: Iterable<string>): GlanceStaleSource[] {
  const out: GlanceStaleSource[] = []
  for (const sourceId of new Set(sourceIds)) {
    const stale = ctx.stale.get(sourceId)
    if (stale === undefined) continue
    out.push({ sourceId, name: ctx.nameOf(sourceId), lastReportedDate: stale.lastReportedDate, medianGapDays: stale.medianGapDays })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function stripDates(on: string): string[] {
  return Array.from({ length: STRIP_DAYS }, (_, i) => shiftLocalDate(on, i - (STRIP_DAYS - 1)))
}

export function dailyFigure(
  ctx: GlanceContext, o: { metric: string, agg: string, on: string, partial: boolean, asOfMs: number | null },
): GlanceFigure {
  const dates = stripDates(o.on)
  const { points } = ctx.q.series({ metric: o.metric, agg: o.agg, from: dates[0]!, to: o.on })
  const byDate = new Map(points.map((point) => [point.localDate, point]))
  const onDay = byDate.get(o.on)
  const baseline = ctx.q.baseline({ metric: o.metric, agg: o.agg, on: o.on })
  return {
    metric: o.metric,
    value: onDay?.value ?? null,
    unit: METRICS[o.metric]?.unit ?? '',
    baseline: baseline === null ? null : {
      center: baseline.center, low: baseline.center - baseline.spread, high: baseline.center + baseline.spread, thin: baseline.thin,
    },
    asOfDate: onDay === undefined ? null : o.on,
    asOfMs: onDay === undefined ? null : o.asOfMs,
    partial: o.partial,
    staleSources: staleFeeding(ctx, points.flatMap(sourcesOf)),
    strip: dates.map((localDate) => ({ localDate, value: byDate.get(localDate)?.value ?? null })),
  }
}
