import { act } from 'react'

/**
 * Waits until a mounted tree stops changing, rather than a fixed number of ticks. A page can fire
 * several independent queries, each its own fetch-then-parse chain, and a single microtask tick
 * is not reliably enough hops for all of them to settle; a fixed tick count that happened to be
 * enough for one query was still a race against the others.
 *
 * Requires the tree to have changed at least once before it will call a stable snapshot "settled".
 * Without that requirement, two consecutive samples of a page that never left its pending state
 * satisfy "unchanged" trivially, and a test built on this helper cannot tell "reached the
 * settled state" from "never got there" (an earlier version of this file had exactly that gap).
 *
 * Throws on running out of attempts rather than returning: a page that changed once and then got
 * stuck (a real bug) exits the loop the same way a page that settled normally does, on the last
 * comparison finding no further change, and a silent return there means a test reading this
 * helper's result cannot tell the two apart either, the same gap this file exists to close. This
 * branch has hit that shape of failure seven times over; a helper that fails loudly here is worth
 * more than one that fails quietly does.
 *
 * 200 attempts (up to a second), not the 40 (200ms) an earlier version used: adding the throw
 * above turned a budget that was already marginal, once the Dashboard grew to five charts each
 * doing its own echarts.init, into a helper that failed on genuinely settling pages rather than
 * only on stuck ones. A generous ceiling costs nothing on the common case, which still returns as
 * soon as the page actually stops changing.
 */
export async function flush(getHtml: () => string): Promise<void> {
  let previous = getHtml()
  let changedOnce = false
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    const current = getHtml()
    if (current !== previous) changedOnce = true
    else if (changedOnce) return
    previous = current
  }
  throw new Error('flush() timed out: the page never settled (or never started changing at all)')
}
