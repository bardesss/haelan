import { describe, it, expect, afterEach } from 'vitest'
import { RawArchive, SCOPES, samplePoint } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'
import { companionIngestibleIds, STALE_SOURCE_MS } from '../src/routes/v1/companion.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

const ORIGIN = { origin: 'http://localhost:4235', host: 'localhost:4235' }

const weightPoint = (time: string) => samplePoint({
  payloadKey: 'weight',
  valuePath: 'weightGrams',
  value: '80000',
  physicalTime: time,
})

async function ingest(token: string, dataTypeId: string, payload: Record<string, unknown>) {
  if (!harness) throw new Error('no harness')
  return harness.app.inject({
    method: 'POST', url: `/api/v1/p/p1/ingest/${dataTypeId}`,
    headers: { authorization: `Bearer ${token}`, ...ORIGIN },
    payload,
  })
}

async function cursors(token: string, query = '') {
  if (!harness) throw new Error('no harness')
  return harness.app.inject({
    method: 'GET', url: `/api/v1/p/p1/companion/cursors${query}`,
    headers: { authorization: `Bearer ${token}` },
  })
}

interface CursorItem {
  dataTypeId: string
  dataSource?: string
  lastWindowEndMs: number | null
  lastIngestAtMs: number | null
}

// Copied verbatim from SyncCursors.kt's parseCursorEnds, not paraphrased: 0.1.0 is already
// installed on a phone and reads the wire with this exact regex, not a JSON parser. If the
// route's field order ever drifts (a new field landing between dataTypeId and lastWindowEndMs
// in the legacy item, say), this is what catches it, the same way it would catch that phone.
const PARSE_CURSOR_ENDS = /"dataTypeId"\s*:\s*"([^"]+)"\s*,\s*"lastWindowEndMs"\s*:\s*(null|\d+)/g
function parseCursorEndsLikeThePhone(body: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const match of body.matchAll(PARSE_CURSOR_ENDS)) {
    const id = match[1]
    const raw = match[2]
    if (id !== undefined && raw !== undefined && raw !== 'null') out.set(id, Number(raw))
  }
  return out
}

describe('GET /companion/cursors', () => {
  it('answers null for every ingestible type before the first sync', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const response = await cursors(token, '?platform=android')
    expect(response.statusCode).toBe(200)
    const body = response.json() as { items: CursorItem[], historyStartMs: number | null }
    expect(body.historyStartMs).toBe(null)
    expect(body.items.map((i) => i.dataTypeId)).toEqual(companionIngestibleIds())
    expect(body.items.every((i) => i.lastWindowEndMs === null && i.lastIngestAtMs === null)).toBe(true)
  })

  it('moves only the ingested type and records the history start', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    expect((await ingest(token, 'weight', { dataPoints: [weightPoint('2026-08-18T10:00:00Z')] })).statusCode).toBe(200)

    const body = (await cursors(token)).json() as { items: CursorItem[], historyStartMs: number | null }
    const weight = body.items.find((i) => i.dataTypeId === 'weight')
    const steps = body.items.find((i) => i.dataTypeId === 'steps')
    // The archive stores an exclusive end, one millisecond past the sample (ingest.ts).
    expect(weight?.lastWindowEndMs).toBe(Date.parse('2026-08-18T10:00:00Z') + 1)
    expect(typeof weight?.lastIngestAtMs).toBe('number')
    expect(steps?.lastWindowEndMs).toBe(null)
    expect(body.historyStartMs).toBe(Date.parse('2026-08-18T10:00:00Z'))
  })

  it('keeps the newest window end and the newest fetch time across two uploads', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    expect((await ingest(token, 'weight', { dataPoints: [weightPoint('2026-08-18T10:00:00Z')] })).statusCode).toBe(200)
    harness.clock.nowMs += 3_600_000
    expect((await ingest(token, 'weight', { dataPoints: [weightPoint('2026-08-20T10:00:00Z')] })).statusCode).toBe(200)

    const body = (await cursors(token)).json() as { items: CursorItem[], historyStartMs: number | null }
    const weight = body.items.find((i) => i.dataTypeId === 'weight')
    expect(weight?.lastWindowEndMs).toBe(Date.parse('2026-08-20T10:00:00Z') + 1)
    expect(body.historyStartMs).toBe(Date.parse('2026-08-18T10:00:00Z'))
  })

  it('ignores Google fetches archived for the same person and type', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    if (!harness) throw new Error('no harness')
    new RawArchive(harness.app.haelan.instance.db).put({
      personId: 'p1',
      dataType: 'weight',
      requestParams: { filter: 'weight.sample_time.physical_time >= "2026-08-10T00:00:00Z"', pageSize: 10000, pageToken: null },
      windowStartMs: Date.parse('2026-08-10T00:00:00Z'),
      windowEndMs: Date.parse('2026-08-11T00:00:00Z'),
      fetchedAtMs: harness.clock.nowMs,
      httpStatus: 200,
      body: JSON.stringify({ dataPoints: [weightPoint('2026-08-10T10:00:00Z')] }),
    })
    const body = (await cursors(token)).json() as { items: CursorItem[], historyStartMs: number | null }
    expect(body.items.find((i) => i.dataTypeId === 'weight')?.lastWindowEndMs).toBe(null)
    expect(body.historyStartMs).toBe(null)
  })

  it('accepts the platform spellings the phone may send and refuses an unknown one', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    for (const query of ['', '?platform=android', '?platform=HEALTH_CONNECT', '?platform=health-connect']) {
      expect((await cursors(token, query)).statusCode).toBe(200)
    }
    const refused = await cursors(token, '?platform=healthkit')
    expect(refused.statusCode).toBe(400)
  })

  it('answers rather than failing when an archived row cannot be classified', async () => {
    // The narrowing runs in SQL now, and `json_extract` raises on a requestParams that is not
    // JSON: unguarded, one such row would make this route a 500 on every dashboard page load
    // instead of the skip it used to be in JavaScript. Nothing writes a row like this, so the
    // seed is direct; the endpoint is what has to survive it.
    harness = await withServer()
    const token = await harness.signIn()
    if (!harness) throw new Error('no harness')
    harness.app.haelan.instance.db.$client.prepare(
      `insert into raw_payloads (id, person_id, data_type, request_params, window_start_ms, window_end_ms,
        fetched_at_ms, http_status, body_gzip, body_hash, body_bytes)
       values ('broken-1', 'p1', 'weight', 'not json at all', 1, 2, 1, 200, x'1f8b', 'h', 2)`,
    ).run()
    expect((await ingest(token, 'weight', { dataPoints: [weightPoint('2026-08-18T10:00:00Z')] })).statusCode).toBe(200)

    const response = await cursors(token)
    expect(response.statusCode).toBe(200)
    const body = response.json() as { items: CursorItem[], historyStartMs: number | null }
    // The phone's own row is still answered, and the unreadable one is left out of both numbers
    // rather than dragging the history start to its own window of one millisecond past 1970.
    expect(body.historyStartMs).toBe(Date.parse('2026-08-18T10:00:00Z'))
    expect(body.items.find((i) => i.dataTypeId === 'weight')?.lastWindowEndMs)
      .toBe(Date.parse('2026-08-18T10:00:00Z') + 1)
  })

  it('names whether the person also has a Google path, so cards know when to clamp', async () => {
    harness = await withServer()
    // The harness finishes the wizard with a Google path for p1, so the unconnected
    // case needs a member of its own: addPerson creates one with no token behind it.
    const added = await harness.addPerson({ id: 'p2', displayName: 'Other', username: 'other' })
    const token = await harness.signIn('other', 'a good long password')
    const forPerson = (personId: string) => {
      if (!harness) throw new Error('no harness')
      return harness.app.inject({
        method: 'GET', url: `/api/v1/p/${personId}/companion/cursors`,
        headers: { authorization: `Bearer ${token}` },
      })
    }
    expect(((await forPerson(added.personId)).json() as { googleConnected: boolean }).googleConnected).toBe(false)
    harness.app.haelan.instance.credentials.putRefreshToken({
      personId: added.personId, refreshToken: 'stub-refresh-token',
      scopes: [...SCOPES], nowMs: harness.clock.nowMs,
    })
    expect(((await forPerson(added.personId)).json() as { googleConnected: boolean }).googleConnected).toBe(true)
  })

  it('cannot be read for another person', async () => {
    harness = await withServer()
    const token = await harness.signIn()
    const other = await harness.addPerson({ id: 'p2', displayName: 'Other', username: 'other' })
    const response = await harness.app.inject({
      method: 'GET', url: `/api/v1/p/${other.personId}/companion/cursors`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(403)
  })

  it('keys the cursor on type and source, so a late source keeps its own progress', async () => {
    harness = await withServer()
    const token = await harness.signIn()

    // The phone's own reading, early. No explicit dataSource, so ingest.ts resolves it to the
    // companion app's default identity.
    expect((await ingest(token, 'weight', {
      dataPoints: [weightPoint('2026-08-18T10:00:00Z')],
    })).statusCode).toBe(200)
    // A second source for the same type, syncing in a week later -- the shape of the bug: a
    // watch or a scale whose reading lands long after the phone's own reading already moved a
    // shared cursor.
    expect((await ingest(token, 'weight', {
      dataPoints: [weightPoint('2026-08-25T10:00:00Z')],
      dataSource: { platform: 'HEALTH_CONNECT', device: { displayName: 'Galaxy Watch6' } },
    })).statusCode).toBe(200)

    const response = await cursors(token)
    const raw = response.payload
    const body = response.json() as { items: CursorItem[] }
    const weightItems = body.items.filter((i) => i.dataTypeId === 'weight')

    // One item per source, each carrying only its own cursor.
    const perSource = weightItems.filter((i) => i.dataSource !== undefined)
    expect(perSource).toHaveLength(2)
    const phoneItem = perSource.find((i) => i.lastWindowEndMs === Date.parse('2026-08-18T10:00:00Z') + 1)
    const watchItem = perSource.find((i) => i.lastWindowEndMs === Date.parse('2026-08-25T10:00:00Z') + 1)
    expect(phoneItem).toBeDefined()
    expect(watchItem).toBeDefined()
    expect(phoneItem?.dataSource).not.toBe(watchItem?.dataSource)

    // The legacy item (no dataSource field) answers the MINIMUM across the type's sources, not
    // the maximum a single shared cursor used to answer -- the maximum is what let the watch's
    // late reading go missing silently, since re-asking from the phone's later cursor would
    // never reach back to it.
    const legacy = weightItems.find((i) => i.dataSource === undefined)
    expect(legacy?.lastWindowEndMs).toBe(Date.parse('2026-08-18T10:00:00Z') + 1)

    // An un-updated 0.1.0 phone, reading with its own regex rather than a JSON parser, still
    // finds a value for every ingestible type and still lands on the safe minimum for weight,
    // not the more advanced per-source items the new field order deliberately hides from it.
    const parsed = parseCursorEndsLikeThePhone(raw)
    expect(parsed.get('weight')).toBe(Date.parse('2026-08-18T10:00:00Z') + 1)
    for (const dataTypeId of companionIngestibleIds()) {
      if (dataTypeId === 'weight') continue
      expect(parsed.has(dataTypeId)).toBe(false)
    }
  })

  // Finding 1 from the follow-up review: the (type, source) minimum fixed a late writer going
  // missing, and introduced the opposite problem -- nothing aged a source back out of it. A
  // retired watch's frozen cursor would otherwise pin the whole type's read start open forever.
  it('drops a source from the minimum once it has been silent past STALE_SOURCE_MS', async () => {
    harness = await withServer()
    const token = await harness.signIn()

    // The watch's one and only upload, at the harness's starting clock.
    expect((await ingest(token, 'weight', {
      dataPoints: [weightPoint('2026-08-01T10:00:00Z')],
      dataSource: { platform: 'HEALTH_CONNECT', device: { displayName: 'Galaxy Watch6' } },
    })).statusCode).toBe(200)
    // The phone syncs in a day later, and keeps syncing after that -- its lastIngestAtMs stays
    // recent throughout the test, only the watch's goes stale.
    harness.clock.nowMs += 24 * 60 * 60 * 1000
    expect((await ingest(token, 'weight', { dataPoints: [weightPoint('2026-08-18T10:00:00Z')] })).statusCode).toBe(200)

    // One day since the watch's last upload: still well under the threshold, so the watch is
    // merely a laggard and still pulls the minimum back to its own frozen progress -- the
    // behaviour the (type, source) fix exists to keep.
    const beforeAgeing = (await cursors(token)).json() as { items: CursorItem[] }
    const legacyBefore = beforeAgeing.items.find((i) => i.dataTypeId === 'weight' && i.dataSource === undefined)
    expect(legacyBefore?.lastWindowEndMs).toBe(Date.parse('2026-08-01T10:00:00Z') + 1)

    // Push the clock so the watch's silence crosses STALE_SOURCE_MS while the phone's own last
    // ingest, one day younger, stays just inside it.
    harness.clock.nowMs += STALE_SOURCE_MS - 1

    const afterAgeing = (await cursors(token)).json() as { items: CursorItem[] }
    const legacyAfter = afterAgeing.items.find((i) => i.dataTypeId === 'weight' && i.dataSource === undefined)
    // The watch has aged out: the minimum is now the phone's own progress, not the watch's
    // frozen one, so the read window stops growing a day a day for a source that is gone.
    expect(legacyAfter?.lastWindowEndMs).toBe(Date.parse('2026-08-18T10:00:00Z') + 1)

    // The watch itself is unaffected: its own per-source item still answers its true progress,
    // so a phone that resumes writing under that identity picks up exactly where it left off.
    const perSourceAfter = afterAgeing.items.filter((i) => i.dataTypeId === 'weight' && i.dataSource !== undefined)
    const watchItem = perSourceAfter.find((i) => i.lastWindowEndMs === Date.parse('2026-08-01T10:00:00Z') + 1)
    expect(watchItem).toBeDefined()
  })

  it('still holds the minimum back to a source silent for just under STALE_SOURCE_MS', async () => {
    harness = await withServer()
    const token = await harness.signIn()

    expect((await ingest(token, 'weight', {
      dataPoints: [weightPoint('2026-08-01T10:00:00Z')],
      dataSource: { platform: 'HEALTH_CONNECT', device: { displayName: 'Galaxy Watch6' } },
    })).statusCode).toBe(200)
    expect((await ingest(token, 'weight', { dataPoints: [weightPoint('2026-08-18T10:00:00Z')] })).statusCode).toBe(200)

    // One millisecond short of the threshold: a genuinely intermittent source, not a dead one.
    harness.clock.nowMs += STALE_SOURCE_MS - 1

    const body = (await cursors(token)).json() as { items: CursorItem[] }
    const legacy = body.items.find((i) => i.dataTypeId === 'weight' && i.dataSource === undefined)
    expect(legacy?.lastWindowEndMs).toBe(Date.parse('2026-08-01T10:00:00Z') + 1)
  })
})

/**
 * The zero row upload. A page whose points all drop is not a rare shape: the mapper drops a
 * value it cannot parse and a session whose interval it cannot read, both of which a real
 * Health Connect payload produces (a reading with no value, a stage with a bad bound).
 */
describe('a companion upload that maps to no rows', () => {
  const RAW_PAYLOADS = "select count(*) as n from raw_payloads where person_id = 'p1'"

  const archiveRows = (): number => {
    if (!harness) throw new Error('no harness')
    const row = harness.app.haelan.instance.db.$client.prepare(RAW_PAYLOADS).get() as { n: number }
    return row.n
  }

  // The value parses to null, so mapSamples drops the point rather than writing a zero
  // (spec invariant 2). The payload itself is well formed, which is what makes this reachable:
  // `dataPoints must not be empty` is satisfied by a page of points nobody can read.
  const unreadableValuePoint = () => samplePoint({
    payloadKey: 'weight', valuePath: 'weightGrams', value: 'not a number',
    physicalTime: '2026-08-18T10:00:00Z',
  })

  // An interval whose bounds are no instant at all. Both ends have to be unreadable: parseInstant
  // falls back through physicalTime, startTime and endTime, so a bad start alone still resolves a
  // point from its end.
  const unreadableIntervalPoint = () => ({
    name: 'users/me/dataTypes/sleep/dataPoints/bad',
    dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
    sleep: {
      interval: {
        startTime: 'not an instant', startUtcOffset: '7200s',
        endTime: 'also not an instant', endUtcOffset: '7200s',
      },
      type: 'STAGES',
      metadata: { mainSleep: true, processed: true, stagesStatus: 'SUCCEEDED' },
      stages: [{ type: 'LIGHT', startTime: '2026-08-18T06:00:00Z', endTime: '2026-08-18T07:00:00Z' }],
    },
  })

  it('answers 200 with nothing written, and archives no window for the empty page', async () => {
    harness = await withServer()
    const token = await harness.signIn()

    const response = await ingest(token, 'weight', { dataPoints: [unreadableValuePoint()] })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      payloadId: null, deduplicated: false, rowsWritten: 0, affected: null, applied: true,
    })
    // Not merely "nothing written": nothing archived. A row here would carry the only window
    // this request could state, and with no rows that window is 1970 (see the guard in ingest.ts).
    expect(archiveRows()).toBe(0)
  })

  it('leaves the type cursor and the history start alone, so no card clamps to 1970', async () => {
    harness = await withServer()
    const token = await harness.signIn()

    // One real upload first, so the assertions below are about what the empty page did *not*
    // move rather than about a type that was never touched.
    expect((await ingest(token, 'weight', { dataPoints: [weightPoint('2026-08-18T10:00:00Z')] })).statusCode).toBe(200)
    const before = (await cursors(token)).json() as { items: CursorItem[], historyStartMs: number | null }
    expect(before.historyStartMs).toBe(Date.parse('2026-08-18T10:00:00Z'))

    expect((await ingest(token, 'weight', { dataPoints: [unreadableValuePoint()] })).statusCode).toBe(200)
    expect((await ingest(token, 'steps', { dataPoints: [unreadableValuePoint()] })).statusCode).toBe(200)

    const after = (await cursors(token)).json() as { items: CursorItem[], historyStartMs: number | null }
    // The whole point of the fix: 0 would have become 1970-01-01 here, and clampFromToHistory
    // returns the range untouched once the start is at or before it, so every card would read
    // "1 of 30 days" over 29 days of inactivity that never happened.
    expect(after.historyStartMs).toBe(Date.parse('2026-08-18T10:00:00Z'))
    const weight = after.items.find((i) => i.dataTypeId === 'weight')
    expect(weight?.lastWindowEndMs).toBe(Date.parse('2026-08-18T10:00:00Z') + 1)
    // A type the empty page was the only upload for, so this is the untouched null: no cursor
    // and no 1970 for a type nothing has ever reported.
    expect(after.items.find((i) => i.dataTypeId === 'steps')?.lastWindowEndMs).toBe(null)
  })

  it('does not move the cursor on a sessions type either, so the phone asks for the window again', async () => {
    harness = await withServer()
    const token = await harness.signIn()

    const response = await ingest(token, 'sleep', { dataPoints: [unreadableIntervalPoint()] })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ payloadId: null, rowsWritten: 0 })
    expect(archiveRows()).toBe(0)

    const body = (await cursors(token)).json() as { items: CursorItem[], historyStartMs: number | null }
    expect(body.historyStartMs).toBe(null)
    expect(body.items.find((i) => i.dataTypeId === 'sleep')?.lastWindowEndMs).toBe(null)
    // No session row either, which is the invariant the guard relies on: nothing survives a
    // point whose interval cannot be read, segments included.
    const sessions = harness.app.haelan.instance.db.$client
      .prepare("select count(*) as n from sessions where person_id = 'p1'").get() as { n: number }
    expect(sessions.n).toBe(0)
  })
})
