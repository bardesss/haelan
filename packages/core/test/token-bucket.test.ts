import { describe, expect, it } from 'vitest'
import { TokenBucket } from '../src/sync/tokenBucket.ts'

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
})
