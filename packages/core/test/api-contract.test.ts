import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { RawArchive } from '../src/store/rawArchive.ts'
import { HealthClient } from '../src/api/client.ts'
import { dataTypeById, DATA_TYPES } from '../src/api/catalogue.ts'
import { mapWindowSamples } from '../src/api/mapSamples.ts'
import { mapSessions } from '../src/api/mapSessions.ts'
import { samplePoint, sleepPoint, body } from '../src/testing/payloads.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'

const WINDOW = { windowStartMs: Date.UTC(2026, 7, 18), windowEndMs: Date.UTC(2026, 7, 19) }

describe('client and mapper together', () => {
  let ctx: TestDatabase
  let archive: RawArchive
  const tokens = { accessTokenFor: async () => 'at' }

  beforeEach(() => {
    ctx = createTestDatabase()
    seedPerson(ctx.db, 'p1')
    archive = new RawArchive(ctx.db)
  })
  afterEach(() => { ctx.cleanup(); vi.restoreAllMocks() })

  it('fetches, archives, reads back and maps without the body ever being passed in memory', async () => {
    const hr = dataTypeById('heart-rate')!
    const points = Array.from({ length: 30 }, (_, i) => samplePoint({
      payloadKey: 'heartRate', valuePath: 'beatsPerMinute', value: String(60 + i),
      physicalTime: new Date(Date.UTC(2026, 7, 18, 10, 0, i * 2)).toISOString(),
    }))
    const fetchMock = vi.fn().mockResolvedValue(new Response(body(points), { status: 200 }))
    const client = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {}, random: () => 0 })

    // Not a test about local time, so UTC keeps the filter window unambiguous.
    const result = await client.listDataPoints({ personId: 'p1', dataType: hr, timezone: 'UTC', ...WINDOW })
    expect(result.payloadIds).toHaveLength(1)

    // Every fetched page, not just the last: a minute can straddle a page boundary, and
    // mapSamples alone only ever sees one page.
    const rows = mapWindowSamples({
      dataType: hr, personId: 'p1', resolveSource: () => 's1',
      pages: result.payloadIds.map((id) => ({ body: archive.getBody('p1', id), rawPayloadId: id })),
    })
    expect(rows).toHaveLength(3)
    expect(rows[0]?.n).toBe(30)
  })

  it('maps a night end to end', async () => {
    const sleep = dataTypeById('sleep')!
    // The end instant is deliberately chosen so UTC and Amsterdam disagree on the calendar
    // date: 22:30 UTC on the 17th is 00:30 CEST on the 18th. The offset is passed explicitly
    // (rather than relying on sleepPoint's default) so the fixture reads as a deliberate
    // choice, not an accident of the default. Only applying +7200s (2 hours) moves the wake
    // date from the 17th to the 18th, so the assertion below can only pass if the offset is
    // actually used rather than the payload's UTC instant read as-is.
    const night = sleepPoint({
      startTime: '2026-08-17T19:30:00Z', endTime: '2026-08-17T22:30:00Z', utcOffset: '7200s',
      stages: [{ type: 'DEEP', startTime: '2026-08-17T20:30:00Z', endTime: '2026-08-17T21:15:00Z' }],
    })
    const fetchMock = vi.fn().mockResolvedValue(new Response(body([night]), { status: 200 }))
    const client = new HealthClient(tokens, archive, { fetch: fetchMock, now: () => 1, sleep: async () => {}, random: () => 0 })

    // A night belonging to its wake date is exactly what this test is about, so a real zone
    // rather than UTC is the point, even though the client's timezone argument only shapes the
    // outgoing filter and does not itself reach the mapper below.
    const result = await client.listDataPoints({ personId: 'p1', dataType: sleep, timezone: 'Europe/Amsterdam', ...WINDOW })
    const stored = archive.getBody('p1', result.payloadIds[0]!)
    const { sessions, segments } = mapSessions({
      dataType: sleep, body: stored, personId: 'p1', resolveSource: () => 's1', rawPayloadId: result.payloadIds[0]!,
    })
    expect(sessions[0]?.endOffsetMinutes).toBe(120)
    expect(sessions[0]?.localDate).toBe('2026-08-18')
    expect(segments).toHaveLength(1)
  })

  it('every listable type declares a filterRoot and payloadKey in the casing the API demands', () => {
    for (const t of DATA_TYPES.filter((t) => t.listSupported)) {
      expect(t.filterRoot, t.id).not.toMatch(/[A-Z]/)
      expect(t.payloadKey, t.id).not.toMatch(/[-_]/)
    }
  })
})
