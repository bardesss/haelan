// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { ApiError } from '../src/api/apiError.js'
import { DemoBanner, mountDemoBanner } from '../src/demo/DemoBanner.js'
import { createDemoTransport } from '../src/demo/client.js'

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  document.querySelectorAll('[data-demo-banner]').forEach((host) => host.remove())
})

describe('the banner', () => {
  it('states all three things a visitor needs to know', () => {
    act(() => { root?.render(<DemoBanner />) })
    const text = container?.textContent ?? ''
    expect(text).toMatch(/generated/i)          // not anyone's real health history
    expect(text).toMatch(/reload/i)             // writes live in this tab only
    expect(text).toMatch(/derived|cascade/i)    // the fidelity limit, said out loud
  })

  it('mounts exactly one host even if the entry runs twice', () => {
    mountDemoBanner()
    mountDemoBanner()
    expect(document.querySelectorAll('[data-demo-banner]')).toHaveLength(1)
  })
})

describe('the actions a static demo cannot honour', () => {
  const transport = () => createDemoTransport(async () => ({ '/api/auth/me': 'me.json' }))

  it('refuses a sync run with an error the UI already renders', async () => {
    const error = await transport().apiSend('POST', '/api/sync/run')
      .then(() => null, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).kind).toBe('config')
    expect((error as ApiError).message).toMatch(/demo/i)
  })

  it('refuses sign-out and the maintenance actions the same way', async () => {
    for (const path of ['/api/auth/logout', '/api/settings/maintenance/backup', '/api/settings/maintenance/reclaim']) {
      const error = await transport().apiSend('POST', path).then(() => null, (thrown: unknown) => thrown)
      expect(error, path).toBeInstanceOf(ApiError)
    }
  })

  it('does not swallow the writes that do work', async () => {
    // The refusal must not become a blanket "no non-GET": Task 6's overlay writes go through it.
    const written = await transport().apiSend('PUT', '/api/v1/p/demo/notes/2026-09-02', { body: 'fine' })
    expect(written).toHaveProperty('id')
  })
})
