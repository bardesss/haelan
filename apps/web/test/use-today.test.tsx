// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import { useToday, msUntilLocalMidnight } from '../src/controls/useToday.js'

let container: HTMLDivElement | null = null
let root: Root | null = null
let seen = ''

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  container = null
  root = null
  vi.useRealTimers()
})

function Probe({ zone }: { zone: string | undefined }) {
  seen = useToday(zone)
  return null
}

function mountProbe(zone: string | undefined): void {
  act(() => { root?.render(<Probe zone={zone} />) })
}

describe('useToday', () => {
  it('rolls over at midnight in UTC', () => {
    vi.setSystemTime(new Date('2026-03-10T23:59:30Z'))
    mountProbe('UTC')
    expect(seen).toBe('2026-03-10')
    act(() => { vi.advanceTimersByTime(31_000) })
    expect(seen).toBe('2026-03-11')
  })

  it('rolls over at the person\'s midnight, not UTC\'s', () => {
    vi.setSystemTime(new Date('2026-03-10T22:59:30Z')) // 23:59:30 in Amsterdam (UTC+1)
    mountProbe('Europe/Amsterdam')
    expect(seen).toBe('2026-03-10')
    act(() => { vi.advanceTimersByTime(31_000) })
    expect(seen).toBe('2026-03-11')
  })

  it('recomputes at once when the timezone changes', () => {
    vi.setSystemTime(new Date('2026-03-10T23:30:00Z'))
    mountProbe('UTC')
    expect(seen).toBe('2026-03-10')
    mountProbe('Europe/Amsterdam')
    expect(seen).toBe('2026-03-11')
  })

  it('counts to the zone midnight', () => {
    expect(msUntilLocalMidnight('UTC', new Date('2026-03-10T23:59:30Z'))).toBe(30_000)
  })
})
