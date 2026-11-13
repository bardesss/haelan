import { afterEach, describe, expect, it, vi } from 'vitest'
import { logDayFailed } from '../src/derive/logDayFailed.ts'

describe('logDayFailed', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('logs one line under the caller prefix with the error message only', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    logDayFailed('drainer')({ personId: 'p1', localDate: '2026-08-17' }, new Error('constraint failed'), 1)
    logDayFailed('sync')({ personId: 'p1', localDate: '2026-08-18' }, 'not an error', 1)
    expect(logged.mock.calls).toEqual([
      ['drainer: deriving p1 2026-08-17 failed, constraint failed'],
      ['sync: deriving p1 2026-08-18 failed, not an error'],
    ])
  })

  it('stays silent for a repeat failure and speaks again every hundredth', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const entry = { personId: 'p1', localDate: '2026-08-21' }
    logDayFailed('drainer')(entry, new Error('poisoned day'), 2)
    expect(logged.mock.calls).toEqual([])
    logDayFailed('drainer')(entry, new Error('poisoned day'), 100)
    expect(logged.mock.calls).toEqual([
      ['drainer: deriving p1 2026-08-21 failed, poisoned day (100 attempts)'],
    ])
  })

  // Characterization: passes before the fix (today every call logs). Mutation: drop the
  // `failures === null` clause and nothing is logged.
  it('logs the plain line when the failure count is unknown', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    logDayFailed('drainer')({ personId: 'p1', localDate: '2026-08-21' }, new Error('poisoned day'), null)
    expect(logged.mock.calls).toEqual([['drainer: deriving p1 2026-08-21 failed, poisoned day']])
  })
})
