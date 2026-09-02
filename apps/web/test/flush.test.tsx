// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act, useEffect, useState } from 'react'
import { QueryClient } from '@tanstack/react-query'
import vitestConfig from '../../../vitest.config.js'
import { flush, pumpUntil, HANG_BUDGET_MS } from './flush.js'

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  root = null
  container = null
})

function LateGreeting() {
  const [text, setText] = useState('waiting')
  useEffect(() => {
    const timer = setTimeout(() => { setText('arrived') }, 20)
    return () => { clearTimeout(timer) }
  }, [])
  return <span>{text}</span>
}

describe('the flush helpers', () => {
  // The point of each helper's own error is that it names what was missing. A condition that
  // never holds used to blow past the runner's testTimeout before either helper reached its own
  // throw, so the failure arrived as vitest's generic "Test timed out in 20000ms" with nothing
  // in it about what the test had been waiting for. These two assert the message; the budget
  // they pass keeps them cheap, since the mechanism is the same at 200ms as at ten seconds.
  it('pumpUntil() reports what it was waiting for when the condition never holds', async () => {
    await expect(pumpUntil(() => false, 'a condition that never holds', 200)).rejects.toThrow(
      'pumpUntil() timed out waiting for a condition that never holds',
    )
  })

  it('flush() reports a page that never started', async () => {
    const queryClient = new QueryClient()
    await expect(flush(queryClient, () => '<span>static</span>', 200)).rejects.toThrow(
      'flush() timed out',
    )
  })

  // Timing out has to be survivable for the rest of the file. When the runner killed a test
  // mid-`await act(...)` instead, React was left mid-act, and the next test in the same file
  // got "overlapping act() calls" and "not configured to support act(...)" - one red test
  // became every test after it. Throwing between pumps rather than being killed inside one is
  // what makes that impossible, so this asserts a render after a timeout still works.
  it('leaves act() usable for whatever runs after a timeout', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(pumpUntil(() => false, 'a condition that never holds', 200)).rejects.toThrow()

      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
      act(() => { root!.render(<LateGreeting />) })
      await pumpUntil(() => container!.textContent === 'arrived', 'the late greeting')

      expect(container.textContent).toBe('arrived')
      // "overlapping act() calls" specifically, not any mention of act: React also logs "not
      // configured to support act(...)" on every update inside act() here, because nothing in
      // this repo sets IS_REACT_ACT_ENVIRONMENT. That one is unrelated background noise - it
      // was measured identical (three of them, from the render, the setState and the unmount)
      // whether or not a timeout ran first - and only becomes visible at all when a file fails
      // and vitest prints its stderr, which is how it came to look like part of this bug.
      expect(errors.mock.calls.flat().join(' ')).not.toContain('overlapping act')
    } finally {
      errors.mockRestore()
    }
  })

  // The budget is only a hang detector if the runner does not kill the test first, and the
  // runner's own budget is the number it has to stay under. Two of ours inside one of the
  // runner's is the margin vitest.config.ts argues for everywhere else in this suite.
  it('leaves the runner room to report the helpers own error', () => {
    const testTimeout = vitestConfig.test?.testTimeout
    expect(testTimeout).toBeTypeOf('number')
    expect(HANG_BUDGET_MS * 2).toBeLessThanOrEqual(testTimeout as number)
  })
})
