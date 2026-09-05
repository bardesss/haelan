import { and, asc, eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { excludedDataTypes } from '../db/schema/index.ts'

/**
 * The data types a person has turned off.
 *
 * Every read of this is a question about what NOT to fetch, which is why nothing here has a
 * "list the types this person wants" method: the answer to that lives in the catalogue, and
 * asking it here would invert the direction the table exists to preserve.
 */
export class ExcludedDataTypeStore {
  readonly #db: DbOrTx

  constructor(db: DbOrTx) { this.#db = db }

  listFor(personId: string): string[] {
    return this.#db.select({ id: excludedDataTypes.dataTypeId }).from(excludedDataTypes)
      .where(eq(excludedDataTypes.personId, personId))
      .orderBy(asc(excludedDataTypes.dataTypeId))
      .all().map((row) => row.id)
  }

  /**
   * Replaces the whole set. Delete then insert rather than a diff: the caller sends the state it
   * wants, and a diff would leave a row behind the first time somebody sent a shorter list.
   */
  setFor(input: { personId: string, dataTypeIds: readonly string[], nowMs: number }): void {
    this.#db.transaction((tx) => {
      tx.delete(excludedDataTypes).where(eq(excludedDataTypes.personId, input.personId)).run()
      for (const dataTypeId of new Set(input.dataTypeIds)) {
        tx.insert(excludedDataTypes)
          .values({ personId: input.personId, dataTypeId, excludedAtMs: input.nowMs }).run()
      }
    })
  }

  isExcluded(personId: string, dataTypeId: string): boolean {
    return this.#db.select({ id: excludedDataTypes.dataTypeId }).from(excludedDataTypes)
      .where(and(
        eq(excludedDataTypes.personId, personId),
        eq(excludedDataTypes.dataTypeId, dataTypeId),
      )).get() !== undefined
  }
}
