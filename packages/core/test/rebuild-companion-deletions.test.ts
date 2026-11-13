import { afterEach, describe, expect, it } from 'vitest'
import { runRebuild } from '../src/rebuild/runRebuild.ts'
import { companionDeletions, companionRecordSamples } from '../src/db/schema/index.ts'
import { COMPANION_SOURCE } from '../src/store/rawArchive.ts'
import { samplePoint } from '../src/testing/payloads.ts'
import { readSamples, seedRebuildable } from '../src/testing/fixtures.ts'
import type { Rebuildable } from '../src/testing/fixtures.ts'

const T1 = Date.parse('2026-08-18T07:00:00Z')
const T2 = Date.parse('2026-08-18T08:00:00Z')

// An archive written before the delete arrived: both records are still in the page.
function seedWeightPage(h: Rebuildable): void {
  const point = (name: string, atMs: number, grams: string): Record<string, unknown> => ({
    ...samplePoint({
      payloadKey: 'weight', valuePath: 'weightGrams', value: grams,
      physicalTime: new Date(atMs).toISOString(),
    }),
    name,
  })
  h.deps.archive.put({
    personId: h.personId, dataType: 'weight',
    requestParams: { source: COMPANION_SOURCE, dataType: 'weight', dataSource: 'phone' },
    windowStartMs: T1, windowEndMs: T2 + 3_600_000, fetchedAtMs: 1, httpStatus: 200,
    body: JSON.stringify({ dataPoints: [point('hc-weight-1', T1, '80000'), point('hc-weight-2', T2, '81000')] }),
  })
  h.db.insert(companionDeletions).values({
    personId: h.personId, dataType: 'weight', recordId: 'hc-weight-1', deletedAtMs: 5,
  }).run()
}

describe('a rebuild keeps companion deletions', () => {
  let h: Rebuildable
  afterEach(() => { h.cleanup() })

  const weights = (): number[] =>
    readSamples(h.db, h.personId).filter((r) => r.metric === 'weight').map((r) => r.utcMs).sort()

  it('does not replay a record that was deleted', () => {
    h = seedRebuildable()
    seedWeightPage(h)
    runRebuild({ ...h.deps, nowMs: 1, force: true })
    expect(weights()).toEqual([T2])
  })

  it('rebuilds the link of a record that remains', () => {
    h = seedRebuildable()
    seedWeightPage(h)
    runRebuild({ ...h.deps, nowMs: 1, force: true })
    const links = h.db.select().from(companionRecordSamples).all()
    expect(links.map((l) => l.recordId)).toEqual(['hc-weight-2'])
  })

  it('keeps the tombstone through a rebuild', () => {
    h = seedRebuildable()
    seedWeightPage(h)
    runRebuild({ ...h.deps, nowMs: 1, force: true })
    expect(h.db.select().from(companionDeletions).all()).toHaveLength(1)
  })
})
