import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { daily, sources, sessions, sessionSegments } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { shiftLocalDate } from '../src/derive/localDay.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { balanceWeeks, isWeekendMorning as coreIsWeekendMorning, readSleepPeriod } from '../src/query/sleepPeriod.ts'
import type { SleepPeriodInput } from '../src/query/sleepPeriod.ts'
import { readPeriodSeries, readSpan } from '../src/query/periodRead.ts'
import { datesIn, periodBounds, yearEarlierDate } from '../src/query/periodBounds.ts'
import { RECOVERY_METRIC_SOURCES } from '../src/api/recoveryIndex.ts'

// Synthetic nights only. Every series runs from FIRST through TODAY, 430 days, so a month has twelve
// whole earlier months behind it and the same month a year earlier is fully covered.
const TODAY = '2026-09-20'
const FIRST = '2025-07-18'
const OFFSET = 120

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  for (const id of ['watch', 'a', 'b']) {
    test.db.insert(sources).values({ id, personId: 'p1', externalId: id, displayName: id, kind: 'device', createdAtMs: 0 }).run()
  }
})
afterEach(() => test.cleanup())

const q = () => new PersonQuery(test.db, 'p1')
const input = (o: Partial<SleepPeriodInput> & Pick<SleepPeriodInput, 'range' | 'anchor'>): SleepPeriodInput => ({
  today: TODAY, sleepTargetMinutes: 480, sleepUseBaseline: true, ...o,
})

/** Two minutes either way on alternate days, and a minute either way by month, so every usual has a spread. */
function jitter(date: string): number {
  const day = Number(date.slice(8, 10))
  const month = Number(date.slice(5, 7))
  return (day % 2 === 0 ? 2 : -2) + (month % 3) - 1
}

function seedSeries(
  metric: string, agg: string, value: (date: string) => number | null,
  o: { from?: string, to?: string, source?: string, coverage?: (date: string) => number } = {},
) {
  const rows = datesIn({ from: o.from ?? FIRST, to: o.to ?? TODAY }).flatMap((localDate) => {
    const v = value(localDate)
    return v === null ? [] : [{
      personId: 'p1', localDate, metric, agg, source: o.source ?? 'merged', value: v, coverage: o.coverage?.(localDate) ?? 1,
      sourceMix: null, derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
    }]
  })
  for (let i = 0; i < rows.length; i += 200) test.db.insert(daily).values(rows.slice(i, i + 200)).run()
}

const isWeekendMorning = (date: string) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())
const asleepOf = (date: string) => 420 + jitter(date)
/** Bedtime without jitter: 23:00 before a weekday morning, midnight before a weekend one. */
const bedOf = (date: string) => (isWeekendMorning(date) ? 0 : -60)
const wakeOf = (date: string) => (isWeekendMorning(date) ? 480 : 420)

/** Every nightly series the page reads, except SpO2. */
function seedNights(o: { asleep?: (date: string) => number } = {}) {
  seedSeries('sleep_asleep_minutes', 'sum', o.asleep ?? asleepOf)
  seedSeries('sleep_deep_minutes', 'sum', (d) => 80 + jitter(d))
  seedSeries('sleep_light_minutes', 'sum', (d) => 240 + jitter(d))
  seedSeries('sleep_rem_minutes', 'sum', (d) => 100 + jitter(d))
  seedSeries('sleep_awake_minutes', 'sum', (d) => 40 + jitter(d))
  seedSeries('sleep_efficiency', 'last', (d) => 90 + jitter(d))
  seedSeries('sleep_bedtime_minutes', 'last', bedOf)
  seedSeries('sleep_waketime_minutes', 'last', wakeOf)
  seedSeries('resting_heart_rate', 'last', (d) => 55 + jitter(d))
  seedSeries('daily_hrv', 'last', (d) => 45 + jitter(d))
}

const at = (localDate: string, hhmm: string) => Date.parse(`${localDate}T${hhmm}:00Z`) - OFFSET * 60_000

/** One main sleep session filed under `localDate`, with the provider's summary in attrs as mapSessions stores it. */
function seedSession(localDate: string, latency: number, o: { sourceId?: string, endLocal?: string } = {}) {
  const sourceId = o.sourceId ?? 'watch'
  const id = `night-${sourceId}-${localDate}`
  const startMs = at(shiftLocalDate(localDate, -1), '23:00')
  const endMs = at(localDate, o.endLocal ?? '07:00')
  test.db.insert(sessions).values({
    id, personId: 'p1', sourceId, kind: 'sleep', externalId: id,
    startMs, startOffsetMinutes: OFFSET, endMs, endOffsetMinutes: OFFSET, localDate, rawPayloadId: null,
    attrs: JSON.stringify({
      type: null, mainSleep: true, stagesStatus: 'SUCCEEDED',
      summary: { minutesToFallAsleep: String(latency), minutesAfterWakeUp: '3', stagesSummary: [{ type: 'AWAKE', minutes: '30', count: '4' }] },
    }),
  }).run()
  test.db.insert(sessionSegments).values({ id: `${id}-1`, sessionId: id, stage: 'light', startMs, endMs }).run()
}

const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
const monthMean = (month: string, f: (date: string) => number) => mean(datesIn(periodBounds('month', `${month}-01`)).map(f))

describe('readSleepPeriod', () => {
  it('reads a whole past month: not partial, judged by months, every night counted, newest first', () => {
    seedNights()
    const page = readSleepPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    expect(page.period).toMatchObject({ from: '2026-08-01', to: '2026-08-31', periodDays: 31, daysSoFar: 31, partial: false })
    expect(page.hero.metric).toBe('sleep_asleep_minutes')
    expect(page.hero.usual?.window.unit).toBe('month')
    const { within, above, below, unjudged } = page.hero.counts
    expect(within + above + below + unjudged).toBe(31)
    expect(page.nights).toHaveLength(31)
    expect(page.nights[0]!.localDate).toBe('2026-08-31')
    expect(page.nights[30]!.localDate).toBe('2026-08-01')
    expect(page.nights[0]).toMatchObject({ asleepMinutes: asleepOf('2026-08-31'), bedtimeMinutes: bedOf('2026-08-31'), waketimeMinutes: wakeOf('2026-08-31') })
    expect(page.hero.weekly).toBeNull()
  })

  it('judges a month slept an hour longer than every earlier one as above and better, and states the change', () => {
    const asleep = (d: string) => asleepOf(d) + (d.startsWith('2026-08') ? 60 : 0)
    seedNights({ asleep })
    const page = readSleepPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    expect(page.hero.standing).toBe('above')
    expect(page.hero.judged).toBe('better')
    expect(page.hero.value).toBeCloseTo(monthMean('2026-08', asleep), 9)
    expect(page.previous).toMatchObject({ from: '2026-07-01', to: '2026-07-31' })
    expect(page.previous.delta).toBeCloseTo(monthMean('2026-08', asleep) - monthMean('2026-07', asleep), 9)
    expect(page.yearEarlier).toMatchObject({ from: '2025-08-01', to: '2025-08-31' })
    expect(page.yearEarlier.delta).toBeCloseTo(monthMean('2026-08', asleep) - monthMean('2025-08', asleep), 9)
    expect(page.high?.value).toBe(Math.max(...datesIn({ from: '2026-08-01', to: '2026-08-31' }).map(asleep)))
    const good = page.nights.filter((n) => n.good)
    // Each night is judged against its own sixty nights before it, so the first four weeks of the
    // longer month still stand above a usual made of the shorter nights; the last few begin to be
    // judged against a usual the longer nights have pulled up.
    const early = page.nights.filter((n) => n.localDate <= '2026-08-28')
    expect(early).toHaveLength(28)
    expect(early.every((n) => n.good)).toBe(true)
    expect(good.length).toBe(29)
  })

  it('reaches back a year for a week, so the year-earlier change has its values', () => {
    seedNights()
    const page = readSleepPeriod(q(), input({ range: 'week', anchor: '2026-09-09' }))
    expect(page.yearEarlier.value).not.toBeNull()
    const bounds = periodBounds('week', '2026-09-09')
    expect(readSpan('week', bounds).from).toBe(yearEarlierDate(bounds.from))
  })

  it('splits bedtimes by the morning a night ended: Saturday and Sunday mornings are the weekend', () => {
    seedNights()
    const { sides } = readSleepPeriod(q(), input({ range: 'month', anchor: '2026-08-15' })).schedule
    expect(sides.weekend!.bedtimeMinutes - sides.weekday!.bedtimeMinutes).toBe(60)
    expect(sides.weekend!.waketimeMinutes - sides.weekday!.waketimeMinutes).toBe(60)
    // August 2026 has ten Saturday and Sunday mornings.
    expect(sides.weekend!.nights).toBe(10)
    expect(sides.weekday!.nights).toBe(21)
  })

  it('flags each night of the list by the same rule: Saturday and Sunday mornings', () => {
    seedNights()
    const { nights } = readSleepPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    const flag = (date: string) => nights.find((n) => n.localDate === date)!.weekend
    // 1 August 2026 is a Saturday.
    expect(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-07', '2026-08-08'].map(flag)).toEqual([true, true, false, false, true])
    expect(nights.filter((n) => n.weekend)).toHaveLength(10)
    expect([coreIsWeekendMorning('2026-08-01'), coreIsWeekendMorning('2026-08-03')]).toEqual([true, false])
  })

  it('counts naps over the whole period, their total and their minutes beside them', () => {
    seedNights()
    const napDay = (d: string) => d.endsWith('-01') || d.endsWith('-15')
    seedSeries('sleep_nap_count', 'count', (d) => (napDay(d) ? 1 : 0))
    seedSeries('sleep_nap_minutes', 'sum', (d) => (napDay(d) ? 25 : 0))
    const month = readSleepPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    expect(month.more.slice(-2).map((f) => f.metric)).toEqual(['sleep_nap_count', 'sleep_nap_minutes'])
    const count = month.more.find((f) => f.metric === 'sleep_nap_count')!
    expect(count).toMatchObject({ per: 'period', total: 2, days: 31 })
    expect(count.value).toBeCloseTo(2, 9)
    expect(month.more.find((f) => f.metric === 'sleep_nap_minutes')!.total).toBe(50)
    // Twenty nights of September so far hold two naps, a pace of three over its thirty.
    const running = readSleepPeriod(q(), input({ range: 'month', anchor: '2026-09-05' }))
    expect(running.more.find((f) => f.metric === 'sleep_nap_count')!.value).toBeCloseTo(3, 9)
  })

  it('adds up the balance a week at a time, each week clipped to the period', () => {
    seedNights()
    const { balance } = readSleepPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    const weekly = balance!.weekly
    // August 2026 opens on a Saturday and closes on a Monday.
    expect(weekly.map((w) => [w.from, w.to])).toEqual([
      ['2026-08-01', '2026-08-02'], ['2026-08-03', '2026-08-09'], ['2026-08-10', '2026-08-16'],
      ['2026-08-17', '2026-08-23'], ['2026-08-24', '2026-08-30'], ['2026-08-31', '2026-08-31'],
    ])
    expect(weekly[0]!.value).toBeCloseTo(balance!.values[0]! + balance!.values[1]!, 9)
    expect(weekly.reduce((s, w) => s + w.value!, 0)).toBeCloseTo(balance!.total, 9)
  })

  it('sends a week without a night as null, not as a balanced week', () => {
    expect(balanceWeeks(['2026-08-01', '2026-08-02', '2026-08-03'], [null, null, 5])).toEqual([
      { from: '2026-08-01', to: '2026-08-02', value: null }, { from: '2026-08-03', to: '2026-08-03', value: 5 },
    ])
    expect(balanceWeeks([], [])).toEqual([])
  })

  it('summarises the nights a month at a time, newest first', () => {
    seedNights()
    const { months } = readSleepPeriod(q(), input({ range: 'year', anchor: '2025-12-15' }))
    // The series starts on 18 July 2025.
    expect(months.map((m) => [m.month, m.nights])).toEqual([
      ['2025-12', 31], ['2025-11', 30], ['2025-10', 31], ['2025-09', 30], ['2025-08', 31], ['2025-07', 14],
    ])
    expect(months[0]!.asleepMinutes).toBeCloseTo(monthMean('2025-12', asleepOf), 9)
  })

  it('leaves a side out below two nights', () => {
    seedNights()
    // The week of 14 September, read on its Saturday: one weekend morning so far.
    const { sides } = readSleepPeriod(q(), input({ range: 'week', anchor: '2026-09-16', today: '2026-09-19' })).schedule
    expect(sides.weekend).toBeNull()
    expect(sides.weekday?.nights).toBe(5)
  })

  it('hides a section without data: no SpO2 rows, no SpO2 figure', () => {
    seedNights()
    const page = readSleepPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    const metrics = page.mornings.map((f) => f.metric)
    expect(metrics).not.toContain('daily_spo2')
    expect(metrics).toEqual(['recovery_index', 'resting_heart_rate', 'daily_hrv'])
    expect(page.figures.map((f) => f.metric)).toEqual(['sleep_efficiency', 'sleep_deep_minutes', 'sleep_rem_minutes', 'sleep_bedtime_minutes'])
    expect(page.more.map((f) => f.metric)).toEqual(['sleep_light_minutes', 'sleep_awake_minutes', 'sleep_waketime_minutes'])
  })

  it('bands every night of the hero but no day of the recovery index', () => {
    seedNights()
    seedSeries('respiratory_rate', 'last', (d) => 14 + jitter(d) / 10)
    const page = readSleepPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    const recovery = page.mornings.find((f) => f.metric === 'recovery_index')!
    // The index is already a distance from the person's own baselines; a band of it would be a
    // baseline of a baseline (readRecovery's rule), so its days are neither banded nor judged.
    expect(recovery.days).toBeGreaterThan(0)
    expect(recovery.daily.every((p) => p.band === null && p.standing === null && p.judged === null)).toBe(true)
    expect(recovery.usual).not.toBeNull()
    expect(page.hero.daily.every((p) => p.band !== null)).toBe(true)
  })

  it('shows SpO2 once it has rows', () => {
    seedNights()
    seedSeries('daily_spo2', 'last', (d) => 96 + jitter(d) / 10)
    const page = readSleepPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    expect(page.mornings.map((f) => f.metric)).toContain('daily_spo2')
  })

  it('an empty month has no figures, no balance and no nights', () => {
    seedNights()
    const page = readSleepPeriod(q(), input({ range: 'month', anchor: '2024-03-10' }))
    expect(page.hero.days).toBe(0)
    expect(page.figures).toEqual([])
    expect(page.mornings).toEqual([])
    expect(page.more).toEqual([])
    expect(page.balance).toBeNull()
    expect(page.nights).toEqual([])
    expect(page.months).toEqual([])
    expect(page.stages).toMatchObject({ deep: null, light: null, rem: null, awake: null, shares: null })
    expect(page.schedule).toMatchObject({ bedtime: null, waketime: null, variability: null })
  })

  it('states stage shares and the balance against the usual', () => {
    seedNights()
    const page = readSleepPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    const { shares } = page.stages
    expect(shares!.deep + shares!.light + shares!.rem + shares!.awake).toBeCloseTo(1, 9)
    const sum = page.stages.deep!.value! + page.stages.light!.value! + page.stages.rem!.value! + page.stages.awake!.value!
    expect(shares!.deep).toBeCloseTo(page.stages.deep!.value! / sum, 9)
    expect(page.balance!.zeroLine.source).toBe('baseline')
    const center = q().baseline({ metric: 'sleep_asleep_minutes', agg: 'sum', on: '2026-08-31' })!.center
    expect(page.balance!.zeroLine.minutes).toBeCloseTo(center, 9)
    expect(page.balance!.values[0]).toBeCloseTo(asleepOf('2026-08-01') - center, 9)
    expect(page.schedule.variability?.metric).toBe('sleep_bedtime_variability')
    expect(page.schedule.variability!.days).toBe(31)
    // Any seven mornings hold five weekday bedtimes (-60) and two weekend ones (0): a sample spread
    // of sqrt(6000/7) minutes on every day, so the period's value is that spread too.
    expect(page.schedule.variability!.daily[0]!.value).toBeCloseTo(Math.sqrt(6000 / 7), 9)
    expect(page.schedule.variability!.value).toBeCloseTo(Math.sqrt(6000 / 7), 9)
  })

  it('reads the provider summary figures from the main sleep, and names the night by its source', () => {
    seedNights()
    for (const [date, latency] of [['2026-08-10', 10], ['2026-08-11', 14], ['2026-08-12', 18]] as const) seedSession(date, latency)
    const page = readSleepPeriod(q(), input({ range: 'month', anchor: '2026-08-15' }))
    const latency = page.more.find((f) => f.metric === 'sleep_latency_minutes')!
    expect(latency.value).toBe(14)
    expect(latency.days).toBe(3)
    expect(page.more.find((f) => f.metric === 'sleep_awakenings')?.value).toBe(4)
    expect(page.more.find((f) => f.metric === 'sleep_after_wake_minutes')?.value).toBe(3)
    expect(page.nights.find((n) => n.localDate === '2026-08-11')?.sourceId).toBe('watch')
    expect(page.nights.find((n) => n.localDate === '2026-08-20')?.sourceId).toBe('merged')
  })

  it('honours the source asked for', () => {
    seedSeries('sleep_asleep_minutes', 'sum', (d) => 400 + jitter(d), { source: 'a' })
    seedSeries('sleep_asleep_minutes', 'sum', (d) => 460 + jitter(d), { source: 'b' })
    const page = readSleepPeriod(q(), input({ range: 'month', anchor: '2026-08-15', source: 'b' }))
    expect(page.hero.value).toBeCloseTo(monthMean('2026-08', (d) => 460 + jitter(d)), 9)
    expect(page.nights[0]!.sourceId).toBe('b')
  })

  it('reads the nights and their summaries of the source asked for', () => {
    seedSeries('sleep_asleep_minutes', 'sum', (d) => 420 + jitter(d), { source: 'b' })
    for (const date of ['2026-08-10', '2026-08-11', '2026-08-12']) {
      // The watch's night is the longer, so an unscoped read would pick it as the night of the date.
      seedSession(date, 10, { sourceId: 'watch', endLocal: '08:00' })
      seedSession(date, 30, { sourceId: 'b', endLocal: '06:00' })
    }
    const query = q()
    const sessionReads: (string | undefined)[] = []
    const readSessions = query.sessions.bind(query)
    query.sessions = (o) => { sessionReads.push(o.sourceId); return readSessions(o) }
    const page = readSleepPeriod(query, input({ range: 'month', anchor: '2026-08-15', source: 'b' }))
    expect(page.more.find((f) => f.metric === 'sleep_latency_minutes')?.value).toBe(30)
    expect(page.nights.find((n) => n.localDate === '2026-08-11')?.sourceId).toBe('b')
    // The summary lookup goes by the night's own session ids, so an unscoped read would still answer
    // right; it would read every source's sessions to do it.
    expect(sessionReads).toEqual(['b'])
  })

  it('uses the target as the zero line when the person does not follow their usual', () => {
    seedNights()
    const page = readSleepPeriod(q(), input({ range: 'month', anchor: '2026-08-15', sleepUseBaseline: false, sleepTargetMinutes: 450 }))
    expect(page.balance!.zeroLine).toEqual({ minutes: 450, source: 'target' })
    expect(page.balance!.values[0]).toBe(asleepOf('2026-08-01') - 450)
  })

  it('carries weekly points for three months and a year, not for a week or a month', () => {
    seedNights()
    const weekly = (range: SleepPeriodInput['range'], anchor: string) => readSleepPeriod(q(), input({ range, anchor })).hero.weekly
    expect(weekly('3months', '2026-08-15')).not.toBeNull()
    expect(weekly('year', '2025-12-15')).not.toBeNull()
    expect(weekly('week', '2026-08-12')).toBeNull()
    expect(weekly('month', '2026-08-15')).toBeNull()
  })

  it('a running month is partial and its strip ends today', () => {
    seedNights()
    const page = readSleepPeriod(q(), input({ range: 'month', anchor: '2026-09-05' }))
    expect(page.period).toMatchObject({ partial: true, daysSoFar: 20, periodDays: 30 })
    expect(page.hero.daily).toHaveLength(page.period.daysSoFar)
    expect(page.nights[0]!.localDate).toBe(TODAY)
  })

  it('reads each metric once, never a day at a time', () => {
    seedNights()
    const query = q()
    const calls = new Map<string, number>()
    const series = query.series.bind(query)
    query.series = (o) => { calls.set(o.metric, (calls.get(o.metric) ?? 0) + 1); return series(o) }
    let nightReads = 0
    let sessionReads = 0
    const sleepNights = query.sleepNights.bind(query)
    const readSessions = query.sessions.bind(query)
    query.sleepNights = (o) => { nightReads += 1; return sleepNights(o) }
    query.sessions = (o) => { sessionReads += 1; return readSessions(o) }
    readSleepPeriod(query, input({ range: 'month', anchor: '2026-08-15' }))
    expect([nightReads, sessionReads]).toEqual([1, 1])
    // The recovery index is scored from its own merged read of its five inputs, so those five are read twice.
    const recoveryInputs = new Set(RECOVERY_METRIC_SOURCES.map((s) => s.metric))
    for (const [metric, n] of calls) expect([metric, n]).toEqual([metric, recoveryInputs.has(metric) && metric !== 'respiratory_rate' ? 2 : 1])
    expect(calls.get('sleep_asleep_minutes')).toBe(2)
  })
})

describe('readPeriodSeries', () => {
  it('drops a barely observed day of a continuously sampled metric, as baselines does', () => {
    seedSeries('steps', 'sum', () => 8000, { coverage: (d) => (d === '2026-08-10' ? 0.1 : 1) })
    const bounds = periodBounds('month', '2026-08-15')
    const { values, bands } = readPeriodSeries(q(), { metric: 'steps', agg: 'sum', span: readSpan('month', bounds), bounds, lastDay: TODAY })
    expect(values.has('2026-08-10')).toBe(false)
    expect(values.has('2026-08-11')).toBe(true)
    expect(bands.get('2026-08-20')).toEqual(q().baseline({ metric: 'steps', agg: 'sum', on: '2026-08-20' }))
  })
})

describe('PersonQuery.sleepPeriod', () => {
  it('refuses a day range and a period that starts after today', () => {
    expect(() => q().sleepPeriod(input({ range: 'day' as never, anchor: '2026-08-15' }))).toThrow(/range/)
    expect(() => q().sleepPeriod(input({ range: 'month', anchor: '2026-10-02' }))).toThrow(/after today/)
    expect(q().sleepPeriod(input({ range: 'month', anchor: '2026-08-15' })).period.from).toBe('2026-08-01')
  })

  it('refuses a merge name as the source: the page narrows to a device, and nights have no merge', () => {
    // Refused at the boundary, before anything is read, not later by the nights read.
    const query = q()
    let reads = 0
    const series = query.series.bind(query)
    query.series = (o) => { reads += 1; return series(o) }
    expect(() => query.sleepPeriod(input({ range: 'month', anchor: '2026-08-15', source: 'merged' }))).toThrow(/merged/)
    expect(reads).toBe(0)
    expect(() => q().sleepPeriod(input({ range: 'month', anchor: '2026-08-15', source: 'provider' }))).toThrow(/provider/)
    expect(q().sleepPeriod(input({ range: 'month', anchor: '2026-08-15', source: 'b' })).period.from).toBe('2026-08-01')
  })
})
