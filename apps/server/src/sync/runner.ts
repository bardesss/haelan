import { DATA_TYPES, RevokedError, TokenBucket, HealthClient, TokenProvider, runBackfill, runSync } from '@haelan/core'
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

export type RunReason = 'manual' | 'scheduled' | 'setup'

export interface RunOutcome {
  started: boolean
  reason?: 'already_running'
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

  constructor(context: ServerContext) { this.#context = context }

  subscribe(listener: (event: SyncProgress) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  status(): RunnerStatus {
    const backfill: BackfillSummary[] = []
    for (const person of this.#context.stores.people.list()) {
      for (const type of DATA_TYPES) {
        if (!type.listSupported) continue
        const state = this.#context.stores.syncState.get(person.id, type.id)
        backfill.push({
          dataType: type.id,
          complete: state?.backfillCompleteAtMs != null,
          cursorMs: state?.backfillCursorMs ?? null,
          horizonDays: type.backfillHorizonDays,
        })
      }
    }
    return {
      running: this.running,
      reason: this.reason,
      startedAtMs: this.startedAtMs,
      lastFinishedAtMs: this.lastFinishedAtMs,
      backfill,
    }
  }

  /**
   * Takes the mutex and returns immediately, leaving the run going. The browser pressing "sync
   * now" wants an answer before a backfill batch finishes, and the status route and the event
   * stream are how it follows the rest.
   */
  tryStart(reason: RunReason): RunOutcome {
    if (this.running) return { started: false, reason: 'already_running' }
    void this.trigger(reason)
    return { started: true }
  }

  // Refuses rather than queues. A queued second run would still be running when the next tick
  // arrives, and the useful answer to "sync now" while a sync runs is that one is already going.
  async trigger(reason: RunReason): Promise<RunOutcome> {
    if (this.running) return { started: false, reason: 'already_running' }
    this.running = true
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
    if (this.timer) return
    const minutes = this.#context.stores.settings.get()?.syncIntervalMinutes ?? 60
    this.timer = setInterval(() => { void this.trigger('scheduled') }, minutes * 60_000)
    // Without unref, an idle timer keeps the process alive through a shutdown that has already
    // closed the server.
    this.timer.unref()
  }

  stop(): void {
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
    }
  }

  private async run(): Promise<void> {
    const deps = this.buildDeps()
    const personIds = this.#context.stores.credentials.listConnectedPeople()
    if (personIds.length === 0) return

    // The trailing window first: today's data is what a dashboard shows, and a backfill that
    // takes an hour must not delay it.
    await runSync({ personIds, trailingDays: TRAILING_DAYS, deps })

    for (const personId of personIds) {
      const person = this.#context.stores.people.get(personId)
      if (!person) continue
      for (const dataType of DATA_TYPES) {
        if (!dataType.listSupported) continue
        try {
          await runBackfill({
            personId, timezone: person.timezone, dataType, nowMs: this.#context.now(),
            ...(this.#context.backfillBatchDays === undefined
              ? {}
              : { batchDays: this.#context.backfillBatchDays }),
            deps,
          })
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
  }
}

// Real wall clock, deliberately, even when the instance is running on an injected clock. The
// injected one stamps data; a limiter driven by a frozen test clock would never refill and the
// eleventh request of a run would wait forever.
function defaultLimiter(): RateLimiter {
  return new TokenBucket({ capacity: BUCKET_CAPACITY, refillPerMinute: REFILL_PER_MINUTE })
}
