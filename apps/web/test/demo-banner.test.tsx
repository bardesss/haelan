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

describe('the banner in the visitor\'s own language', () => {
  // navigator.language is read-only by default; a data descriptor lets each test set it. happy-dom
  // defines `language` as a getter on Navigator.prototype rather than as an own property of
  // window.navigator, so Object.getOwnPropertyDescriptor(window.navigator, 'language') reads
  // undefined - there was never an own-property descriptor here for an `if (originalLanguage)`
  // restore to run, which is why that guard never fired and left the stubbed value behind for
  // every test file sharing this worker. setLanguage below shadows the prototype getter with an
  // own data property, so deleting that own property in the teardown is what uncovers the
  // prototype getter again, rather than restoring a descriptor that was never actually captured.
  function setLanguage(tag: string): void {
    Object.defineProperty(window.navigator, 'language', { value: tag, configurable: true })
  }

  afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>)['language']
  })

  it('renders Dutch for a Dutch browser, including the fidelity-limit sentence', () => {
    setLanguage('nl-NL')
    act(() => { root?.render(<DemoBanner />) })
    const text = container?.textContent ?? ''
    expect(text).toMatch(/gegenereerd/i)   // not anyone's real health history
    expect(text).toMatch(/herladen/i)      // writes live in this tab only
    expect(text).toMatch(/afgeleid/i)      // the fidelity limit, in Dutch
    expect(text).not.toMatch(/generated/i) // the English string must not also be present
  })

  it('falls back to English for any browser language that is not Dutch', () => {
    setLanguage('fr-FR')
    act(() => { root?.render(<DemoBanner />) })
    const text = container?.textContent ?? ''
    expect(text).toMatch(/generated/i)
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
