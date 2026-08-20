import { ConfigError } from '../errors.ts'

export interface TokenBucketDeps { now: () => number, sleep: (ms: number) => Promise<void> }

// The household shares one project's quota, so a backfill walking a year of history has to leave
// room for the interactive sync somebody just pressed. Spec section 8.
export class TokenBucket {
  private tokens: number
  private lastRefillMs: number
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly config: { capacity: number, refillPerMinute: number },
    private readonly deps: TokenBucketDeps = { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
  ) {
    this.tokens = config.capacity
    this.lastRefillMs = deps.now()
  }

  available(nowMs: number): number {
    const elapsed = nowMs - this.lastRefillMs
    if (elapsed <= 0) return Math.floor(this.tokens)
    const gained = (elapsed / 60_000) * this.config.refillPerMinute
    const projected = Math.min(this.config.capacity, this.tokens + gained)
    return Math.floor(projected)
  }

  async take(cost = 1): Promise<void> {
    if (cost > this.config.capacity) {
      throw new ConfigError(`cost ${cost} exceeds bucket capacity ${this.config.capacity}`)
    }
    const result = this.tail.then(() => this.acquireTokens(cost), () => this.acquireTokens(cost))
    this.tail = result.catch(() => {})
    return result
  }

  private async acquireTokens(cost: number): Promise<void> {
    while (true) {
      this.refill(this.deps.now())
      if (this.tokens >= cost) {
        this.tokens -= cost
        return
      }
      const perMs = this.config.refillPerMinute / 60_000
      const shortfall = cost - this.tokens
      await this.deps.sleep(Math.ceil(shortfall / perMs))
    }
  }

  private refill(nowMs: number): void {
    const elapsed = nowMs - this.lastRefillMs
    if (elapsed <= 0) return
    const gained = (elapsed / 60_000) * this.config.refillPerMinute
    this.tokens = Math.min(this.config.capacity, this.tokens + gained)
    this.lastRefillMs = nowMs
  }
}
