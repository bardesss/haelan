import { describe, expect, it } from 'vitest'
import { dashboardRows } from '../src/pages/dashboard/dashboardRows.js'
import { glanceBody, glanceFigure } from './glanceFixture.js'

const spans = (rows: ReturnType<typeof dashboardRows>) => rows.map((row) => row.map((s) => `${s.kind}:${s.span}${s.wide ? 'w' : ''}`).join(' '))

describe('dashboardRows', () => {
  it('everything present: night 8 + recovery 4, today 8 + week 4', () => {
    expect(spans(dashboardRows(glanceBody()))).toEqual(['night:8 recovery:4', 'today:8 week:4'])
  })
  it('no night: recovery takes the row in its wide layout', () => {
    expect(spans(dashboardRows({ ...glanceBody(), sleep: null }))).toEqual(['recovery:12w', 'today:8 week:4'])
  })
  it('recovery has nothing: the night takes the row', () => {
    const empty = glanceFigure({ metric: 'resting_heart_rate', value: null, asOfDate: null })
    const g = glanceBody()
    expect(spans(dashboardRows({ ...g, recovery: { ...g.recovery, index: { ...g.recovery.index, value: null }, restingHeartRate: empty, hrv: empty } })))
      .toEqual(['night:12', 'today:8 week:4'])
  })
  it('no week to show: today takes its row', () => {
    expect(spans(dashboardRows({ ...glanceBody(), week: { steps: null, activeMinutes: null, asleep: null } }))).toEqual(['night:8 recovery:4', 'today:12'])
  })
  it('no night and no recovery at all: the first row is omitted, not led by an empty recovery card', () => {
    const empty = glanceFigure({ metric: 'resting_heart_rate', value: null, asOfDate: null })
    const g = glanceBody()
    const noRecovery = { ...g.recovery, index: { ...g.recovery.index, value: null }, restingHeartRate: empty, hrv: empty }
    expect(spans(dashboardRows({ ...g, sleep: null, recovery: noRecovery }))).toEqual(['today:8 week:4'])
  })
  it('every row sums to twelve, in every combination, except the omitted top row', () => {
    const g = glanceBody()
    const emptyFigure = glanceFigure({ metric: 'resting_heart_rate', value: null, asOfDate: null })
    const noRecovery = { ...g.recovery, index: { ...g.recovery.index, value: null }, restingHeartRate: emptyFigure, hrv: emptyFigure }
    for (const sleep of [g.sleep, null]) for (const week of [g.week, { steps: null, activeMinutes: null, asleep: null }]) {
      for (const recovery of [g.recovery, noRecovery]) {
        const rows = dashboardRows({ ...g, sleep, week, recovery })
        // No night and no recovery reading: the top row is omitted rather than returned empty, so
        // there is exactly one row (today/week) instead of two.
        if (sleep === null && recovery === noRecovery) expect(rows).toHaveLength(1)
        for (const row of rows) expect(row.reduce((s, c) => s + c.span, 0)).toBe(12)
      }
    }
  })
})
