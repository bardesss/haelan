import { and, asc, eq, ne } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { sourceAliases, sources } from '../db/schema/index.ts'
import { ConfigError } from '../errors.ts'
import { getSource } from './sources.ts'

/**
 * Past this a name stops being a name and starts deciding the source picker's layout. Exported
 * because the route refuses on the same number and the tests pin it.
 */
export const MAX_ALIAS_LENGTH = 64

export interface NamedSource {
  id: string
  externalId: string
  displayName: string
  /** What this person called it, or null if they never did. */
  alias: string | null
  /** What every surface shows. Resolved here so no client reimplements the chain. */
  name: string
  kind: 'device' | 'app' | 'manual'
  createdAtMs: number
}

/**
 * Alias, then the provider's own name, then the id.
 *
 * The last step is not dead code: `display_name` is not null, but nothing stops a provider from
 * sending an empty one, and an option rendering as blank is worse than one rendering as a hex id.
 * One function rather than a chain repeated per surface, because the web picker, M4's MCP server
 * and M4's CLI would otherwise each carry their own copy and drift apart on what a source is
 * called.
 */
export function nameFor(input: { id: string, displayName: string, alias: string | null }): string {
  if (input.alias !== null) return input.alias
  return input.displayName === '' ? input.id : input.displayName
}

/**
 * The names a person gave their sources.
 *
 * No DeriveQueue, unlike SourcePriorityStore: a ranking changes which source wins a merge and so
 * marks every day dirty, where a name changes nothing anyone derived. This store never enqueues.
 */
export class SourceAliasStore {
  readonly #db: DbOrTx

  constructor(db: DbOrTx) { this.#db = db }

  /** Every source this person has, each with the name to show for it. Creation order. */
  listNamed(personId: string): NamedSource[] {
    const rows = this.#db.select({
      id: sources.id,
      externalId: sources.externalId,
      displayName: sources.displayName,
      kind: sources.kind,
      createdAtMs: sources.createdAtMs,
      alias: sourceAliases.alias,
    }).from(sources)
      .leftJoin(sourceAliases, and(
        eq(sourceAliases.personId, sources.personId),
        eq(sourceAliases.sourceId, sources.id),
      ))
      .where(eq(sources.personId, personId))
      // Stable and meaningful: oldest source first, and the id breaks a tie so two sources first
      // seen in the same payload do not swap places between two reads of the same list.
      .orderBy(asc(sources.createdAtMs), asc(sources.id))
      .all()

    return rows.map((row) => ({
      id: row.id,
      externalId: row.externalId,
      displayName: row.displayName,
      alias: row.alias,
      name: nameFor({ id: row.id, displayName: row.displayName, alias: row.alias }),
      kind: row.kind,
      createdAtMs: row.createdAtMs,
    }))
  }

  put(input: { personId: string, sourceId: string, alias: string, nowMs: number }): void {
    const alias = input.alias.trim()
    if (alias === '') throw new ConfigError('alias must not be empty; remove it instead')
    if (alias.length > MAX_ALIAS_LENGTH) {
      throw new ConfigError(`alias must be ${MAX_ALIAS_LENGTH} characters or fewer, got ${alias.length}`)
    }

    // The same rule SourcePriorityStore's #assertOwned enforces and for the same reason: the
    // foreign key is on sources.id alone, so the database would happily file another household
    // member's source under this person. The route checks this first to answer not_found; this is
    // the backstop, and it is what makes the store safe to call from anywhere.
    if (!getSource(this.#db, input.personId, input.sourceId)) {
      throw new ConfigError(`source ${input.sourceId} does not belong to this person`)
    }

    // Checked rather than left to the unique index: a raw constraint failure reaches the route as
    // an unrecognised error and is answered 500, where this is a 400 whose message says what is
    // wrong. The index stays as the backstop.
    const taken = this.#db.select({ sourceId: sourceAliases.sourceId }).from(sourceAliases)
      .where(and(
        eq(sourceAliases.personId, input.personId),
        eq(sourceAliases.alias, alias),
        ne(sourceAliases.sourceId, input.sourceId),
      )).get()
    if (taken) throw new ConfigError(`'${alias}' is already the name of another source`)

    this.#db.insert(sourceAliases)
      .values({ personId: input.personId, sourceId: input.sourceId, alias, updatedAtMs: input.nowMs })
      .onConflictDoUpdate({
        target: [sourceAliases.personId, sourceAliases.sourceId],
        set: { alias, updatedAtMs: input.nowMs },
      })
      .run()
  }

  /** Removing a name nobody set is not an error: the caller's intent is already true. */
  clear(input: { personId: string, sourceId: string }): void {
    this.#db.delete(sourceAliases).where(and(
      eq(sourceAliases.personId, input.personId),
      eq(sourceAliases.sourceId, input.sourceId),
    )).run()
  }
}
