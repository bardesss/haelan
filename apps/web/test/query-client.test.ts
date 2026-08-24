import { describe, it, expect, vi } from 'vitest'
import { createQueryClient, createBoundQueryClient } from '../src/api/queryClient.js'
import { ApiError } from '../src/api/client.js'
import { queryKeys } from '../src/api/queryKeys.js'

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
  it('wires its own onUnauthorized callback to remove the session entry from itself', async () => {
    const client = createBoundQueryClient()
    client.setQueryData(queryKeys.session(), { personId: 'p1' })

    await client.fetchQuery({
      queryKey: ['person', 'p1', 'series'],
      queryFn: () => Promise.reject(new ApiError('unauthorized', 401, 'no session')),
    }).catch(() => undefined)

    expect(client.getQueryData(queryKeys.session())).toBeUndefined()
  })
})
