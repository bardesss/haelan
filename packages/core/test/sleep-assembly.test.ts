import { describe, expect, it } from 'vitest'
import { assembleNights, DEFAULT_NIGHT_GAP_MINUTES } from '../src/derive/sleep.ts'
import type { SleepSessionLike } from '../src/derive/sleep.ts'

const MIN = 60_000
const H = 60 * MIN
// 2026-08-22T00:00Z, used as a fixed origin. The offsets below are what make it local.
const T0 = Date.UTC(2026, 7, 22, 0, 0)

const session = (o: Partial<SleepSessionLike> & { id: string, startMs: number, endMs: number }): SleepSessionLike => ({
  sourceId: 'watch', startOffsetMinutes: 120, endOffsetMinutes: 120, mainSleep: null, ...o,
})

const assemble = (sessions: SleepSessionLike[], gapMinutes = DEFAULT_NIGHT_GAP_MINUTES) =>
  assembleNights({ sessions, gapMinutes })

describe('assembleNights', () => {
  it('keeps one unbroken session as the night', () => {
    const only = session({ id: 'a', startMs: T0, endMs: T0 + 8 * H })
    const out = assemble([only])
    expect(out.night.map((s) => s.id)).toEqual(['a'])
    expect(out.naps).toEqual([])
  })

  it('joins a night that arrived in two pieces', () => {
    // The case this concept exists for: woken early, asleep again an hour later. Reporting the
    // first piece alone would lose the second every time it happens.
    const out = assemble([
      session({ id: 'first', startMs: T0, endMs: T0 + 5 * H }),
      session({ id: 'second', startMs: T0 + 6 * H, endMs: T0 + 8 * H }),
    ])
    expect(out.night.map((s) => s.id)).toEqual(['first', 'second'])
    expect(out.naps).toEqual([])
  })

  it('keeps a session beyond the gap out of the night', () => {
    const out = assemble([
      session({ id: 'night', startMs: T0, endMs: T0 + 7 * H }),
      session({ id: 'afternoon', startMs: T0 + 14 * H, endMs: T0 + 15 * H }),
    ])
    expect(out.night.map((s) => s.id)).toEqual(['night'])
    expect(out.naps.map((s) => s.id)).toEqual(['afternoon'])
  })

  it('joins at exactly the threshold, because a gap of up to two hours is still one night', () => {
    const exactly = assemble([
      session({ id: 'a', startMs: T0, endMs: T0 + 5 * H }),
      session({ id: 'b', startMs: T0 + 5 * H + 120 * MIN, endMs: T0 + 8 * H }),
    ], 120)
    expect(exactly.night.map((s) => s.id)).toEqual(['a', 'b'])

    const overBy = assemble([
      session({ id: 'a', startMs: T0, endMs: T0 + 5 * H }),
      session({ id: 'b', startMs: T0 + 5 * H + 121 * MIN, endMs: T0 + 8 * H }),
    ], 120)
    expect(overBy.night.map((s) => s.id)).toEqual(['a'])
  })

  it('chains three pieces through the middle one', () => {
    const out = assemble([
      session({ id: 'a', startMs: T0, endMs: T0 + 3 * H }),
      session({ id: 'b', startMs: T0 + 4 * H, endMs: T0 + 5 * H }),
      session({ id: 'c', startMs: T0 + 6 * H, endMs: T0 + 8 * H }),
    ])
    // a and c are five hours apart, well past the gap, but each is within it of b.
    expect(out.night.map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('lets the provider flag pick which group is the night', () => {
    // The long block is an afternoon sleep; the flagged one is the night. Without the flag the
    // longest group would win and get it backwards.
    const out = assemble([
      session({ id: 'flagged', startMs: T0, endMs: T0 + 4 * H, mainSleep: true }),
      session({ id: 'longer', startMs: T0 + 12 * H, endMs: T0 + 18 * H }),
    ])
    expect(out.night.map((s) => s.id)).toEqual(['flagged'])
    expect(out.naps.map((s) => s.id)).toEqual(['longer'])
  })

  it('lets the gap outrank the flag inside one group', () => {
    // The early wake case again, with the watch flagging only the first piece. The second piece
    // says mainSleep false and is still part of the night, because the gap says so.
    const out = assemble([
      session({ id: 'first', startMs: T0, endMs: T0 + 5 * H, mainSleep: true }),
      session({ id: 'second', startMs: T0 + 6 * H, endMs: T0 + 8 * H, mainSleep: false }),
    ])
    expect(out.night.map((s) => s.id)).toEqual(['first', 'second'])
    expect(out.naps).toEqual([])
  })

  it('falls back to the longest group when nothing carries the flag', () => {
    const out = assemble([
      session({ id: 'short', startMs: T0, endMs: T0 + 1 * H }),
      session({ id: 'long', startMs: T0 + 12 * H, endMs: T0 + 19 * H }),
    ])
    expect(out.night.map((s) => s.id)).toEqual(['long'])
    expect(out.naps.map((s) => s.id)).toEqual(['short'])
  })

  it('falls back to the longest group when two groups both claim the flag', () => {
    // Two devices, or a provider that flagged twice. Picking either arbitrarily would make the
    // night depend on row order, which is the one thing derivation must never do.
    const out = assemble([
      session({ id: 'shortFlagged', startMs: T0, endMs: T0 + 2 * H, mainSleep: true }),
      session({ id: 'longFlagged', startMs: T0 + 12 * H, endMs: T0 + 20 * H, mainSleep: true }),
    ])
    expect(out.night.map((s) => s.id)).toEqual(['longFlagged'])
  })

  it('returns an empty night rather than inventing one', () => {
    const out = assemble([])
    expect(out.night).toEqual([])
    expect(out.naps).toEqual([])
  })

  it('does not depend on the order the sessions arrived in', () => {
    const sessions = [
      session({ id: 'a', startMs: T0, endMs: T0 + 5 * H }),
      session({ id: 'b', startMs: T0 + 6 * H, endMs: T0 + 8 * H }),
      session({ id: 'nap', startMs: T0 + 14 * H, endMs: T0 + 15 * H }),
    ]
    expect(assemble([...sessions].reverse())).toEqual(assemble(sessions))
  })

  it('orders the night pieces and the naps by start', () => {
    const out = assemble([
      session({ id: 'lateNap', startMs: T0 + 16 * H, endMs: T0 + 17 * H }),
      session({ id: 'earlyNap', startMs: T0 + 12 * H, endMs: T0 + 13 * H }),
      session({ id: 'night', startMs: T0, endMs: T0 + 8 * H }),
    ])
    expect(out.night.map((s) => s.id)).toEqual(['night'])
    expect(out.naps.map((s) => s.id)).toEqual(['earlyNap', 'lateNap'])
  })
})
