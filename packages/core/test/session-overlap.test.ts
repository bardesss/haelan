import { describe, expect, it } from 'vitest'
import { groupSessions, DEFAULT_OVERLAP_RATIO } from '../src/derive/sessionOverlap.ts'
import { priorityFrom } from '../src/derive/priority.ts'
import type { SourceFacts } from '../src/derive/priority.ts'
import type { SessionLike } from '../src/derive/overrides.ts'

const SOURCES: SourceFacts[] = [
  { id: 'watch', kind: 'device' },
  { id: 'phone', kind: 'app' },
]
const HOUR = 3_600_000

const session = (o: Partial<SessionLike> & { id: string, startMs: number, endMs: number }): SessionLike => ({
  sourceId: 'watch', kind: 'sleep', ...o,
})

const group = (sessions: SessionLike[], lists: Map<string, readonly string[]> = new Map(), ratio = DEFAULT_OVERLAP_RATIO) =>
  groupSessions({ sessions, priority: priorityFrom({ lists, sources: SOURCES }), overlapRatio: ratio })

describe('groupSessions', () => {
  it('treats two heavily overlapping sessions as one event', () => {
    const groups = group([
      session({ id: 'a', sourceId: 'watch', startMs: 0, endMs: 8 * HOUR }),
      session({ id: 'b', sourceId: 'phone', startMs: HOUR, endMs: 8 * HOUR }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.primary.id).toBe('a')
    expect(groups[0]?.alternates.map((s) => s.id)).toEqual(['b'])
  })

  it('keeps a nap and a night apart when they barely touch', () => {
    const groups = group([
      session({ id: 'night', startMs: 0, endMs: 8 * HOUR }),
      session({ id: 'nap', sourceId: 'phone', startMs: 7 * HOUR + 30 * 60_000, endMs: 9 * HOUR }),
    ])
    // 30 minutes of a 90 minute nap is a third of the shorter session, under the half it takes.
    expect(groups).toHaveLength(2)
  })

  it('never deletes the alternate, which is what makes the merge inspectable', () => {
    const groups = group([
      session({ id: 'a', sourceId: 'watch', startMs: 0, endMs: 8 * HOUR }),
      session({ id: 'b', sourceId: 'phone', startMs: 0, endMs: 8 * HOUR }),
    ])
    expect(groups[0]?.alternates.map((s) => s.id)).toEqual(['b'])
  })

  it('lets the priority list pick the primary', () => {
    const groups = group(
      [
        session({ id: 'a', sourceId: 'watch', startMs: 0, endMs: 8 * HOUR }),
        session({ id: 'b', sourceId: 'phone', startMs: 0, endMs: 8 * HOUR }),
      ],
      new Map([['sleep', ['phone', 'watch']]]),
    )
    expect(groups[0]?.primary.id).toBe('b')
  })

  it('never groups two kinds together', () => {
    const groups = group([
      session({ id: 'a', kind: 'sleep', startMs: 0, endMs: 8 * HOUR }),
      session({ id: 'b', kind: 'exercise', sourceId: 'phone', startMs: 0, endMs: 8 * HOUR }),
    ])
    expect(groups).toHaveLength(2)
  })

  it('chains through a middle session, because one stretch of sleep is one event', () => {
    const groups = group([
      session({ id: 'a', startMs: 0, endMs: 4 * HOUR }),
      session({ id: 'b', sourceId: 'phone', startMs: 1 * HOUR, endMs: 7 * HOUR }),
      session({ id: 'c', sourceId: 'phone', startMs: 4 * HOUR, endMs: 8 * HOUR }),
    ])
    // a and c do not overlap at all, but b overlaps each by three quarters of their length.
    expect(groups).toHaveLength(1)
    expect(groups[0]?.alternates).toHaveLength(2)
  })

  it('honours a configured ratio', () => {
    const sessions = [
      session({ id: 'a', startMs: 0, endMs: 8 * HOUR }),
      session({ id: 'b', sourceId: 'phone', startMs: 6 * HOUR, endMs: 10 * HOUR }),
    ]
    // Two hours of a four hour session is exactly half, and the threshold is exceeded, not met.
    expect(group(sessions, new Map(), 0.5)).toHaveLength(2)
    expect(group(sessions, new Map(), 0.4)).toHaveLength(1)
  })

  it('never groups a zero length session, which has no duration to be half of', () => {
    const groups = group([
      session({ id: 'a', startMs: 0, endMs: 8 * HOUR }),
      session({ id: 'b', sourceId: 'phone', startMs: HOUR, endMs: HOUR }),
    ])
    expect(groups).toHaveLength(2)
  })

  it('orders groups by start, and does not depend on input order', () => {
    const sessions = [
      session({ id: 'later', startMs: 10 * HOUR, endMs: 11 * HOUR }),
      session({ id: 'earlier', startMs: 0, endMs: HOUR }),
    ]
    expect(group(sessions).map((g) => g.primary.id)).toEqual(['earlier', 'later'])
    expect(group([...sessions].reverse())).toEqual(group(sessions))
  })
})
