import {
  DATA_TYPES, RevokedError, TokenBucket, HealthClient, TokenProvider, runBackfill, runSync,
  horizonDaysFor, DEFAULT_USER_HORIZON_DAYS,
} from '@haelan/core'
import type { JobDeps, RateLimiter, SyncProgress } from '@haelan/core'
import type { ServerContext } from '../app.ts'

// probe/findings/scopes.md measured 300 requests per minute per user. Running at the ceiling is
// how a transient 429 becomes a sustained one, so this sits at 60 percent of it and keeps the
// burst small. A trailing week for one person is 18 types times 7 days, about 126 requests, so
// a single person's nightly run finishes inside a minute and a five person household inside
// four. That is the real number; a backfill batch runs on top of it.
const REFILL_PER_MINUTE = 180
const BUCKET_CAPACITY = 10

const TRAILING_DAYS = 7

const DAY_MS = 86_400_000
/**
 * How much history the first run fills before settling into the hourly batch. Measured at 2,250
 * requests, about thirteen minutes at 180 a minute, against the 5.4 days the hourly batch alone
 * took to walk a five-year horizon. Deliberately its own literal rather than INTRADAY_HORIZON_DAYS:
 * this is the window that makes the dashboard usable quickly, and tying it to the intraday cap
 * would mean any future rise in that cap silently turns a thirteen-minute sprint into a much
 * longer one. With the cap at 365 days, intraday types reach the sprint floor (below) but not
 * their full horizon, so they carry on in the trickle after the sprint at the normal batch rate
 * like everything else. This is the production value; tests override it through
 * ServerDeps.sprintDays (see run()) rather than shrinking this constant.
 */
const SPRINT_DAYS = 90
/**
 * A pass that keeps fetching without moving a cursor is a type failing every window. Bounded so
 * that case ends the sprint rather than looping on it; 90 days at the smallest useful batch
 * needs far fewer passes than this.
 */
const MAX_SPRINT_PASSES = 40

export type RunReason = 'manual' | 'scheduled' | 'setup'

export interface RunOutcome {
  started: boolean
  reason?: 'already_running' | 'shutting_down'
}

export interface BackfillSummary {
  dataType: string
  complete: boolean
  cursorMs: number | null
  horizonDays: number
}

export interface RunnerStatus {
  running: boolean
  reason: RunReason | null
  startedAtMs: number | null
  lastFinishedAtMs: number | null
  userHorizonDays: number
  backfill: BackfillSummary[]
}

export class SyncRunner {
  private running = false
  private reason: RunReason | null = null
  private startedAtMs: number | null = null
  private lastFinishedAtMs: number | null = null
  private timer: NodeJS.Timeout | null = null
  private readonly listeners = new Set<(event: SyncProgress) => void>()

  readonly #context: ServerContext
  /** The run tryStart left going, so a shutdown can wait for it rather than close under it. */
  #inFlight: Promise<unknown> | null = null
  /** Set by stop(), checked between batches, so a sprint cannot outlive a shutdown. */
  #aborted = false
  /**
   * Set by stop() and never cleared, unlike #aborted which trigger() resets at the start of
   * every run. shutdown() calls stop() then awaits settle() while the HTTP server is still up,
   * so a request racing that window (routes/sync.ts, routes/oauth.ts) can reach tryStart after
   * the aborted run has already finished — at which point #aborted alone would have been reset
   * to false by trigger() and the new run would start, and settle()'s while loop would pick up
   * its promise and wait out a full sprint instead of returning. This flag latches so neither
   * tryStart nor trigger can start anything once stop() has been called, for good.
   */
  #stopped = false

  constructor(context: ServerContext) { this.#context = context }

  /**
   * Resolves once no run started by tryStart is still going. A run outliving the process that
   * started it means SQLite closing mid-write, which surfaces as "the database connection is
   * not open" from somewhere unrelated to whatever actually went wrong.
   */
  async settle(): Promise<void> {
    while (this.#inFlight) {
      const pending = this.#inFlight
      await pending
      if (this.#inFlight === pending) this.#inFlight = null
    }
  }

  subscribe(listener: (event: SyncProgress) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  // The operator's choice, not the type's: it lives on the settings row because it is a single
  // number chosen once for the account, and horizonDaysFor turns it into a per-type ceiling.
  #userHorizonDays(): number {
    return this.#context.stores.settings.get()?.backfillHorizonDays ?? DEFAULT_USER_HORIZON_DAYS
  }

  status(): RunnerStatus {
    const userHorizonDays = this.#userHorizonDays()
    const backfill: BackfillSummary[] = []
    for (const person of this.#context.stores.people.list()) {
      for (const type of DATA_TYPES) {
        if (!type.listSupported) continue
        const state = this.#context.stores.syncState.get(person.id, type.id)
        backfill.push({
          dataType: type.id,
          complete: state?.backfillCompleteAtMs != null,
          cursorMs: state?.backfillCursorMs ?? null,
          horizonDays: horizonDaysFor(type, userHorizonDays),
        })
      }
    }
    return {
      running: this.running,
      reason: this.reason,
      startedAtMs: this.startedAtMs,
      lastFinishedAtMs: this.lastFinishedAtMs,
      userHorizonDays,
      backfill,
    }
  }

  /**
   * Takes the mutex and returns immediately, leaving the run going. The browser pressing "sync
   * now" wants an answer before a backfill batch finishes, and the status route and the event
   * stream are how it follows the rest.
   */
  tryStart(reason: RunReason): RunOutcome {
    if (this.#stopped) return { started: false, reason: 'shutting_down' }
    if (this.running) return { started: false, reason: 'already_running' }
    this.#inFlight = this.trigger(reason).catch(() => undefined)
    return { started: true }
  }

  // Refuses rather than queues. A queued second run would still be running when the next tick
  // arrives, and the useful answer to "sync now" while a sync runs is that one is already going.
  async trigger(reason: RunReason): Promise<RunOutcome> {
    if (this.#stopped) return { started: false, reason: 'shutting_down' }
    if (this.running) return { started: false, reason: 'already_running' }
    this.running = true
    this.#aborted = false
    this.reason = reason
    this.startedAtMs = this.#context.now()
    try {
      await this.run()
    } finally {
      this.running = false
      this.reason = null
      this.startedAtMs = null
      this.lastFinishedAtMs = this.#context.now()
    }
    return { started: true }
  }

  start(): void {
    if (this.#stopped) return
    if (this.timer) return
    const minutes = this.#context.stores.settings.get()?.syncIntervalMinutes ?? 60
    // setInterval waits a whole interval before its first tick, so an instance restarted more
    // often than its interval would never sync at all. A boot catches up first, then settles
    // into the schedule. tryStart, so a boot during a run is a no-op rather than a queue.
    this.tryStart('scheduled')
    this.timer = setInterval(() => { void this.trigger('scheduled') }, minutes * 60_000)
    // Without unref, an idle timer keeps the process alive through a shutdown that has already
    // closed the server.
    this.timer.unref()
  }

  stop(): void {
    this.#aborted = true
    this.#stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private emit(event: SyncProgress): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A subscriber that throws is a broken SSE client, not a reason to lose a window.
      }
    }
  }

  private buildDeps(): JobDeps {
    const tokens = new TokenProvider(this.#context.stores.credentials, {
      fetch: this.#context.fetch,
      now: this.#context.now,
      tokenEndpoint: this.#context.endpoints?.tokenEndpoint,
    })
    const client = new HealthClient(tokens, this.#context.stores.archive, {
      fetch: this.#context.fetch,
      now: this.#context.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      random: Math.random,
      apiRoot: this.#context.endpoints?.apiRoot,
    })
    return {
      db: this.#context.instance.db,
      archive: this.#context.stores.archive,
      sources: this.#context.stores.sources,
      syncState: this.#context.stores.syncState,
      client,
      now: this.#context.now,
      limiter: this.#context.limiter ?? defaultLimiter(),
      onProgress: (event) => this.emit(event),
      deriveQueue: this.#context.instance.deriveQueue,
    }
  }

  private async run(): Promise<void> {
    const deps = this.buildDeps()
    const personIds = this.#context.stores.credentials.listConnectedPeople()
    if (personIds.length === 0) return

    // The trailing window first: today's data is what a dashboard shows, and a backfill that
    // takes an hour must not delay it.
    await runSync({ personIds, trailingDays: TRAILING_DAYS, userHorizonDays: this.#userHorizonDays(), deps })

    // Resolved once per run rather than per type: it is one operator setting, and reading it
    // fresh for every (person, type) pair would let a mid-run settings change produce a run
    // that walked different types to different depths for no reason a user could explain.
    const userHorizonDays = this.#userHorizonDays()
    // Unset in production, so this is SPRINT_DAYS there; tests override it so a run that merely
    // completes consent doesn't pay for a 90 day sprint in its cleanup. Resolved once here, like
    // userHorizonDays above, so #sprintPending and the pass loop below can't disagree on depth.
    const sprintDays = this.#context.sprintDays ?? SPRINT_DAYS
    if (this.#sprintPending(personIds, userHorizonDays, sprintDays)) {
      let pass = 0
      for (; pass < MAX_SPRINT_PASSES; pass++) {
        if (this.#aborted) return
        // A pass that advances no cursor at all means whatever is left is either converged
        // (complete, or already past its own sprint floor) or a type failing every window -
        // either way another pass buys nothing. windowsFetched used to be the signal here, but
        // runBackfill counts a failed window as fetched too, so a type failing every window
        // never produced a zero and burned every remaining pass alone.
        const advanced = await this.#backfillPass(deps, personIds, userHorizonDays, sprintDays)
        if (!advanced) break
      }
      // Reaching MAX_SPRINT_PASSES without ever seeing a pass that failed to advance means every
      // single pass still had real work in it - the sprint did not converge, it simply ran out of
      // passes. That is the sprint's promise (fill sprintDays in one run) not holding, which is
      // worth an operator seeing rather than discovering only as a slower-than-expected trickle.
      if (pass === MAX_SPRINT_PASSES) {
        console.log(`sync: sprint used all ${MAX_SPRINT_PASSES} passes without converging on the ${sprintDays} day floor`)
      }
    }
    // Falls through to the trickle regardless of how the sprint ended - converged, exhausted
    // its passes, or was never entered because nothing was pending. A type failing every window
    // is never marked complete and its cursor never moves, so #sprintPending stays true forever;
    // returning here instead, as an earlier version of this method did, meant that one broken
    // type held every other, healthy type at the sprint floor for good, since the sprint branch
    // above was the only place any of them ever got a chance to walk.
    if (this.#aborted) return
    await this.#backfillPass(deps, personIds, userHorizonDays, null)
  }

  /** True while any connected person has a type that has not yet reached the sprint depth. */
  #sprintPending(personIds: string[], userHorizonDays: number, sprintDays: number): boolean {
    const floorMs = this.#context.now() - sprintDays * DAY_MS
    for (const personId of personIds) {
      if (!this.#context.stores.people.get(personId)) continue
      for (const type of DATA_TYPES) {
        if (!type.listSupported) continue
        const state = this.#context.stores.syncState.get(personId, type.id)
        if (state?.backfillCompleteAtMs != null) continue
        const cursor = state?.backfillCursorMs
        if (cursor == null || cursor > floorMs) return true
      }
    }
    return false
  }

  /**
   * One batch for every type. capDays limits how deep this pass may walk, which is what makes
   * the sprint a bounded phase rather than a run to the full horizon; null means the type's own
   * resolved horizon, which is the trickle. The cap is enforced by skipping a type that has
   * already reached it, not by shrinking the horizonDays passed to runBackfill — see the comment
   * at the skip below for why that distinction is load-bearing. Returns whether any type's
   * cursor actually moved, which is what the sprint loop above uses to decide whether another
   * pass is worth taking.
   */
  async #backfillPass(
    deps: JobDeps, personIds: string[], userHorizonDays: number, capDays: number | null,
  ): Promise<boolean> {
    let cursorAdvanced = false
    for (const personId of personIds) {
      const person = this.#context.stores.people.get(personId)
      if (!person) continue
      for (const dataType of DATA_TYPES) {
        if (!dataType.listSupported) continue
        if (this.#aborted) return cursorAdvanced
        const resolved = horizonDaysFor(dataType, userHorizonDays)
        // A stored completion mark pins a type to whatever horizon was in force on the day it
        // happened to finish, and horizons move - both when an operator raises theirs (see
        // routes/settings.ts, which clears daily types on a raise) and when a measurement moves
        // the policy default itself, as INTRADAY_HORIZON_DAYS just did. Either way the mark would
        // otherwise silently strand the type at its old, shallower floor: runBackfill returns
        // immediately once backfillCompleteAtMs is set, and nothing else ever clears it. Checking
        // it here, against the type's *current* resolved horizon, catches both directions
        // generally instead of teaching each policy change its own special case.
        const state = this.#context.stores.syncState.get(personId, dataType.id)
        if (state?.backfillCompleteAtMs != null && state.backfillCursorMs != null
          && state.backfillCursorMs > this.#context.now() - resolved * DAY_MS) {
          this.#context.stores.syncState.clearBackfillComplete(personId, dataType.id)
        }
        // A type whose real horizon reaches past the sprint cap needs a floor of its own, kept
        // separate from the horizonDays runBackfill is given below. Passing a *capped*
        // horizonDays would work for one call, but a batch that doesn't divide evenly into
        // capDays (fourteen into ninety, say) can walk straight past the cap and hit
        // runBackfill's own "reached the floor" check in the same call — and that check (frozen,
        // from Task 5) reads it as "done" and marks the type complete for good, permanently
        // stunting a type whose operator asked for years of history at the sprint's 90 days.
        // Checking the cap here instead, before ever calling runBackfill, and always handing it
        // the type's real horizon, means the only way runBackfill marks something complete is by
        // genuinely reaching it — overshooting the sprint cap by a few days is harmless, a type
        // never reaching horizonDays this way is not.
        if (capDays !== null && resolved > capDays) {
          const floorMs = this.#context.now() - capDays * DAY_MS
          const cursor = state?.backfillCursorMs
          if (cursor != null && cursor <= floorMs) continue
        }
        try {
          const result = await runBackfill({
            personId, timezone: person.timezone, dataType, nowMs: this.#context.now(),
            horizonDays: resolved,
            ...(this.#context.backfillBatchDays === undefined
              ? {}
              : { batchDays: this.#context.backfillBatchDays }),
            deps,
          })
          // stoppedBecause 'error' or 'revoked' does not mean the cursor never moved - runBackfill
          // writes the cursor after every window it completes and only reports the error from a
          // later one, so a call that walked four windows before failing on the fifth already has
          // real progress on disk. It is still counted as not-advanced here regardless, because
          // this signal only decides whether the sprint loop above takes another pass: treating a
          // failing type as progress would let it look converged when it is really stuck, while
          // treating real progress as "no advance" only costs one extra pass over a type that was
          // going to need one anyway. Conservative in the safe direction, and it stays that way.
          if (result.windowsFetched > 0
            && result.stoppedBecause !== 'error' && result.stoppedBecause !== 'revoked') {
            cursorAdvanced = true
          }
        } catch (error) {
          if (error instanceof RevokedError) break
          // runBackfill records the failures it expects through runJob, so anything arriving
          // here is unexpected. Recording it rather than swallowing it is what stops a whole
          // backfill from silently doing nothing: the first version of this catch was silent,
          // and it hid a missing export behind eighteen types that quietly never walked.
          this.#context.stores.syncState.recordFailure({
            personId, dataType: dataType.id,
            error: error instanceof Error ? error : new Error(String(error)),
            nowMs: this.#context.now(),
          })
        }
      }
    }
    return cursorAdvanced
  }
}

// Real wall clock, deliberately, even when the instance is running on an injected clock. The
// injected one stamps data; a limiter driven by a frozen test clock would never refill and the
// eleventh request of a run would wait forever.
function defaultLimiter(): RateLimiter {
  return new TokenBucket({ capacity: BUCKET_CAPACITY, refillPerMinute: REFILL_PER_MINUTE })
}
