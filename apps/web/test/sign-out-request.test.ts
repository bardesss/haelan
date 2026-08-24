import { describe, it, expect, vi, afterEach } from 'vitest'
import { submitSignOut } from '../src/auth/signOutRequest.js'

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
