import {
  DATA_TYPES, RevokedError, CredentialsUnreadableError, TokenBucket, HealthClient, TokenProvider,
  peopleNeedingRebuild, runBackfill, runDerive, runSync, horizonDaysFor, DEFAULT_USER_HORIZON_DAYS,
  supports, isQuarantined, producedNothing,
} from '@haelan/core'
import type { DataType, JobDeps, RateLimiter, SyncProgress } from '@haelan/core'
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
 *
 * Exported only so a test can size itself against it: "fills the sprint window in one run"
 * walks a subset of the catalogue and needs that subset to be large enough that a pass
 * advancing one type instead of all of them runs out of passes here rather than converging
 * anyway. Reading the number beats restating it in a comment that would not notice it moving.
 */
export const MAX_SPRINT_PASSES = 40

/**
 * runDerive claims one batch per call, and a sprint marks far more days than one batch holds.
 * Bounded for the same reason the sprint is: a batch that comes back claimed and is still
 * queued afterwards would otherwise spin here. What is left stays queued for the next run,
 * which is safe because the queue is the record of what needs deriving, not this loop.
 */
const MAX_DERIVE_BATCHES = 200

export type RunReason = 'manual' | 'scheduled' | 'setup'

/**
 * How long after a run finishes a person may start another by hand. A run with nothing new to
 * fetch ends in a moment, so without this every click started a fresh one against Google's quota;
 * the button looked broken because each run finished before anybody saw it start. Scheduled runs
 * ignore it: the scheduler is what the cooldown exists to leave room for.
 */
export const MANUAL_SYNC_COOLDOWN_MS = 60_000

export interface RunOutcome {
  started: boolean
  reason?: 'already_running' | 'shutting_down' | 'cooldown'
  /** Only with reason 'cooldown': how long until a manual run would be accepted. */
  retryAfterMs?: number
}

/**
 * Deliberately carries no person id. status() below takes one and returns only that person's
 * rows, so every entry belongs to the person the caller named and a field repeating it on each
 * row would be redundant on every response. It would also preserve the flat shape this type
 * used to have, where the array held one entry per person per type and duplicate dataType
 * values were the only sign that two households were mixed together. Spec section 15 settles
 * the question a household-wide variant would raise: each account sees only its own data, with
 * no sharing mechanism, so there is nothing for a per-row owner to serve. An admin may now reset
 * another member's password, and that changes nothing here: it is a named exception for account
 * recovery, not a role hierarchy, and it reaches no row of anybody's - least of all this one,
 * which is a person's own sync progress and stays theirs alone.
 */
export interface BackfillSummary {
  dataType: string
  complete: boolean
  cursorMs: number | null
  horizonDays: number
}

/**
 * What the last rebuild of this person did, as the browser needs to say it.
 *
 * Per person and carried on the same envelope as the backfill array, for the same reason that
 * array is: this is a fact about one household member's own data and belongs only to them. The
 * admin's household-wide view is a separate, admin-gated route.
 *
 * `quarantined` is derived rather than stored. A person is quarantined when their last attempt
 * ended in an error and no later attempt has committed, which is exactly "the last thing that
 * happened was a failure" - there is no separate flag to get out of step with the timestamps.
 * The predicate itself lives in packages/core as `isQuarantined`, not here, because this is not
 * the only surface that needs to ask it; a person warned about here and reported clean somewhere
 * else would be worse than either answer standing alone, so the two share one function rather
 * than one comment describing two.
 *
 * `awaitingRebuild` is the other way a person's data stops, and the one no rebuild attempt
 * precedes. It comes off `peopleNeedingRebuild`, the same predicate #eligible below already
 * skips people by, so this field cannot disagree with the decision it is reporting. Its cause
 * is usually nothing going wrong at all: PeopleStore.setTimezone nulls builtDerivationVersion
 * in the same statement as the zone, which the Profile form reaches, and from the next tick the
 * runner and the derive drainer both skip that person until a boot rebuilds them. rebuild_state
 * still holds their last actual outcome - a clean success, or no row - so `quarantined` alone
 * reported them as fine while they had in fact stopped, for as long as nobody restarted the
 * container.
 *
 * The two are not exclusive and this deliberately does not choose between them. A quarantined
 * person is behind on their stamp as well, because the rollback took it with them, so both read
 * true of them. Which sentence a reader is shown is a question about wording, and it is settled
 * once in RebuildNotice rather than differently by each surface that asks.
 */
export interface RebuildStatus {
  quarantined: boolean
  awaitingRebuild: boolean
  droppedPages: number
  /**
   * Their last rebuild was handed an archive and left nothing in tier 2 or tier 3.
   *
   * Sent as the answer rather than as the two columns behind it, unlike droppedPages beside it,
   * because it is a conjunction and not a measurement: rows_written = 0 on its own is true of
   * every member connected in the last hour. Deciding it here, through the same shared predicate
   * the admin route calls, is what keeps the two surfaces from disagreeing - the argument
   * isQuarantined is already sent as a boolean for.
   *
   * Not a failure. Their rebuild committed and every flag beside this one reads clean, and tier 1
   * still holds every payload, so a later mapping version may read what this one could not.
   */
  producedNothing: boolean
  lastErrorAtMs: number | null
  /** What can and cannot end up in this string is answered once, at the catch in runRebuild.ts
   * that captures it - not here and not on the admin route that reads the same column. */
  lastError: string | null
  /**
   * When the last rebuild attempt committed. Added so the browser can date droppedPages and
   * producedNothing above, which otherwise persist unchanged from one boot to the next: a
   * rebuild only reruns for a person once their version stamp goes stale, so a person stamped
   * current while still carrying a drop or an empty rebuild would show the same numbers forever
   * with nothing on screen saying whether that happened twenty minutes or four months ago.
   *
   * Not when the gap ITSELF began - a data type that keeps failing to map across two
   * MAPPING_VERSION bumps has this timestamp walk forward on every later rebuild while the
   * underlying gap is however old the first bad rebuild was. RebuildNotice's own copy is worded
   * around that ("as of the rebuild ... ago"), not this field's own doc comment, since the
   * component is what a reader actually sees.
   *
   * Already returned by the admin route (routes/maintenance.ts); this is the per-person mirror
   * of the same rebuild_state column, added here for the same reason lastErrorAtMs above already
   * is.
   */
  lastSuccessAtMs: number | null
  drops: { dataType: string, reason: string, pages: number }[]
}

/**
 * What is true of the runner itself rather than of anybody's data. The runner is one singleton
 * per instance, so these four are instance-wide facts and safe to hand to any signed-in caller.
 * Split out from RunnerStatus so that asking "is a run going" does not require naming a person
 * and, more to the point, so that there is no argument-free call that returns a backfill array.
 */
export interface RunState {
  running: boolean
  reason: RunReason | null
  startedAtMs: number | null
  lastFinishedAtMs: number | null
  lastRowsWritten: number | null
  lastFailed: number | null
  cooldownRemainingMs: number
}

export interface RunnerStatus extends RunState {
  /**
   * Whose snapshot this is. Named once on the envelope rather than once per row: the event
   * stream sends a snapshot unsolicited on connect, and a client that has since switched person
   * needs to know whether the one it is holding is the one it is drawing.
   */
  personId: string
  userHorizonDays: number
  backfill: BackfillSummary[]
  rebuild: RebuildStatus
  /**
   * Whether index.ts's boot rebuild worker is running right now. Instance-wide, which is why it
   * sits out here beside `running` rather than inside `rebuild`: one worker rebuilds the whole
   * household in a single pass, and RebuildStatus is documented as carrying facts about one
   * member's own data alone.
   *
   * It exists because `rebuild.awaitingRebuild` on its own is ambiguous at the one moment it is
   * most likely to be read. index.ts calls app.listen BEFORE the boot rebuild starts, and that
   * rebuild runs for as long as fifteen minutes on real data, so every person the worker has not
   * reached yet reports a stale stamp throughout the run that is fixing them - which is exactly
   * the state right after an upgrade. The browser used to render "a restart is what runs it" for
   * that, and an operator who acted on it would abort the rebuild. Paired with awaitingRebuild,
   * this is what tells "it is running now, wait" apart from "nothing is running, only a restart
   * starts one". Which sentence a reader sees is settled in RebuildNotice, as with the other
   * states; this route reports the fact.
   *
   * Read through the ServerContext the runner already holds - ServerContext extends ServerDeps,
   * so `rebuildInFlight` is on it for the same reason routes/maintenance.ts can reach it - rather
   * than plumbed in separately. A second copy of the boot flag is a second thing that can fall out
   * of step with the first. Unset outside index.ts's own wiring, hence the `?? false`: a test that
   * never rebuilds anybody has no rebuild in flight, which is the honest answer, not an absence.
   */
  rebuildInFlight: boolean
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
   * the aborted run has already finished, at which point #aborted alone would have been reset
   * to false by trigger() and the new run would start, and settle()'s while loop would pick up
   * its promise and wait out a full sprint instead of returning. This flag latches so neither
   * tryStart nor trigger can start anything once stop() has been called, for good.
   */
  #stopped = false
  /**
   * Who this runner has already said it is skipping. The scheduler ticks hourly and a person
   * stays quarantined until a boot rebuilds them, so a line per tick is how a real reason to
   * look becomes noise nobody reads by the second day. Entries are dropped again once the
   * person comes back up to date, so a second quarantine is reported as loudly as the first.
   */
  readonly #reportedSkips = new Set<string>()

  /** run_finished's totals for the run in flight; null until runSync reports them. */
  #runTotals: { rowsWritten: number, failed: number } | null = null

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

  /**
   * The types this person actually wants, in catalogue order.
   *
   * One helper rather than an exclusion check in each of the three walks below: a rule spelled
   * three times is a rule that drifts the first time one of them is edited alone.
   *
   * routes/settings.ts's horizon raise deliberately does not filter through this. It clears
   * backfill-complete marks for every type, and clearing the mark of a type nothing will fetch is
   * harmless - filtering there would put the rule in a second place for no change in behaviour.
   */
  #typesFor(personId: string): DataType[] {
    const excluded = new Set(this.#context.stores.excludedDataTypes.listFor(personId))
    // The test narrowing applies after the exclusions rather than instead of them, so a test that
    // sets both still sees a person's own choices honoured. Unset in production; see
    // ServerDeps.dataTypeIdsForTest for why this is a named seam rather than the exclusions table.
    const only = this.#context.dataTypeIdsForTest
    return DATA_TYPES.filter((type) => !excluded.has(type.id))
      .filter((type) => only === undefined || only.includes(type.id))
  }

  #cooldownRemainingMs(): number {
    const last = this.#lastFinished()
    if (last === null) return 0
    return Math.max(0, MANUAL_SYNC_COOLDOWN_MS - (this.#context.now() - last))
  }

  /** In memory once this process has finished a run; the persisted one before that. */
  #lastFinished(): number | null {
    return this.lastFinishedAtMs ?? this.#context.stores.settings.lastSync()?.finishedAtMs ?? null
  }

  /** The instance-wide facts, with nothing of anybody's data in them. */
  runState(): RunState {
    const persisted = this.#context.stores.settings.lastSync()
    return {
      running: this.running,
      reason: this.reason,
      startedAtMs: this.startedAtMs,
      lastFinishedAtMs: this.#lastFinished(),
      lastRowsWritten: persisted?.rowsWritten ?? null,
      lastFailed: persisted?.failed ?? null,
      cooldownRemainingMs: this.#cooldownRemainingMs(),
    }
  }

  /**
   * One person's view of the runner. personId is required rather than optional: this used to
   * walk people.list() and return every household member's backfill in one flat array, which
   * meant any caller that forgot to filter served one member's cursors to another. An optional
   * parameter would leave that call spelled the same way it is today and reintroduce the leak
   * the first time somebody wrote status() out of habit, so the type is what refuses it now.
   */
  status(personId: string): RunnerStatus {
    const userHorizonDays = this.#userHorizonDays()
    const backfill: BackfillSummary[] = []
    for (const type of this.#typesFor(personId)) {
      if (!supports(type, 'list')) continue
      const state = this.#context.stores.syncState.get(personId, type.id)
      backfill.push({
        dataType: type.id,
        complete: state?.backfillCompleteAtMs != null,
        cursorMs: state?.backfillCursorMs ?? null,
        horizonDays: horizonDaysFor(type, userHorizonDays),
      })
    }
    // Read fresh on every call rather than cached anywhere on the runner: this is a fact about
    // one row in rebuild_state, written by a boot rebuild the runner itself never drives, and a
    // stale copy here would leave a person's dashboard reporting yesterday's quarantine after a
    // later boot already cleared it.
    const rebuild = this.#context.stores.rebuildState.get(personId)
    // Read from the people row rather than from rebuild_state, because that is where this state
    // lives: a stale stamp is the absence of a rebuild, so no row records it. An unknown person
    // is behind on nothing - peopleNeedingRebuild over an empty list is an empty list - which is
    // the same answer #eligible gives them, and #backfillPass is where a connected person with
    // no row is actually handled.
    const person = this.#context.stores.people.get(personId)
    return {
      ...this.runState(),
      personId,
      userHorizonDays,
      backfill,
      // Asked on every call, like the rebuild row above and for the same reason: the boot
      // rebuild settles while a dashboard is open, and a copy taken when this runner was
      // constructed would have been true for the whole life of the process.
      rebuildInFlight: this.#context.rebuildInFlight?.() ?? false,
      rebuild: {
        quarantined: isQuarantined(rebuild),
        awaitingRebuild: peopleNeedingRebuild(person === null ? [] : [person]).length > 0,
        droppedPages: rebuild?.droppedPages ?? 0,
        producedNothing: producedNothing(rebuild),
        lastErrorAtMs: rebuild?.lastErrorAtMs ?? null,
        lastError: rebuild?.lastError ?? null,
        lastSuccessAtMs: rebuild?.lastSuccessAtMs ?? null,
        drops: rebuild?.drops ?? [],
      },
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
    if (reason === 'manual') {
      const remaining = this.#cooldownRemainingMs()
      if (remaining > 0) return { started: false, reason: 'cooldown', retryAfterMs: remaining }
    }
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
    this.#runTotals = null
    let threw = false
    try {
      await this.run()
    } catch (error) {
      threw = true
      throw error
    } finally {
      this.running = false
      this.reason = null
      this.startedAtMs = null
      this.lastFinishedAtMs = this.#context.now()
      // failed counts jobs; a run that threw before runSync reported counts as one failure, so
      // the panel never reads a crashed run as "nothing new".
      const totals = this.#runTotals ?? { rowsWritten: 0, failed: 0 }
      this.#context.stores.settings.putLastSync({
        finishedAtMs: this.lastFinishedAtMs,
        rowsWritten: totals.rowsWritten,
        failed: threw && totals.failed === 0 ? 1 : totals.failed,
      }, this.lastFinishedAtMs)
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
    if (event.kind === 'run_finished') this.#runTotals = { rowsWritten: event.rowsWritten, failed: event.failed }
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
    const personIds = this.#eligible(this.#context.stores.credentials.listConnectedPeople())
    if (personIds.length === 0) return

    // The trailing window first: today's data is what a dashboard shows, and a backfill that
    // takes an hour must not delay it.
    //
    // shouldStop, because this is run()'s first await and everything below it is guarded by an
    // #aborted check while this was not. stop() sets #aborted and shutdown() then awaits
    // settle(), so without this a shutdown waited out a whole trailing sync of every connected
    // person and every listable type before anything noticed it had been asked to stop.
    await runSync({
      personIds, trailingDays: TRAILING_DAYS, userHorizonDays: this.#userHorizonDays(), deps,
      shouldStop: () => this.#aborted,
    })
    if (this.#aborted) return
    // Here as well as at the end of the run, for the same reason the trailing window goes
    // first: a backfill that takes an hour must not be what stands between today's samples and
    // the dashboard reading them.
    this.#derive(personIds)

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
    this.#derive(personIds)
  }

  /**
   * The connected people whose derived rows are at the versions this build derives at.
   *
   * A person whose boot rebuild failed keeps rows built by an older mapper, and their version
   * stamp rolled back with them. Syncing them anyway would append rows derived at the current
   * version alongside the old ones, leaving a person whose tier 2 and tier 3 disagree with no
   * record of which rows came from which, which is the one thing the version stamp exists to
   * prevent. So they wait, and the rest of the household goes on ingesting.
   *
   * Read fresh on every run rather than resolved once at boot. The person is meant to recover by
   * a later boot rebuilding them, and a cached decision would keep them quarantined until the
   * process was restarted a second time.
   *
   * A brand new person is not caught by this, and that is not luck: PeopleStore.create stamps the
   * current versions precisely so that "needs a rebuild" means "has rows built by something
   * older" rather than "has no rows yet". Without that, somebody who connected after boot would
   * be skipped here and never rebuilt either, since the rebuild only runs at boot, and so would
   * never receive any data at all.
   */
  #eligible(personIds: string[]): string[] {
    const connected = new Set(personIds)
    const rows = this.#context.stores.people.list().filter((person) => connected.has(person.id))
    const behind = new Map(peopleNeedingRebuild(rows).map((need) => [need.personId, need.reasons]))

    // Forgotten as soon as they are current again, so a person quarantined a second time is
    // reported a second time rather than silently skipped on the strength of an old line.
    for (const id of this.#reportedSkips) {
      if (!behind.has(id)) this.#reportedSkips.delete(id)
    }

    const eligible: string[] = []
    for (const personId of personIds) {
      const reasons = behind.get(personId)
      // Undefined covers two cases on purpose: a person who is current, and a connected person
      // with no row at all. The second is already handled downstream, where #backfillPass skips
      // whoever people.get cannot find, and inventing a second answer to it here would only mean
      // two places to keep in agreement.
      if (reasons === undefined) {
        eligible.push(personId)
        continue
      }
      if (this.#reportedSkips.has(personId)) continue
      this.#reportedSkips.add(personId)
      console.log(
        `sync: skipping ${personId} until a boot rebuilds them, `
        + `because their derived data is behind (${reasons.join(', ')})`,
      )
    }
    return eligible
  }

  /**
   * Drains the days sync just marked. Nothing else in the running system does, so without this
   * derive_queue only grows and tier 3 never receives a derived row.
   *
   * Its failures stay inside it, the way a failed job stays inside runJob: a derivation defect
   * turning a completed sync into a failed one is the coupling section 13 forbids in the other
   * direction, and the days it could not derive are still queued for the next run either way.
   *
   * Restricted to the same people #eligible allowed through, and for the same reason. Gating the
   * fetch alone left the quarantine leaking: a day queued before the rebuild failed is still in
   * the queue, and draining it writes tier 3 at the current derivation version over tier 2 built
   * by an older mapper. Their days stay queued until a boot rebuilds them.
   */
  #derive(personIds: string[]): void {
    try {
      for (let batch = 0; batch < MAX_DERIVE_BATCHES; batch++) {
        if (this.#aborted) return
        if (runDerive({
          db: this.#context.instance.db, queue: this.#context.instance.deriveQueue,
          priority: this.#context.instance.sourcePriority,
          overrides: this.#context.instance.overrides,
          settings: this.#context.instance.settings,
          nowMs: this.#context.now(),
          personIds,
        }).daysDerived === 0) return
      }
      console.log(`sync: derivation stopped after ${MAX_DERIVE_BATCHES} batches with days still queued`)
    } catch (error) {
      console.log(`sync: derivation failed, ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** True while any connected person has a type that has not yet reached the sprint depth. */
  #sprintPending(personIds: string[], userHorizonDays: number, sprintDays: number): boolean {
    const floorMs = this.#context.now() - sprintDays * DAY_MS
    for (const personId of personIds) {
      if (!this.#context.stores.people.get(personId)) continue
      for (const type of this.#typesFor(personId)) {
        if (!supports(type, 'list')) continue
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
   * already reached it, not by shrinking the horizonDays passed to runBackfill. See the comment
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
      for (const dataType of this.#typesFor(personId)) {
        if (!supports(dataType, 'list')) continue
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
        // runBackfill's own "reached the floor" check in the same call, and that check (frozen,
        // from Task 5) reads it as "done" and marks the type complete for good, permanently
        // stunting a type whose operator asked for years of history at the sprint's 90 days.
        // Checking the cap here instead, before ever calling runBackfill, and always handing it
        // the type's real horizon, means the only way runBackfill marks something complete is by
        // genuinely reaching it. Overshooting the sprint cap by a few days is harmless, a type
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
            && result.stoppedBecause !== 'error' && result.stoppedBecause !== 'revoked'
            && result.stoppedBecause !== 'credentials_unreadable') {
            cursorAdvanced = true
          }
        } catch (error) {
          // Symmetric with runJob's own catch, which is where each of these is actually
          // resolved into a stoppedBecause today rather than thrown this far - kept here too in
          // case a future caller of runBackfill ever bypasses that translation.
          if (error instanceof RevokedError || error instanceof CredentialsUnreadableError) break
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
