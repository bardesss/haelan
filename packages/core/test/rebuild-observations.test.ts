import { afterEach, describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { runRebuild } from '../src/rebuild/runRebuild.ts'
import { events, observations, sources } from '../src/db/schema/index.ts'
import { EventStore } from '../src/store/events.ts'
import { ObservationStore } from '../src/store/observations.ts'
import { body, samplePoint } from '../src/testing/payloads.ts'
import { seedRebuildable, REBUILDABLE_DATE } from '../src/testing/fixtures.ts'
import type { Rebuildable } from '../src/testing/fixtures.ts'

let h: Rebuildable
afterEach(() => { h.cleanup() })

const OBSERVATION_WINDOW_START = Date.parse(`${REBUILDABLE_DATE}T00:00:00Z`)
const LIST_PARAMS = { filter: 'x', pageSize: 1000, pageToken: null }

// A dataSource distinct from seedRebuildable's own default (the one its archived heart-rate
// window carries). Sharing that default would resolve to the same source id as the samples
// beside it, which would hide a rebuild that forgets observations are a reason a source counts
// as referenced - see dropUnreferencedSources in runRebuild.ts.
const OBSERVATION_DATA_SOURCE = {
  platform: 'HEALTH_CONNECT',
  application: { packageName: 'com.example.reproductive' },
  recordingMethod: 'ACTIVELY_MEASURED',
}

// A real catalogue entry (Group C, target: 'observations'), archived as a plain list response so
// isRollupRequest in replay.ts reads it the same way a real ovulation-test fetch would.
function archiveOvulationTest(rebuildable: Rebuildable, personId: string, value: string): void {
  rebuildable.deps.archive.put({
    personId, dataType: 'ovulation-test', requestParams: LIST_PARAMS,
    windowStartMs: OBSERVATION_WINDOW_START, windowEndMs: OBSERVATION_WINDOW_START + 86_400_000,
    fetchedAtMs: 1, httpStatus: 200,
    body: body([samplePoint({
      payloadKey: 'ovulationTest', valuePath: 'result', value,
      physicalTime: `${REBUILDABLE_DATE}T09:00:00Z`, dataSource: OBSERVATION_DATA_SOURCE,
    })]),
  })
}

describe('runRebuild / observations', () => {
  // The property this table exists for. A rebuild has to delete and regenerate observations
  // exactly the way it does samples and sessions, while events - tier 1, user-authored - survives
  // untouched. If either half slipped, the other assertion here would still pass, which is why
  // both live in the one test that matters most.
  test('a rebuild regenerates observations from the archive and leaves the user\'s events row untouched', () => {
    h = seedRebuildable()
    archiveOvulationTest(h, h.personId, 'POSITIVE')

    // A row from before the current mapping, under an id and a source the replay below will never
    // produce. If the rebuild's delete were skipped this would still be here afterwards, sitting
    // beside the fresh row rather than being replaced by it.
    h.db.insert(sources).values({
      id: 'stale-source', personId: h.personId, externalId: 'stale-source',
      displayName: 'stale-source', kind: 'device', createdAtMs: 0,
    }).run()
    new ObservationStore(h.db).writeMany([{
      id: 'stale-observation', personId: h.personId, sourceId: 'stale-source', kind: 'mood',
      startedAtMs: 0, startedAtOffsetMinutes: 0, endedAtMs: null, endedAtOffsetMinutes: null,
      localDate: '1970-01-01', value: 'SAD', rawPayloadId: null,
    }])

    // The user's own record of something that happened to them - tier 1, never derived, and the
    // one thing in this test a rebuild must leave exactly as it found it.
    const eventStore = new EventStore(h.db)
    const eventId = eventStore.add({
      personId: h.personId, kind: 'illness',
      startedAtMs: OBSERVATION_WINDOW_START, startedAtOffsetMinutes: 0, note: 'flu',
    })
    const eventBefore = h.db.select().from(events).where(eq(events.id, eventId)).get()!

    const report = runRebuild({ ...h.deps, nowMs: 1 })

    const rows = h.db.select().from(observations).where(eq(observations.personId, h.personId)).all()
    // Exactly the row the archive maps to, not that row plus the stale one: this is what proves
    // the rebuild deleted before it regenerated rather than merely inserting on top.
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('ovulation_test')
    expect(rows[0]!.value).toBe('POSITIVE')
    expect(report.people[0]!.observations).toBe(1)

    // Asserted whole, never a substring: a rebuild that touched any field here - even one it left
    // looking unchanged by coincidence - is the tier-1/tier-2 boundary breaking.
    expect(h.db.select().from(events).where(eq(events.id, eventId)).get()).toEqual(eventBefore)
  })

  // deleteForPerson exists to make this possible: a rebuild scoped to one household member must
  // never delete or regenerate rows belonging to somebody else.
  test('a single-person rebuild leaves another person\'s observations alone', () => {
    h = seedRebuildable()
    archiveOvulationTest(h, h.personId, 'POSITIVE')
    h.seedSecondPerson()

    h.db.insert(sources).values({
      id: 'p2-source', personId: 'p2', externalId: 'p2-source',
      displayName: 'p2-source', kind: 'device', createdAtMs: 0,
    }).run()
    new ObservationStore(h.db).writeMany([{
      id: 'p2-observation', personId: 'p2', sourceId: 'p2-source', kind: 'mood',
      startedAtMs: OBSERVATION_WINDOW_START, startedAtOffsetMinutes: 0,
      endedAtMs: null, endedAtOffsetMinutes: null, localDate: REBUILDABLE_DATE,
      value: 'HAPPY', rawPayloadId: null,
    }])
    const p2Before = h.db.select().from(observations).where(eq(observations.personId, 'p2')).all()

    runRebuild({ ...h.deps, nowMs: 1, personIds: [h.personId] })

    expect(h.db.select().from(observations).where(eq(observations.personId, 'p2')).all()).toEqual(p2Before)
  })
})
