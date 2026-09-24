import { and, eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { sourcePanelVisibility } from '../db/schema/index.ts'
import { ConfigError } from '../errors.ts'
import { getSource } from './sources.ts'

/**
 * Which sources a person chose to see in the status panel, or chose not to. Absence is meaningful:
 * it means "follow the default" (reported in the last 30 days), which is what lets a new device
 * appear and a retired one leave without anybody touching a switch.
 */
export class SourceVisibilityStore {
  readonly #db: DbOrTx

  constructor(db: DbOrTx) { this.#db = db }

  list(personId: string): Map<string, boolean> {
    const rows = this.#db.select({ sourceId: sourcePanelVisibility.sourceId, visible: sourcePanelVisibility.visible })
      .from(sourcePanelVisibility).where(eq(sourcePanelVisibility.personId, personId)).all()
    return new Map(rows.map((row) => [row.sourceId, row.visible]))
  }

  put(input: { personId: string, sourceId: string, visible: boolean, nowMs: number }): void {
    if (!getSource(this.#db, input.personId, input.sourceId)) {
      throw new ConfigError(`source ${input.sourceId} does not belong to this person`)
    }
    this.#db.insert(sourcePanelVisibility)
      .values({ personId: input.personId, sourceId: input.sourceId, visible: input.visible, updatedAtMs: input.nowMs })
      .onConflictDoUpdate({
        target: [sourcePanelVisibility.personId, sourcePanelVisibility.sourceId],
        set: { visible: input.visible, updatedAtMs: input.nowMs },
      }).run()
  }

  clear(input: { personId: string, sourceId: string }): void {
    this.#db.delete(sourcePanelVisibility).where(and(
      eq(sourcePanelVisibility.personId, input.personId),
      eq(sourcePanelVisibility.sourceId, input.sourceId),
    )).run()
  }
}
