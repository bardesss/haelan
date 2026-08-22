import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { mergeDay } from '../src/derive/merge.ts'
import { rollUpDay } from '../src/derive/rollup.ts'
import { priorityFrom } from '../src/derive/priority.ts'
import type { SourceFacts } from '../src/derive/priority.ts'
import { applyToSamples } from '../src/derive/overrides.ts'
import type { OverrideLike } from '../src/derive/overrides.ts'
import { sampleTarget } from '../src/derive/targetKey.ts'
import type { SampleLike } from '../src/derive/rollup.ts'

const OFFSET = 120
const MIDNIGHT_UTC = Date.UTC(2026, 7, 21, 22, 0)
const LOCAL_DATE = '2026-08-22'

const SOURCES: SourceFacts[] = [
  { id: 's-watch', kind: 'device' },
  { id: 's-phone', kind: 'app' },
  { id: 's-typed', kind: 'manual' },
]
const IDS = SOURCES.map((s) => s.id)

interface Spec { sourceId: string, hour: number, minute: number, value: number }

const specArb = fc.record({
  sourceId: fc.constantFrom(...IDS),
  hour: fc.integer({ min: 0, max: 23 }),
  minute: fc.integer({ min: 0, max: 59 }),
  value: fc.integer({ min: 0, max: 5000 }),
})

const dayArb = fc.array(specArb, { minLength: 1, maxLength: 40 })
const listArb = fc.shuffledSubarray(IDS, { minLength: 0, maxLength: 3 })

const toRows = (specs: readonly Spec[]): SampleLike[] => specs.map((s) => ({
  sourceId: s.sourceId,
  metric: 'steps',
  utcMs: MIDNIGHT_UTC + s.hour * 3_600_000 + s.minute * 60_000,
  tzOffsetMinutes: OFFSET,
  agg: 'raw' as const,
  value: s.value,
  n: 1,
}))

const mergeWith = (specs: readonly Spec[], list: readonly string[]) => mergeDay({
  personId: 'p1',
  localDate: LOCAL_DATE,
  rows: toRows(specs),
  priority: priorityFrom({ lists: new Map([['steps', list]]), sources: SOURCES }),
})

const sumRow = (rows: ReturnType<typeof mergeWith>) => rows.find((r) => r.agg === 'sum')

const decodeMix = (json: string | null): Array<{ source: string, hours: number }> =>
  json === null ? [] : JSON.parse(json)

const distinctHours = (specs: readonly Spec[]) => new Set(specs.map((s) => s.hour)).size

describe('merge properties', () => {
  it('gives every observed hour to exactly one source', () => {
    // Stated as arithmetic: the mix's hours add up to the number of hours that had any data at
    // all. Two sources sharing an hour would make the total larger, which is the double count.
    fc.assert(fc.property(dayArb, listArb, (specs, list) => {
      const mix = decodeMix(sumRow(mergeWith(specs, list))?.sourceMix ?? null)
      const total = mix.reduce((sum, entry) => sum + entry.hours, 0)
      expect(total).toBe(distinctHours(specs))
    }))
  })

  it('sums to what an independent per hour winner sum produces', () => {
    fc.assert(fc.property(dayArb, listArb, (specs, list) => {
      const priority = priorityFrom({ lists: new Map([['steps', list]]), sources: SOURCES })

      const byHour = new Map<number, Spec[]>()
      for (const spec of specs) {
        const bucket = byHour.get(spec.hour)
        if (bucket) bucket.push(spec)
        else byHour.set(spec.hour, [spec])
      }

      let expected = 0
      for (const bucket of byHour.values()) {
        const winner = [...new Set(bucket.map((s) => s.sourceId))]
          .sort((a, b) => priority.rank('steps', a) - priority.rank('steps', b) || (a < b ? -1 : 1))[0]!
        expected += bucket.filter((s) => s.sourceId === winner).reduce((sum, s) => sum + s.value, 0)
      }

      expect(sumRow(mergeWith(specs, list))?.value).toBe(expected)
    }))
  })

  it('reproduces the source own row exactly when only one source has data', () => {
    fc.assert(fc.property(dayArb, fc.constantFrom(...IDS), listArb, (specs, only, list) => {
      const single = specs.map((s) => ({ ...s, sourceId: only }))
      const merged = sumRow(mergeWith(single, list))
      const perSource = rollUpDay({ personId: 'p1', localDate: LOCAL_DATE, rows: toRows(single) })
        .find((r) => r.agg === 'sum')

      expect(merged?.value).toBe(perSource?.value)
      expect(merged?.coverage).toBe(perSource?.coverage)
    }))
  })

  it('measures coverage over every observed hour, never below any one source', () => {
    fc.assert(fc.property(dayArb, listArb, (specs, list) => {
      const merged = sumRow(mergeWith(specs, list))
      expect(merged?.coverage).toBeCloseTo(distinctHours(specs) / 24, 10)

      const perSource = rollUpDay({ personId: 'p1', localDate: LOCAL_DATE, rows: toRows(specs) })
      for (const row of perSource) {
        expect(merged?.coverage ?? 0).toBeGreaterThanOrEqual(row.coverage ?? 0)
      }
    }))
  })

  it('does not depend on the order the rows arrived in', () => {
    fc.assert(fc.property(dayArb, listArb, (specs, list) => {
      expect(mergeWith([...specs].reverse(), list)).toEqual(mergeWith(specs, list))
    }))
  })

  it('applies overrides idempotently', () => {
    fc.assert(fc.property(dayArb, fc.array(fc.boolean(), { maxLength: 40 }), (specs, flags) => {
      const rows = toRows(specs)
      const overrides: OverrideLike[] = rows
        .filter((_, at) => flags[at] === true)
        .map((row) => ({
          scope: 'sample' as const,
          targetKey: sampleTarget({ source: row.sourceId, metric: row.metric, utcMs: row.utcMs }),
          action: 'exclude' as const,
          correctedValue: null,
        }))

      const once = applyToSamples(rows, overrides)
      expect(applyToSamples(once, overrides)).toEqual(once)
    }))
  })
})
