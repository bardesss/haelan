import { randomUUID } from 'node:crypto'
import { and, asc, eq, gte, lte } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { events } from '../db/schema/index.ts'

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

  listFor(personId: string, fromMs: number, toMs: number): StoredEvent[] {
    return this.#db.select().from(events).where(and(
      eq(events.personId, personId),
      gte(events.startedAtMs, fromMs),
      lte(events.startedAtMs, toMs),
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
      }))
  }
}
