import { act } from 'react'
import type { QueryClient } from '@tanstack/react-query'

/**
 * How long either helper below keeps pumping WITHOUT SEEING PROGRESS before calling it a hang. See
 * flush()'s last three paragraphs for why this is a duration rather than the count of attempts it
 * used to be, why ten seconds, and what counts as progress.
 */
export const HANG_BUDGET_MS = 10_000

/**
 * The absolute ceiling on one flush(), progress or no progress.
 *
 * Something has to bound a page that keeps producing results forever (a refetch loop), or flush()
 * never reaches its own throw and vitest's testTimeout kills the test instead. That costs the
 * diagnostic message and leaves React mid-act(), so the next tests in the same file fail on
 * "overlapping act() calls" having done nothing wrong - the exact failure the budget below the
 * fold already exists to prevent.
 *
 * This deliberately spends most of the 2x margin under testTimeout that the old fixed budget kept,
 * and the trade is worth stating rather than discovering. With a rolling budget a SLOW BUT
 * PROGRESSING page can now legitimately run to this ceiling, so it is this number, not
 * HANG_BUDGET_MS, that bounds a flush which goes on to pass. Ten seconds was the number that left
 * 2x; it was also the number failing passing tests on a busy machine, which is the entire reason
 * for the change, so keeping it would have been keeping the bug. Fifteen leaves 25%, which is room
 * for the throw and the report it carries and no more.
 */
export const TOTAL_CEILING_MS = 15_000

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
 * The budget ROLLS, rather than running from the first pump: it is how long this helper will go
 * without seeing a query produce a result, and every result restarts it. A fixed duration measures
 * the machine rather than the code, so the same passing test fails under load and the failure reads
 * as a product bug instead of a scheduling one. What makes a rolling budget safe is the choice of
 * signal. Progress here is `dataUpdateCount + errorUpdateCount` across the cache, which only ever
 * rises and rises exactly when a query settles, so it is the one thing a stuck page cannot
 * counterfeit: a request in flight forever never increments it, and neither does a render loop or
 * an animation. Resetting on `isFetching`, or on the HTML changing, would have disarmed the hang
 * detector for precisely the two shapes it exists to catch. TOTAL_CEILING_MS above is the backstop
 * for the one shape that CAN counterfeit it, a page refetching in a loop.
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
  ceilingMs = TOTAL_CEILING_MS,
): Promise<void> {
  const inFlight = () => queryClient.isFetching() + queryClient.isMutating() > 0
  // Every result every query in the cache has produced. Both counters only ever rise, and they
  // rise exactly when a query settles, which is what makes this the progress signal the rolling
  // budget can trust. See the header's paragraph on why the obvious alternatives cannot be.
  const results = () => queryClient.getQueryCache().getAll()
    .reduce((total, query) => total + query.state.dataUpdateCount + query.state.errorUpdateCount, 0)
  // A query some mounted component is waiting on that has never produced a result, whether or not
  // it is fetching right now. `status` is the result axis ('pending' until a first success or
  // error), as against `fetchStatus`, which is the in-flight axis `isFetching` above already
  // covers.
  //
  // `type: 'active'` is react-query's "some observer has this ENABLED", which is the distinction
  // that matters here. A query parked behind a gate that never opens - a filter the reader has not
  // set, a card the page does not show - is pending forever by design, and counting those would
  // turn this helper's budget into a hang on every page that has one. Measured: counting every
  // observed pending query instead of only the enabled ones times out 20+ tests in this suite.
  //
  // What this DOES catch is the window between a gate opening and react-query issuing the request
  // it gates: enabled, pending, not yet fetching, with the page still showing whatever it showed
  // before. `isFetching` above reads zero there, and the two checks below would take that for a
  // settled page.
  const awaitingResult = () =>
    queryClient.getQueryCache().findAll({ type: 'active' }).some((q) => q.state.status === 'pending')
  // A LEVEL, not the edge `inFlight()` alone can offer. The guard below wants to know whether the
  // page ever started, and witnessing it in flight is only one way to know that: a query that has
  // already produced a result is proof it started, whether or not any pump happened to sample the
  // moment it was running.
  //
  // That gap is what this arming closes, and it is not hypothetical. settings-maintenance.test.tsx
  // clicks a button and then calls flush(), and under a full suite's contention the whole mutation
  // and the refetch it invalidates can resolve inside the click's own act(). flush() then enters a
  // page that has ALREADY settled: nothing in flight, nothing pending, and the HTML already in its
  // final state, so it never changes either. Every branch below reads that as "never started" and
  // the helper waits out its entire budget on a page that was finished before it was called. The
  // report it produced said `633 pumps, in flight on 0, waiting on a mounted query on 0, changed
  // on 0`, which is that shape exactly, and the same test passes in isolation because without the
  // contention the mutation is still in flight when flush() takes its first sample.
  let sawFetch = inFlight() || results() > 0
  let previous = getHtml()
  let idleOnce = false
  let pumps = 0
  let fetching = 0
  let gated = 0
  let changed = 0
  let progressed = 0
  const started = performance.now()
  const ceiling = started + ceilingMs
  let seenResults = results()
  let lastProgress = started
  do {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    pumps += 1
    const landed = results()
    if (landed > seenResults) {
      seenResults = landed
      lastProgress = performance.now()
      progressed += 1
    }
    if (inFlight()) {
      sawFetch = true
      idleOnce = false
      fetching += 1
      previous = getHtml()
      continue
    }
    // Nothing in flight, but something mounted is still waiting for its first result: the page is
    // between two dependent queries rather than done. This is the gap that made this helper lie.
    // `useWorkoutSession` is `enabled: personId !== undefined`, and `personId` comes from
    // `useSession`'s own request, so the second query cannot start until the first has resolved
    // AND React has re-rendered with it. In that window the fetch count is zero and the HTML is
    // whatever it was before - "Loading", on both sides - which is exactly what the two checks
    // below accept as settled. CI on Node 26 put two pumps inside it and the workout page's test
    // read Loading off a page flush() had just called finished.
    if (awaitingResult()) {
      idleOnce = false
      gated += 1
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
  } while (performance.now() < Math.min(lastProgress + budgetMs, ceiling))
  // The counts, not just the sentence: "never settled" and "never started" are two different
  // failures and the sentence alone names neither, which is exactly how the animation race this
  // budget was losing stayed undiagnosed - the report it produced said nothing a reader could act
  // on. `fetching` still in step with `pumps` is a page stuck in flight; `changed` in step with
  // `pumps` while `fetching` stays at zero is a page that keeps redrawing after its data landed
  // (an animation, or a render loop); both at zero is a page that never started.
  // Which budget ran out is the first thing a reader needs, because the two mean different things:
  // the ceiling means a page that kept producing results and never settled, while the rolling
  // budget means one that stopped producing them altogether. `progressed` separates the same two
  // for anyone reading a log after the fact.
  const elapsed = Math.round(performance.now() - started)
  const ranOut = performance.now() >= ceiling
    ? `the ${ceilingMs}ms ceiling`
    : `${budgetMs}ms without a query result`
  throw new Error(
    `flush() timed out after ${elapsed}ms (${ranOut}): the page never settled `
    + `(or never started changing at all) - ${pumps} pumps, in flight on ${fetching}, `
    + `waiting on a mounted query on ${gated}, changed on ${changed}, `
    + `${progressed} query results`,
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
 * `budgetMs` is the hang detector, and it is a FIXED duration rather than the rolling one flush()
 * now uses. Not an oversight: a rolling budget needs a progress signal distinct from the thing
 * being waited on, and here there is none. `ready` is the terminal condition, so "has progress
 * happened" and "are we done" are the same question, and a budget that rolled on it would only
 * ever reset on the pump that returns anyway. A `ready` that genuinely never holds has to surface
 * here, naming `what`, rather than as the runner's own timeout.
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
