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
 * A page whose seeded data never changes after the first render (nothing async left to resolve)
 * still returns once the attempt budget below runs out, so this cannot hang forever.
 */
export async function flush(getHtml: () => string): Promise<void> {
  let previous = getHtml()
  let changedOnce = false
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    const current = getHtml()
    if (current !== previous) changedOnce = true
    else if (changedOnce) return
    previous = current
  }
}
