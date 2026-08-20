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

  resolve(personId: string, dataSource: unknown, nowMs: number): string {
    const { externalId, displayName, kind } = describe(dataSource)
    const cacheKey = `${personId} ${externalId}`
    const cached = this.cache.get(cacheKey)
    if (cached) return cached

    const existing = this.db.select({ id: sources.id }).from(sources)
      .where(and(eq(sources.personId, personId), eq(sources.externalId, externalId))).get()
    if (existing) {
      this.cache.set(cacheKey, existing.id)
      return existing.id
    }

    // Derived rather than random so a rebuild from tier 1 reconstructs the same ids and the
    // derived rows that reference them stay valid.
    const id = createHash('sha256').update(`${personId} ${externalId}`).digest('hex').slice(0, 32)
    this.db.insert(sources)
      .values({ id, personId, externalId, displayName, kind, createdAtMs: nowMs })
      .onConflictDoNothing({ target: [sources.personId, sources.externalId] })
      .run()
    this.cache.set(cacheKey, id)
    return id
  }
}
