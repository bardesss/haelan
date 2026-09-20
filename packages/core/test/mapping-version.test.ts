import { describe, it, expect } from 'vitest'
import { mapSamples } from '../src/api/mapSamples.ts'
import { mapSessions } from '../src/api/mapSessions.ts'
import { dataTypeById } from '../src/api/catalogue.ts'
import { samplePoint, sleepPoint, body } from '../src/testing/payloads.ts'

// MAPPING_VERSION decides whether every existing household rebuilds on upgrade, and the rebuild
// holds the write lock for its whole run. So a bump has to be justified by a body that actually
// maps differently, not by a code path that could in principle.
//
// The candidate change: mapSamples and mapSessions now read `valueAt(point, 'dataSource') ??
// pageSource`, where pageSource is the parsed body's own top level dataSource. That can only ever
// change a replay if some archived body carries a top level dataSource for the fallback to reach.
// samplePoint and sleepPoint are this codebase's stand-in for a real Google fixture (the same
// helpers map-samples.test.ts and map-sessions.test.ts build their Google-shaped bodies from,
// and their shape comes from probe/findings/field-map.md, a read-only probe over an archived
// household). Neither the helper nor `body()` ever writes a top level dataSource, because the
// real Google v4 response never has one - only ingest.ts (the companion route) constructs that
// key, and it archives it beside dataPoints for exactly that reason.
describe('what the mapper version bump changes', () => {
  it('files a Google sample under the same source it always did', () => {
    const spo2 = dataTypeById('oxygen-saturation')!
    const seen: unknown[] = []
    const googleBody = body([samplePoint({
      payloadKey: 'oxygenSaturation', valuePath: 'percentage', value: 97,
      physicalTime: '2026-08-18T22:30:00Z',
    })])

    // The structural reason the fallback is inert for a Google body: there is nothing at the top
    // level for a point's own dataSource to fall back to.
    expect((JSON.parse(googleBody) as { dataSource?: unknown }).dataSource).toBeUndefined()

    mapSamples({
      dataType: spo2, body: googleBody, personId: 'p1', rawPayloadId: 'r1',
      resolveSource: (dataSource) => { seen.push(dataSource); return 's1' },
    })

    // `valueAt(point, 'dataSource') ?? pageSource` with pageSource undefined is
    // `valueAt(point, 'dataSource') ?? undefined`, which is `valueAt(point, 'dataSource')` - the
    // exact expression version 5 used. Whatever this fixture's point carries for its own
    // dataSource, the fallback never gets a chance to substitute anything else for it.
    expect(seen).toEqual([{ platform: 'FITBIT', recordingMethod: 'PASSIVELY_MEASURED' }])
  })

  it('files a Google session under the same source it always did', () => {
    const sleep = dataTypeById('sleep')!
    const seen: unknown[] = []
    const googleBody = body([sleepPoint({
      startTime: '2026-08-17T21:30:00Z', endTime: '2026-08-18T05:15:00Z', stages: [],
    })])

    expect((JSON.parse(googleBody) as { dataSource?: unknown }).dataSource).toBeUndefined()

    mapSessions({
      dataType: sleep, body: googleBody, personId: 'p1', rawPayloadId: 'r1',
      resolveSource: (dataSource) => { seen.push(dataSource); return 's1' },
    })

    expect(seen).toEqual([{ platform: 'FITBIT', recordingMethod: 'DERIVED' }])
  })
})
