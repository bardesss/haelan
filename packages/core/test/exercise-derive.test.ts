import { describe, expect, it } from 'vitest'
import { deriveExerciseDay } from '../src/derive/exercise.ts'
import type { ExerciseSessionLike } from '../src/derive/exercise.ts'
import { priorityFrom } from '../src/derive/priority.ts'
import type { SourceFacts } from '../src/derive/priority.ts'
import { DEFAULT_OVERLAP_RATIO } from '../src/derive/sessionOverlap.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'

const H = 3_600_000
const LOCAL_DATE = '2026-08-22'
const MIDNIGHT = Date.UTC(2026, 7, 22, 0, 0)

const SOURCES: SourceFacts[] = [
  { id: 'watch', kind: 'device' },
  { id: 'phone', kind: 'app' },
]
const PRIORITY = priorityFrom({ lists: new Map(), sources: SOURCES })

const session = (o: { id: string, startHour: number, endHour: number, sourceId?: string }): ExerciseSessionLike => ({
  id: o.id,
  sourceId: o.sourceId ?? 'watch',
  startMs: MIDNIGHT + o.startHour * H,
  endMs: MIDNIGHT + o.endHour * H,
})

const derive = (sessions: ExerciseSessionLike[]) => deriveExerciseDay({
  personId: 'p1',
  localDate: LOCAL_DATE,
  source: 'watch',
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
})
