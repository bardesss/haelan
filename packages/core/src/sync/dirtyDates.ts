import { and, between, eq, gt, lte } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import type { SampleKeys } from '../db/keys.ts'
import type { SampleRow } from '../api/mapSamples.ts'
import { samples, sessions } from '../db/schema/index.ts'
import { localDateOf } from '../derive/localDay.ts'

// A workout is filed on the date it ends, and workoutZones reads its whole span. A heart rate
// reading on the near side of midnight therefore changes a workout filed on the next day, and
// marking only the reading's own date would leave that workout's zones stale. A revised offset has
// the mirror problem: it moves a stored reading to another date, and the date it left needs a
// re-derive as well as the date it landed on.

/**
 * The date of every exercise session whose half-open span [startMs, endMs) holds some instant in
 * `utcMs`, which is the span workoutZones reads. One query bounded by the earliest and latest
 * instant, then each instant is checked in memory.
 */
export function exerciseDatesSpanning(
  tx: DbOrTx,
  input: { personId: string, utcMs: readonly number[] },
): string[] {
  if (input.utcMs.length === 0) return []
  let min = Infinity
  let max = -Infinity
  for (const t of input.utcMs) {
    if (t < min) min = t
    if (t > max) max = t
  }
  const candidates = tx.select({
    startMs: sessions.startMs, endMs: sessions.endMs, localDate: sessions.localDate,
  }).from(sessions).where(and(
    eq(sessions.personId, input.personId),
    eq(sessions.kind, 'exercise'),
    lte(sessions.startMs, max),
    gt(sessions.endMs, min),
  )).all()
  const dates = new Set<string>()
  for (const session of candidates) {
    if (input.utcMs.some((t) => t >= session.startMs && t < session.endMs)) dates.add(session.localDate)
  }
  return [...dates]
}

/**
 * Every local date a window of sample rows leaves needing a re-derive. Call it before the upsert,
 * while the stored offsets are still the old ones.
 */
export function sampleDirtyDates(tx: DbOrTx, rows: readonly SampleRow[], keys: SampleKeys): Set<string> {
  const dates = new Set<string>()
  for (const row of rows) dates.add(localDateOf(row.utcMs, row.tzOffsetMinutes))

  const groups = new Map<string, SampleRow[]>()
  for (const row of rows) {
    const key = `${row.personId}\u0000${row.sourceId}\u0000${row.metric}`
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }
  for (const group of groups.values()) {
    const first = group[0]!
    // IfKnown: an unknown ref means nothing is stored yet, so no stored offset can disagree.
    const personRef = keys.personRefIfKnown(first.personId)
    const sourceRef = keys.sourceRefIfKnown(first.sourceId)
    const metricRef = keys.metricRefIfKnown(first.metric)
    if (personRef === undefined || sourceRef === undefined || metricRef === undefined) continue
    let min = Infinity
    let max = -Infinity
    for (const row of group) {
      if (row.utcMs < min) min = row.utcMs
      if (row.utcMs > max) max = row.utcMs
    }
    const stored = tx.select({ utcMs: samples.utcMs, tzOffsetMinutes: samples.tzOffsetMinutes })
      .from(samples).where(and(
        eq(samples.personRef, personRef),
        eq(samples.sourceRef, sourceRef),
        eq(samples.metricRef, metricRef),
        between(samples.utcMs, min, max),
      )).all()
    const offsetsByInstant = new Map<number, number[]>()
    for (const s of stored) {
      const list = offsetsByInstant.get(s.utcMs)
      if (list) list.push(s.tzOffsetMinutes)
      else offsetsByInstant.set(s.utcMs, [s.tzOffsetMinutes])
    }
    for (const row of group) {
      for (const offset of offsetsByInstant.get(row.utcMs) ?? []) {
        if (offset !== row.tzOffsetMinutes) dates.add(localDateOf(row.utcMs, offset))
      }
    }
  }

  const heartRate = rows.filter((row) => row.metric === 'heart_rate')
  const byPerson = new Map<string, number[]>()
  for (const row of heartRate) {
    const list = byPerson.get(row.personId)
    if (list) list.push(row.utcMs)
    else byPerson.set(row.personId, [row.utcMs])
  }
  for (const [personId, utcMs] of byPerson) {
    for (const date of exerciseDatesSpanning(tx, { personId, utcMs })) dates.add(date)
  }
  return dates
}
