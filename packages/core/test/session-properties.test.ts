import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { groupSessions } from '../src/derive/sessionOverlap.ts'
import type { SessionLike } from '../src/derive/overrides.ts'
import { priorityFrom } from '../src/derive/priority.ts'
import type { SourceFacts } from '../src/derive/priority.ts'

/**
 * Spec section 14 names "no session is double-counted" among the property tests, and until M2f it
 * had only golden cases. The two units it sat between each had a reason to think the other owned
 * it: M2b wrote the property suite and M2c wrote the code that counts a night once.
 *
 * The invariant is a partition. Every session belongs to exactly one group, as primary or as an
 * alternate, whatever the overlaps look like. Everything downstream that counts a workout or a
 * night counts one member per group, so a session appearing twice here is a double count there,
 * and a session appearing nowhere is one silently dropped.
 */

const SOURCES: SourceFacts[] = [
  { id: 's-watch', kind: 'device' },
  { id: 's-phone', kind: 'app' },
  { id: 's-typed', kind: 'manual' },
]
const IDS = SOURCES.map((s) => s.id)
const KINDS = ['sleep', 'exercise'] as const

const MIDNIGHT = Date.UTC(2026, 7, 21, 22, 0)
const MINUTE = 60_000

// Start and length in minutes rather than raw instants, so the generated sessions land in the
// same few hours and actually overlap each other often enough to exercise the linkage. Arbitrary
// instants across a day would mostly produce singletons and the property would pass on nothing.
const sessionArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 4 }),
  sourceId: fc.constantFrom(...IDS),
  kind: fc.constantFrom(...KINDS),
  startMinute: fc.integer({ min: 0, max: 600 }),
  lengthMinutes: fc.integer({ min: 0, max: 480 }),
})

const dayArb = fc
  .array(sessionArb, { minLength: 1, maxLength: 25 })
  // Ids are the identity the grouping sorts and reports on, so duplicates would make "appears
  // exactly once" ambiguous rather than false.
  .map((raw) => raw.filter((s, at) => raw.findIndex((other) => other.id === s.id) === at))
  .map((raw): SessionLike[] => raw.map((s) => ({
    id: s.id,
    sourceId: s.sourceId,
    kind: s.kind,
    startMs: MIDNIGHT + s.startMinute * MINUTE,
    endMs: MIDNIGHT + (s.startMinute + s.lengthMinutes) * MINUTE,
  })))

const ratioArb = fc.constantFrom(0, 0.25, 0.5, 0.75, 1)

const group = (sessions: SessionLike[], overlapRatio: number) => groupSessions({
  sessions,
  priority: priorityFrom({ lists: new Map(), sources: SOURCES }),
  overlapRatio,
})

describe('session grouping properties', () => {
  it('places every session in exactly one group, so nothing is counted twice or lost', () => {
    fc.assert(fc.property(dayArb, ratioArb, (sessions, ratio) => {
      const placed = group(sessions, ratio).flatMap((g) => [g.primary, ...g.alternates])
      const counts = new Map<string, number>()
      for (const session of placed) counts.set(session.id, (counts.get(session.id) ?? 0) + 1)

      expect(placed).toHaveLength(sessions.length)
      expect([...counts.values()].every((n) => n === 1)).toBe(true)
      expect([...counts.keys()].sort()).toEqual(sessions.map((s) => s.id).sort())
    }))
  })

  it('never groups two kinds together, so a nap cannot absorb a workout', () => {
    fc.assert(fc.property(dayArb, ratioArb, (sessions, ratio) => {
      for (const g of group(sessions, ratio)) {
        const kinds = new Set([g.primary, ...g.alternates].map((s) => s.kind))
        expect(kinds.size).toBe(1)
      }
    }))
  })

  it('is independent of the order the rows arrived in', () => {
    fc.assert(fc.property(dayArb, ratioArb, (sessions, ratio) => {
      const shuffled = [...sessions].reverse()
      const shape = (input: SessionLike[]) => group(input, ratio)
        .map((g) => [g.primary.id, ...g.alternates.map((a) => a.id)])
      expect(shape(shuffled)).toEqual(shape(sessions))
    }))
  })
})
