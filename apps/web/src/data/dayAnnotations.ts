import type { Translate } from '../format.js'
import { SEED_KINDS } from './eventKinds.js'
import type { StoredEvent, StoredNote } from './useAnnotations.js'
import type { MetricAnnotations } from './chartAnnotations.js'

const EMPTY: { date: string; text: string }[] = Object.freeze([]) as never[]

/**
 * A note carries its own free text already; an event carries only a `kind` and an optional
 * `note`. `kind` is translated through the same six annotate.event.kinds keys the panel's own
 * datalist offers (SEED_KINDS, imported rather than copied), and left exactly as the reader typed
 * it otherwise, since a kind past the seed set is their own words, not this project's vocabulary
 * to translate. The event's own note, when present, is appended rather than dropped: it is the one
 * piece of an event a reader actually wrote by hand, same as a note's body.
 */
function eventText(t: Translate, event: StoredEvent): string {
  const kind = SEED_KINDS.includes(event.kind) ? t(`annotate.event.kinds.${event.kind}`) : event.kind
  return event.note ? t('charts.absence.eventWithNote', { kind, note: event.note }) : kind
}

/**
 * Every note and every event in the requested range, flattened into the same `{date, text}` shape
 * a chart's `annotations` prop already takes, one entry per row rather than one per date: two
 * notes cannot share a date (NoteStore's own unique constraint), but a note and an event can, and
 * collapsing them here would be a second place deciding how same-date text joins, next to the one
 * that already exists (each chart's own accessible table, ChartFigure's row builder). Left apart,
 * both draw from the same rule: filter by date, join with `', '`.
 *
 * Day level, not metric scoped, unlike an override: a note about a bad night or an event like
 * travel is something that happened to the person that day, not a claim about one chart's own
 * reading, so this carries no metric and reaches every chart on a page alike (see the pages that
 * call mergeDayAnnotations below).
 *
 * An event is placed on its own `localDate` alone. A multi day event (one with `endedAtMs` set)
 * marks only the day it started, never every day it spans: the server resolves a local date for
 * `startedAtMs` alone (see StoredEvent's own comment on why that arithmetic is not duplicated
 * here), so an end day this function could place a second mark on does not exist on the wire, and
 * guessing at the calendar between the two would be exactly the DST sensitive arithmetic this
 * project keeps out of the browser. eventText above never implies a range either, only names the
 * event itself, so a reader is not told the mark covers days this build never actually placed one on.
 */
export function dayAnnotationsFrom(
  notes: readonly StoredNote[], events: readonly StoredEvent[], t: Translate,
): { date: string; text: string }[] {
  if (notes.length === 0 && events.length === 0) return EMPTY
  return [
    ...notes.map((n) => ({ date: n.localDate, text: n.body })),
    ...events.map((e) => ({ date: e.localDate, text: eventText(t, e) })),
  ].sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Every metric `overridesByMetric` grouped, with `dayAnnotations` appended to whichever reasons
 * that metric already carries.
 *
 * Meant to be called once per render, memoised by the caller on `byMetric` and `dayAnnotations`
 * (both already stable references across a render that changed neither, see those functions' own
 * comments), and read through `annotationsWithDay` below rather than concatenated inside a card's
 * own render closure. A page draws one card per metric and calls that closure once per card; doing
 * the concatenation there would allocate a fresh annotations array for every card on every render,
 * handing each chart's `build` a new identity and disposing it (chart-lifecycle.test.tsx), on any
 * render at all, including the one opening the panel causes by setting page state after a click on
 * an entirely different chart.
 */
export function mergeDayAnnotations(
  byMetric: ReadonlyMap<string, MetricAnnotations>,
  dayAnnotations: { date: string; text: string }[],
): Map<string, { date: string; text: string }[]> {
  const merged = new Map<string, { date: string; text: string }[]>()
  for (const [metric, entry] of byMetric) {
    merged.set(metric, entry.annotations.length === 0 ? dayAnnotations : [...entry.annotations, ...dayAnnotations])
  }
  return merged
}

/**
 * `merged`'s own entry for `metric`, or `dayAnnotations` itself when the metric carries no
 * override of its own. The fallback is `dayAnnotations` by reference, not a copy: every metric
 * with no override (most of them, on any real page) then shares one array identity across a render
 * that changed neither the overrides list nor the notes/events lists, the same discipline
 * chartAnnotations.ts's own NONE constant holds for `excluded`/`corrected`.
 */
export function annotationsWithDay(
  merged: ReadonlyMap<string, { date: string; text: string }[]>,
  dayAnnotations: { date: string; text: string }[],
  metric: string,
): { date: string; text: string }[] {
  return merged.get(metric) ?? dayAnnotations
}
