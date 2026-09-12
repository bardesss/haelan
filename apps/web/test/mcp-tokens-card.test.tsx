// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/i18n/index.js'
import { McpTokens } from '../src/pages/settings/McpTokens.js'
import { mcpCallsKey, mcpTokensKey } from '../src/data/useMcpTokens.js'
import type { McpCallRow, McpTokenRow } from '../src/data/useMcpTokens.js'

let container: HTMLDivElement | null = null
let root: Root | null = null
const realFetch = globalThis.fetch

const NOW = 1_770_000_000_000

beforeEach(() => {
  // TOKEN.expiresAtMs is 90 days out from NOW, and McpTokens.tsx computes naturallyExpired off
  // real Date.now(). Left unmocked, every row this suite mounts is expired the moment NOW falls
  // behind the actual clock - which it has, silently, since the day this suite was written - and
  // the live-token branch (the Revoke button, useRevokeMcpToken) goes untested with every
  // assertion about it still green.
  vi.setSystemTime(NOW)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  globalThis.fetch = realFetch
  vi.useRealTimers()
})

const TOKEN: McpTokenRow = {
  id: 't1', label: 'the laptop', createdAtMs: NOW, expiresAtMs: NOW + 90 * 86_400_000,
  lastUsedAtMs: null, revokedAtMs: null,
}

/**
 * Both queries seeded, so nothing this component renders depends on a request. The mint path is
 * the one place a test drives fetch, and it stubs it per case.
 */
function mount(tokens: McpTokenRow[], calls: McpCallRow[] = []): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(mcpTokensKey(), { tokens })
  client.setQueryData(mcpCallsKey(), { calls })
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <I18nProvider lng="en"><McpTokens /></I18nProvider>
      </QueryClientProvider>,
    )
  })
}

const text = (): string => container!.textContent ?? ''
const buttonSaying = (label: string): HTMLButtonElement | undefined =>
  [...container!.querySelectorAll('button')].find((b) => b.textContent?.includes(label))

// Same device control-row.test.tsx's and annotate-panel.test.tsx's own copies of this helper use:
// assigning .value directly goes through React's own tracked setter and leaves onChange never
// firing, pass or fail, no matter what the handler does. The native prototype setter bypasses
// that tracking the way a real keystroke would.
function type(input: HTMLInputElement, value: string): void {
  const nativeValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  nativeValueSetter.call(input, value)
  act(() => { input.dispatchEvent(new Event('input', { bubbles: true })) })
}

describe('the Agent access card', () => {
  it('says the surface is invisible until a token exists', () => {
    mount([])
    expect(text()).toContain('answers as though it were not there at all')
  })

  it('offers exactly the three lives the server accepts, defaulting to ninety days', () => {
    mount([])
    const select = container!.querySelector('select')!
    expect([...select.options].map((o) => o.value)).toEqual(['30', '90', '365'])
    expect(select.value).toBe('90')
  })

  it('shows the secret once, and it is gone for good once dismissed', async () => {
    const secret = 'hmcp_a-secret-that-must-appear-exactly-once'
    // Minting invalidates mcpTokensKey, which refetches the token list from this same stub while
    // the panel is still mounted: a mock that answered every method identically would hand that
    // refetch the mint response's shape instead, which is exactly the kind of harness bug this
    // component cannot be blamed for.
    globalThis.fetch = vi.fn(async (_input, init) => {
      if (init?.method === 'POST') {
        return new Response(
          JSON.stringify({ token: TOKEN, secret }), { status: 201, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({ tokens: [TOKEN] }), { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    mount([])
    const input = container!.querySelector('input')!
    await act(async () => { type(input, 'the laptop') })
    await act(async () => {
      container!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(text()).toContain(secret)

    await act(async () => { buttonSaying('I have copied it')!.click() })
    // Gone from the DOM, and gone from anywhere it could come back from: the mutation result is
    // held in component state and the query cache was never written with it.
    expect(text()).not.toContain(secret)
    expect(JSON.stringify(container!.innerHTML)).not.toContain(secret)
  })

  it('shows a revoked token as revoked, with no revoke button', () => {
    mount([{ ...TOKEN, revokedAtMs: NOW + 1000 }])
    expect(text()).toContain('Revoked')
    expect(buttonSaying('Revoke')).toBeUndefined()
  })

  it('shows a live token as live, with a working revoke button', async () => {
    let request: { method: string | undefined, url: string } | null = null
    // Revoking invalidates mcpTokensKey, which refetches the token list from this same stub
    // while the panel is still mounted - the mint test above hits the identical hazard and the
    // same fix applies: a mock answering every method with the DELETE's own 204 would hand that
    // refetch an empty body, and McpTokens.tsx would crash reading rows off it.
    globalThis.fetch = vi.fn(async (input, init) => {
      if (init?.method === 'DELETE') {
        request = { method: init.method, url: String(input) }
        return new Response(null, { status: 204 })
      }
      return new Response(
        JSON.stringify({ tokens: [TOKEN] }), { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof globalThis.fetch

    mount([TOKEN])
    expect(text()).toContain('Expires')
    expect(text()).not.toContain('Expired')
    const revokeButton = buttonSaying('Revoke')
    expect(revokeButton).toBeDefined()

    await act(async () => { revokeButton!.click() })

    expect(request).not.toBeNull()
    expect(request!.method).toBe('DELETE')
    expect(request!.url).toContain('/api/profile/mcp-tokens/t1')
  })

  it('always says the arguments are not recorded, even with no calls', () => {
    mount([TOKEN], [])
    expect(text()).toContain('The arguments are not recorded')
    expect(text()).toContain('No calls yet')
  })

  it('reports the server own sentence when minting fails', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: { kind: 'config', code: 'config', message: 'a token lasts 30, 90, 365 days, not 7' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof globalThis.fetch

    mount([])
    const input = container!.querySelector('input')!
    await act(async () => { type(input, 'x') })
    await act(async () => {
      container!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    // The instance's own sentence, naming the three lives - not "that did not work".
    expect(text()).toContain('30, 90, 365')
  })
})
