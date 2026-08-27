import { act } from 'react'
import type { QueryClient } from '@tanstack/react-query'

/**
 * Waits until a mounted tree has nothing in flight and has stopped changing, rather than a fixed
 * number of ticks or a wall clock budget. A page can fire several independent queries, each its
 * own fetch-then-parse chain, and a budget tuned against how long that happens to take on one
 * machine is a race everywhere else: a CI runner slower than the laptop it was tuned on hits the
 * ceiling on a page that was still going to settle, and raising the number again only moves the
 * flake to a slower runner still. queryClient.isFetching() sidesteps the guess: it is the count of
 * queries actually in flight, so waiting on it means waiting on the thing this helper actually
 * cares about instead of how long that thing usually takes.
 *
 * Requires isFetching() to have left zero at least once before it will call a later zero
 * "settled". isFetching() reads zero before any query has started as readily as it does once every
 * query has finished, and without this guard a page that has not begun would satisfy "nothing in
 * flight" on the very first sample, exactly the "never got there" case this helper exists to catch
 * rather than paper over (an earlier version of this file had exactly that gap, on a wall clock
 * budget instead of a fetch count, and returning silently instead of throwing).
 *
 * Nothing in flight is necessary but not sufficient: a query settling can still trigger a render
 * that starts another one (a refetch fired from an effect, say), so this also asks for one more
 * sample, taken after the first "nothing in flight" reading, to match it before calling the page
 * settled. Either check alone can lie about "settled"; both together is what the word means.
 *
 * Throws on running out of attempts rather than returning: a page that started and then got stuck
 * (a real bug, in flight forever or still changing after the fetch count returns to zero) exits
 * the loop the same way a page that settled normally does, on the last comparison finding no
 * further progress, and a silent return there means a test reading this helper's result cannot
 * tell the two apart either, the same gap this file exists to close. This branch has hit that
 * shape of failure seven times over; a helper that fails loudly here is worth more than one that
 * fails quietly does.
 *
 * 2000 attempts (up to ten seconds), not the 200 (one second) a wall clock version needed: the
 * ceiling is no longer the settle mechanism, only a hang detector, so it can afford to be generous
 * without weakening anything. The common case still returns as soon as isFetching() reaches zero
 * and one more sample confirms the tree agrees, which does not need anywhere near ten seconds; the
 * ceiling only matters for a page that is genuinely stuck.
 */
export async function flush(queryClient: QueryClient, getHtml: () => string): Promise<void> {
  let sawFetch = queryClient.isFetching() > 0
  let previous = getHtml()
  let idleOnce = false
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    if (queryClient.isFetching() > 0) {
      sawFetch = true
      idleOnce = false
      previous = getHtml()
      continue
    }
    if (!sawFetch) {
      previous = getHtml()
      continue
    }
    const current = getHtml()
    if (idleOnce && current === previous) return
    idleOnce = true
    previous = current
  }
  throw new Error('flush() timed out: the page never settled (or never started changing at all)')
}

/**
 * Pumps the tree until `ready()` holds, for the states flush() cannot reach: a page where one
 * request is deliberately left hanging so a card can be read while it is still in flight. flush()
 * waits for nothing to be in flight and throws when that never happens, which is the right posture
 * for a settled page and the wrong one here, since the whole point is that a query never settles.
 *
 * `ready` is a predicate on the tree rather than a tick budget, for the same reason flush() counts
 * queries rather than milliseconds: a budget tuned on one machine is a race on a slower one. The
 * state being sampled has to be a resting state, not a moment in a sequence, or this is just a
 * race with extra steps; a request stubbed to never resolve gives exactly that.
 */
export async function pumpUntil(ready: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    if (ready()) return
  }
  throw new Error(`pumpUntil() timed out waiting for ${what}`)
}
