import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { sources } from '../db/schema/index.ts'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

interface Described { externalId: string, displayName: string, kind: 'device' | 'app' | 'manual' }

/**
 * What identifies a source, in the order the payload answers it.
 *
 * The field map records platform taking both FITBIT and HEALTH_CONNECT inside single payloads,
 * so the platform alone cannot identify a source. The device name joins it when there is one,
 * and `application.packageName` when there is not: several apps report through Health Connect
 * with no device between them, and on the platform alone a scale app and a food diary became one
 * source that spec section 9's merge policy could never let anyone choose between.
 *
 * `MANUAL` is part of the identity for the same reason but a stronger one - a reading somebody
 * typed in is not a measurement, and the person who wants their manual weights out of a trend
 * needs them to be a source they can exclude. The other recordingMethod values are not: DERIVED
 * and PASSIVELY_MEASURED are both the app measuring, and splitting on each would turn one app
 * into three sources for no question anyone asks. This is also what finally produces the
 * 'manual' kind the schema has carried since the first migration.
 *
 * Widening this re-keys only what was genuinely ambiguous. A payload with a device, or with
 * neither a package name nor a manual flag, produces exactly the externalId it produced before,
 * so rows already written against it keep pointing at the same source (pinned in sources.test.ts).
 */
function describe(dataSource: unknown): Described {
  if (!isRecord(dataSource)) return { externalId: 'unknown', displayName: 'unknown', kind: 'app' }
  const platform = typeof dataSource['platform'] === 'string' ? dataSource['platform'] : 'unknown'
  const device = dataSource['device']
  const deviceName = isRecord(device) && typeof device['displayName'] === 'string'
    ? device['displayName']
    : null
  const application = dataSource['application']
  const packageName = isRecord(application) && typeof application['packageName'] === 'string'
    ? application['packageName']
    : null
  const isManual = dataSource['recordingMethod'] === 'MANUAL'

  const who = deviceName ?? packageName
  const externalId = [platform, who, isManual ? 'MANUAL' : null].filter((p) => p !== null).join(':')
  const kind = isManual ? 'manual' : deviceName ? 'device' : 'app'
  return { externalId, displayName: who ?? platform, kind }
}

export class SourceRegistry {
  readonly #cache = new Map<string, string>()

  readonly #db: DbOrTx

  constructor(db: DbOrTx) { this.#db = db }

  /**
   * `into` is the handle the row is written and read through. A caller inside a transaction
   * passes its transaction handle so the sources row commits and rolls back with the samples
   * and sessions rows whose foreign keys point at it.
   */
  resolve(personId: string, dataSource: unknown, nowMs: number, into: DbOrTx = this.#db): string {
    const { externalId, displayName, kind } = describe(dataSource)
    const cacheKey = `${personId} ${externalId}`
    const cached = this.#cache.get(cacheKey)
    if (cached) return cached

    const existing = into.select({ id: sources.id }).from(sources)
      .where(and(eq(sources.personId, personId), eq(sources.externalId, externalId))).get()
    if (existing) {
      this.#cache.set(cacheKey, existing.id)
      return existing.id
    }

    // Derived rather than random so a rebuild from tier 1 reconstructs the same ids and the
    // derived rows that reference them stay valid.
    const id = createHash('sha256').update(`${personId} ${externalId}`).digest('hex').slice(0, 32)
    into.insert(sources)
      .values({ id, personId, externalId, displayName, kind, createdAtMs: nowMs })
      .onConflictDoNothing({ target: [sources.personId, sources.externalId] })
      .run()
    this.#cache.set(cacheKey, id)
    return id
  }

  /**
   * Drops one person's cached ids. A transaction that rolled back takes its sources rows with
   * it while the cache entry survives, and every later write pointing at that id then fails the
   * foreign key. Person granularity is the failure's own blast radius: a window only ever
   * resolves sources for one person, so no other person's entry can have been created by it.
   */
  forget(personId: string): void {
    const prefix = `${personId} `
    for (const key of this.#cache.keys()) {
      if (key.startsWith(prefix)) this.#cache.delete(key)
    }
  }
}
