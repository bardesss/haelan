import { describe, expect, it } from 'vitest'
import { deriveExerciseDay } from '../src/derive/exercise.ts'
import type { ExerciseSessionLike } from '../src/derive/exercise.ts'
import { priorityFrom } from '../src/derive/priority.ts'
import type { SourceFacts } from '../src/derive/priority.ts'
import { DEFAULT_OVERLAP_RATIO } from '../src/derive/sessionOverlap.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { MERGED_SOURCE } from '../src/derive/rollup.ts'

const H = 3_600_000
const LOCAL_DATE = '2026-08-22'
const MIDNIGHT = Date.UTC(2026, 7, 22, 0, 0)

const SOURCES: SourceFacts[] = [
  { id: 'watch', kind: 'device' },
  { id: 'phone', kind: 'app' },
]
const PRIORITY = priorityFrom({ lists: new Map(), sources: SOURCES })

const session = (o: {
  id: string, startHour: number, endHour: number, sourceId?: string, startOffsetMinutes?: number,
}): ExerciseSessionLike => ({
  id: o.id,
  sourceId: o.sourceId ?? 'watch',
  startMs: MIDNIGHT + o.startHour * H,
  endMs: MIDNIGHT + o.endHour * H,
  startOffsetMinutes: o.startOffsetMinutes ?? 0,
})

const derive = (sessions: ExerciseSessionLike[]) => deriveExerciseDay({
  personId: 'p1',
  localDate: LOCAL_DATE,
  source: 'watch',
  sessions,
  priority: PRIORITY,
  overlapRatio: DEFAULT_OVERLAP_RATIO,
})

const deriveMerged = (sessions: ExerciseSessionLike[]) => deriveExerciseDay({
  personId: 'p1',
  localDate: LOCAL_DATE,
  source: MERGED_SOURCE,
  sessions,
  priority: PRIORITY,
  overlapRatio: DEFAULT_OVERLAP_RATIO,
})

describe('deriveExerciseDay', () => {
  // A stored zero needs a source to attribute the row to, and a day with no workouts has no
  // source. Unlike a sample, a session carries no coverage question underneath it either, so
  // absence is the whole answer: the dashboard reads "no workouts" from the missing row exactly
  // as it already does for a day with no sleep.
  it('writes nothing at all for a day with no exercise sessions', () => {
    expect(derive([])).toEqual([])
  })

  // The same shape as sleep's rounding defect (M3f Finding 1): summing per group roundings rather
  // than rounding once at the end. Two 90 second (1.5 minute) sessions each round up alone (2 + 2
  // = 4), overstating the true 3 minute total by a third. Measured across 192 real exercise
  // sessions this direction is not systematic (90 rounded up, 101 rounded down, net 1.8 minutes),
  // because workout timings are not grid aligned the way the sleep provider's 30 second reporting
  // grid was, so this is ordinary rounding error rather than the one directional inflation sleep
  // had. The design spec still calls for the same treatment "alongside for the pattern rather than
  // for a defect": sum in milliseconds, round once.
  it('rounds the total minutes once rather than rounding every session into it', () => {
    const rows = derive([
      session({ id: 'a', startHour: 7, endHour: 7 + 90 / 3600 }),
      session({ id: 'b', startHour: 18, endHour: 18 + 90 / 3600 }),
    ])
    expect(rows.find((r) => r.metric === 'workout_minutes')?.value).toBe(3)
  })

  it('sums the minutes of every workout in the day', () => {
    const rows = derive([
      session({ id: 'a', startHour: 7, endHour: 8 }),
      session({ id: 'b', startHour: 18, endHour: 18.5 }),
    ])
    expect(rows.find((r) => r.metric === 'workout_count')?.value).toBe(2)
    expect(rows.find((r) => r.metric === 'workout_minutes')?.value).toBe(90)
  })

  // The same run recorded by a watch and a phone is one workout. M2b's grouping already decides
  // this; counting ungrouped sessions would report two.
  it('counts one workout once when two sources both recorded it', () => {
    const rows = derive([
      session({ id: 'watch-run', sourceId: 'watch', startHour: 7, endHour: 8 }),
      session({ id: 'phone-run', sourceId: 'phone', startHour: 7, endHour: 8 }),
    ])
    expect(rows.find((r) => r.metric === 'workout_count')?.value).toBe(1)
  })

  // Grouped sessions count once, and the group's own primary supplies the duration. Priority
  // decides the primary, not length: a device outranks an app regardless of which one ran longer,
  // so a shorter watch session beating a longer phone one here is the point, not an accident.
  // Summing both or taking the longer one would each pass every other test in this file while
  // answering this one wrong.
  it('gives the group\'s duration to the primary chosen by priority, not the longer session', () => {
    const rows = derive([
      session({ id: 'watch-run', sourceId: 'watch', startHour: 7, endHour: 7.5 }),
      session({ id: 'phone-run', sourceId: 'phone', startHour: 7, endHour: 8.5 }),
    ])
    expect(rows.find((r) => r.metric === 'workout_count')?.value).toBe(1)
    expect(rows.find((r) => r.metric === 'workout_minutes')?.value).toBe(30)
  })

  it('files every row under the source it was told, with no coverage or mix', () => {
    const rows = derive([session({ id: 'a', startHour: 7, endHour: 8 })])
    expect(rows.every((r) => r.source === 'watch')).toBe(true)
    expect(rows.every((r) => r.coverage === null)).toBe(true)
    expect(rows.every((r) => r.sourceMix === null)).toBe(true)
    expect(rows.every((r) => r.derivationVersion === DERIVATION_VERSION)).toBe(true)
    expect(rows.every((r) => r.localDate === LOCAL_DATE)).toBe(true)
  })

  // The schema documents source_mix as written whenever source is merged, and sleepMerge.ts
  // honours that. deriveExerciseDay hardcoded null for both calls, so a merged workout_minutes
  // of 90 that was 60 from the watch plus 30 from the phone carried nothing recording that split.
  describe('the merged row\'s sourceMix', () => {
    it('names the one source a merged row drew on when nothing else recorded that day', () => {
      const rows = deriveMerged([session({ id: 'a', sourceId: 'watch', startHour: 7, endHour: 8 })])
      const mix = JSON.parse(rows.find((r) => r.metric === 'workout_count')!.sourceMix!)
      expect(mix).toEqual([{ source: 'watch', hours: 1 }])
    })

    it('names every source across more than one workout, following sleepMerge\'s own encoding', () => {
      const rows = deriveMerged([
        // Same event, watch and phone both recorded it: priority picks the device, so only
        // watch's hour counts here.
        session({ id: 'watch-run', sourceId: 'watch', startHour: 7, endHour: 8 }),
        session({ id: 'phone-run', sourceId: 'phone', startHour: 7, endHour: 8 }),
        // A separate event only the phone recorded.
        session({ id: 'phone-solo', sourceId: 'phone', startHour: 18, endHour: 18.5 }),
      ])
      const mix = JSON.parse(rows.find((r) => r.metric === 'workout_count')!.sourceMix!)
      // encodeMix orders by hours descending then source ascending; both sources won one hour
      // here, so the tie falls to 'phone' before 'watch', exactly as encodeMix's own doc comment
      // says it will.
      expect(mix).toEqual([{ source: 'phone', hours: 1 }, { source: 'watch', hours: 1 }])
    })

    it('stays null on a per source row, which has no mix of its own', () => {
      const rows = derive([session({ id: 'a', startHour: 7, endHour: 8 })])
      expect(rows.every((r) => r.sourceMix === null)).toBe(true)
    })
  })
})
