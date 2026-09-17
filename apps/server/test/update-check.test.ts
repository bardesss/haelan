import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'
import { checkForUpdate, resetUpdateCacheForTest, CACHE_TTL_MS, LATEST_RELEASE_URL } from '../src/updates.ts'

/**
 * The update check: what it sends, what it caches, and what it does when it cannot ask.
 *
 * The cache is module state, so every case starts by clearing it. That is not test plumbing
 * hiding a design problem - the cache is meant to outlive a request and die with the process, and
 * a fixture that had to construct one would be testing a different shape from the one that ships.
 */
let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })
beforeEach(() => { resetUpdateCacheForTest() })

const headers = { origin: 'http://localhost:4235', host: 'localhost:4235' }
const NOW = 1_770_000_000_000

/** A fetch that answers one release tag and counts how many times it was asked. */
function releasing(tag: string): typeof fetch & { calls: () => number } {
  let calls = 0
  const impl = (async () => {
    calls += 1
    return new Response(JSON.stringify({ tag_name: tag }), { status: 200 })
  }) as unknown as typeof fetch & { calls: () => number }
  impl.calls = () => calls
  return impl
}

async function sessionCookie(h: Harness, username = 'robin'): Promise<string> {
  const response = await h.app.inject({
    method: 'POST', url: '/api/auth/login', headers,
    payload: { username, password: 'a good long password' },
  })
  return response.cookies.find((c) => c.name === 'haelan_session')!.value
}

describe('asking GitHub for the newest release', () => {
  it('sends a plain request for one public tag, with no credential and nothing about this instance', async () => {
    const seen: { url: unknown, init: RequestInit | undefined }[] = []
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url, init })
      return new Response(JSON.stringify({ tag_name: 'v1.34.0' }), { status: 200 })
    }) as unknown as typeof fetch

    await checkForUpdate(NOW, fetchImpl)

    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe(LATEST_RELEASE_URL)
    // The whole header set, asserted as a whole rather than by picking at it: the claim this
    // feature makes to a household is that nothing else goes with the request, and a test that
    // checked one header at a time could not see a second one being added later.
    expect(seen[0]!.init?.headers).toEqual({ accept: 'application/vnd.github+json', 'user-agent': 'haelan' })
    expect(seen[0]!.init).not.toHaveProperty('body')
    expect(JSON.stringify(seen[0]!.init)).not.toContain('localhost:4235')
  })

  it('reports the tag without the v GitHub publishes it with', async () => {
    expect(await checkForUpdate(NOW, releasing('v1.34.0'))).toMatchObject({ latest: '1.34.0', reachable: true })
  })

  it('takes a tag that has no v as it is', async () => {
    expect(await checkForUpdate(NOW, releasing('1.34.0'))).toMatchObject({ latest: '1.34.0' })
  })

  it('asks once for six hours, however many readers open the page', async () => {
    const fetchImpl = releasing('v1.34.0')
    await checkForUpdate(NOW, fetchImpl)
    await checkForUpdate(NOW + 1000, fetchImpl)
    await checkForUpdate(NOW + CACHE_TTL_MS - 1, fetchImpl)
    expect(fetchImpl.calls()).toBe(1)
    await checkForUpdate(NOW + CACHE_TTL_MS, fetchImpl)
    expect(fetchImpl.calls()).toBe(2)
  })

  it('makes one request for readers arriving at the same moment, not one each', async () => {
    const fetchImpl = releasing('v1.34.0')
    const answers = await Promise.all([
      checkForUpdate(NOW, fetchImpl), checkForUpdate(NOW, fetchImpl), checkForUpdate(NOW, fetchImpl),
    ])
    expect(fetchImpl.calls()).toBe(1)
    expect(answers.map((a) => a.latest)).toEqual(['1.34.0', '1.34.0', '1.34.0'])
  })

  describe('an instance that cannot reach GitHub', () => {
    const refusing = (async () => { throw new Error('ENOTFOUND api.github.com') }) as unknown as typeof fetch

    it('says so rather than throwing, so the page never shows an error it cannot act on', async () => {
      expect(await checkForUpdate(NOW, refusing)).toEqual({ latest: null, checkedAtMs: null, reachable: false })
    })

    it('says so for a refusal that is an answer, too', async () => {
      const rateLimited = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch
      expect(await checkForUpdate(NOW, rateLimited)).toMatchObject({ reachable: false })
    })

    it('treats a 200 with no tag in it as not having asked, rather than as an answer', async () => {
      const empty = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
      expect(await checkForUpdate(NOW, empty)).toMatchObject({ latest: null, reachable: false })
    })

    // The slow version of "an error card for ever": without a backoff every page view pays the
    // request timeout again, on an instance whose whole problem is that it has no way out.
    it('waits before trying again rather than retrying on every page view', async () => {
      let calls = 0
      const counting = (async () => { calls += 1; throw new Error('ENOTFOUND') }) as unknown as typeof fetch
      await checkForUpdate(NOW, counting)
      await checkForUpdate(NOW + 60_000, counting)
      await checkForUpdate(NOW + 5 * 60_000, counting)
      expect(calls).toBe(1)
      await checkForUpdate(NOW + 16 * 60_000, counting)
      expect(calls).toBe(2)
    })

    // Keeps what it knew. A household that saw "1.34.0 is out" before the network went does not
    // get told the answer is unknown, only that this could not be checked again.
    it('keeps the last answer it did get', async () => {
      await checkForUpdate(NOW, releasing('v1.34.0'))
      const after = await checkForUpdate(NOW + CACHE_TTL_MS, refusing)
      expect(after).toMatchObject({ latest: '1.34.0', reachable: false })
    })
  })
})

describe('the update routes', () => {
  it('answers off, and asks nobody, until an admin turns it on', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const cookie = await sessionCookie(harness)

    const response = await harness.app.inject({
      method: 'GET', url: '/api/settings/update', headers, cookies: { haelan_session: cookie },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ enabled: false, latest: null, checkedAtMs: null, reachable: true })
    // The point of the default, asserted rather than assumed: an instance nobody has asked does
    // not contact anybody.
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('api.github.com'))).toEqual([])
    fetchSpy.mockRestore()
  })

  it('checks once it is switched on, and answers with what it found', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const cookie = await sessionCookie(harness)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: unknown) => {
      if (String(url) === LATEST_RELEASE_URL) return new Response(JSON.stringify({ tag_name: 'v9.9.9' }), { status: 200 })
      throw new Error(`unexpected request to ${String(url)}`)
    }) as unknown as typeof fetch)

    const put = await harness.app.inject({
      method: 'PUT', url: '/api/settings/update', headers, cookies: { haelan_session: cookie },
      payload: { enabled: true },
    })

    expect(put.statusCode).toBe(200)
    expect(put.json()).toMatchObject({ enabled: true, latest: '9.9.9', reachable: true })
    // Stored, not merely answered: the next reader gets the same state without switching anything.
    const get = await harness.app.inject({
      method: 'GET', url: '/api/settings/update', headers, cookies: { haelan_session: cookie },
    })
    expect(get.json()).toMatchObject({ enabled: true, latest: '9.9.9' })
    fetchSpy.mockRestore()
  })

  it('goes quiet again when it is switched off, cached answer and all', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const cookie = await sessionCookie(harness)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async () =>
      new Response(JSON.stringify({ tag_name: 'v9.9.9' }), { status: 200 })) as unknown as typeof fetch)
    await harness.app.inject({
      method: 'PUT', url: '/api/settings/update', headers, cookies: { haelan_session: cookie },
      payload: { enabled: true },
    })

    const off = await harness.app.inject({
      method: 'PUT', url: '/api/settings/update', headers, cookies: { haelan_session: cookie },
      payload: { enabled: false },
    })

    expect(off.json()).toEqual({ enabled: false, latest: null, checkedAtMs: null, reachable: true })
    fetchSpy.mockRestore()
  })

  it('refuses anything that is not a boolean', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const cookie = await sessionCookie(harness)
    const response = await harness.app.inject({
      method: 'PUT', url: '/api/settings/update', headers, cookies: { haelan_session: cookie },
      payload: { enabled: 'yes' },
    })
    expect(response.statusCode).toBe(400)
  })

  // Reading is a member's, deciding is not: whether this instance talks to a third party at all is
  // a household decision, and the route says so rather than leaving it to the screen.
  it('lets a member read the answer but not change the setting', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    await harness.addPerson({ id: 'p-outsider', displayName: 'Outsider', username: 'outsider' })
    const cookie = await sessionCookie(harness, 'outsider')

    const read = await harness.app.inject({
      method: 'GET', url: '/api/settings/update', headers, cookies: { haelan_session: cookie },
    })
    const write = await harness.app.inject({
      method: 'PUT', url: '/api/settings/update', headers, cookies: { haelan_session: cookie },
      payload: { enabled: true },
    })

    expect(read.statusCode).toBe(200)
    expect(write.statusCode).toBe(403)
    expect(write.json()).toEqual({ error: { kind: 'forbidden', code: 'not_admin', message: 'this needs an admin' } })
  })

  it('refuses an unauthenticated caller outright', async () => {
    harness = await withServer({ google: 'ok' })
    await harness.connectPerson()
    const response = await harness.app.inject({ method: 'GET', url: '/api/settings/update', headers })
    expect(response.statusCode).toBe(401)
  })
})
