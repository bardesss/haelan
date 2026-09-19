import { describe, expect, it } from 'vitest'
import type { UseQueryResult } from '@tanstack/react-query'
import { recoveryFetchRange, selectRecoveryQuery } from '../src/data/useRecoveryIndex.js'
import { seriesPath } from '../src/data/useSeries.js'
import type { MetricSeries } from '../src/data/useSeries.js'

describe('recoveryFetchRange', () => {
  it('fetches back far enough for the oldest scored day to have a full window', () => {
    // 60 baseline days plus the six a sleep week needs behind the oldest of them.
    expect(recoveryFetchRange({ from: '2026-09-01', to: '2026-09-14' }).from).toBe('2026-06-27')
    expect(recoveryFetchRange({ from: '2026-09-01', to: '2026-09-14' }).to).toBe('2026-09-14')
  })
})

describe('/series request shape', () => {
  it('requests an unthinned series, because a point budget must not move the number', () => {
    const path = seriesPath('p1', ['daily_hrv'], { from: '2026-06-27', to: '2026-09-14', source: 'all' }, 'last')
    expect(path.includes('points=')).toBe(false)
  })
})

describe('selectRecoveryQuery', () => {
  const settled = (data: Record<string, MetricSeries>) =>
    ({ isError: false, isPending: false, data, error: null } as unknown as
      UseQueryResult<Record<string, MetricSeries>>)

  const errored = (error: Error) =>
    ({ isError: true, isPending: false, data: undefined, error } as unknown as
      UseQueryResult<Record<string, MetricSeries>>)

  const pending = () =>
    ({ isError: false, isPending: true, data: undefined, error: null } as unknown as
      UseQueryResult<Record<string, MetricSeries>>)

  it('surfaces the sum query error rather than reporting a silent data shortage', () => {
    // The bug this guards: lastQuery alone is neither erroring nor pending here, so a caller
    // reading only lastQuery would see byDate stay undefined with no error and no pending state -
    // indistinguishable from "not enough recent data" when what actually happened was a failed
    // request for sleep_asleep_minutes.
    const error = new Error('sum query failed')
    const lastQuery = settled({ daily_hrv: { points: [], reduction: null } })
    const sumQuery = errored(error)
    const query = selectRecoveryQuery(lastQuery, sumQuery)
    expect(query.isError).toBe(true)
    expect(query.error).toBe(error)
  })

  it('surfaces an error over a pending state on the other query', () => {
    const error = new Error('last query failed')
    const lastQuery = errored(error)
    const sumQuery = pending()
    const query = selectRecoveryQuery(lastQuery, sumQuery)
    expect(query.isError).toBe(true)
    expect(query.error).toBe(error)
  })

  it('surfaces a pending sum query when the last query has already settled', () => {
    const lastQuery = settled({ daily_hrv: { points: [], reduction: null } })
    const sumQuery = pending()
    const query = selectRecoveryQuery(lastQuery, sumQuery)
    expect(query.isPending).toBe(true)
  })

  it('falls back to the last query once both have settled without error', () => {
    const lastQuery = settled({ daily_hrv: { points: [], reduction: null } })
    const sumQuery = settled({ sleep_asleep_minutes: { points: [], reduction: null } })
    const query = selectRecoveryQuery(lastQuery, sumQuery)
    expect(query).toBe(lastQuery)
  })
})
