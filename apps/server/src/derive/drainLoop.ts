import { DRAIN_TICK_MS, drainOnce } from './drainer.ts'
import type { DrainDeps } from './drainer.ts'

/**
 * The timer that asks. Kept apart from drainOnce so the policy stays a pure function and this
 * class holds nothing but the schedule and the handle to cancel it, the same split
 * maintenance/tick.ts uses for the backup schedule, and for the same reason: a class with
 * start()/stop() is what index.ts already knows how to wire into shutdown, rather than a second,
 * differently shaped mechanism just for this one timer.
 *
 * Unref'd: a drain pending at shutdown must not hold the process open, and the days it did not
 * reach stay queued for the next tick or the next boot, whichever comes first.
 */
export class DrainLoop {
  readonly #deps: DrainDeps
  #timer: ReturnType<typeof setInterval> | null = null

  constructor(deps: DrainDeps) { this.#deps = deps }

  start(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => { drainOnce(this.#deps) }, DRAIN_TICK_MS)
    this.#timer.unref?.()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }
}
