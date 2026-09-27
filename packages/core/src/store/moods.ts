import { and, asc, between, eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { moods } from '../db/schema/index.ts'
import { ConfigError } from '../errors.ts'

export interface StoredMood { localDate: string, score: number, updatedAtMs: number }

export class MoodStore {
  readonly #db: DbOrTx
  constructor(db: DbOrTx) { this.#db = db }

  put(input: { personId: string, localDate: string, score: number, nowMs: number }): void {
    if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
      throw new ConfigError('score must be an integer from 1 to 5')
    }
    this.#db.insert(moods)
      .values({ personId: input.personId, localDate: input.localDate, score: input.score, updatedAtMs: input.nowMs })
      .onConflictDoUpdate({ target: [moods.personId, moods.localDate], set: { score: input.score, updatedAtMs: input.nowMs } })
      .run()
  }

  remove(input: { personId: string, localDate: string }): void {
    this.#db.delete(moods).where(and(eq(moods.personId, input.personId), eq(moods.localDate, input.localDate))).run()
  }

  get(personId: string, localDate: string): number | null {
    const row = this.#db.select({ score: moods.score }).from(moods)
      .where(and(eq(moods.personId, personId), eq(moods.localDate, localDate))).get()
    return row?.score ?? null
  }

  listFor(personId: string, from: string, to: string): StoredMood[] {
    return this.#db.select({ localDate: moods.localDate, score: moods.score, updatedAtMs: moods.updatedAtMs })
      .from(moods).where(and(eq(moods.personId, personId), between(moods.localDate, from, to)))
      .orderBy(asc(moods.localDate)).all()
  }
}
