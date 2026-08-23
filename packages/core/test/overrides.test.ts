import { describe, expect, it } from 'vitest'
import { applyToSamples, excludedMetrics, applyToDay, applyToSessions } from '../src/derive/overrides.ts'
import type { OverrideLike, SessionLike } from '../src/derive/overrides.ts'
import { sampleTarget, sessionTarget, dayMetricTarget } from '../src/derive/targetKey.ts'
import type { SampleLike, DailyRow } from '../src/derive/rollup.ts'

const LOCAL_DATE = '2026-08-22'

const sample = (o: Partial<SampleLike> & { metric: string, value: number | null }): SampleLike => ({
  sourceId: 'watch', utcMs: 1000, tzOffsetMinutes: 120, agg: 'raw', n: 1, ...o,
})

const dailyRow = (o: Partial<DailyRow> & { metric: string }): DailyRow => ({
  personId: 'p1', localDate: LOCAL_DATE, agg: 'sum', source: 'watch', value: 1,
  coverage: 0.5, sourceMix: null, derivationVersion: 1, ...o,
})

const exclude = (scope: OverrideLike['scope'], targetKey: string): OverrideLike =>
  ({ scope, targetKey, action: 'exclude', correctedValue: null })

describe('applyToSamples', () => {
  it('drops an excluded reading', () => {
    const rows = [sample({ metric: 'heart_rate', value: 210 }), sample({ metric: 'heart_rate', value: 60, utcMs: 2000 })]
    const out = applyToSamples(rows, [
      exclude('sample', sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: 1000 })),
    ])
    expect(out.map((r) => r.value)).toEqual([60])
  })

  it('drops every aggregate of the excluded minute, not only one of them', () => {
    // The key carries no agg on purpose: a strap glitch wrote min, mean and max for that minute,
    // and leaving two of them would leave the glitch on the chart.
    const rows = [
      sample({ metric: 'heart_rate', value: 210, agg: 'max', n: 30 }),
      sample({ metric: 'heart_rate', value: 190, agg: 'mean', n: 30 }),
      sample({ metric: 'heart_rate', value: 170, agg: 'min', n: 30 }),
    ]
    const out = applyToSamples(rows, [
      exclude('sample', sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: 1000 })),
    ])
    expect(out).toEqual([])
  })

  it('replaces a corrected reading and leaves n alone', () => {
    const rows = [sample({ metric: 'weight', value: 205, n: 4 })]
    const out = applyToSamples(rows, [{
      scope: 'sample',
      targetKey: sampleTarget({ source: 'watch', metric: 'weight', utcMs: 1000 }),
      action: 'correct',
      correctedValue: 80.5,
    }])
    expect(out).toEqual([{ ...rows[0], value: 80.5 }])
  })

  it('leaves the reading alone when a correction carries no value', () => {
    // OverrideStore refuses to write this, but the function is exported from the barrel, so the
    // store is not the only door in. Nulling the value would be an exclusion that forgot to
    // remove the row, which is worse than the correction saying nothing.
    const rows = [sample({ metric: 'weight', value: 205, n: 4 })]
    const out = applyToSamples(rows, [{
      scope: 'sample',
      targetKey: sampleTarget({ source: 'watch', metric: 'weight', utcMs: 1000 }),
      action: 'correct',
      correctedValue: null,
    }])
    expect(out).toEqual(rows)
  })

  it('leaves another source at the same instant untouched', () => {
    const rows = [
      sample({ metric: 'heart_rate', value: 210, sourceId: 'watch' }),
      sample({ metric: 'heart_rate', value: 62, sourceId: 'phone' }),
    ]
    const out = applyToSamples(rows, [
      exclude('sample', sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: 1000 })),
    ])
    expect(out.map((r) => r.sourceId)).toEqual(['phone'])
  })

  it('ignores overrides of another scope', () => {
    const rows = [sample({ metric: 'steps', value: 400 })]
    expect(applyToSamples(rows, [exclude('day_metric', dayMetricTarget({ localDate: LOCAL_DATE, metric: 'steps' }))]))
      .toEqual(rows)
  })

  it('is idempotent', () => {
    const rows = [sample({ metric: 'weight', value: 205 })]
    const overrides: OverrideLike[] = [{
      scope: 'sample',
      targetKey: sampleTarget({ source: 'watch', metric: 'weight', utcMs: 1000 }),
      action: 'correct',
      correctedValue: 80.5,
    }]
    expect(applyToSamples(applyToSamples(rows, overrides), overrides)).toEqual(applyToSamples(rows, overrides))
  })
})

describe('excludedMetrics and applyToDay', () => {
  it('names the metrics excluded on that day and no other day', () => {
    const overrides = [
      exclude('day_metric', dayMetricTarget({ localDate: LOCAL_DATE, metric: 'steps' })),
      exclude('day_metric', dayMetricTarget({ localDate: '2026-08-21', metric: 'hrv' })),
    ]
    expect([...excludedMetrics(overrides, LOCAL_DATE)]).toEqual(['steps'])
  })

  it('drops the metric from every source and every aggregate, merged included', () => {
    // A day somebody has thrown out is thrown out. Leaving the merged row would put the number
    // back on the chart the exclusion was made from.
    const rows = [
      dailyRow({ metric: 'steps', source: 'watch' }),
      dailyRow({ metric: 'steps', source: 'merged', agg: 'sum' }),
      dailyRow({ metric: 'hrv', source: 'watch' }),
    ]
    expect(applyToDay(rows, new Set(['steps'])).map((r) => r.metric)).toEqual(['hrv'])
  })

  it('returns the rows untouched when nothing is excluded', () => {
    const rows = [dailyRow({ metric: 'steps' })]
    expect(applyToDay(rows, new Set())).toEqual(rows)
  })
})

describe('applyToSessions', () => {
  const session = (id: string): SessionLike => ({ id, sourceId: 'watch', kind: 'sleep', startMs: 0, endMs: 1 })

  it('drops an excluded session', () => {
    const out = applyToSessions([session('a'), session('b')], [exclude('session', sessionTarget('a'))])
    expect(out.map((s) => s.id)).toEqual(['b'])
  })

  it('returns the sessions untouched when nothing is excluded', () => {
    const sessions = [session('a')]
    expect(applyToSessions(sessions, [])).toEqual(sessions)
  })

  it('ignores an override of another scope', () => {
    const sessions = [session('a')]
    expect(applyToSessions(sessions, [
      exclude('day_metric', dayMetricTarget({ localDate: LOCAL_DATE, metric: 'steps' })),
    ])).toEqual(sessions)
  })
})
