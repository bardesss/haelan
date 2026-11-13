import { afterEach, describe, expect, it, vi } from 'vitest'
import { logDayFailed } from '../src/derive/logDayFailed.ts'

describe('logDayFailed', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('logs one line under the caller prefix with the error message only', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    logDayFailed('drainer')({ personId: 'p1', localDate: '2026-08-17' }, new Error('constraint failed'))
    logDayFailed('sync')({ personId: 'p1', localDate: '2026-08-18' }, 'not an error')
    expect(logged.mock.calls).toEqual([
      ['drainer: deriving p1 2026-08-17 failed, constraint failed'],
      ['sync: deriving p1 2026-08-18 failed, not an error'],
    ])
  })
})
