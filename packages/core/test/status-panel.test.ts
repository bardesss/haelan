import { describe, expect, it } from 'vitest'
import { composeStatus, shownByDefault } from '../src/api/statusPanel.ts'
import type { StatusInput } from '../src/api/statusPanel.ts'

const RUN = { running: false, lastFinishedAtMs: 1_000, lastRowsWritten: 0, lastFailed: 0, cooldownRemainingMs: 0 }
function input(over: Partial<StatusInput> = {}): StatusInput {
  return {
    today: '2026-09-24', nowMs: 10_000_000,
    google: { state: 'connected' }, run: RUN,
    phone: { lastUploadAtMs: null, sourceIds: new Set() },
    activity: [], names: new Map(), choices: new Map(),
    ...over,
  }
}
const seen = (
  sourceId: string, lastReportedDate: string | null, status: 'reporting' | 'stale' | 'unjudged' = 'reporting',
  continuedElsewhere = false, routineMetrics: string[] = [],
) => ({ sourceId, lastReportedDate, status, continuedElsewhere, routineMetrics })

describe('shownByDefault', () => {
  it('shows a date exactly on the 30-day boundary', () => {
    expect(shownByDefault('2026-08-25', '2026-09-24')).toBe(true)
  })

  it('hides a date one day past the 30-day boundary', () => {
    expect(shownByDefault('2026-08-24', '2026-09-24')).toBe(false)
  })

  it('hides a null lastReportedDate', () => {
    expect(shownByDefault(null, '2026-09-24')).toBe(false)
  })
})

describe('composeStatus', () => {
  it('shows no connection a household does not have', () => {
    const panel = composeStatus(input({ google: { state: 'none' } }))
    expect(panel.connections).toEqual([])
    expect(panel.sync).toBeNull()
  })

  it('drops Google-attributed devices without counting them hidden when Google state is none', () => {
    const panel = composeStatus(input({
      google: { state: 'none' },
      activity: [seen('old-google-device', '2026-09-20')],
    }))
    expect(panel.connections).toEqual([])
    expect(panel.hiddenDevices).toBe(0)
  })

  it('puts a device under the phone when the phone delivered it, and everything else under Google', () => {
    const panel = composeStatus(input({
      phone: { lastUploadAtMs: 9_000_000, sourceIds: new Set(['hc-watch']) },
      activity: [seen('fitbit-watch', '2026-09-24'), seen('hc-watch', '2026-09-23')],
    }))
    expect(panel.connections.map((c) => [c.kind, c.devices.map((d) => d.sourceId)]))
      .toEqual([['google', ['fitbit-watch']], ['phone', ['hc-watch']]])
  })

  it('shows a source by default only if it reported in the last 30 days', () => {
    const panel = composeStatus(input({ activity: [seen('recent', '2026-08-26'), seen('old', '2026-08-24')] }))
    expect(panel.connections[0]!.devices.map((d) => d.sourceId)).toEqual(['recent'])
    expect(panel.hiddenDevices).toBe(1)
  })

  it('lets an explicit choice override the default either way', () => {
    const panel = composeStatus(input({
      activity: [seen('recent', '2026-09-24'), seen('old', '2025-01-01')],
      choices: new Map([['recent', false], ['old', true]]),
    }))
    expect(panel.connections[0]!.devices.map((d) => [d.sourceId, d.choice])).toEqual([['old', true]])
  })

  it('counts a stale visible device as a problem, and a continued or hidden one as none', () => {
    const panel = composeStatus(input({
      activity: [
        seen('dead', '2026-09-01', 'stale'),
        seen('renamed', '2026-09-01', 'stale', true),
        seen('hiddenDead', '2026-09-01', 'stale'),
      ],
      choices: new Map([['hiddenDead', false]]),
    }))
    expect(panel.connections[0]!.devices.map((d) => [d.sourceId, d.stale])).toEqual([['dead', true], ['renamed', false]])
    expect(panel.problems).toBe(1)
  })

  it('flags a revoked Google connection and keeps its Sync out', () => {
    const panel = composeStatus(input({ google: { state: 'revoked' } }))
    expect(panel.connections[0]).toMatchObject({ kind: 'google', problem: 'revoked' })
    expect(panel.problems).toBe(1)
  })

  it('flags a run that had failures', () => {
    const panel = composeStatus(input({ run: { ...RUN, lastFailed: 2 } }))
    expect(panel.connections[0]!.problem).toBe('sync_failed')
  })

  it('flags a phone that has not uploaded for more than a day', () => {
    const quiet = composeStatus(input({ phone: { lastUploadAtMs: 10_000_000 - 24 * 3_600_000 - 1, sourceIds: new Set() } }))
    const fine = composeStatus(input({ phone: { lastUploadAtMs: 10_000_000 - 24 * 3_600_000, sourceIds: new Set() } }))
    expect(quiet.connections.find((c) => c.kind === 'phone')!.problem).toBe('phone_quiet')
    expect(fine.connections.find((c) => c.kind === 'phone')!.problem).toBeNull()
  })

  it('names devices by their alias-resolved name and orders them most recent first', () => {
    const panel = composeStatus(input({
      activity: [seen('a', '2026-09-20'), seen('b', '2026-09-24')],
      names: new Map([['a', 'Scale'], ['b', 'Watch']]),
    }))
    expect(panel.connections[0]!.devices.map((d) => d.name)).toEqual(['Watch', 'Scale'])
  })

  it('lists what a stale device reported routinely, and nothing for a device that is not stale', () => {
    // 'renamed' carries a routine list too, since continuedElsewhere was judged over it, and
    // 'reporting' is handed one to prove the gate is the verdict rather than the input's shape.
    const panel = composeStatus(input({
      activity: [
        seen('dead', '2026-09-01', 'stale', false, ['heart_rate', 'steps']),
        seen('renamed', '2026-09-01', 'stale', true, ['steps']),
        seen('fine', '2026-09-24', 'reporting', false, ['steps']),
      ],
    }))
    expect(panel.connections[0]!.devices.map((d) => [d.sourceId, d.metrics])).toEqual([
      ['fine', []], ['dead', ['heart_rate', 'steps']], ['renamed', []],
    ])
  })
})
