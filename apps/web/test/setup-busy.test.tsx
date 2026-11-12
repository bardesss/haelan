// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import type { ReactNode } from 'react'
import { AccountStep } from '../src/setup/AccountStep.js'
import { InstanceUrlStep } from '../src/setup/InstanceUrlStep.js'
import { GoogleStep } from '../src/setup/GoogleStep.js'
import { I18nProvider } from '../src/i18n/index.js'
import { pumpUntil } from './flush.js'

let container: HTMLDivElement | null = null
let root: Root | null = null
const fetchMock = vi.fn()

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => new Response('{}', {
    status: 200, headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  vi.unstubAllGlobals()
})

function render(node: ReactNode): void {
  act(() => { root!.render(<I18nProvider lng="en">{node}</I18nProvider>) })
}

const submit = (): HTMLButtonElement => container!.querySelector('button[type="submit"]') as HTMLButtonElement

function click(el: Element): void {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

// A save that succeeds while onDone leaves the wizard where it is (the server still names this
// step due, or the navigation is a no-op) used to leave the button disabled for good.
describe('setup steps never stay busy', () => {
  it('the account step is clickable again after a save that did not move the wizard', async () => {
    render(<AccountStep onDone={() => {}} />)
    click(submit())
    await pumpUntil(() => fetchMock.mock.calls.length > 0, 'the save to be sent')
    await pumpUntil(() => !submit().disabled, 'the button to come back', 500)
    expect(submit().textContent).toBe('Create account')
  })

  it('the instance address step is clickable again after a save that did not move the wizard', async () => {
    render(<InstanceUrlStep onDone={() => {}} />)
    click(submit())
    await pumpUntil(() => fetchMock.mock.calls.length > 0, 'the save to be sent')
    await pumpUntil(() => !submit().disabled, 'the button to come back', 500)
    expect(submit().textContent).toBe('Continue')
  })

  it('the Google step is clickable again after a client save that did not move the wizard', async () => {
    render(<GoogleStep candidates={[]} scopes={[]} error={null} onDone={() => {}} onCompanion={() => {}} />)
    click(submit())
    await pumpUntil(() => fetchMock.mock.calls.length > 0, 'the save to be sent')
    await pumpUntil(() => !submit().disabled, 'the button to come back', 500)
    expect(submit().textContent).toBe('Save and grant consent')
  })

  it('the companion button is clickable again after a save that did not move the wizard', async () => {
    render(<GoogleStep candidates={[]} scopes={[]} error={null} onDone={() => {}} onCompanion={() => {}} />)
    const companion = (): HTMLButtonElement =>
      [...container!.querySelectorAll('button')].find((b) => b.type === 'button' && b.className === 'button') as HTMLButtonElement
    click(companion())
    await pumpUntil(() => fetchMock.mock.calls.length > 0, 'the save to be sent')
    await pumpUntil(() => !companion().disabled, 'the button to come back', 500)
    expect(companion().textContent).toBe('Continue without Google')
  })
})
