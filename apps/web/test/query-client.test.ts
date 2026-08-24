import { describe, it, expect, vi } from 'vitest'
import { QueryObserver } from '@tanstack/react-query'
import { createQueryClient, createBoundQueryClient } from '../src/api/queryClient.js'
import { ApiError } from '../src/api/client.js'
import { queryKeys } from '../src/api/queryKeys.js'

// Gives an in-flight loop time to run its extra fetches before we count them. Long enough that a
// real loop (each iteration is a microtask, not a timer) fires several times over; short enough
// that a passing suite does not notice it.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe('the query client', () => {
  it('calls back on any unauthorized answer, not only the session query', async () => {
    const onUnauthorized = vi.fn()
    const client = createQueryClient(onUnauthorized)

    await client.fetchQuery({
      queryKey: ['person', 'p1', 'series'],
      queryFn: () => Promise.reject(new ApiError('unauthorized', 401, 'no session')),
    }).catch(() => undefined)

    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('leaves an unreachable instance alone, because signing the reader out would lose their place', async () => {
    const onUnauthorized = vi.fn()
    const client = createQueryClient(onUnauthorized)

    await client.fetchQuery({
      queryKey: ['person', 'p1', 'series'],
      queryFn: () => Promise.reject(new ApiError('unreachable', null, 'no answer')),
      retry: false,
    }).catch(() => undefined)

    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('does not retry an error that is not an ApiError, since that would be a bug in our own code', async () => {
    const onUnauthorized = vi.fn()
    const client = createQueryClient(onUnauthorized)
    const queryFn = vi.fn(() => Promise.reject(new TypeError('boom')))

    await client.fetchQuery({
      queryKey: ['person', 'p1', 'series'],
      queryFn,
    }).catch(() => undefined)

    expect(queryFn).toHaveBeenCalledOnce()
  })
})

describe('createBoundQueryClient', () => {
  it('invalidates rather than removes the session entry when a different query is unauthorized', async () => {
    // Removing deletes a query something is still observing (useSession never unmounts while the
    // reader is signed out): the observer would rebuild it, see data === undefined, and refetch
    // immediately. Invalidating leaves it alive to settle into its own error state instead.
    const client = createBoundQueryClient()
    client.setQueryData(queryKeys.session(), { personId: 'p1' })

    await client.fetchQuery({
      queryKey: ['person', 'p1', 'series'],
      queryFn: () => Promise.reject(new ApiError('unauthorized', 401, 'no session')),
    }).catch(() => undefined)

    expect(client.getQueryData(queryKeys.session())).toEqual({ personId: 'p1' })
    expect(client.getQueryState(queryKeys.session())?.isInvalidated).toBe(true)
  })

  it('settles the session query after exactly one fetch, even once its observer renders again', async () => {
    // The regression this guards: onError used to remove the session query unconditionally,
    // including when the session query was the one that failed, while useSession's observer
    // stayed mounted. A React hook calls setOptions on every render; against a removed query that
    // rebuilds an unfetched one and refetches it on the spot. Each fetch settled to another 401,
    // another removal, another render calling setOptions, and round it goes: isPending stayed
    // true throughout, so Shell's branch for SignIn was never reached. Confirmed against this
    // exact sequence with the old remove-based handler: the second setOptions call below produced
    // a second fetch (2 calls); with invalidate-and-skip-self it does not (1 call).
    const client = createBoundQueryClient()
    const queryFn = vi.fn(() => Promise.reject(new ApiError('unauthorized', 401, 'no session')))
    const options = { queryKey: queryKeys.session(), queryFn, retry: false }
    const observer = new QueryObserver(client, options)
    const unsubscribe = observer.subscribe(() => {})

    await settle()
    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(observer.getCurrentResult().isPending).toBe(false)

    // Simulates the next render: useBaseQuery calls setOptions on every one.
    observer.setOptions({ ...options })
    await settle()
    unsubscribe()

    expect(queryFn).toHaveBeenCalledTimes(1)
    expect(client.isFetching()).toBe(0)
  })

  it('does not loop when a different query invalidates the session query it shares a cache with', async () => {
    const client = createBoundQueryClient()
    const sessionQueryFn = vi.fn(() => Promise.reject(new ApiError('unauthorized', 401, 'no session')))
    const observer = new QueryObserver(client, { queryKey: queryKeys.session(), queryFn: sessionQueryFn, retry: false })
    const unsubscribe = observer.subscribe(() => {})
    await settle()
    expect(sessionQueryFn).toHaveBeenCalledTimes(1)

    await client.fetchQuery({
      queryKey: ['person', 'p1', 'series'],
      queryFn: () => Promise.reject(new ApiError('unauthorized', 401, 'no session')),
    }).catch(() => undefined)
    await settle()
    unsubscribe()

    // The foreign 401 invalidates the observed session query, which refetches once. That refetch
    // also 401s, but the handler skips invalidating the session query when the session query is
    // the one that failed, so it stops there rather than looping a second time.
    expect(sessionQueryFn).toHaveBeenCalledTimes(2)
    expect(client.isFetching()).toBe(0)
  })
})
