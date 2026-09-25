import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { and, eq } from 'drizzle-orm'
import { daily, sessions, sources } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { PersonQuery } from '../src/query/personQuery.ts'
import { contextFor, dailyFigure } from '../src/query/glance.ts'
import type { Glance, GlanceFigure, GlanceStanding, GlanceStripDay } from '../src/query/glance.ts'
import { baselineOf, baselineWindow } from '../src/query/baseline.ts'
import type { CalendarSleep, CalendarSteps } from '../src/query/glanceCalendar.ts'

/**
 * Every dot on a strip opens its own day, and that day - like the calendar - is judged against its
 * own 60-day baseline. So a strip day's standing has to be the standing that day's own glance gives
 * it, and the calendar's verdict for it, or a dot drawn "below" opens a day that reads "within".
 *
 * The fixture drifts on purpose: every metric trends across 140 days with noise on top, and a
 * block of six wild days sits just where the strip's windows start (60 to 66 days before each
 * view's shown day). A strip's first day has all six in its window, its last day none, so the
 * first day's band is wide and the last day's narrow. A strip judged against one band for all
 * seven days (as it was before each day carried its own) disagrees with the days it opens.
 */

const TODAY = '2026-08-20'
const NOW = Date.parse('2026-08-20T10:00:00Z')
const SHOWN = '2026-06-12'

let test: TestDatabase
beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'p1')
  test.db.insert(sources).values({ id: 'watch', personId: 'p1', externalId: 'watch', displayName: 'Watch', kind: 'device', createdAtMs: 0 }).run()
  seedDriftingHistory()
})
afterEach(() => test.cleanup())

function insert(o: { metric: string, agg?: string, localDate: string, value: number }) {
  test.db.insert(daily).values({
    personId: 'p1', localDate: o.localDate, metric: o.metric, agg: o.agg ?? 'sum', source: 'merged',
    value: o.value, coverage: 1, sourceMix: JSON.stringify([{ source: 'watch', share: 1 }]),
    derivationVersion: DERIVATION_VERSION, updatedAtMs: 123,
  }).run()
}

function datesEnding(end: string, days: number): string[] {
  const endMs = Date.parse(`${end}T00:00:00Z`)
  return Array.from({ length: days }, (_, i) => new Date(endMs - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10))
}

function dayEndMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) + 86_400_000 - 1
}

/** A deterministic noise in [-1, 1], so the fixture is the same on every run. */
function noise(i: number, salt: number): number {
  const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43_758.5453
  return (x - Math.floor(x)) * 2 - 1
}

/**
 * The wild days: the six days 61 to 66 days before each view's shown day, which drop out of the
 * strip's windows one a day as the strip walks forward (TODAY's strip: 06-15 to 06-20; SHOWN's:
 * 04-07 to 04-12). SHOWN sits before TODAY's block, so its windows never see TODAY's wild days.
 */
function wild(date: string): boolean {
  return (date >= '2026-06-15' && date <= '2026-06-20') || (date >= '2026-04-07' && date <= '2026-04-12')
}

function seedDriftingHistory() {
  for (const [i, date] of datesEnding(TODAY, 140).entries()) {
    const w = wild(date) ? 1 : 0
    insert({ metric: 'steps', localDate: date, value: Math.round(6_000 + 60 * i + 1_600 * noise(i, 1) + 25_000 * w) })
    insert({ metric: 'sleep_asleep_minutes', localDate: date, value: Math.round(380 + 0.4 * i + 45 * noise(i, 2) + 300 * w) })
    insert({ metric: 'active_minutes_light', localDate: date, value: Math.round(25 + 0.1 * i + 12 * noise(i, 3) + 150 * w) })
    insert({ metric: 'active_minutes_moderate', localDate: date, value: Math.round(10 + 6 * Math.abs(noise(i, 4))) })
    insert({ metric: 'active_minutes_vigorous', localDate: date, value: Math.round(4 + 4 * Math.abs(noise(i, 5))) })
    insert({ metric: 'resting_heart_rate', agg: 'last', localDate: date, value: Math.round(62 - 0.04 * i + 3 * noise(i, 6) + 30 * w) })
    insert({ metric: 'daily_hrv', agg: 'last', localDate: date, value: Math.round(38 + 0.08 * i + 7 * noise(i, 7) + 60 * w) })
    const endMs = Date.parse(`${date}T05:10:00Z`)
    test.db.insert(sessions).values({
      id: `night-${date}`, personId: 'p1', sourceId: 'watch', kind: 'sleep', externalId: `night-${date}`,
      startMs: endMs - 7 * 3_600_000, startOffsetMinutes: 0, endMs, endOffsetMinutes: 0,
      localDate: date, attrs: JSON.stringify({}), rawPayloadId: null,
    }).run()
  }
}

/** The glance a click on `date` opens: today's own when it is today, a finished day's otherwise. */
function glanceOf(q: PersonQuery, date: string): Glance {
  return date === TODAY
    ? q.glance({ today: TODAY, nowMs: NOW })
    : q.glance({ today: TODAY, nowMs: NOW, day: date, dayEndMs: dayEndMs(date) })
}

/** The calendar's own words for a strip standing, folded as judgeCalendarDay folds a standing. */
const asCalendarSteps = (s: GlanceStanding | null): CalendarSteps => (s === null ? null : s === 'below' ? 'below' : 'reached')
const asCalendarSleep = (s: GlanceStanding | null): CalendarSleep => (s === null ? null : s === 'within' ? 'within' : 'outside')

interface StripCase {
  name: string
  strip: (g: Glance) => GlanceStripDay[]
  /** The figure the opened day's own glance shows for this strip's metric. */
  own: (g: Glance, date: string) => GlanceFigure
  calendar?: (s: GlanceStanding | null, day: { sleep: CalendarSleep, steps: CalendarSteps }) => [unknown, unknown]
}

const CASES: StripCase[] = [
  { name: 'steps', strip: (g) => g.day.steps.strip, own: (g) => g.day.steps,
    calendar: (s, day) => [asCalendarSteps(s), day.steps] },
  { name: 'active minutes', strip: (g) => g.day.activeMinutes.strip, own: (g) => g.day.activeMinutes },
  { name: 'time asleep', strip: (g) => g.sleep!.asleep.strip,
    own: (g, date) => {
      // The opened day's night has to be the night the dot stood for, or this compares two nights.
      expect(g.sleep?.localDate).toBe(date)
      return g.sleep!.asleep
    },
    calendar: (s, day) => [asCalendarSleep(s), day.sleep] },
  { name: 'resting heart rate', strip: (g) => g.recovery.restingHeartRate.strip, own: (g) => g.recovery.restingHeartRate },
  { name: 'hrv', strip: (g) => g.recovery.hrv.strip, own: (g) => g.recovery.hrv },
]

describe.each([
  { view: 'today', shown: TODAY },
  { view: 'a finished day', shown: SHOWN },
])('every strip day on $view agrees with the day it opens', ({ shown }) => {
  it.each(CASES)('$name', (c) => {
    const q = new PersonQuery(test.db, 'p1')
    const strip = c.strip(glanceOf(q, shown))
    expect(strip).toHaveLength(7)
    const calendars = new Map<string, Map<string, { sleep: CalendarSleep, steps: CalendarSteps }>>()
    let judged = 0
    for (const day of strip) {
      expect(day.value).not.toBeNull()
      const own = c.own(glanceOf(q, day.localDate), day.localDate)
      expect({ date: day.localDate, standing: day.standing }).toEqual({ date: day.localDate, standing: own.standing })
      // The band drawn behind the dot is the one the opened day states as its usual.
      expect({ date: day.localDate, band: day.band }).toEqual({ date: day.localDate, band: own.baseline })
      if (day.standing !== null) judged += 1
      if (c.calendar !== undefined) {
        const month = day.localDate.slice(0, 7)
        if (!calendars.has(month)) {
          calendars.set(month, new Map(q.glanceCalendar({ month, today: TODAY }).days.map((d) => [d.localDate, d])))
        }
        const [mapped, verdict] = c.calendar(day.standing, calendars.get(month)!.get(day.localDate)!)
        expect({ date: day.localDate, verdict: mapped }).toEqual({ date: day.localDate, verdict })
      }
    }
    // A strip of seven null standings would agree with anything; the fixture has to judge real days.
    expect(judged).toBeGreaterThanOrEqual(6)
  })
})

describe('PersonQuery.baselines', () => {
  it('answers each day exactly as a read of its own window would, low-coverage days dropped', () => {
    // A barely worn day inside the windows: the coverage rule has to drop it in the batched read too.
    test.db.update(daily).set({ coverage: 0.1 }).where(and(eq(daily.localDate, '2026-07-01'), eq(daily.metric, 'steps'))).run()
    const q = new PersonQuery(test.db, 'p1')
    const batched = q.baselines({ metric: 'steps', agg: 'sum', from: '2026-08-14', to: TODAY })
    expect([...batched.keys()]).toEqual(datesEnding(TODAY, 7))
    for (const [date, baseline] of batched) {
      // Independent of the code under test: the window's rows, filtered and folded by hand.
      const { from, to } = baselineWindow(date)
      const values = q.series({ metric: 'steps', agg: 'sum', from, to }).points.filter((p) => p.coverage === null || p.coverage >= 0.5).map((p) => p.value)
      expect(values.length).toBeLessThan(60)
      expect(baseline).toEqual(baselineOf(values))
    }
  })

  it('costs a figure one baselines read, not one baseline read per strip day', () => {
    const q = new PersonQuery(test.db, 'p1')
    const series = vi.spyOn(q, 'series')
    const figure = dailyFigure(contextFor(q, { today: TODAY, nowMs: NOW, nameOf: (id) => id }), { metric: 'steps', agg: 'sum', on: TODAY, partial: true, asOfMs: null })
    expect(figure.strip.every((d) => d.band !== null)).toBe(true)
    // The look-back (value and stale sources) and the one baselines read under every strip day's window.
    expect(series).toHaveBeenCalledTimes(2)
  })
})
