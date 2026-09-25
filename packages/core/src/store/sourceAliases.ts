import { and, asc, eq, ne } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { people, sourceAliases, sources } from '../db/schema/index.ts'
import { ConfigError } from '../errors.ts'
import { localDateOf } from '../sync/localDate.ts'
import { defaultNamesOf, englishDefaultName, knownAppOf } from '../api/sourceNames.ts'
import type { DefaultName } from '../api/sourceNames.ts'
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
  /**
   * What every surface shows. Resolved here so no client reimplements the chain. For a known app
   * with no alias this is the English default (sourceNames.ts), which is what an MCP tool, an
   * export and any client without a reader's language print.
   */
  name: string
  kind: 'device' | 'app' | 'manual'
  createdAtMs: number
  /**
   * The known app's default this source has, so the web can say it in the reader's language. Null
   * for a source that is not a known app, where `name` is the whole answer. Still set beside an
   * alias, for Settings' placeholder (see DefaultName); every reader checks `alias` first, the order
   * nameFor itself follows.
   */
  defaultName: DefaultName | null
}

/**
 * Alias, then a known app's readable default, then the provider's own name, then the id.
 *
 * The last step is not dead code: `display_name` is not null, but nothing stops a provider from
 * sending an empty one, and an option rendering as blank is worse than one rendering as a hex id.
 * One function rather than a chain repeated per surface, because the web picker, M4's MCP server
 * and M4's CLI would otherwise each carry their own copy and drift apart on what a source is
 * called.
 */
export function nameFor(input: {
  id: string, displayName: string, alias: string | null, defaultName?: DefaultName | null,
}): string {
  if (input.alias !== null) return input.alias
  if (input.defaultName) return englishDefaultName(input.defaultName)
  return input.displayName === '' ? input.id : input.displayName
}

/**
 * Every source one person has, named, oldest first. The one read behind every surface that names a
 * source - listNamed, PersonQuery.describe (and through it the MCP tools), the all-time records -
 * because a default name depends on the person's other sources (two Health Connect rows are told
 * apart by date, one is not) and so cannot be resolved one row at a time without each caller
 * re-reading the list and, sooner or later, disagreeing about it.
 *
 * The first-seen date is read in the person's own zone, the same way every other local date in
 * this codebase is: "since 4 Sep" means the day the person would have called it.
 *
 * `timezone` is for a caller that has already read the person (describe, the routes that compute
 * the person's today): this read sits behind every page's source picker, so it should not repeat a
 * lookup its caller just made. Without it, the zone is read here - and only when some source is a
 * known app, since nothing else needs a date at all.
 */
export function namedSourcesOf(db: DbOrTx, personId: string, timezone?: string): NamedSource[] {
  const rows = db.select({
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
  if (rows.length === 0) return []

  // Only known apps can earn a default, so only they need a first-seen date, and a person with
  // none of them costs no people read and no date formatting.
  const candidates = rows.filter((row) => knownAppOf(row) !== null)
  let defaults = new Map<string, DefaultName>()
  if (candidates.length > 0) {
    // UTC for a person row that is somehow missing: the sources exist, so their names must still
    // resolve, and a date one day off in the rare disambiguation suffix is the whole cost.
    const zone = timezone ?? db.select({ timezone: people.timezone }).from(people)
      .where(eq(people.id, personId)).get()?.timezone ?? 'UTC'
    defaults = defaultNamesOf(candidates.map((row) => ({
      id: row.id, displayName: row.displayName, kind: row.kind, alias: row.alias,
      firstSeenDate: localDateOf(row.createdAtMs, zone),
    })))
  }

  return rows.map((row) => {
    const defaultName = defaults.get(row.id) ?? null
    return {
      id: row.id,
      externalId: row.externalId,
      displayName: row.displayName,
      alias: row.alias,
      name: nameFor({ id: row.id, displayName: row.displayName, alias: row.alias, defaultName }),
      kind: row.kind,
      createdAtMs: row.createdAtMs,
      defaultName,
    }
  })
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

  /**
   * Every source this person has, each with the name to show for it. Creation order. `timezone`
   * saves the people read for a caller that already has the person (see namedSourcesOf).
   */
  listNamed(personId: string, timezone?: string): NamedSource[] {
    return namedSourcesOf(this.#db, personId, timezone)
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
