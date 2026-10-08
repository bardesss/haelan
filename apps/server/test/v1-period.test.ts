import { describe, it, expect, afterEach } from 'vitest'
import { DERIVATION_VERSION, highOf, lowOf, periodBounds, schema, shiftLocalDate } from '@haelan/core'
import type { ActivityPeriod, PeriodFigure, PeriodStripPoint, RecoveryDay, RecoveryPeriod, SleepPeriod } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'
import { roundHrvDeviationDay } from '../src/routes/v1/shared.ts'
import { roundActivityPeriod, roundPeriodFigure, roundRecoveryPeriod, roundSleepPeriod } from '../src/routes/v1/period.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

// 12:00 in Europe/Amsterdam (every harness person's zone), a Thursday, so p1's today is 2026-09-10.
const NOW_MS = Date.parse('2026-09-10T10:00:00Z')
// A finished Monday-to-Sunday week before today, and the first day of the twelve weeks it is judged against.
const WEEK = '2026-08-31'
const HISTORY_FROM = shiftLocalDate(WEEK, -7 * 12)

async function get(h: Harness, token: string, path: string, extraHeaders: Record<string, string> = {}) {
  return h.app.inject({ method: 'GET', url: `/api/v1/p/p1${path}`, headers: { authorization: `Bearer ${token}`, ...extraHeaders } })
}

function seedDaily(h: Harness, localDate: string, metric: string, value: number): void {
  seedDailyAgg(h, localDate, metric, 'sum', value)
}

function seedDailyAgg(h: Harness, localDate: string, metric: string, agg: string, value: number): void {
  h.app.haelan.instance.db.insert(schema.daily).values({
    personId: 'p1', localDate, metric, agg, source: 'merged', value, coverage: 1, sourceMix: null,
    derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
  }).run()
}

function seedSource(h: Harness, id: string): void {
  h.app.haelan.instance.db.insert(schema.sources).values({
    id, personId: 'p1', externalId: id, displayName: id, kind: 'device', createdAtMs: 0,
  }).run()
}

/** Twelve weeks of nights at `usual` before WEEK, then WEEK's seven nights at `week`. */
function seedSleep(h: Harness, usual: number, week: number): void {
  for (let d = HISTORY_FROM; d < WEEK; d = shiftLocalDate(d, 1)) seedDaily(h, d, 'sleep_asleep_minutes', usual)
  for (let i = 0; i < 7; i += 1) seedDaily(h, shiftLocalDate(WEEK, i), 'sleep_asleep_minutes', week)
}

async function started(): Promise<{ h: Harness, token: string }> {
  harness = await withServer()
  harness.clock.nowMs = NOW_MS
  return { h: harness, token: await harness.signIn() }
}

describe('GET /sleep/period and /activity/period', () => {
  it('answers each overview for the period periodBounds names', async () => {
    const { h, token } = await started()
    seedSleep(h, 400, 400)
    for (const [path, range] of [['/sleep/period', 'month'], ['/activity/period', '3months']] as const) {
      const response = await get(h, token, `${path}?range=${range}&anchor=2026-08-14`)
      expect(response.statusCode).toBe(200)
      const { from, to } = periodBounds(range, '2026-08-14')
      expect(response.json().period).toMatchObject({ range, from, to })
    }
  })

  it('refuses a day range, an unknown range, a missing or malformed anchor and a period not yet started', async () => {
    const { h, token } = await started()
    for (const path of ['/sleep/period', '/activity/period']) {
      for (const query of [
        'range=day&anchor=2026-09-01', 'range=quarter&anchor=2026-09-01', 'anchor=2026-09-01',
        'range=month', 'range=month&anchor=2026-13-01', 'range=week&anchor=2026-09-14',
      ]) {
        const response = await get(h, token, `${path}?${query}`)
        expect(response.statusCode, `${path}?${query}`).toBe(400)
        expect(response.json()).toMatchObject({ error: { kind: 'config' } })
      }
    }
    // The running week is not a future one: it started on Monday.
    expect((await get(h, token, '/sleep/period?range=week&anchor=2026-09-10')).statusCode).toBe(200)
  })

  it('answers 304 to a repeat request carrying the first one\'s ETag', async () => {
    const { h, token } = await started()
    seedSleep(h, 400, 400)
    for (const path of ['/sleep/period', '/activity/period']) {
      const first = await get(h, token, `${path}?range=week&anchor=${WEEK}`)
      expect(first.statusCode).toBe(200)
      const again = await get(h, token, `${path}?range=week&anchor=${WEEK}`, { 'if-none-match': first.headers.etag as string })
      expect(again.statusCode).toBe(304)
    }
  })

  // Twelve weeks at 400 make a usual of exactly 400 (no spread). Core judges the week's 400.4 above
  // it, and so better; on the wire both are 400, so the page must say within and claim no verdict.
  it('re-judges the hero and every day on the rounded numbers, and counts the days as drawn', async () => {
    const { h, token } = await started()
    seedSleep(h, 400, 400.4)
    const body = (await get(h, token, `/sleep/period?range=week&anchor=${WEEK}`)).json()
    expect(body.hero.value).toBe(400)
    expect(body.hero.usual).toMatchObject({ center: 400, low: 400, high: 400, thin: false })
    expect(body.hero.standing).toBe('within')
    expect(body.hero.judged).toBeNull()
    // Each night sits a hair above its own band before rounding and on its edge after.
    expect(body.hero.daily.map((p: PeriodStripPoint) => p.standing)).toEqual(Array(7).fill('within'))
    expect(body.hero.counts).toEqual({ within: 7, above: 0, below: 0, unjudged: 0 })
    expect(body.nights).toHaveLength(7)
    expect(body.nights.every((n: { good: boolean, asleepMinutes: number }) => !n.good && n.asleepMinutes === 400)).toBe(true)
  })

  it('treats source=all as no source, and refuses an unknown or derived source as /insights does', async () => {
    const { h, token } = await started()
    seedSource(h, 'watch')
    seedSleep(h, 400, 410)
    for (const path of ['/sleep/period', '/activity/period']) {
      const bare = await get(h, token, `${path}?range=week&anchor=${WEEK}`)
      const all = await get(h, token, `${path}?range=week&anchor=${WEEK}&source=all`)
      expect(all.statusCode).toBe(200)
      expect(all.body).toBe(bare.body)
      expect((await get(h, token, `${path}?range=week&anchor=${WEEK}&source=watch`)).statusCode).toBe(200)
      for (const source of ['nope', 'merged']) {
        const refused = await get(h, token, `${path}?range=week&anchor=${WEEK}&source=${source}`)
        expect(refused.statusCode, `${path} ${source}`).toBe(400)
        expect(refused.json()).toMatchObject({ error: { kind: 'config' } })
      }
    }
    // /insights answers an unknown source the same way.
    expect((await get(h, token, '/insights?metric=steps&agg=sum&from=2026-08-01&to=2026-08-31&source=nope')).statusCode).toBe(400)
  })

  it('passes the person\'s own sleep target and baseline choice to the balance', async () => {
    const { h, token } = await started()
    seedSleep(h, 400, 400)
    const people = h.app.haelan.stores.people
    // With the baseline on and a full twelve weeks behind it, the line is the usual.
    const onBaseline = (await get(h, token, `/sleep/period?range=week&anchor=${WEEK}`)).json()
    expect(onBaseline.balance.zeroLine).toEqual({ minutes: 400, source: 'baseline' })
    people.setSleepUseBaseline('p1', false)
    people.setSleepTargetMinutes('p1', 480)
    const target = (await get(h, token, `/sleep/period?range=week&anchor=${WEEK}`)).json()
    expect(target.balance.zeroLine).toEqual({ minutes: 480, source: 'target' })
    expect(target.balance.total).toBe(7 * (400 - 480))
    people.setSleepTargetMinutes('p1', 450)
    expect((await get(h, token, `/sleep/period?range=week&anchor=${WEEK}`)).json().balance.zeroLine).toEqual({ minutes: 450, source: 'target' })
  })
})

// Every figure in a section, however deep, found the way trimForWire finds them.
interface WireFigure { daily: unknown[], weekly: unknown[] | null, counts: Record<string, number> }
function figuresIn(value: unknown): WireFigure[] {
  if (typeof value !== 'object' || value === null) return []
  if ('daily' in value && 'counts' in value) return [value as unknown as WireFigure]
  return Object.values(value).flatMap(figuresIn)
}

function sections(body: Record<string, unknown>) {
  const { hero, more, ...rest } = body
  return { hero: hero as { daily: unknown[] }, more: figuresIn(more), others: figuresIn(rest) }
}

describe('the wire trims the strips the page never draws', () => {
  // Ten days in 2025, so every section shows; the year and quarter asked for are finished ones.
  function seedYear(h: Harness): void {
    for (let i = 0; i < 10; i += 1) {
      const d = shiftLocalDate('2025-03-01', i)
      for (const metric of ['sleep_asleep_minutes', 'sleep_deep_minutes', 'sleep_light_minutes', 'sleep_in_bed_minutes', 'steps', 'distance', 'active_minutes_light', 'total_calories']) {
        seedDaily(h, d, metric, 100 + i)
      }
      for (const metric of ['sleep_bedtime_minutes', 'sleep_waketime_minutes', 'resting_heart_rate']) seedDailyAgg(h, d, metric, 'last', 60 + i)
    }
  }

  for (const path of ['/sleep/period', '/activity/period']) {
    for (const range of ['year', '3months'] as const) {
      it(`${path} ${range}: the hero keeps its days, the rest keep only weeks, and more keeps neither`, async () => {
        const { h, token } = await started()
        seedYear(h)
        const body = (await get(h, token, `${path}?range=${range}&anchor=2025-03-05`)).json()
        const { hero, more, others } = sections(body)
        expect(hero.daily.length).toBeGreaterThan(range === 'year' ? 300 : 80)
        expect(others.length).toBeGreaterThan(1)
        for (const f of others) {
          expect(f.daily).toHaveLength(0)
          expect(f.weekly).not.toBeNull()
        }
        expect(more.length).toBeGreaterThan(0)
        for (const f of more) expect([f.daily.length, f.weekly]).toEqual([0, null])
        // Counts were taken before the trim, from the days no longer sent.
        expect(others.some((f) => Object.values(f.counts).some((n) => n > 0))).toBe(true)
      })
    }

    it(`${path} month: the other figures keep their days, more still keeps none`, async () => {
      const { h, token } = await started()
      seedYear(h)
      const body = (await get(h, token, `${path}?range=month&anchor=2025-03-05`)).json()
      const { hero, more, others } = sections(body)
      expect(hero.daily.length).toBe(31)
      expect(others.length).toBeGreaterThan(1)
      for (const f of others) expect(f.daily).toHaveLength(31)
      expect(more.length).toBeGreaterThan(0)
      for (const f of more) expect([f.daily.length, f.weekly]).toEqual([0, null])
    })
  }
})

// The rounding itself, on synthetic figures, so each rule is pinned by the number it changes.
const band = (center: number, low: number, high: number) => ({ center, low, high, thin: false })
const WINDOW = { unit: 'week' as const, count: 12, from: '2026-06-08', to: '2026-08-30' }

function point(from: string, value: number | null, b: PeriodStripPoint['band'], standing: PeriodStripPoint['standing'], judged: PeriodStripPoint['judged']): PeriodStripPoint {
  return { from, to: from, value, band: b, standing, judged, days: value === null ? 0 : 1 }
}

function figure(over: Partial<PeriodFigure> = {}): PeriodFigure {
  return {
    metric: 'sleep_asleep_minutes', unit: 'minutes', precision: 0, direction: 'up', per: 'day',
    value: 400.4, total: 2802.8, days: 7, usual: { ...band(400.2, 399.8, 400.3), window: WINDOW, periods: 12 },
    usualTotal: null, totalStanding: null, totalJudged: null,
    standing: 'above', judged: 'better', reason: null, counts: { within: 0, above: 1, below: 1, unjudged: 0 },
    daily: [
      point('2026-08-31', 400.4, band(400, 400, 400), 'above', 'better'),
      point('2026-09-01', 380, band(400, 390, 410), 'below', 'worse'),
    ],
    weekly: null,
    ...over,
  }
}

describe('roundPeriodFigure', () => {
  it('rounds the value, total, usual, days and weeks, and re-judges each on its rounded pair', () => {
    const rounded = roundPeriodFigure(figure({
      weekly: [{ ...point('2026-08-31', 400.3, band(400, 400, 400), 'above', 'better'), to: '2026-09-06', days: 7 }],
    }))
    expect(rounded.value).toBe(400)
    expect(rounded.total).toBe(2803)
    expect(rounded.usual).toEqual({ center: 400, low: 400, high: 400, thin: false, window: WINDOW, periods: 12 })
    expect([rounded.standing, rounded.judged]).toEqual(['within', null])
    expect(rounded.daily.map((p) => [p.value, p.standing, p.judged])).toEqual([[400, 'within', null], [380, 'below', 'worse']])
    expect(rounded.weekly!.map((p) => [p.value, p.standing, p.judged])).toEqual([[400, 'within', null]])
    expect(rounded.counts).toEqual({ within: 1, above: 0, below: 1, unjudged: 0 })
  })

  it('rounds the usual of the total and judges the rounded total against it again', () => {
    const rounded = roundPeriodFigure(figure({
      usualTotal: { ...band(2700, 2600.2, 2802.6), window: WINDOW, periods: 12 }, totalStanding: 'above', totalJudged: 'better',
    }))
    // 2802.8 is above 2802.6, but 2803 is not above the 2803 the page prints.
    expect(rounded.usualTotal).toEqual({ center: 2700, low: 2600, high: 2803, thin: false, window: WINDOW, periods: 12 })
    expect([rounded.totalStanding, rounded.totalJudged]).toEqual(['within', null])
  })

  it("keeps a total core left unjudged, for a running period or one under 70% of its days", () => {
    const rounded = roundPeriodFigure(figure({
      usualTotal: { ...band(2000, 1900, 2100), window: WINDOW, periods: 12 }, totalStanding: null, totalJudged: null,
    }))
    expect([rounded.totalStanding, rounded.totalJudged]).toEqual([null, null])
  })

  it('keeps a standing core left null, and the reason with it', () => {
    const rounded = roundPeriodFigure(figure({ standing: null, judged: null, reason: 'too-few-days' }))
    expect([rounded.standing, rounded.judged, rounded.reason]).toEqual([null, null, 'too-few-days'])
  })
})

const HEADER = { range: 'week' as const, from: '2026-08-31', to: '2026-09-06', today: '2026-09-10', periodDays: 7, daysSoFar: 7, partial: false }

describe('roundSleepPeriod', () => {
  it('takes the high, the changes, the balance and the nights list again from the rounded hero', () => {
    const hero = figure({
      daily: [
        point('2026-08-31', 400.4, band(400, 400, 400), 'above', 'better'),
        point('2026-09-01', 400.6, band(401, 401, 401), 'below', 'worse'),
      ],
    })
    // Signed minutes from the wake day's midnight, as stored (derive/sleep.ts): 23:00 is -60.
    const bedtime = figure({
      metric: 'sleep_bedtime_minutes', direction: 'neutral', value: -59.6, total: null, usual: null, standing: null, judged: null,
      daily: [point('2026-08-31', -59.6, null, null, null), point('2026-09-01', -58.4, null, null, null)],
    })
    const period: SleepPeriod = {
      period: HEADER, hero,
      high: { localDate: '2026-09-01', value: 400.6, good: false },
      previous: { from: '2026-08-24', to: '2026-08-30', value: 390.6, delta: 9.8 },
      yearEarlier: { from: '2025-08-31', to: '2025-09-06', value: null, delta: null },
      figures: [bedtime],
      stages: { deep: null, light: null, rem: null, awake: null, shares: { deep: 0.20049, light: 0.5, rem: 0.2, awake: 0.09951 } },
      schedule: {
        bedtime, waketime: null, variability: null,
        sides: { weekday: { bedtimeMinutes: -59.6, waketimeMinutes: 420.6, nights: 5 }, weekend: null },
      },
      balance: {
        zeroLine: { minutes: 400.4, source: 'baseline' }, values: [0, 0.2], total: 0.2,
        weekly: [{ from: '2026-08-31', to: '2026-09-01', value: 0.2 }],
      },
      mornings: [], more: [],
      // The weekend flags are deliberately not these dates' own: the route passes a date's flag through.
      nights: [
        { localDate: '2026-09-01', sourceId: 'watch', asleepMinutes: 400.6, bedtimeMinutes: -58.4, waketimeMinutes: null, standing: 'below', judged: 'worse', good: false, weekend: true },
        { localDate: '2026-08-31', sourceId: 'watch', asleepMinutes: 400.4, bedtimeMinutes: -59.6, waketimeMinutes: null, standing: 'above', judged: 'better', good: true, weekend: false },
      ],
      months: [{ month: '2026-09', nights: 1, asleepMinutes: 400.6 }, { month: '2026-08', nights: 1, asleepMinutes: 400.4 }],
    }
    const rounded = roundSleepPeriod(period)
    expect(rounded.high).toEqual({ localDate: '2026-09-01', value: 401, good: false })
    // 400 against 391 is 9, though the unrounded difference is 9.8.
    expect(rounded.previous).toMatchObject({ value: 391, delta: 9 })
    expect(rounded.yearEarlier).toMatchObject({ value: null, delta: null })
    expect(rounded.stages.shares).toEqual({ deep: 0.2, light: 0.5, rem: 0.2, awake: 0.1 })
    expect(rounded.schedule.sides.weekday).toEqual({ bedtimeMinutes: -60, waketimeMinutes: 421, nights: 5 })
    expect(rounded.balance).toEqual({
      zeroLine: { minutes: 400, source: 'baseline' }, values: [0, 1], total: 1,
      weekly: [{ from: '2026-08-31', to: '2026-09-01', value: 1 }],
    })
    expect(rounded.nights).toEqual([
      { localDate: '2026-09-01', sourceId: 'watch', asleepMinutes: 401, bedtimeMinutes: -58, waketimeMinutes: null, standing: 'within', judged: null, good: false, weekend: true },
      { localDate: '2026-08-31', sourceId: 'watch', asleepMinutes: 400, bedtimeMinutes: -60, waketimeMinutes: null, standing: 'within', judged: null, good: false, weekend: false },
    ])
    expect(rounded.months).toEqual([{ month: '2026-09', nights: 1, asleepMinutes: 401 }, { month: '2026-08', nights: 1, asleepMinutes: 400 }])
    expect(rounded.figures[0]!.value).toBe(-60)
    expect(roundSleepPeriod({ ...period, balance: null }).balance).toBeNull()
  })

  it("rounds a month's mean of the rounded nights to the hero's precision", () => {
    const hero = figure({
      daily: [point('2026-09-01', 400.4, null, null, null), point('2026-09-02', 400.6, null, null, null)],
    })
    const empty = { deep: null, light: null, rem: null, awake: null, shares: null }
    const period: SleepPeriod = {
      period: HEADER, hero, high: null,
      previous: { from: '2026-08-24', to: '2026-08-30', value: null, delta: null },
      yearEarlier: { from: '2025-08-31', to: '2025-09-06', value: null, delta: null },
      figures: [], stages: empty,
      schedule: { bedtime: null, waketime: null, variability: null, sides: { weekday: null, weekend: null } },
      balance: null, mornings: [], more: [], nights: [], months: [],
    }
    // 400 and 401 average 400.5, sent whole.
    expect(roundSleepPeriod(period).months).toEqual([{ month: '2026-09', nights: 2, asleepMinutes: 401 }])
  })
})

describe('roundHrvDeviationDay', () => {
  const day = (rolling: number, low: number, high: number, side: 'below' | 'within' | 'above') =>
    ({ localDate: '2026-08-31', measured: true as const, rolling, band: { low, high }, side })

  // Rounding is monotone, so a day that core put outside its band can only land on the band's edge
  // or inside it after rounding, never on the far side; the two moves that exist are below to within
  // and above to within, and a day within can stay within only.
  it('judges a day above its band as within when the rounded rolling mean meets the rounded high', () => {
    expect(roundHrvDeviationDay(day(50.4, 40.04, 49.96, 'above'))).toEqual(day(50, 40, 50, 'within'))
  })

  it('judges a day below its band as within when the rounded rolling mean meets the rounded low', () => {
    expect(roundHrvDeviationDay(day(39.6, 40.4, 49.96, 'below'))).toEqual(day(40, 40, 50, 'within'))
  })
  it('keeps a side the rounded numbers still support, and leaves an unmeasured day alone', () => {
    expect(roundHrvDeviationDay(day(52.4, 40.04, 49.96, 'above'))).toMatchObject({ side: 'above' })
    expect(roundHrvDeviationDay(day(30.2, 40.04, 49.96, 'below'))).toMatchObject({ side: 'below' })
    expect(roundHrvDeviationDay(day(45.2, 40.04, 49.96, 'within'))).toMatchObject({ side: 'within' })
    const unmeasured = { localDate: '2026-08-31', measured: false as const, reason: 'thin-week' as const }
    expect(roundHrvDeviationDay(unmeasured)).toEqual(unmeasured)
  })
})

describe('roundRecoveryPeriod', () => {
  function recovery(over: Partial<RecoveryPeriod> = {}): RecoveryPeriod {
    const hero = figure({
      metric: 'recovery_index', unit: 'score', precision: 0, value: 61, total: null, usual: null,
      daily: [point('2026-08-31', 61, band(50, 40, 60), 'above', 'better'), point('2026-09-01', 58, band(50, 40, 60), 'within', null)],
    })
    return {
      period: HEADER, hero,
      high: { localDate: '2026-08-31', value: 61, good: true },
      low: { localDate: '2026-09-01', value: 58, good: false },
      previous: { from: '2026-08-24', to: '2026-08-30', value: 55.6, delta: 5.4 },
      yearEarlier: { from: '2025-08-31', to: '2025-09-06', value: null, delta: null },
      carriedBy: 'hrv',
      figures: [figure({ metric: 'daily_hrv', unit: 'ms', value: 45.4, total: null })],
      stretch: {
        days: [
          { localDate: '2026-08-31', measured: true, rolling: 44.46, band: { low: 40.04, high: 49.96 }, side: 'within' },
          { localDate: '2026-09-01', measured: false, reason: 'thin-week' },
        ],
        weeks: [{ from: '2026-08-31', to: '2026-09-06', point: { localDate: '2026-08-31', measured: true, rolling: 44.46, band: { low: 40.04, high: 49.96 }, side: 'within' } }],
        runs: [], run: null,
      },
      days: [{
        localDate: '2026-08-31', score: 61, band: 'usual',
        inputs: [{ key: 'hrv', weight: 0.5, points: 7.46, contribution: 0.123456 }, { key: 'restingHeartRate', weight: 0.5, points: -2.04, contribution: -0.0124 }],
      }],
      method: {
        weights: { hrv: 0.4, restingHeartRate: 0.3, respiratoryRate: 0.15, sleep: 0.15 } as RecoveryPeriod['method']['weights'],
        usualBand: { low: 40, high: 60 }, baselineDays: 60,
        stretch: { weekDays: 7, minReadings: 4, band: 1, minRun: 3, lookbackDays: 90 },
      },
      ...over,
    }
  }

  it('rounds the hero and figures as every period figure, and takes high, low and the changes again from the rounded hero', () => {
    const base = recovery()
    const hero = figure({
      metric: 'recovery_index', unit: 'score', precision: 0, value: 60.6, total: null, usual: null,
      daily: [point('2026-08-31', 60.6, band(50, 40, 60), 'above', 'better'), point('2026-09-01', 57.4, band(50, 40, 60), 'within', null)],
    })
    const rounded = roundRecoveryPeriod({ ...base, hero })
    expect(rounded.hero.value).toBe(61)
    expect(rounded.hero.daily.map((p) => p.value)).toEqual([61, 57])
    expect(rounded.high).toEqual({ localDate: '2026-08-31', value: 61, good: true })
    expect(rounded.low).toEqual({ localDate: '2026-09-01', value: 57, good: false })
    // 61 against 56 is 5, though the unrounded difference is 5.4.
    expect(rounded.previous).toEqual({ from: '2026-08-24', to: '2026-08-30', value: 56, delta: 5 })
    expect(rounded.figures[0]!.value).toBe(45)
    expect(rounded.carriedBy).toBe('hrv')
  })

  it('names what carried the period again from the rounded hero, whose standing rounding can move to within', () => {
    const days: RecoveryDay[] = [{
      localDate: '2026-08-31', score: 44, band: 'usual',
      inputs: [{ key: 'hrv', weight: 0.5, points: 3, contribution: 1 }, { key: 'restingHeartRate', weight: 0.5, points: -6, contribution: -2 }],
    }]
    // 44.48 is above a usual reaching 44.45, so HRV lifted it; at 44 against 44 it is within, and
    // below 50 the push that counts is the one down.
    const hero = figure({
      metric: 'recovery_index', unit: 'score', precision: 0, value: 44.48, total: null,
      usual: { ...band(40, 35, 44.45), window: WINDOW, periods: 12 }, standing: 'above', judged: 'better',
    })
    const rounded = roundRecoveryPeriod(recovery({ hero, days, carriedBy: 'hrv' }))
    expect(rounded.hero.standing).toBe('within')
    expect(rounded.carriedBy).toBe('restingHeartRate')
  })

  it("sends a tap panel input's points to a tenth and its contribution to a thousandth, leaving the rest of the day", () => {
    const rounded = roundRecoveryPeriod(recovery())
    expect(rounded.days).toEqual([{
      localDate: '2026-08-31', score: 61, band: 'usual',
      inputs: [{ key: 'hrv', weight: 0.5, points: 7.5, contribution: 0.123 }, { key: 'restingHeartRate', weight: 0.5, points: -2, contribution: -0.012 }],
    }])
  })

  it("sends the stretch's rolling mean and band to the HRV metric's precision, and keeps unmeasured days, runs and the run as they are", () => {
    const run = { side: 'below' as const, days: 4, capped: false, since: '2026-08-31', sideNights: 4, weekReadings: 5, filledDays: 0 }
    const rounded = roundRecoveryPeriod(recovery({
      stretch: { ...recovery().stretch!, runs: [{ from: '2026-08-31', to: '2026-09-01', side: 'below' }], run },
    }))
    expect(rounded.stretch!.days).toEqual([
      { localDate: '2026-08-31', measured: true, rolling: 44, band: { low: 40, high: 50 }, side: 'within' },
      { localDate: '2026-09-01', measured: false, reason: 'thin-week' },
    ])
    expect(rounded.stretch!.weeks![0]!.point).toEqual({ localDate: '2026-08-31', measured: true, rolling: 44, band: { low: 40, high: 50 }, side: 'within' })
    expect(rounded.stretch!.runs).toEqual([{ from: '2026-08-31', to: '2026-09-01', side: 'below' }])
    expect(rounded.stretch!.run).toEqual(run)
  })

  it("judges each stretch day and week point again on its rounded band, while the runs and the run stay core's verdict", () => {
    const above = { localDate: '2026-08-31', measured: true as const, rolling: 50.4, band: { low: 40.04, high: 49.96 }, side: 'above' as const }
    const run = { side: 'above' as const, days: 3, capped: false, since: '2026-08-29', sideNights: 3, weekReadings: 6, filledDays: 0 }
    const spans = [{ from: '2026-08-29', to: '2026-08-31', side: 'above' as const }]
    const rounded = roundRecoveryPeriod(recovery({
      stretch: { days: [above], weeks: [{ from: '2026-08-31', to: '2026-09-06', point: above }], runs: spans, run },
    }))
    const drawn = { ...above, rolling: 50, band: { low: 40, high: 50 }, side: 'within' }
    expect(rounded.stretch!.days).toEqual([drawn])
    expect(rounded.stretch!.weeks![0]!.point).toEqual(drawn)
    expect(rounded.stretch!.runs).toEqual(spans)
    expect(rounded.stretch!.run).toEqual(run)
  })

  it('keeps a null stretch, null weeks, a null week point and the method as they are', () => {
    expect(roundRecoveryPeriod(recovery({ stretch: null })).stretch).toBeNull()
    const stretch = recovery().stretch!
    expect(roundRecoveryPeriod(recovery({ stretch: { ...stretch, weeks: null } })).stretch!.weeks).toBeNull()
    expect(roundRecoveryPeriod(recovery({ stretch: { ...stretch, weeks: [{ from: '2026-08-31', to: '2026-09-06', point: null }] } })).stretch!.weeks)
      .toEqual([{ from: '2026-08-31', to: '2026-09-06', point: null }])
    expect(roundRecoveryPeriod(recovery()).method).toEqual(recovery().method)
  })
})

describe('GET /recovery/period', () => {
  // Mornings from before any range asked for to today, an HRV and a resting heart rate either side of a round level.
  function seedMornings(h: Harness): void {
    let i = 0
    for (let d = '2025-12-01'; d <= '2026-09-10'; d = shiftLocalDate(d, 1)) {
      seedDailyAgg(h, d, 'daily_hrv', 'last', 45 + (i % 2 === 0 ? 3 : -3))
      seedDailyAgg(h, d, 'resting_heart_rate', 'last', 55 + (i % 2 === 0 ? 1 : -1))
      i += 1
    }
  }

  it('answers each range with the hero, the figures, the stretch and the scored days', async () => {
    const { h, token } = await started()
    seedMornings(h)
    for (const range of ['week', 'month', '3months', 'year'] as const) {
      const response = await get(h, token, `/recovery/period?range=${range}&anchor=2026-08-14`)
      expect(response.statusCode, range).toBe(200)
      const body = response.json()
      const { from, to } = periodBounds(range, '2026-08-14')
      expect(body.period).toMatchObject({ range, from, to })
      expect(body.hero.metric).toBe('recovery_index')
      expect(body.hero.days).toBeGreaterThan(0)
      expect(body.figures.map((f: { metric: string }) => f.metric)).toEqual(['resting_heart_rate', 'daily_hrv'])
      // Three months and a year send no days of either; the trim test below pins that.
      const byWeek = range === '3months' || range === 'year'
      expect(body.days.length > 0, range).toBe(!byWeek)
      expect(body.stretch.days.length > 0, range).toBe(!byWeek)
      expect(body.method.baselineDays).toBe(60)
    }
  })

  it('refuses a day range, an unknown range, a missing or malformed anchor, a period not yet started and an unknown source', async () => {
    const { h, token } = await started()
    for (const query of [
      'range=day&anchor=2026-09-01', 'range=quarter&anchor=2026-09-01', 'anchor=2026-09-01',
      'range=month', 'range=month&anchor=2026-13-01', 'range=week&anchor=2026-09-14', 'range=week&anchor=2026-09-01&source=nope',
    ]) {
      const response = await get(h, token, `/recovery/period?${query}`)
      expect(response.statusCode, query).toBe(400)
      expect(response.json()).toMatchObject({ error: { kind: 'config' } })
    }
  })

  it("answers 304 to a repeat request carrying the first one's ETag, and treats source=all as no source", async () => {
    const { h, token } = await started()
    seedMornings(h)
    const first = await get(h, token, `/recovery/period?range=week&anchor=${WEEK}`)
    expect(first.statusCode).toBe(200)
    const again = await get(h, token, `/recovery/period?range=week&anchor=${WEEK}`, { 'if-none-match': first.headers.etag as string })
    expect(again.statusCode).toBe(304)
    expect((await get(h, token, `/recovery/period?range=week&anchor=${WEEK}&source=all`)).body).toBe(first.body)
  })

  it('sends every input of a scored day with points to a tenth and contribution to a thousandth', async () => {
    const { h, token } = await started()
    seedMornings(h)
    const body = (await get(h, token, `/recovery/period?range=week&anchor=${WEEK}`)).json()
    const inputs = body.days.flatMap((d: RecoveryDay) => d.inputs)
    expect(inputs.length).toBeGreaterThan(0)
    for (const x of inputs) {
      expect(x.points).toBe(Number(x.points.toFixed(1)))
      expect(x.contribution).toBe(Number(x.contribution.toFixed(3)))
    }
  })

  it('on three months and a year empties the figures, the stretch and the scored days of their days, keeping the weeks and the runs', async () => {
    const { h, token } = await started()
    seedMornings(h)
    for (const range of ['3months', 'year'] as const) {
      const body = (await get(h, token, `/recovery/period?range=${range}&anchor=2026-08-14`)).json()
      const { from, to } = periodBounds(range, '2026-08-14')
      const lastDay = to < '2026-09-10' ? to : '2026-09-10'
      expect(body.figures.length).toBeGreaterThan(0)
      for (const f of body.figures) {
        expect(f.daily).toEqual([])
        expect(f.weekly).not.toBeNull()
      }
      expect(body.hero.daily.length).toBeGreaterThan(0)
      // Taken from the hero's days before the trim, and sent untouched.
      expect(body.high).not.toBeNull()
      expect([body.high, body.low]).toEqual([highOf(body.hero.daily), lowOf(body.hero.daily)])
      expect(['hrv', 'restingHeartRate', 'sleep', 'respiratoryRate', null]).toContain(body.carriedBy)
      expect(body.stretch.days).toEqual([])
      expect(body.stretch.weeks.at(-1).to).toBe(lastDay)
      expect(body.stretch.weeks[0].from).toBe(from)
      expect(Array.isArray(body.stretch.runs)).toBe(true)
      expect('run' in body.stretch).toBe(true)
      expect(body.days).toEqual([])
      expect(body.method.stretch.minRun).toBeGreaterThan(0)
    }
    const month = (await get(h, token, '/recovery/period?range=month&anchor=2026-08-14')).json()
    expect(month.figures.every((f: { daily: unknown[] }) => f.daily.length === 31)).toBe(true)
    expect(month.stretch.weeks).toBeNull()
    expect(month.stretch.days.at(-1).localDate).toBe('2026-08-31')
    expect(month.days.length).toBeGreaterThan(0)
  })
})

describe('roundActivityPeriod', () => {
  function activity(over: Partial<ActivityPeriod> = {}): ActivityPeriod {
    const steps = figure({ metric: 'steps', unit: 'count' })
    const none = { light: null, moderate: null, vigorous: null }
    return {
      period: HEADER, hero: steps, high: null,
      previous: { from: '2026-08-24', to: '2026-08-30', value: null, delta: null },
      yearEarlier: { from: '2025-08-31', to: '2025-09-06', value: null, delta: null },
      workoutCount: 2, figures: [], intensity: none, zoneMinutes: { fatBurn: null, cardio: null, peak: null },
      heartRateZones: { ...none, peak: null, hard: null }, maxHeartRate: null, workouts: [], workoutMonths: [], types: [],
      cardioLoad: null, vo2max: null, more: [],
      ...over,
    }
  }

  it('sends workouts whole, a type\'s usual count to a tenth and its standing from that tenth', () => {
    const rounded = roundActivityPeriod(activity({
      workouts: [{
        id: 'w', sourceId: 'watch', localDate: '2026-09-01', startMs: 0, endMs: 1_800_000, type: 'RUNNING',
        durationSeconds: 1800.4, distanceMeters: 5012.6, caloriesKcal: 300.4, averageHeartRateBpm: 141.6,
        paceSecondsPerKm: 318.6, elevationGainMeters: 57.5, excluded: false, rate: { key: 'pace', unit: 'seconds_per_km', value: 319 }, filled: false,
      }],
      types: [{
        type: 'RUNNING', count: 2, seconds: 3600.4, distanceMeters: 10000.6,
        usualCount: { ...band(1.8, 1.66, 1.96), window: WINDOW, periods: 12 }, standing: 'above', judged: 'better',
      }],
    }))
    expect(rounded.workouts[0]).toMatchObject({
      durationSeconds: 1800, distanceMeters: 5013, caloriesKcal: 300, averageHeartRateBpm: 142, paceSecondsPerKm: 319, elevationGainMeters: 58,
      rate: { key: 'pace', unit: 'seconds_per_km', value: 319 },
    })
    // 2 is above 1.96 but not above the 2.0 the page prints.
    expect(rounded.types[0]).toMatchObject({
      seconds: 3600, distanceMeters: 10001, usualCount: { center: 1.8, low: 1.7, high: 2, window: WINDOW, periods: 12 }, standing: 'within', judged: null,
    })
    expect(rounded.high).toEqual({ localDate: '2026-08-31', value: 400, good: false })
  })

  it('leaves a running period\'s type counts unjudged', () => {
    const rounded = roundActivityPeriod(activity({
      period: { ...HEADER, partial: true },
      types: [{ type: 'RUNNING', count: 5, seconds: 0, distanceMeters: null, usualCount: { ...band(1, 1, 1), window: WINDOW, periods: 12 }, standing: null, judged: null }],
    }))
    expect(rounded.types[0]!.standing).toBeNull()
  })

  it("judges a type's count with more as the better side", () => {
    const rounded = roundActivityPeriod(activity({
      types: [
        { type: 'RUNNING', count: 5, seconds: 0, distanceMeters: null, usualCount: { ...band(3, 2.5, 3.5), window: WINDOW, periods: 12 }, standing: 'above', judged: 'better' },
        { type: 'WALKING', count: 1, seconds: 0, distanceMeters: null, usualCount: { ...band(3, 2.5, 3.5), window: WINDOW, periods: 12 }, standing: 'below', judged: 'worse' },
      ],
    }))
    expect(rounded.types.map((t) => [t.standing, t.judged])).toEqual([['above', 'better'], ['below', 'worse']])
  })

  it('rounds the hard zones and the highest heart rate as figures', () => {
    const rounded = roundActivityPeriod(activity({
      heartRateZones: { light: null, moderate: null, vigorous: null, peak: null, hard: figure({ metric: 'hard_zone_minutes' }) },
      maxHeartRate: figure({ metric: 'max_heart_rate', unit: 'bpm', total: null }),
    }))
    expect(rounded.heartRateZones.hard).toMatchObject({ value: 400, total: 2803, standing: 'within' })
    expect(rounded.maxHeartRate).toMatchObject({ value: 400, standing: 'within' })
  })

  it("sums each month's header again from the rounded rows, leaving an excluded workout out", () => {
    const row = (id: string, localDate: string, durationSeconds: number, excluded = false) => ({
      id, sourceId: 'watch', localDate, startMs: 0, endMs: 0, type: 'RUNNING', durationSeconds, distanceMeters: null,
      caloriesKcal: null, averageHeartRateBpm: null, paceSecondsPerKm: null, elevationGainMeters: null, excluded, rate: null, filled: false,
    })
    const rounded = roundActivityPeriod(activity({
      workouts: [row('c', '2026-09-02', 600.4), row('b', '2026-09-01', 600.4), row('x', '2026-09-01', 900, true), row('a', '2026-08-31', 1200.6)],
      workoutMonths: [{ month: '2026-09', count: 3, seconds: 2101.8 }, { month: '2026-08', count: 1, seconds: 1200.6 }],
    }))
    // 600 and 600 printed are 1200, though 600.4 twice is 1200.8.
    expect(rounded.workoutMonths).toEqual([{ month: '2026-09', count: 2, seconds: 1200 }, { month: '2026-08', count: 1, seconds: 1201 }])
  })

  it('sends VO2 max to a tenth and takes its trend again from the two tenths sent', () => {
    const rounded = roundActivityPeriod(activity({
      vo2max: { metric: 'daily_vo2_max', latest: 42.24, latestDate: '2026-09-06', earlier: 41.26, earlierDate: '2026-06-01', trend: 'rising' },
    }))
    // 42.2 against 41.3 is a rise of 0.9, short of a whole point.
    expect(rounded.vo2max).toMatchObject({ latest: 42.2, earlier: 41.3, trend: 'steady' })
  })
})
