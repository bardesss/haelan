import { act } from 'react'
import type { QueryClient } from '@tanstack/react-query'

/**
 * How long either helper below keeps pumping before calling it a hang. See flush()'s last two
 * paragraphs for why this is a duration rather than the count of attempts it used to be, and
 * why ten seconds.
 */
export const HANG_BUDGET_MS = 10_000

/**
 * Waits until a mounted tree has nothing in flight and has stopped changing, rather than a fixed
 * number of ticks or a wall clock budget. A page can fire several independent queries, each its
 * own fetch-then-parse chain, and a budget tuned against how long that happens to take on one
 * machine is a race everywhere else: a CI runner slower than the laptop it was tuned on hits the
 * ceiling on a page that was still going to settle, and raising the number again only moves the
 * flake to a slower runner still. queryClient.isFetching() + queryClient.isMutating() sidesteps
 * the guess: it is the count of queries and mutations actually in flight, so waiting on it means
 * waiting on the thing this helper actually cares about instead of how long that thing usually
 * takes.
 *
 * Both counts, not isFetching() alone: a click triggered mutation (a submit, a remove) is invisible
 * to isFetching(), so a test that clicks and then calls this helper could settle on the read before
 * the click's own write and the refetch it invalidates ever registered as in flight, the same gap
 * the guard below closes for a query that has not started yet. override-list.test.tsx hit exactly
 * this: a removal's DELETE and the GET it invalidates both resolved inside the same act() the click
 * already flushed, so isFetching() alone never left zero and sawFetch never armed, and the helper
 * waited out its own budget for an in-flight state that had already come and gone.
 *
 * Requires the combined count to have left zero at least once before it will call a later zero
 * "settled". The combined count reads zero before anything has started as readily as it does once
 * every query and mutation has finished, and without this guard a page that has not begun would
 * satisfy "nothing in flight" on the very first sample, exactly the "never got there" case this
 * helper exists to catch rather than paper over (an earlier version of this file had exactly that
 * gap, on a wall clock budget instead of a fetch count, and returning silently instead of
 * throwing).
 *
 * Nothing in flight is necessary but not sufficient: a query settling can still trigger a render
 * that starts another one (a refetch fired from an effect, say), so this also asks for one more
 * sample, taken after the first "nothing in flight" reading, to match it before calling the page
 * settled. Either check alone can lie about "settled"; both together is what the word means.
 *
 * Throws on running out of budget rather than returning: a page that started and then got stuck
 * (a real bug, in flight forever or still changing after the fetch count returns to zero) exits
 * the loop the same way a page that settled normally does, on the last comparison finding no
 * further progress, and a silent return there means a test reading this helper's result cannot
 * tell the two apart either, the same gap this file exists to close. This branch has hit that
 * shape of failure seven times over; a helper that fails loudly here is worth more than one that
 * fails quietly does.
 *
 * The budget is a duration, not the 2000 attempts it used to be, because what the ceiling has to
 * stay inside is the runner's own testTimeout and that is measured in wall clock. 2000 attempts
 * of a 5ms sleep is the ten seconds the comment here used to claim only on a platform where a 5ms
 * sleep costs 5ms, and Windows is not one: its timer granularity makes setTimeout(5) cost about
 * 14ms, so the real ceiling sat near 29 seconds, past vitest's 20 000ms. The runner killed the
 * test before either helper reached its own throw, which cost the message twice over - the
 * generic "Test timed out in 20000ms" that arrived instead named nothing about what had been
 * missing, and being killed mid-`await act(...)` left React mid-act, so the next tests in the
 * same file failed on "overlapping act() calls" having done nothing wrong. Throwing between
 * pumps, from outside act(), is what keeps a timeout the failure of one test.
 *
 * Note that the interval is not the thing to shrink: setTimeout(0) measured about 10ms here
 * against setTimeout(5)'s 14ms, so the per-pump floor is the platform's rather than this
 * number's, and 2000 pumps could not fit inside testTimeout at any interval. act() is not the
 * expense either - 200 calls cost 1.3ms, against 2.8 seconds for the 200 sleeps. Measuring the
 * budget also makes the ceiling mean the same thing on every machine, which is the argument the
 * top of this comment already makes about the settle mechanism, one layer down: a count of
 * attempts is a wall clock budget written in a unit whose length varies by platform. Ten seconds
 * keeps the number this comment always claimed and leaves the 2x margin under testTimeout that
 * vitest.config.ts argues for; a caller testing the timeout itself passes a small budget of its
 * own rather than waiting out this one.
 */
export async function flush(
  queryClient: QueryClient,
  getHtml: () => string,
  budgetMs = HANG_BUDGET_MS,
): Promise<void> {
  const inFlight = () => queryClient.isFetching() + queryClient.isMutating() > 0
  let sawFetch = inFlight()
  let previous = getHtml()
  let idleOnce = false
  let pumps = 0
  let fetching = 0
  let changed = 0
  const started = performance.now()
  const deadline = started + budgetMs
  do {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    pumps += 1
    if (inFlight()) {
      sawFetch = true
      idleOnce = false
      fetching += 1
      previous = getHtml()
      continue
    }
    if (!sawFetch) {
      previous = getHtml()
      continue
    }
    const current = getHtml()
    if (idleOnce && current === previous) return
    if (current !== previous) changed += 1
    idleOnce = true
    previous = current
  } while (performance.now() < deadline)
  // The counts, not just the sentence: "never settled" and "never started" are two different
  // failures and the sentence alone names neither, which is exactly how the animation race this
  // budget was losing stayed undiagnosed - the report it produced said nothing a reader could act
  // on. `fetching` still in step with `pumps` is a page stuck in flight; `changed` in step with
  // `pumps` while `fetching` stays at zero is a page that keeps redrawing after its data landed
  // (an animation, or a render loop); both at zero is a page that never started.
  throw new Error(
    `flush() timed out after ${Math.round(performance.now() - started)}ms: the page never settled `
    + `(or never started changing at all) - ${pumps} pumps, in flight on ${fetching}, `
    + `changed on ${changed}`,
  )
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
 *
 * `budgetMs` is the hang detector, on the same terms as flush()'s - and a `ready` that genuinely
 * never holds has to surface here, naming `what`, rather than as the runner's own timeout.
 */
export async function pumpUntil(
  ready: () => boolean,
  what: string,
  budgetMs = HANG_BUDGET_MS,
): Promise<void> {
  const deadline = performance.now() + budgetMs
  do {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    if (ready()) return
  } while (performance.now() < deadline)
  throw new Error(`pumpUntil() timed out waiting for ${what}`)
}
