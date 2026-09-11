import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { replayPerson } from '../src/rebuild/replay.ts'
import { peopleNeedingRebuild } from '../src/rebuild/versions.ts'
import { MAPPING_VERSION } from '../src/api/version.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { RawArchive } from '../src/store/rawArchive.ts'
import { SourceRegistry } from '../src/store/sources.ts'
import { sessions } from '../src/db/schema/index.ts'
import { body } from '../src/testing/payloads.ts'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

let t: TestDatabase | null = null
afterEach(() => { t?.cleanup(); t = null })

const listParams = { filter: 'x', pageSize: 1000, pageToken: null }

const runWithSplits = {
  name: 'users/me/dataTypes/exercise/dataPoints/run1',
  dataSource: { platform: 'FITBIT', recordingMethod: 'ACTIVELY_MEASURED' },
  exercise: {
    interval: {
      startTime: '2026-08-18T06:00:00Z', startUtcOffset: '7200s',
      endTime: '2026-08-18T06:30:00Z', endUtcOffset: '7200s',
    },
    exerciseType: 'RUNNING',
    displayName: 'Evening Run',
    activeDuration: '1680s',
    splits: [{
      startTime: '2026-08-18T06:00:00Z', startUtcOffset: '7200s',
      endTime: '2026-08-18T06:06:19Z', endUtcOffset: '7200s',
      activeDuration: '379s', splitType: 'DISTANCE',
      metricsSummary: { distanceMillimeters: 1_000_000 },
    }],
  },
}

describe('MAPPING_VERSION 5', () => {
  it('is 5, so a person stamped 4 is rebuilt rather than left with seven-key sessions', () => {
    expect(MAPPING_VERSION).toBe(5)
  })

  it('reports a person stamped at the old version as needing a rebuild, naming the mapping', () => {
    const need = peopleNeedingRebuild([{
      id: 'p1',
      builtMappingVersion: 4,
      builtDerivationVersion: DERIVATION_VERSION,
    } as Parameters<typeof peopleNeedingRebuild>[0][number]])

    expect(need).toHaveLength(1)
    expect(need[0]?.personId).toBe('p1')
    expect(need[0]?.reasons).toEqual(['mapping version 4, now 5'])
  })

  it('refills a session built under the old mapping with its splits, from the archive alone', () => {
    t = createTestDatabase()
    const db = t.db
    seedPerson(db, 'p1')
    const archive = new RawArchive(db)
    archive.put({
      personId: 'p1', dataType: 'exercise', requestParams: listParams,
      windowStartMs: Date.parse('2026-08-18T00:00:00Z'),
      windowEndMs: Date.parse('2026-08-19T00:00:00Z'),
      fetchedAtMs: 1, httpStatus: 200,
      body: body([runWithSplits]),
    })

    // The state a person stamped 4 is in: the payload is on disk, the session row is not.
    expect(db.select().from(sessions).where(eq(sessions.personId, 'p1')).all()).toHaveLength(0)

    db.transaction((tx) => replayPerson(tx, {
      personId: 'p1', payloads: archive.listFor('p1'), archive,
      sources: new SourceRegistry(db), nowMs: 1,
    }))

    const rows = db.select().from(sessions).where(eq(sessions.personId, 'p1')).all()
    expect(rows).toHaveLength(1)
    const attrs = JSON.parse(rows[0]!.attrs) as Record<string, unknown>
    // The whole justification for the version bump: history becomes detailed, not only future
    // workouts. A re-fetch was never needed, because the payload never left.
    expect(attrs.displayName).toBe('Evening Run')
    expect(attrs.activeDuration).toBe('1680s')
    expect(Array.isArray(attrs.splits)).toBe(true)
    expect((attrs.splits as unknown[])).toHaveLength(1)
  })
})
