// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act, useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import vitestConfig from '../../../vitest.config.js'
import { flush, pumpUntil, HANG_BUDGET_MS, TOTAL_CEILING_MS } from './flush.js'

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

/**
 * The shape every page in this app has: one query gated on another's result.
 *
 * `useWorkoutSession` is `enabled: personId !== undefined && sessionId !== undefined`, and
 * `personId` arrives from `useSession`'s own `/api/auth/me` query. So the second request cannot
 * start until the first has resolved AND React has re-rendered with the result - and in the window
 * between those, nothing is in flight and the page still says exactly what it said before.
 *
 * The gate here is opened by a timer rather than directly by the first query's data, and that is
 * the one liberty this fixture takes: it makes the window wide enough to span two pumps every
 * time, instead of only on a machine where the scheduling happens to land that way. The window
 * itself is not invented - it is the same window, and 30ms is barely twice a pump.
 */
function GatedChain() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => Promise.resolve('p1') })
  const [gateOpen, setGateOpen] = useState(false)
  useEffect(() => {
    if (me.data === undefined) return undefined
    const timer = setTimeout(() => { setGateOpen(true) }, 30)
    return () => { clearTimeout(timer) }
  }, [me.data])
  const workout = useQuery({
    queryKey: ['workout'],
    enabled: gateOpen,
    queryFn: () => Promise.resolve('Morning run'),
  })
  return <span>{workout.data ?? 'Loading'}</span>
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

  // KNOWN GAP, pinned deliberately: flush() can call a page settled while it is still loading.
  //
  // Its settle condition is "something was in flight once, and now two samples in a row show
  // nothing in flight and identical HTML". A page sitting behind a gate that has not opened yet
  // satisfies every part of that: no request is running, and the fallback on screen is the same
  // fallback as last time. Two pumps inside such a window and the helper returns, with the caller
  // about to assert against a page that never loaded.
  //
  // This is asserted as it behaves rather than as it should, because the fix is not available at
  // this layer. Closing it means treating "a mounted query has never produced a result" as
  // unsettled, and this app is full of queries that are pending by design and never resolve - a
  // filter the reader has not set, a card the page does not show. Measured: that version times out
  // twenty-plus tests in this suite, turning a rare flake into a reliable hang.
  //
  // What this leaves is a real constraint on callers, and it is the reason pumpUntil() exists one
  // function below: a test whose page loads behind a gate should wait for the thing it is about to
  // assert, not for "settled". flush() is right for a page whose queries all start at mount.
  it('flush() returns early while a gate has not opened - the gap it cannot see', async () => {
    const queryClient = new QueryClient()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root!.render(
        <QueryClientProvider client={queryClient}><GatedChain /></QueryClientProvider>,
      )
    })

    await flush(queryClient, () => container!.innerHTML)
    expect(container.textContent, 'flush() returned before the gated query ran').toBe('Loading')

    // ...and the condition-based helper gets it right on the same tree, which is the remedy this
    // gap points a caller at rather than a hypothetical stricter flush().
    await pumpUntil(() => container!.textContent === 'Morning run', 'the gated query')
    expect(container.textContent).toBe('Morning run')
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
  // runner's own budget is the number it has to stay under.
  //
  // It is the CEILING that has to fit, not HANG_BUDGET_MS. Since the no-progress budget started
  // rolling, a slow but progressing page can legitimately spend everything up to the ceiling and
  // still pass, so the ceiling is what bounds a passing flush and therefore what this has to
  // measure. That is a real departure from the 2x margin vitest.config.ts argues for everywhere
  // else, taken deliberately: ten seconds was the number that left 2x and also the number timing
  // out settled pages on a busy machine, so keeping it would have been keeping the bug. What is
  // left has to be enough for the throw and the report it carries, and no less.
  it('leaves the runner room to report the helpers own error', () => {
    const testTimeout = vitestConfig.test?.testTimeout
    expect(testTimeout).toBeTypeOf('number')
    expect(HANG_BUDGET_MS).toBeLessThan(TOTAL_CEILING_MS)
    expect(TOTAL_CEILING_MS * 1.25).toBeLessThanOrEqual(testTimeout as number)
  })

  // The regression this whole change exists for. A click whose mutation and invalidated refetch
  // both resolve inside the click's own act() leaves a page that is already finished: nothing in
  // flight, nothing pending, and HTML that will never change again because it is already final.
  // Arming on a witnessed in-flight moment cannot see any of that, so flush() used to read a
  // settled page as one that never started and wait out its entire budget. Observed in a full
  // suite run as `633 pumps, in flight on 0, waiting on a mounted query on 0, changed on 0`, and
  // green in isolation, which is what a race on contention looks like.
  it('returns on a page that had already settled before it was called', async () => {
    const queryClient = new QueryClient()
    await queryClient.fetchQuery({ queryKey: ['done'], queryFn: () => Promise.resolve('landed') })
    await expect(flush(queryClient, () => '<span>landed</span>', 400)).resolves.toBeUndefined()
  })

  // A page still producing results is slow, not stuck, and the budget has to tell them apart or a
  // busy machine fails passing tests. The HTML changes on every tick so flush can never call this
  // settled, which leaves the budget as the only thing that can end it: a fixed one would end it
  // at 200ms, and the assertion is that what ends it is the ceiling instead.
  it('does not give up on a page that is still producing results', async () => {
    const queryClient = new QueryClient()
    let landed = 0
    const timer = setInterval(() => {
      landed += 1
      queryClient.setQueryData([`result-${landed}`], landed)
    }, 40)
    try {
      await expect(flush(queryClient, () => `<span>${landed}</span>`, 200, 900))
        .rejects.toThrow(/the 900ms ceiling/)
    } finally {
      clearInterval(timer)
    }
    expect(landed).toBeGreaterThan(4)
  })

  // The other half of that choice, and the reason progress is a query result rather than anything
  // cheaper to observe. A render loop redraws forever without any query settling; resetting the
  // budget on the HTML changing would have disarmed the detector for exactly this page.
  it('still gives up on a page that redraws forever without producing results', async () => {
    const queryClient = new QueryClient()
    await queryClient.fetchQuery({ queryKey: ['once'], queryFn: () => Promise.resolve('a') })
    let redraws = 0
    await expect(flush(queryClient, () => `<span>${redraws++}</span>`, 250, 9000))
      .rejects.toThrow(/250ms without a query result/)
  })
})
