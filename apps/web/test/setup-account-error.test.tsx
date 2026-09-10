// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { AccountStep } from '../src/setup/AccountStep.js'
import { I18nProvider } from '../src/i18n/index.js'
import { pumpUntil } from './flush.js'

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
  vi.unstubAllGlobals()
})

function click(el: Element): void {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

describe('the account step, submitted against a rejecting server', () => {
  // Shaped exactly as apps/server/src/routes/setup.ts answers this route -- the envelope every
  // route now speaks (errorBody('setup_incomplete', 'account_exists', 'an account already
  // exists')). The point is the words on screen, not the rejection itself: a wizard that only
  // proves a promise rejected still passes with a blank line where this message belongs, which is
  // exactly the failure a household hits mid setup with no way to tell what went wrong.
  it('shows the server\'s own message, not merely that the request failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { kind: 'setup_incomplete', code: 'account_exists', message: 'an account already exists' } }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )))

    act(() => {
      root!.render(<I18nProvider lng="en"><AccountStep onDone={() => {}} /></I18nProvider>)
    })
    click(container!.querySelector('button[type="submit"]')!)

    await pumpUntil(
      () => container!.querySelector('[role="alert"]') !== null,
      'the account step to show the rejection',
    )

    expect(container!.querySelector('[role="alert"]')?.textContent).toBe('an account already exists')
  })
})
