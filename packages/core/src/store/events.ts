import { randomUUID } from 'node:crypto'
import { and, asc, eq, gte, lte } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { events } from '../db/schema/index.ts'
import { localDateOf, widenedUtcWindow } from '../derive/localDay.ts'

export interface AddEventInput {
  personId: string
  kind: string
  startedAtMs: number
  startedAtOffsetMinutes: number
  endedAtMs?: number
  endedAtOffsetMinutes?: number
  value?: number
  note?: string
}

export interface StoredEvent {
  id: string
  kind: string
  startedAtMs: number
  startedAtOffsetMinutes: number
  endedAtMs: number | null
  endedAtOffsetMinutes: number | null
  value: number | null
  note: string | null
  /**
   * localDateOf(startedAtMs, startedAtOffsetMinutes), computed once here (listFor already needs
   * the answer to decide whether a row belongs in the requested range) and handed back on the row
   * rather than thrown away, so a caller placing this event on a chart never has to recompute the
   * same DST sensitive arithmetic itself.
   */
  localDate: string
}

/**
 * A person's own record of something that happened to them: an illness, a trip, a dose. Like
 * NoteStore beside it, this takes no DeriveQueue and marks nothing dirty, because an event
 * changes no derived number; it is context a person reads alongside their data, not an input to
 * any of it.
 */
export class EventStore {
  readonly #db: DbOrTx

  constructor(db: DbOrTx) {
    this.#db = db
  }

  // kind is a free string, not an enum: the schema comment names illness, travel, alcohol,
  // medication, injury and caffeine as the seed set, but the column deliberately accepts
  // anything non empty. Validating it here would enforce a rule the schema chose not to make.
  add(input: AddEventInput): string {
    const id = randomUUID()
    this.#db.insert(events).values({
      id,
      personId: input.personId,
      kind: input.kind,
      startedAtMs: input.startedAtMs,
      startedAtOffsetMinutes: input.startedAtOffsetMinutes,
      endedAtMs: input.endedAtMs ?? null,
      endedAtOffsetMinutes: input.endedAtOffsetMinutes ?? null,
      value: input.value ?? null,
      note: input.note ?? null,
    }).run()
    return id
  }

  remove(input: { personId: string, id: string }): void {
    // Scoped by personId as well as id, for the same reason OverrideStore.remove is: an id is
    // not a secret, and an event is removed by its id alone, with no date or other key alongside
    // it to also get wrong. Without personId here, holding another person's event id would be
    // enough to delete their event.
    this.#db.delete(events).where(and(
      eq(events.id, input.id),
      eq(events.personId, input.personId),
    )).run()
  }

  /**
   * `from` and `to` are local dates, not instants: an event carries the offset in force at its
   * own start rather than the account carrying one timezone this could resolve `from`/`to`
   * against. A UTC calendar day is the wrong boundary for either end: 00:30 local at UTC+2 on
   * `from` is 22:30Z the day before, outside a `from`T00:00:00Z window even though its own local
   * day is in range, and the same offset can put a `to + 1` local day inside a `to`-shaped UTC
   * window. widenedUtcWindow and localDateOf exist for exactly this, the same pair deriveDayInto
   * and readIntraday use: widen the SQL fetch past every offset the provider can report, UTC-12
   * to UTC+14, then narrow row by row using the instant and offset that row actually carries,
   * which is what makes the wide first pass safe rather than merely broader.
   *
   * Each row's own offset decides its local date, never the caller's current timezone: a reading
   * keeps the offset it was recorded under even if the person has since moved.
   */
  listFor(personId: string, from: string, to: string): StoredEvent[] {
    const windowStart = widenedUtcWindow(from).start
    const windowEnd = widenedUtcWindow(to).end
    return this.#db.select().from(events).where(and(
      eq(events.personId, personId),
      gte(events.startedAtMs, windowStart),
      lte(events.startedAtMs, windowEnd),
    )).orderBy(asc(events.startedAtMs)).all()
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        startedAtMs: row.startedAtMs,
        startedAtOffsetMinutes: row.startedAtOffsetMinutes,
        endedAtMs: row.endedAtMs ?? null,
        endedAtOffsetMinutes: row.endedAtOffsetMinutes ?? null,
        value: row.value ?? null,
        note: row.note ?? null,
        localDate: localDateOf(row.startedAtMs, row.startedAtOffsetMinutes),
      }))
      .filter((row) => row.localDate >= from && row.localDate <= to)
  }
}
