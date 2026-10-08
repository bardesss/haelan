import { describe, it, expect, afterEach } from 'vitest'
import { DERIVATION_VERSION, PersonQuery, schema, shiftLocalDate } from '@haelan/core'
import { recoveryWindowStart, RECOVERY_METRIC_SOURCES } from '@haelan/core/recovery-index'
import type { RecoveryMetricSource } from '@haelan/core/recovery-index'
import { recoveryIndexTool } from '../src/mcp/tools/recovery.ts'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

/**
 * The spec's own cross-surface requirement (finding C of the final review): the MCP tool and the
 * web page must answer the same score for the same day, and a test proving that has to actually
 * exercise both of the surfaces that could diverge, not call one function twice and call that
 * proof.
 *
 * The MCP side calls `recoveryIndexTool.run` directly against a `PersonQuery`, exactly as
 * `apps/server/src/mcp/adapter.ts` does for a real tool call.
 *
 * The web side is the Recovery page's one read since its overview: it scores nothing itself, it
 * draws `GET /api/v1/p/:id/recovery/period`, whose hero strip carries a day's index as that day's
 * point and whose `days` carry the score and band its tap panel prints. So this test drives that
 * real HTTP route (rounded, re-judged and trimmed exactly as the browser receives it) and holds
 * both of those numbers to the MCP tool's for every day of the month. It was the browser's own
 * scoring over two /series reads until then, and its purpose is unchanged: one number, two
 * surfaces.
 *
 * If either surface started reading a different window, a different metric or agg for one of the
 * inputs, or rounding the score its own way, the two would answer a different score on some day
 * and this test would fail on the score, not merely on some incidental detail.
 */

let h: Harness | null = null
afterEach(async () => { await h?.cleanup(); h = null })

// 12:00 in Europe/Amsterdam on 10 September, so every day of August has happened.
const NOW_MS = Date.parse('2026-09-10T10:00:00Z')
const FROM = '2026-08-01'
const TO = '2026-08-31'
const START = recoveryWindowStart(FROM)
// A dip in HRV and a rise in resting heart rate, so the month's scores spread across the bands
// rather than all sitting at the usual's centre, where two surfaces could agree by accident.
const DIP_FROM = '2026-08-10'
const DIP_TO = '2026-08-16'

/**
 * Real rows for all five recovery metrics, oscillating gently around a centre so every 60-day
 * baseline has a real, non-zero spread to score against - the same shape
 * `packages/core/test/recovery-index.test.ts`'s own `history()` fixture uses, and for the same
 * reason: a literally flat series gives `baselineOf` a spread of zero and every z score null.
 */
function seedRecoveryDaily(h: Harness, personId: string): void {
  const centreOf = (key: RecoveryMetricSource['key']): number => ({
    hrv: 40, restingHeartRate: 55, respiratoryRate: 14, asleepMinutes: 430, bedtimeMinutes: 1380,
  })[key]
  const dipOf = (key: RecoveryMetricSource['key'], date: string): number => {
    if (date < DIP_FROM || date > DIP_TO) return 0
    return key === 'hrv' ? -8 : key === 'restingHeartRate' ? 4 : 0
  }
  let i = 0
  for (let date = START; date <= TO; date = shiftLocalDate(date, 1)) {
    for (const source of RECOVERY_METRIC_SOURCES) {
      const value = centreOf(source.key) + (i % 3) - 1 + dipOf(source.key, date)
      h.app.haelan.instance.db.insert(schema.daily).values({
        personId, localDate: date, metric: source.metric, agg: source.agg, source: 'merged',
        value, coverage: null, sourceMix: null, derivationVersion: DERIVATION_VERSION,
      }).run()
    }
    i += 1
  }
}

interface WirePoint { from: string, value: number | null }
interface WireDay { localDate: string, score: number, band: string }
interface WirePeriod { hero: { daily: WirePoint[] }, days: WireDay[] }

describe('recovery_index: the MCP tool and the Recovery page agree', () => {
  it('answers the same score and band for every day of a month, the page\'s strip and panel alike', async () => {
    h = await withServer()
    h.clock.nowMs = NOW_MS
    await h.completeSetup()
    seedRecoveryDaily(h, 'p1')
    const token = await h.signIn()

    // The MCP surface: recoveryIndexTool.run against a PersonQuery, exactly as adapter.ts calls it
    // for a real `tools/call`.
    const q = new PersonQuery(h.app.haelan.instance.db, 'p1')
    const mcpResult = recoveryIndexTool.run(q, { from: FROM, to: TO }) as {
      days: { localDate: string, enough: boolean, score: number | null, band: string | null }[]
    }
    const mcpScored = mcpResult.days.filter((day) => day.enough)

    // The web surface: the one read the Recovery page makes, through the real HTTP route.
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/v1/p/p1/recovery/period?range=month&anchor=${FROM}`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    const page = response.json() as WirePeriod
    const pointOn = new Map(page.hero.daily.map((point) => [point.from, point.value]))

    // Every day of the month scored, on both surfaces, and more than one band among them, so the
    // comparison below is over days that differ from one another.
    expect(mcpScored).toHaveLength(31)
    expect(new Set(mcpScored.map((day) => day.band)).size).toBeGreaterThan(1)

    // The panel's days, field for field, and the strip's points, day for day.
    expect(page.days.map((day) => ({ localDate: day.localDate, score: day.score, band: day.band })))
      .toEqual(mcpScored.map((day) => ({ localDate: day.localDate, score: day.score, band: day.band })))
    expect(mcpScored.map((day) => [day.localDate, pointOn.get(day.localDate)]))
      .toEqual(mcpScored.map((day) => [day.localDate, day.score]))
  })
})
