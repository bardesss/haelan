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

  it('keeps rescheduling past the one-hour cap and still rolls over', () => {
    vi.setSystemTime(new Date('2026-03-10T12:00:00Z'))
    mountProbe('UTC')
    expect(seen).toBe('2026-03-10')
    for (let hour = 0; hour < 11; hour += 1) act(() => { vi.advanceTimersByTime(3_600_000) })
    expect(seen).toBe('2026-03-10')
    act(() => { vi.advanceTimersByTime(3_600_000) })
    expect(seen).toBe('2026-03-11')
  })

  it('rolls over at Amsterdam midnight on the 23 hour spring-forward day', () => {
    vi.setSystemTime(new Date('2026-03-29T00:30:00Z')) // 01:30 CET, before the 02:00 jump
    mountProbe('Europe/Amsterdam')
    expect(seen).toBe('2026-03-29')
    // 21:59:30Z is 23:59:30 CEST on the 29th.
    act(() => { vi.advanceTimersByTime(21 * 3_600_000 + 29 * 60_000) }) // to 21:59:00Z
    expect(seen).toBe('2026-03-29')
    act(() => { vi.advanceTimersByTime(2 * 60_000) }) // 22:01:00Z = 00:01 CEST
    expect(seen).toBe('2026-03-30')
  })

  it('clears its pending timer on unmount', () => {
    vi.setSystemTime(new Date('2026-03-10T12:00:00Z'))
    mountProbe('UTC')
    expect(vi.getTimerCount()).toBe(1)
    act(() => { root?.unmount() })
    expect(vi.getTimerCount()).toBe(0)
    root = createRoot(container!)
  })

  it('counts to the zone midnight', () => {
    expect(msUntilLocalMidnight('UTC', new Date('2026-03-10T23:59:30Z'))).toBe(30_000)
  })
})
