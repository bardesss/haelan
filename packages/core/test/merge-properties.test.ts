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

// A permutation of the same day, not a single fixed reversal, so order independence is sampled
// across the ordering space instead of checked at one point in it.
const dayWithPermutationArb = dayArb.chain((specs) => fc.tuple(
  fc.constant(specs),
  fc.shuffledSubarray(specs, { minLength: specs.length, maxLength: specs.length }),
))

// A separate nullable spec, rather than making value nullable on specArb itself, so properties 1
// to 4 never have to filter or precondition around a null they were not written to expect.
interface NullableSpec { sourceId: string, hour: number, minute: number, value: number | null }

const nullableSpecArb = fc.record({
  sourceId: fc.constantFrom(...IDS),
  hour: fc.integer({ min: 0, max: 23 }),
  minute: fc.integer({ min: 0, max: 59 }),
  value: fc.option(fc.integer({ min: 0, max: 5000 }), { nil: null }),
})

const nullableDayArb = fc.array(nullableSpecArb, { minLength: 1, maxLength: 40 })

const toRows = (specs: readonly Spec[]): SampleLike[] => specs.map((s) => ({
  sourceId: s.sourceId,
  metric: 'steps',
  utcMs: MIDNIGHT_UTC + s.hour * 3_600_000 + s.minute * 60_000,
  tzOffsetMinutes: OFFSET,
  agg: 'raw' as const,
  value: s.value,
  n: 1,
}))

const toRowsNullable = (specs: readonly NullableSpec[]): SampleLike[] => specs.map((s) => ({
  sourceId: s.sourceId,
  metric: 'steps',
  utcMs: MIDNIGHT_UTC + s.hour * 3_600_000 + s.minute * 60_000,
  tzOffsetMinutes: OFFSET,
  agg: 'raw' as const,
  value: s.value,
  n: 1,
}))

const mergeRows = (rows: SampleLike[], list: readonly string[]) => mergeDay({
  personId: 'p1',
  localDate: LOCAL_DATE,
  rows,
  priority: priorityFrom({ lists: new Map([['steps', list]]), sources: SOURCES }),
})

const mergeWith = (specs: readonly Spec[], list: readonly string[]) => mergeRows(toRows(specs), list)

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

  it('measures coverage over every observed hour', () => {
    fc.assert(fc.property(dayArb, listArb, (specs, list) => {
      const merged = sumRow(mergeWith(specs, list))
      // The per-source floor check was dropped: coverageOf makes each source's hours a subset of all observed hours, so that inequality follows from this assertion alone and pinned nothing of the merge itself.
      expect(merged?.coverage).toBeCloseTo(distinctHours(specs) / 24, 10)
    }))
  })

  it('does not depend on the order the rows arrived in', () => {
    fc.assert(fc.property(dayWithPermutationArb, listArb, ([specs, permuted], list) => {
      expect(mergeWith(permuted, list)).toEqual(mergeWith(specs, list))
    }))
  })

  it('applies overrides idempotently', () => {
    const choiceArb = fc.option(
      fc.oneof(
        fc.constant({ action: 'exclude' as const, correctedValue: null as number | null }),
        fc.integer({ min: 0, max: 5000 }).map((value) => ({ action: 'correct' as const, correctedValue: value })),
      ),
      { nil: null },
    )

    fc.assert(fc.property(dayArb, fc.array(choiceArb, { maxLength: 40 }), (specs, choices) => {
      const rows = toRows(specs)
      const overrides: OverrideLike[] = []
      rows.forEach((row, at) => {
        const choice = choices[at] ?? null
        if (choice === null) return
        overrides.push({
          scope: 'sample',
          targetKey: sampleTarget({ source: row.sourceId, metric: row.metric, utcMs: row.utcMs }),
          action: choice.action,
          correctedValue: choice.correctedValue,
        })
      })

      const once = applyToSamples(rows, overrides)
      expect(applyToSamples(once, overrides)).toEqual(once)
    }))
  })

  it('treats a null reading as absent, not as a zero', () => {
    fc.assert(fc.property(nullableDayArb, listArb, (specs, list) => {
      const withNulls = mergeRows(toRowsNullable(specs), list)
      const withoutNulls = mergeRows(toRowsNullable(specs.filter((s) => s.value !== null)), list)
      expect(withNulls).toEqual(withoutNulls)
    }))
  })
})
