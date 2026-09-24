import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, seedPerson, seedOverride } from '../src/testing/fixtures.ts'
import type { TestDatabase } from '../src/testing/fixtures.ts'
import { daily } from '../src/db/schema/index.ts'
import { DERIVATION_VERSION } from '../src/derive/version.ts'
import { readSourceActivity } from '../src/query/sourceActivity.ts'

let test: TestDatabase
beforeEach(() => { test = createTestDatabase(); seedPerson(test.db, 'p1') })
afterEach(() => test.cleanup())

/** `days` reporting dates from `from`, one every `everyDays` (default consecutive). */
const seedDates = (o: {
  sourceId: string, from: string, days: number, everyDays?: number, personId?: string, metric?: string,
}) => {
  const start = Date.parse(`${o.from}T00:00:00Z`)
  for (let i = 0; i < o.days; i += 1) {
    const date = new Date(start + i * (o.everyDays ?? 1) * 86_400_000).toISOString().slice(0, 10)
    test.db.insert(daily).values({
      personId: o.personId ?? 'p1', localDate: date, metric: o.metric ?? 'steps', agg: 'sum',
      source: o.sourceId, value: 1000, coverage: 0.9, sourceMix: null,
      derivationVersion: DERIVATION_VERSION, updatedAtMs: null,
    }).run()
  }
}

describe('readSourceActivity', () => {
  it('calls a daily source silent past its own floor stale', () => {
    // 20 consecutive days then 20 silent: 20 >= MIN_REPORTING_DATES and 20 > max(4*1, 14)
    seedDates({ sourceId: 's-watch', from: '2026-01-01', days: 20 })
    const [activity] = readSourceActivity(test.db, 'p1', { today: '2026-02-09' })
    expect(activity).toMatchObject({
      sourceId: 's-watch', reportingDates: 20, medianGapDays: 1,
      lastReportedDate: '2026-01-20', status: 'stale', reportingNow: false,
    })
  })

  it('spares a monthly source silent well inside its own gap', () => {
    // 14 readings a month apart, last on 2026-02-08, read 40 days later. The silence has to sit
    // ABOVE the flat floor and BELOW this source's own threshold, or the test passes whether the
    // rule is relative or not: 40 > STALE_FLOOR_DAYS, and 40 < 4 * 31. A first version used 12
    // days, which is under both, and a mutation to a flat threshold sailed through it.
    seedDates({ sourceId: 's-scale', from: '2025-01-01', days: 14, everyDays: 31 })
    const [activity] = readSourceActivity(test.db, 'p1', { today: '2026-03-20' })
    expect(activity!.status).toBe('reporting')
    expect(activity!.reportingNow).toBe(true)
  })

  it('does not judge a source with too little history, however long it has been silent', () => {
    seedDates({ sourceId: 's-once', from: '2025-01-01', days: 13 })
    const [activity] = readSourceActivity(test.db, 'p1', { today: '2026-09-01' })
    expect(activity!.status).toBe('unjudged')
    // Past UNJUDGED_FLOOR_DAYS, so it leaves the live list without being called stale.
    expect(activity!.reportingNow).toBe(false)
  })

  it('keeps a recently active unjudged source in the live list', () => {
    seedDates({ sourceId: 's-new', from: '2026-08-25', days: 3 })
    const [activity] = readSourceActivity(test.db, 'p1', { today: '2026-08-30' })
    expect(activity).toMatchObject({ status: 'unjudged', reportingNow: true })
  })

  // What this replaced, and why it is worth a comment rather than a silent edit. The original
  // asserted that an excluded day still counts as a day the source reported, matching a claim in
  // the reader's own header. It passed by seeding a `daily` row AND an override directly, which
  // is a state production never reaches: `applyToDay` removes an excluded metric's rows before
  // they are written, so the row the test relied on would never exist. The test asserted
  // behaviour that cannot occur and the header documented a decision the data layer had already
  // made the other way.
  //
  // What is actually true is asserted here instead: this reader sees whatever survived
  // derivation, and nothing about an override reaches it.
  it('judges a source on the rows derivation left behind, overrides included', () => {
    seedDates({ sourceId: 's-watch', from: '2026-01-01', days: 20 })
    seedOverride(test.db, {
      personId: 'p1', scope: 'day_metric', action: 'exclude',
      targetKey: JSON.stringify({ localDate: '2026-01-20', metric: 'steps' }), reason: 'test',
    })

    // The override changes nothing here, because this reader never consults the overrides table:
    // in production the excluded row would simply be absent from `daily`, and the cadence would
    // be computed over the days that remain.
    const [activity] = readSourceActivity(test.db, 'p1', { today: '2026-01-21' })
    expect(activity!.reportingDates).toBe(20)
    expect(activity!.status).toBe('reporting')
  })

  it('shortens a history when derivation left the excluded day out, which is what really happens', () => {
    // The production shape, written the way production writes it: the excluded day's row is
    // simply not there. 13 dates is below MIN_REPORTING_DATES, so the source stops being judged
    // at all rather than being called stale - the honest consequence of the rule above.
    seedDates({ sourceId: 's-watch', from: '2026-01-01', days: 13 })
    const [activity] = readSourceActivity(test.db, 'p1', { today: '2026-01-14' })
    expect(activity!.reportingDates).toBe(13)
    expect(activity!.status).toBe('unjudged')
  })

  it('never reports the sources of another person', () => {
    seedPerson(test.db, 'p2')
    seedDates({ sourceId: 's-mine', from: '2026-01-01', days: 20 })
    seedDates({ sourceId: 's-theirs', from: '2026-01-01', days: 20, personId: 'p2' })
    expect(readSourceActivity(test.db, 'p1', { today: '2026-01-21' }).map((a) => a.sourceId))
      .toEqual(['s-mine'])
  })

  it('leaves out the derived sources, which cannot go stale', () => {
    seedDates({ sourceId: 'merged', from: '2026-01-01', days: 20 })
    seedDates({ sourceId: 'provider', from: '2026-01-01', days: 20 })
    seedDates({ sourceId: 's-watch', from: '2026-01-01', days: 20 })
    expect(readSourceActivity(test.db, 'p1', { today: '2026-01-21' }).map((a) => a.sourceId))
      .toEqual(['s-watch'])
  })

  describe('a stale source whose data kept arriving under another source', () => {
    const byId = (today: string) =>
      new Map(readSourceActivity(test.db, 'p1', { today }).map((a) => [a.sourceId, a]))

    it('is continued elsewhere when a renamed device carries on with everything it reported', () => {
      // The shape the Google Health API produced: it names a device only by its displayName, and
      // one fetch attributed a stretch of the watch's history to a longer name than every fetch
      // since. Two source rows, one physical watch, and the old name silent ever after.
      for (const metric of ['steps', 'heart_rate', 'daily_hrv']) {
        seedDates({ sourceId: 's-watch-long-name', from: '2026-01-01', days: 20, metric })
        seedDates({ sourceId: 's-watch', from: '2026-01-18', days: 23, metric })
      }
      const old = byId('2026-02-09').get('s-watch-long-name')!
      // Still stale: the id really did stop, and the settings card says so truthfully.
      expect(old.status).toBe('stale')
      expect(old.continuedElsewhere).toBe(true)
    })

    it('is not continued when only part of what it reported carries on, as a phone does for a dead watch', () => {
      // The case the warning exists for: the watch dies, the phone keeps counting steps, and the
      // step chart thins with no day wrong. Nothing else measures the heart rate, so it warns.
      seedDates({ sourceId: 's-watch', from: '2026-01-01', days: 20, metric: 'steps' })
      seedDates({ sourceId: 's-watch', from: '2026-01-01', days: 20, metric: 'heart_rate' })
      seedDates({ sourceId: 's-phone', from: '2026-01-01', days: 40, metric: 'steps' })
      const watch = byId('2026-02-09').get('s-watch')!
      expect(watch.status).toBe('stale')
      expect(watch.continuedElsewhere).toBe(false)
    })

    it('does not let an occasional metric in its last week hold the verdict hostage', () => {
      // A workout on one day of the final week is not part of the watch's routine; requiring a
      // successor to have logged a workout since would keep a renamed watch warning until the
      // household next exercised.
      seedDates({ sourceId: 's-old', from: '2026-01-01', days: 20, metric: 'steps' })
      seedDates({ sourceId: 's-old', from: '2026-01-19', days: 1, metric: 'workout_count' })
      seedDates({ sourceId: 's-new', from: '2026-01-21', days: 20, metric: 'steps' })
      expect(byId('2026-02-09').get('s-old')!.continuedElsewhere).toBe(true)
    })

    it('does not count rows the successor wrote before the silence began', () => {
      // Overlap is normal (both names covered the same days for a while), and those days prove
      // nothing about whether the data is still arriving now.
      seedDates({ sourceId: 's-old', from: '2026-01-01', days: 20, metric: 'heart_rate' })
      seedDates({ sourceId: 's-other', from: '2026-01-01', days: 20, metric: 'heart_rate' })
      expect(byId('2026-02-09').get('s-old')!.continuedElsewhere).toBe(false)
    })

    it('is never continued by the derived tiers, which only restate what the devices sent', () => {
      seedDates({ sourceId: 's-watch', from: '2026-01-01', days: 20 })
      seedDates({ sourceId: 'merged', from: '2026-01-01', days: 40 })
      seedDates({ sourceId: 'provider', from: '2026-01-01', days: 40 })
      expect(byId('2026-02-09').get('s-watch')!.continuedElsewhere).toBe(false)
    })

    it("lists a stale source's routine metrics off its own last week, and none for a reporting source", () => {
      // The watch: steps and heart rate daily, a workout on one day of its final week. The phone
      // keeps reporting, so it is not stale and is never asked.
      seedDates({ sourceId: 's-watch', from: '2026-01-01', days: 20, metric: 'steps' })
      seedDates({ sourceId: 's-watch', from: '2026-01-01', days: 20, metric: 'heart_rate' })
      seedDates({ sourceId: 's-watch', from: '2026-01-18', days: 1, metric: 'workout_count' })
      seedDates({ sourceId: 's-phone', from: '2026-01-01', days: 40, metric: 'steps' })
      expect(byId('2026-02-09').get('s-watch')!.routineMetrics).toEqual(['heart_rate', 'steps'])
      expect(byId('2026-02-09').get('s-phone')!.routineMetrics).toEqual([])
    })

    it('is false for a source that is not stale at all', () => {
      seedDates({ sourceId: 's-watch', from: '2026-01-01', days: 20 })
      expect(byId('2026-01-21').get('s-watch')!.continuedElsewhere).toBe(false)
    })
  })

  it('reports a source with a single reporting date without dividing by a gap it has not got', () => {
    seedDates({ sourceId: 's-one', from: '2026-01-01', days: 1 })
    const [activity] = readSourceActivity(test.db, 'p1', { today: '2026-01-02' })
    expect(activity).toMatchObject({
      reportingDates: 1, medianGapDays: null, status: 'unjudged', reportingNow: true,
    })
  })
})
