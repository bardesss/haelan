import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { sources } from '../db/schema/index.ts'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

interface Described { externalId: string, displayName: string, kind: 'device' | 'app' | 'manual' }

// The field map records platform taking both FITBIT and HEALTH_CONNECT inside single payloads,
// so the platform alone cannot identify a source. The device name joins it when there is one.
function describe(dataSource: unknown): Described {
  if (!isRecord(dataSource)) return { externalId: 'unknown', displayName: 'unknown', kind: 'app' }
  const platform = typeof dataSource['platform'] === 'string' ? dataSource['platform'] : 'unknown'
  const device = dataSource['device']
  const deviceName = isRecord(device) && typeof device['displayName'] === 'string'
    ? device['displayName']
    : null
  if (deviceName) return { externalId: `${platform}:${deviceName}`, displayName: deviceName, kind: 'device' }
  return { externalId: platform, displayName: platform, kind: 'app' }
}

export class SourceRegistry {
  private readonly cache = new Map<string, string>()

  constructor(private readonly db: DbOrTx) {}

  /**
   * `into` is the handle the row is written and read through. A caller inside a transaction
   * passes its transaction handle so the sources row commits and rolls back with the samples
   * and sessions rows whose foreign keys point at it.
   */
  resolve(personId: string, dataSource: unknown, nowMs: number, into: DbOrTx = this.db): string {
    const { externalId, displayName, kind } = describe(dataSource)
    const cacheKey = `${personId} ${externalId}`
    const cached = this.cache.get(cacheKey)
    if (cached) return cached

    const existing = into.select({ id: sources.id }).from(sources)
      .where(and(eq(sources.personId, personId), eq(sources.externalId, externalId))).get()
    if (existing) {
      this.cache.set(cacheKey, existing.id)
      return existing.id
    }

    // Derived rather than random so a rebuild from tier 1 reconstructs the same ids and the
    // derived rows that reference them stay valid.
    const id = createHash('sha256').update(`${personId} ${externalId}`).digest('hex').slice(0, 32)
    into.insert(sources)
      .values({ id, personId, externalId, displayName, kind, createdAtMs: nowMs })
      .onConflictDoNothing({ target: [sources.personId, sources.externalId] })
      .run()
    this.cache.set(cacheKey, id)
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
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key)
    }
  }
}
