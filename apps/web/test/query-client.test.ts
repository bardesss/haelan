import { describe, it, expect, vi } from 'vitest'
import { createQueryClient } from '../src/api/queryClient.js'
import { ApiError } from '../src/api/client.js'

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
})
