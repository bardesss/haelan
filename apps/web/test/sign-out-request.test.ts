import { describe, it, expect, vi, afterEach } from 'vitest'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { submitSignOut, signOutAndResetSession } from '../src/auth/signOutRequest.js'
import { queryKeys } from '../src/api/queryKeys.js'
import { ApiError } from '../src/api/client.js'

afterEach(() => { vi.unstubAllGlobals() })

describe('submitSignOut', () => {
  it('posts to the logout route the server has carried since M1d', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await submitSignOut()

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }))
  })

  it('throws rather than resolving when the instance cannot be reached, so the caller does not clear a session that is still valid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))

    await expect(submitSignOut()).rejects.toThrow()
  })
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('signOutAndResetSession', () => {
  // The regression this guards: queryClient.clear() routes to query.destroy(), which dispatches
  // no action and notifies no observer. The exact QueryObserver useSession mounts inside Shell
  // would have kept reporting the old signed-in session forever, and the dashboard would have
  // sat there with the reader's name in the rail while the server session was already gone.
  // resetQueries() reaches that same observer: this subscribes one exactly the way useSession
  // does, on the same query key, and checks what it actually sees afterwards, not just which
  // method got called.
  it('notifies the observer useSession relies on and drops the cached session, unlike clear()', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    const client = new QueryClient()
    client.setQueryData(queryKeys.session(), { personId: 'p1', displayName: 'Wilma', username: 'wilma', isAdmin: false })

    const queryFn = vi.fn(() => Promise.reject(new ApiError('unauthorized', 401, 'no session')))
    const observer = new QueryObserver(client, { queryKey: queryKeys.session(), queryFn, retry: false })
    let notifications = 0
    const unsubscribe = observer.subscribe(() => { notifications += 1 })

    expect(observer.getCurrentResult().data).toEqual(expect.objectContaining({ displayName: 'Wilma' }))

    const result = await signOutAndResetSession(client)
    await settle()
    unsubscribe()

    expect(result).toEqual({ ok: true })
    expect(notifications).toBeGreaterThan(0)
    expect(observer.getCurrentResult().data).toBeUndefined()
    expect(queryFn).toHaveBeenCalled()
  })

  it('leaves the session alone and reports failure when the sign-out request itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const client = new QueryClient()
    const session = { personId: 'p1', displayName: 'Wilma', username: 'wilma', isAdmin: false }
    client.setQueryData(queryKeys.session(), session)

    const result = await signOutAndResetSession(client)

    expect(result).toEqual({ ok: false })
    expect(client.getQueryData(queryKeys.session())).toEqual(session)
  })
})
