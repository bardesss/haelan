import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { DERIVATION_VERSION, peopleNeedingRebuild, samplePoint } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

const ORIGIN = { origin: 'http://localhost:4235', host: 'localhost:4235' }

// 22:00 in Europe/Amsterdam (the harness person's home zone) on the 26th, and already 05:00 on the
// 27th in Asia/Tokyo: the traveller's phone is a day ahead of home.
const NOW_MS = Date.parse('2026-09-26T20:00:00Z')

async function start(): Promise<{ h: Harness, token: string }> {
  const h = await withServer()
  harness = h
  h.clock.nowMs = NOW_MS
  return { h, token: await h.signIn() }
}

const weightPoint = () => samplePoint({
  payloadKey: 'weight', valuePath: 'weightGrams', value: '80000', physicalTime: '2026-09-20T10:00:00Z',
})

function ingest(h: Harness, token: string, zone: string | undefined, personId = 'p1') {
  return h.app.inject({
    method: 'POST', url: `/api/v1/p/${personId}/ingest/weight`,
    headers: { authorization: `Bearer ${token}`, ...ORIGIN, ...(zone === undefined ? {} : { 'x-haelan-zone': zone }) },
    payload: { dataPoints: [weightPoint()] },
  })
}

function get(h: Harness, token: string, url: string) {
  return h.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })
}

describe('the phone zone header on ingest', () => {
  it('stores a zone Intl knows as the current zone, and leaves the home zone and its stamp alone', async () => {
    const { h, token } = await start()
    const response = await ingest(h, token, 'Asia/Tokyo')
    expect(response.statusCode).toBe(200)
    const person = h.app.haelan.stores.people.get('p1')!
    expect(person.currentTimezone).toBe('Asia/Tokyo')
    expect(person.timezone).toBe('Europe/Amsterdam')
    expect(person.builtDerivationVersion).toBe(DERIVATION_VERSION)
    expect(peopleNeedingRebuild(h.app.haelan.stores.people.list())).toEqual([])
  })

  it('ignores an unknown zone and still succeeds', async () => {
    const { h, token } = await start()
    await ingest(h, token, 'Asia/Tokyo')
    const response = await ingest(h, token, 'Mars/Olympus_Mons')
    expect(response.statusCode).toBe(200)
    expect(h.app.haelan.stores.people.get('p1')!.currentTimezone).toBe('Asia/Tokyo')
  })

  it('changes nothing without the header, and still succeeds', async () => {
    const { h, token } = await start()
    const response = await ingest(h, token, undefined)
    expect(response.statusCode).toBe(200)
    expect(h.app.haelan.stores.people.get('p1')!.currentTimezone).toBeNull()
  })

  it('stores it on an upload that maps to no rows too, which is still a successful ingest', async () => {
    const { h, token } = await start()
    const response = await h.app.inject({
      method: 'POST', url: '/api/v1/p/p1/ingest/weight',
      headers: { authorization: `Bearer ${token}`, ...ORIGIN, 'x-haelan-zone': 'Asia/Tokyo' },
      payload: { dataPoints: [{ unreadable: true }] },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().rowsWritten).toBe(0)
    expect(h.app.haelan.stores.people.get('p1')!.currentTimezone).toBe('Asia/Tokyo')
  })
})

describe('/api/auth/me', () => {
  it('carries the home zone, the effective zone, the current zone and the switch', async () => {
    const { h, token } = await start()
    expect((await get(h, token, '/api/auth/me')).json()).toMatchObject({
      timezone: 'Europe/Amsterdam', effectiveTimezone: 'Europe/Amsterdam', currentTimezone: null, followPhoneZone: true,
    })
    await ingest(h, token, 'Asia/Tokyo')
    expect((await get(h, token, '/api/auth/me')).json()).toMatchObject({
      timezone: 'Europe/Amsterdam', effectiveTimezone: 'Asia/Tokyo', currentTimezone: 'Asia/Tokyo', followPhoneZone: true,
    })
    h.app.haelan.stores.people.setFollowPhoneZone('p1', false)
    expect((await get(h, token, '/api/auth/me')).json()).toMatchObject({
      timezone: 'Europe/Amsterdam', effectiveTimezone: 'Europe/Amsterdam', currentTimezone: 'Asia/Tokyo', followPhoneZone: false,
    })
  })
})

describe('read-time today follows the effective zone', () => {
  it('the glance is already tomorrow for a person whose phone is in Tokyo, and home again with the switch off', async () => {
    const { h, token } = await start()
    expect((await get(h, token, '/api/v1/p/p1/glance')).json().today).toBe('2026-09-26')
    h.app.haelan.stores.people.setCurrentTimezone('p1', 'Asia/Tokyo')
    expect((await get(h, token, '/api/v1/p/p1/glance')).json().today).toBe('2026-09-27')
    h.app.haelan.stores.people.setFollowPhoneZone('p1', false)
    expect((await get(h, token, '/api/v1/p/p1/glance')).json().today).toBe('2026-09-26')
  })

  it('quick-log files today by the effective zone, at its offset', async () => {
    const { h, token } = await start()
    h.app.haelan.stores.people.setCurrentTimezone('p1', 'Asia/Tokyo')
    const written = await h.app.inject({
      method: 'POST', url: '/api/v1/p/p1/quick-log',
      headers: { authorization: `Bearer ${token}`, ...ORIGIN },
      payload: { kind: 'travel', day: '2026-09-27' },
    })
    expect(written.statusCode).toBe(200)
    expect(written.json()).toMatchObject({ startedAtMs: NOW_MS, startedAtOffsetMinutes: 540, localDate: '2026-09-27' })
  })

  it('quick-log files a past day at 21:00 in the effective zone', async () => {
    const { h, token } = await start()
    h.app.haelan.stores.people.setCurrentTimezone('p1', 'Asia/Tokyo')
    const written = await h.app.inject({
      method: 'POST', url: '/api/v1/p/p1/quick-log',
      headers: { authorization: `Bearer ${token}`, ...ORIGIN },
      payload: { kind: 'illness', day: '2026-09-24' },
    })
    expect(written.statusCode).toBe(200)
    // 21:00 in Tokyo, UTC+9; in the home zone it would have been 19:00Z.
    expect(written.json().startedAtMs).toBe(Date.parse('2026-09-24T12:00:00Z'))
  })
})

describe('PUT /api/profile followPhoneZone', () => {
  const save = (h: Harness, token: string, payload: Record<string, unknown>) => h.app.inject({
    method: 'PUT', url: '/api/profile', headers: { authorization: `Bearer ${token}` }, payload,
  })

  it('round-trips, clears no stamp and asks for no rebuild', async () => {
    const { h, token } = await start()
    const response = await save(h, token, { followPhoneZone: false })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ followPhoneZone: false, rebuildPending: false })
    expect((await get(h, token, '/api/auth/me')).json().followPhoneZone).toBe(false)
    expect(h.app.haelan.stores.people.get('p1')!.builtDerivationVersion).toBe(DERIVATION_VERSION)
    await save(h, token, { followPhoneZone: true })
    expect((await get(h, token, '/api/auth/me')).json().followPhoneZone).toBe(true)
  })

  it('refuses anything that is not a boolean, before writing anything', async () => {
    const { h, token } = await start()
    for (const value of ['false', 0, null]) {
      const response = await save(h, token, { displayName: 'Changed', followPhoneZone: value })
      expect(response.statusCode).toBe(400)
      expect(response.json().error.message).toContain('followPhoneZone')
    }
    expect(h.app.haelan.stores.people.get('p1')!).toMatchObject({ displayName: 'Robin', followPhoneZone: true })
  })
})

// Google sync cuts its day windows and archive keys at the person's home midnight, and a change
// there can leave backfill gaps, so the phone's zone must never reach it. A source guard rather
// than a run, because the question is which field the call sites read, and a run with every
// zone equal could not tell.
describe('Google sync, derivation and rebuilds stay on the home zone', () => {
  const root = join(import.meta.dirname, '..', '..', '..')
  const read = (path: string) => readFileSync(join(root, path), 'utf8')

  it('every timezone handed to runJob, runRollupJob and runBackfill is person.timezone', () => {
    const sites: [string, number][] = [
      ['packages/core/src/sync/runSync.ts', 2],
      ['apps/server/src/sync/runner.ts', 1],
    ]
    for (const [path, expected] of sites) {
      const values = [...read(path).matchAll(/\btimezone: ([^,\n}]+)/g)].map((m) => m[1]!.trim())
      expect(values, path).toEqual(Array.from({ length: expected }, () => 'person.timezone'))
    }
  })

  it('nothing under sync, derive or rebuild reads the phone zone', () => {
    const walk = (dir: string): string[] => readdirSync(join(root, dir)).flatMap((name) => {
      const path = `${dir}/${name}`
      return statSync(join(root, path)).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : []
    })
    const files = ['packages/core/src/sync', 'packages/core/src/derive', 'packages/core/src/rebuild',
      'apps/server/src/sync', 'apps/server/src/derive'].flatMap(walk)
    expect(files.length).toBeGreaterThan(10)
    const offenders = files.filter((path) => /effectiveTimezone|currentTimezone|current_timezone/.test(read(path)))
    expect(offenders).toEqual([])
  })
})
