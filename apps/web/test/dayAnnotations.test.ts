import { describe, it, expect } from 'vitest'
import { dayAnnotationsFrom, mergeDayAnnotations, annotationsWithDay } from '../src/data/dayAnnotations.js'
import type { StoredEvent, StoredNote } from '../src/data/useAnnotations.js'
import type { MetricAnnotations } from '../src/data/chartAnnotations.js'
import type { Translate } from '../src/format.js'

// A hand rolled stand-in for i18next's own t(), the same device chart-marks.test.tsx's own
// header comment explains for why this file carries no I18nProvider: a real instance would make
// this file assert against translated copy a locale file is free to reword, rather than against
// which key and which options dayAnnotations.ts actually asked for. MESSAGES mirrors the real keys
// this module reads (annotate.event.kinds.*, charts.event.withNote, charts.event.multiDay),
// interpolated the same {{token}} way i18next itself does, so a change to any one template's own
// placeholders would break here too rather than only in production.
const MESSAGES: Record<string, string> = {
  'annotate.event.kinds.illness': 'Illness',
  'annotate.event.kinds.travel': 'Travel',
  'charts.event.withNote': '{{kind}}: {{note}}',
  'charts.event.multiDay': '{{kind}}, started',
}
const t: Translate = (key, options) => {
  let text = MESSAGES[key] ?? key
  if (options) for (const [k, v] of Object.entries(options)) text = text.replaceAll(`{{${k}}}`, String(v))
  return text
}

function note(over: Partial<StoredNote>): StoredNote {
  return { id: 'n1', localDate: '2026-08-11', body: 'flew to Tokyo', updatedAtMs: 0, ...over }
}

function event(over: Partial<StoredEvent>): StoredEvent {
  return {
    id: 'e1', kind: 'travel', startedAtMs: 0, startedAtOffsetMinutes: 0,
    endedAtMs: null, endedAtOffsetMinutes: null, value: null, note: null,
    localDate: '2026-08-11', ...over,
  }
}

describe('dayAnnotationsFrom', () => {
  it("carries a note's own date and body through unchanged", () => {
    const result = dayAnnotationsFrom([note({ localDate: '2026-08-12', body: 'sick day' })], [], t)
    expect(result).toEqual([{ date: '2026-08-12', text: 'sick day' }])
  })

  it('translates a seed kind event with no note of its own', () => {
    const result = dayAnnotationsFrom([], [event({ kind: 'illness', note: null })], t)
    expect(result).toEqual([{ date: '2026-08-11', text: 'Illness' }])
  })

  // A kind past the seed set is the reader's own words, not this project's vocabulary: the panel's
  // datalist accepts anything typed past the six seeds (AnnotatePanel.tsx), and this has to read
  // it back the same way, not attempt (and fail) to translate it.
  it("leaves a kind outside the seed set exactly as the reader typed it", () => {
    const result = dayAnnotationsFrom([], [event({ kind: 'dentist appointment', note: null })], t)
    expect(result).toEqual([{ date: '2026-08-11', text: 'dentist appointment' }])
  })

  it("appends an event's own note to its kind rather than dropping it", () => {
    const result = dayAnnotationsFrom([], [event({ kind: 'travel', note: 'delayed flight' })], t)
    expect(result).toEqual([{ date: '2026-08-11', text: 'Travel: delayed flight' }])
  })

  // The reviewer's own finding: a bare kind label on the one day a multi day event is marked
  // asserts, by omission, that it was only that day. "started" corrects that without resolving the
  // end day's own local date (endedAtMs !== null is a null check on a field already on the wire).
  it('marks a multi day event as started rather than implying it was only that one day', () => {
    const result = dayAnnotationsFrom([], [event({ kind: 'travel', endedAtMs: 1_770_500_000_000, note: null })], t)
    expect(result).toEqual([{ date: '2026-08-11', text: 'Travel, started' }])
  })

  it('leaves a single day event exactly as before, no "started" clause', () => {
    const result = dayAnnotationsFrom([], [event({ kind: 'travel', endedAtMs: null, note: null })], t)
    expect(result).toEqual([{ date: '2026-08-11', text: 'Travel' }])
  })

  it('combines the multi day clause with a note, in that order', () => {
    const result = dayAnnotationsFrom(
      [], [event({ kind: 'travel', endedAtMs: 1_770_500_000_000, note: 'delayed flight' })], t,
    )
    expect(result).toEqual([{ date: '2026-08-11', text: 'Travel, started: delayed flight' }])
  })

  // The task's own multiplicity rule: a note and an event on the same date are two entries, not
  // one silently overwriting the other. Sparkline/ActivityHeatmap/HeartRateRange's own filter+join
  // (not find()) is what reads both back out; this pins that both actually reach the array they
  // read from.
  it('keeps a note and an event on the same date as two separate entries, not one overwriting the other', () => {
    const result = dayAnnotationsFrom(
      [note({ localDate: '2026-08-11', body: 'felt off' })],
      [event({ kind: 'illness', note: null })],
      t,
    )
    expect(result).toHaveLength(2)
    expect(result).toContainEqual({ date: '2026-08-11', text: 'felt off' })
    expect(result).toContainEqual({ date: '2026-08-11', text: 'Illness' })
  })

  it('sorts a mixed set of notes and events by date', () => {
    const result = dayAnnotationsFrom(
      [note({ localDate: '2026-08-15', body: 'later' })],
      [event({ localDate: '2026-08-10', kind: 'travel', note: null })],
      t,
    )
    expect(result.map((r) => r.date)).toEqual(['2026-08-10', '2026-08-15'])
  })

  // Chart props are keyed on this identity, same reason annotationsFor's own NONE singleton is
  // pinned in chartAnnotations.test.ts: a fresh [] literal per call would hand every chart with no
  // notes or events a new build identity every render.
  it('returns the same frozen empty array, by identity, when there is nothing to annotate', () => {
    expect(dayAnnotationsFrom([], [], t)).toBe(dayAnnotationsFrom([], [], t))
  })
})

describe('mergeDayAnnotations / annotationsWithDay', () => {
  const dayAnnotations = [{ date: '2026-08-11', text: 'Illness' }]

  it("appends the day level list after a metric's own override annotations", () => {
    const byMetric = new Map<string, MetricAnnotations>([
      ['steps', { excluded: ['2026-08-10'], corrected: [], annotations: [{ date: '2026-08-10', text: 'Watch left charging' }] }],
    ])
    const merged = mergeDayAnnotations(byMetric, dayAnnotations)
    expect(annotationsWithDay(merged, dayAnnotations, 'steps')).toEqual([
      { date: '2026-08-10', text: 'Watch left charging' },
      { date: '2026-08-11', text: 'Illness' },
    ])
  })

  // The fallback path every metric with no override of its own takes, which on a real page is
  // most of them (see mergeDayAnnotations' own comment): the day level list has to reach a chart
  // that carries no override too, since a note or an event says nothing about any one metric.
  it('falls back to the day level list itself, by reference, for a metric with no override entry', () => {
    const byMetric = new Map<string, MetricAnnotations>()
    const merged = mergeDayAnnotations(byMetric, dayAnnotations)
    expect(annotationsWithDay(merged, dayAnnotations, 'steps')).toBe(dayAnnotations)
  })

  // The identity guarantee the density decision leans on: every metric on a page without its own
  // override shares one array, not a fresh copy each, which is what keeps opening the panel (a
  // page-wide rerender) from disposing every other chart on the page.
  it('hands two different metrics with no override the exact same array reference', () => {
    const byMetric = new Map<string, MetricAnnotations>()
    const merged = mergeDayAnnotations(byMetric, dayAnnotations)
    expect(annotationsWithDay(merged, dayAnnotations, 'steps'))
      .toBe(annotationsWithDay(merged, dayAnnotations, 'floors'))
  })

  // Defensive symmetry with the fallback above: a map entry whose own annotations list is already
  // empty (overridesByMetric never actually produces one today, since every parsed row pushes at
  // least its own reason) still has to resolve to dayAnnotations by reference rather than a
  // needless copy of it, the same as a metric absent from the map entirely.
  it('falls back to the day level list by reference for a map entry with no annotations of its own', () => {
    const byMetric = new Map<string, MetricAnnotations>([
      ['steps', { excluded: [], corrected: [], annotations: [] }],
    ])
    const merged = mergeDayAnnotations(byMetric, dayAnnotations)
    expect(annotationsWithDay(merged, dayAnnotations, 'steps')).toBe(dayAnnotations)
  })
})
