import { describe, expect, it } from 'vitest'
import { priorityFrom, fallbackOrder, DEFAULT_LIST, UNRANKED_BASE } from '../src/derive/priority.ts'
import type { SourceFacts } from '../src/derive/priority.ts'

const SOURCES: SourceFacts[] = [
  { id: 'zz-phone', kind: 'app' },
  { id: 'aa-watch', kind: 'device' },
  { id: 'mm-typed', kind: 'manual' },
]

describe('fallbackOrder', () => {
  it('puts a device before an app before a hand typed reading', () => {
    expect(fallbackOrder(SOURCES)).toEqual(['aa-watch', 'zz-phone', 'mm-typed'])
  })

  it('breaks a tie on the source id, which a rebuild reconstructs identically', () => {
    // Not created_at_ms: M2e re-stamps every source in one batch, so a created-at tie-break
    // becomes insertion order of the rebuild, and the merge silently changes its mind.
    const two: SourceFacts[] = [{ id: 'b', kind: 'device' }, { id: 'a', kind: 'device' }]
    expect(fallbackOrder(two)).toEqual(['a', 'b'])
  })
})

describe('priorityFrom', () => {
  it('ranks by the metric list when there is one', () => {
    const p = priorityFrom({ lists: new Map([['steps', ['zz-phone', 'aa-watch']]]), sources: SOURCES })
    expect(p.rank('steps', 'zz-phone')).toBe(0)
    expect(p.rank('steps', 'aa-watch')).toBe(1)
  })

  it('falls back to the person default list for a metric with no list of its own', () => {
    const p = priorityFrom({ lists: new Map([[DEFAULT_LIST, ['zz-phone', 'aa-watch']]]), sources: SOURCES })
    expect(p.rank('weight', 'zz-phone')).toBe(0)
    expect(p.rank('weight', 'aa-watch')).toBe(1)
  })

  it('treats a metric list as complete, so the default list does not leak into it', () => {
    // The default says the phone wins. The weight list names only the watch, so for weight the
    // phone is unranked rather than second: indices from two lists are not comparable, and
    // interleaving them would rank the phone by a number that means something else.
    const p = priorityFrom({
      lists: new Map([[DEFAULT_LIST, ['zz-phone', 'aa-watch']], ['weight', ['aa-watch']]]),
      sources: SOURCES,
    })
    expect(p.rank('weight', 'aa-watch')).toBe(0)
    expect(p.rank('weight', 'zz-phone')).toBeGreaterThanOrEqual(UNRANKED_BASE)
  })

  it('ranks an unconfigured source below every configured one, in the fallback order', () => {
    const p = priorityFrom({ lists: new Map([['steps', ['mm-typed']]]), sources: SOURCES })
    expect(p.rank('steps', 'mm-typed')).toBe(0)
    expect(p.rank('steps', 'aa-watch')).toBe(UNRANKED_BASE + 0)
    expect(p.rank('steps', 'zz-phone')).toBe(UNRANKED_BASE + 1)
  })

  it('ranks a source it has never heard of last rather than throwing', () => {
    // A source can appear in a day's rows before anything registered facts about it, and a
    // merge that threw there would lose the day instead of ranking it conservatively.
    const p = priorityFrom({ lists: new Map(), sources: SOURCES })
    expect(p.rank('steps', 'unknown')).toBe(UNRANKED_BASE + SOURCES.length)
  })

  it('ranks everything by the fallback when nothing is configured at all', () => {
    const p = priorityFrom({ lists: new Map(), sources: SOURCES })
    expect(p.rank('steps', 'aa-watch')).toBeLessThan(p.rank('steps', 'zz-phone'))
    expect(p.rank('steps', 'zz-phone')).toBeLessThan(p.rank('steps', 'mm-typed'))
  })
})
