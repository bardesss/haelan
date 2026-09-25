import { describe, it, expect } from 'vitest'
import type { Glance } from '../../packages/core/src/query/glance.ts'
import { sliceToFirstDay, trimGlance, unreachableDays } from '../../demo/capture/slice.ts'

const P = '/api/v1/p/demo'

/** Seven strip days ending on `on`, one value each (null for a silent day). */
function strip(on: string, values: (number | null)[]) {
  const end = Date.parse(`${on}T00:00:00Z`)
  return values.map((value, i) => ({
    localDate: new Date(end - (values.length - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    value,
    standing: value === null ? null : 'within',
  }))
}

function figure(on: string, values: (number | null)[]) {
  return { metric: 'steps', value: values.at(-1), baseline: { center: 5000, low: 4000, high: 6000, thin: false }, strip: strip(on, values), standing: 'within' }
}

/** The fields trimGlance reads, in the wire's shape; the rest of a glance is carried through untouched. */
function glance(on: string, opts: { previous?: string | null, next?: string | null, steps?: (number | null)[], asleep?: (number | null)[] | null } = {}): Glance {
  const steps = opts.steps ?? [1000, 2000, 3000, 4000, 5000, 6000, 7000]
  const asleep = opts.asleep === undefined ? [400, 410, 420, 430, 440, 450, 460] : opts.asleep
  return {
    today: on,
    finished: true,
    sleep: asleep === null ? null : { localDate: on, asleep: figure(on, asleep) },
    recovery: { index: figure(on, [60, 61, 62, 63, 64, 65, 66]) },
    day: { steps: figure(on, steps), activeMinutes: figure(on, [null, null, null, null, null, null, 30]), workouts: [] },
    week: { steps: { perDay: 1, days: 1, total: 1 }, activeMinutes: { perDay: 1, days: 1, total: 1 }, asleep: { perDay: 1, days: 1, total: 1 } },
    nav: { previous: opts.previous ?? null, next: opts.next ?? null },
  } as unknown as Glance
}

describe('trimGlance', () => {
  it('empties every strip day before the first day and recounts the week over what is left', () => {
    const captured = glance('2026-08-21', { previous: '2026-08-19', next: '2026-08-22' })
    const trimmed = trimGlance(captured, '2026-08-20')

    expect(trimmed.day.steps.strip.map((d) => d.value)).toEqual([null, null, null, null, null, 6000, 7000])
    expect(trimmed.day.steps.strip.map((d) => d.standing)).toEqual([null, null, null, null, null, 'within', 'within'])
    expect(trimmed.recovery.index.strip.map((d) => d.value)).toEqual([null, null, null, null, null, 65, 66])
    expect(trimmed.sleep!.asleep.strip.map((d) => d.value)).toEqual([null, null, null, null, null, 450, 460])
    // A finished day counts its own day (weekOfFinished), as readGlance does.
    expect(trimmed.week.steps).toEqual({ perDay: 6500, days: 2, total: 13000 })
    expect(trimmed.week.asleep).toEqual({ perDay: 455, days: 2, total: 910 })
    // Nothing before the first day on this strip, so its week figure is the capture's.
    expect(trimmed.week.activeMinutes).toEqual({ perDay: 1, days: 1, total: 1 })
    // The day's own figures stay as captured.
    expect(trimmed.day.steps.value).toBe(7000)
    expect(trimmed.day.steps.baseline).toEqual(captured.day.steps.baseline)

    expect(trimmed.nav).toEqual({ previous: null, next: '2026-08-22' })
    // A copy: the capture's own object is shared by every read of it.
    expect(captured.day.steps.strip[0]!.value).toBe(1000)
    expect(captured.nav.previous).toBe('2026-08-19')
  })

  it('leaves a glance with nothing before the first day as captured', () => {
    const captured = glance('2026-09-10', { previous: '2026-09-09', next: '2026-09-11' })
    expect(trimGlance(captured, '2026-08-20')).toEqual(captured)
  })

  it('leaves the asleep week figure alone on a day with no night', () => {
    const trimmed = trimGlance(glance('2026-08-21', { asleep: null }), '2026-08-20')
    expect(trimmed.week.asleep).toEqual({ perDay: 1, days: 1, total: 1 })
  })

  it('does not count an already silent day as trimmed', () => {
    const trimmed = trimGlance(glance('2026-08-21', { steps: [null, null, null, null, null, 6000, 7000] }), '2026-08-20')
    expect(trimmed.week.steps).toEqual({ perDay: 1, days: 1, total: 1 })
  })
})

describe('sliceToFirstDay', () => {
  it('names the first day in every calendar, lists nothing before it, and drops a month wholly before it', () => {
    const series = { steps: { points: [] } }
    const recorded = new Map<string, unknown>([
      [`${P}/glance/calendar?month=2026-07`, { month: '2026-07', firstDay: '2025-08-03', days: [{ localDate: '2026-07-30' }] }],
      [`${P}/glance/calendar?month=2026-08`, {
        month: '2026-08', firstDay: '2025-08-03', days: [{ localDate: '2026-08-19' }, { localDate: '2026-08-20' }, { localDate: '2026-08-21' }],
      }],
      [`${P}/glance?day=2026-08-20`, glance('2026-08-20', { previous: '2026-08-19', next: '2026-08-21' })],
      [`${P}/series?agg=sum&metric=steps`, series],
    ])

    sliceToFirstDay(recorded, '2026-08-20')

    expect(recorded.has(`${P}/glance/calendar?month=2026-07`)).toBe(false)
    expect(recorded.get(`${P}/glance/calendar?month=2026-08`)).toEqual({
      month: '2026-08', firstDay: '2026-08-20', days: [{ localDate: '2026-08-20' }, { localDate: '2026-08-21' }],
    })
    expect((recorded.get(`${P}/glance?day=2026-08-20`) as Glance).nav.previous).toBeNull()
    expect(recorded.get(`${P}/series?agg=sum&metric=steps`)).toBe(series)
  })
})

describe('unreachableDays', () => {
  it('is empty when every arrow, dot and calendar day has a captured glance', () => {
    const recorded = new Map<string, unknown>([
      [`${P}/glance`, glance('2026-08-22', { previous: '2026-08-21', steps: [null, null, null, null, null, 6000, 7000], asleep: null })],
      [`${P}/glance?day=2026-08-21`, glance('2026-08-21', { next: '2026-08-22', steps: [null, null, null, null, null, null, 7000], asleep: null })],
      [`${P}/glance/calendar?month=2026-08`, { month: '2026-08', firstDay: '2026-08-21', days: [{ localDate: '2026-08-21' }, { localDate: '2026-08-22' }] }],
    ])
    // The recovery strip in the fixture has a value on every day; empty it so only steps open days.
    for (const body of recorded.values()) {
      const g = body as Glance
      if (g.recovery !== undefined) g.recovery.index.strip.forEach((d) => { if (d.localDate < '2026-08-21') d.value = null })
      if (g.day !== undefined) g.day.activeMinutes.strip.forEach((d) => { d.value = null })
    }
    expect(unreachableDays(recorded, '2026-08-22')).toEqual([])
  })

  it('names a dot, an arrow and a calendar day with nothing captured behind them', () => {
    const recorded = new Map<string, unknown>([
      [`${P}/glance?day=2026-08-21`, glance('2026-08-21', { previous: '2026-08-12', asleep: null })],
      [`${P}/glance/calendar?month=2026-08`, { month: '2026-08', firstDay: '2026-08-01', days: [{ localDate: '2026-08-02' }] }],
    ])
    const days = unreachableDays(recorded, '2026-08-22').map((line) => line.slice(0, 10))
    // The strips' six earlier days, the back arrow's day and the calendar's day; never the day shown.
    expect(days).toEqual(['2026-08-02', '2026-08-12', '2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20'])
  })
})
