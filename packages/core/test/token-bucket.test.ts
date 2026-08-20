import { describe, expect, it } from 'vitest'
import { TokenBucket } from '../src/sync/tokenBucket.ts'
import { ConfigError } from '../src/errors.ts'

const controllable = () => {
  let now = 0
  const slept: number[] = []
  return {
    deps: { now: () => now, sleep: async (ms: number) => { slept.push(ms); now += ms } },
    slept,
    advance: (ms: number) => { now += ms },
  }
}

describe('TokenBucket', () => {
  it('lets a burst through up to its capacity without waiting', async () => {
    const c = controllable()
    const bucket = new TokenBucket({ capacity: 5, refillPerMinute: 60 }, c.deps)
    for (let i = 0; i < 5; i++) await bucket.take()
    expect(c.slept).toEqual([])
  })

  it('waits once the burst is spent, rather than refusing', async () => {
    const c = controllable()
    const bucket = new TokenBucket({ capacity: 2, refillPerMinute: 60 }, c.deps)
    await bucket.take()
    await bucket.take()
    await bucket.take()
    expect(c.slept.length).toBe(1)
    expect(c.slept[0]).toBeGreaterThan(0)
  })

  it('refills over time, so a caller that pauses is not penalised', async () => {
    const c = controllable()
    const bucket = new TokenBucket({ capacity: 10, refillPerMinute: 60 }, c.deps)
    for (let i = 0; i < 10; i++) await bucket.take()
    c.advance(5000)
    expect(bucket.available(c.deps.now())).toBeGreaterThanOrEqual(5)
  })

  it('never refills past its capacity, because an idle night is not a quota bank', async () => {
    const c = controllable()
    const bucket = new TokenBucket({ capacity: 10, refillPerMinute: 60 }, c.deps)
    c.advance(86_400_000)
    expect(bucket.available(c.deps.now())).toBe(10)
  })

  it('charges a caller that asks for several at once', async () => {
    const c = controllable()
    const bucket = new TokenBucket({ capacity: 10, refillPerMinute: 60 }, c.deps)
    await bucket.take(10)
    expect(bucket.available(c.deps.now())).toBe(0)
  })

  it('refuses a cost it can never satisfy rather than sleeping forever', async () => {
    const c = controllable()
    const bucket = new TokenBucket({ capacity: 5, refillPerMinute: 60 }, c.deps)
    await expect(bucket.take(6)).rejects.toThrow(/capacity/)
  })

  it('underdelivering sleep does not grant tokens early or drive negative balance', async () => {
    const c = controllable()
    const underdeliveringDeps = {
      now: c.deps.now,
      sleep: async (ms: number) => {
        c.advance(Math.ceil(ms / 3))
      },
    }
    const bucket = new TokenBucket({ capacity: 1, refillPerMinute: 60 }, underdeliveringDeps)
    await bucket.take()
    await bucket.take()
    expect(bucket.available(c.deps.now())).toBeGreaterThanOrEqual(0)
  })

  it('concurrent takes queue and complete in order, not out of order when the queue is skipped', async () => {
    const c = controllable()
    const bucket = new TokenBucket({ capacity: 1, refillPerMinute: 60 }, c.deps)
    await bucket.take()
    const completionOrder: number[] = []
    const promise1 = bucket.take(1).then(() => { completionOrder.push(1) })
    const promise2 = bucket.take(1).then(() => { completionOrder.push(2) })
    await Promise.all([promise1, promise2])
    expect(completionOrder).toEqual([1, 2])
  })

  it('available() with future timestamp does not bank unearned quota', async () => {
    const c = controllable()
    const bucket = new TokenBucket({ capacity: 5, refillPerMinute: 60 }, c.deps)
    for (let i = 0; i < 5; i++) await bucket.take()
    const futureTime = c.deps.now() + 1000
    const futureAvailable = bucket.available(futureTime)
    expect(bucket.available(c.deps.now())).toBe(0)
    c.advance(1000)
    expect(bucket.available(c.deps.now())).toBe(futureAvailable)
  })

  it('refuses a non positive refill rate rather than waiting for a token that never arrives', () => {
    // The wait for a token would be Infinity, which Node clamps to a millisecond, so take would
    // spin instead of either succeeding or failing. M1d configures this from settings.
    expect(() => new TokenBucket({ capacity: 5, refillPerMinute: 0 })).toThrow(ConfigError)
    expect(() => new TokenBucket({ capacity: 5, refillPerMinute: 0 })).toThrow(/refillPerMinute/)
    expect(() => new TokenBucket({ capacity: 5, refillPerMinute: -1 })).toThrow(/refillPerMinute/)
  })

  it('refuses a non positive capacity, which no cost could ever fit inside', () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerMinute: 60 })).toThrow(ConfigError)
    expect(() => new TokenBucket({ capacity: 0, refillPerMinute: 60 })).toThrow(/capacity/)
    expect(() => new TokenBucket({ capacity: -1, refillPerMinute: 60 })).toThrow(/capacity/)
  })
})
