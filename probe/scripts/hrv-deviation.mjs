// HRV deviation constants, throwaway. Measures how often a rolling week of HRV sits outside a band
// around the person's own usual, and for how long, at the bands and minimum runs the design could
// plausibly pick - before the shipped constants are settled by anyone's impression of them.
//
//   node --experimental-strip-types probe/scripts/hrv-deviation.mjs [dataDir]
//
// dataDir defaults to $HAELAN_DATA_DIR, then ./.local-archive. It must be a directory holding
// haelan.sqlite, not the file itself.
//
// Opens through `openReadOnly`, never `openHaelan`: that connection migrates nothing, writes
// nothing and creates no encryption key, so it is safe to point at a running instance's data
// directory.
//
// PRIVACY. This prints no HRV value, no date and no person id. People appear as "person 1",
// "person 2" in an arbitrary order that carries no meaning. What it prints is day counts, rates
// per 30 measured days, run lengths in days and shares of days, which are the figures under test.
// Its output stays in the session and out of git: these are counts about one household and the
// repository is public. Anything added here has to be safe to paste into a terminal somebody is
// sharing.
//
// What it reads. HRV through PersonQuery.series with the metric and agg RECOVERY_METRIC_SOURCES
// names for 'hrv', from the person's first to last reading, so a day filled from the intraday mean
// arrives exactly as production sees it. Every day with a full baseline and week behind it is
// scored: from the first reading plus 66 days (7 of the week, 60 of the baseline, less the day
// itself counted in both) to the last.
//
// Per person, for each band and each minimum run:
//   - scored days, and the share of them unmeasured, by reason;
//   - runs started per 30 measured days, below and above separately;
//   - run length, median and longest, in measured days;
//   - the share of measured days inside an active run.
//
// A run is counted here from the series, not by hrvDeviationRun: measured days on one side in a
// row, unmeasured days skipped without breaking it, a within day or the other side ending it. A
// run "starts" on the day its streak reaches the minimum, and a day is "inside" a run from that
// day on. Lengths are whole streaks that reached the minimum.

import { openReadOnly } from '../../packages/core/src/db/openReadOnly.ts'
import { PersonQuery } from '../../packages/core/src/query/personQuery.ts'
import { RECOVERY_METRIC_SOURCES } from '../../packages/core/src/api/recoveryIndex.ts'
import { hrvDeviationSeries, HRV_WEEK_DAYS } from '../../packages/core/src/query/hrvDeviation.ts'
import { BASELINE_WINDOW_DAYS } from '../../packages/core/src/query/baseline.ts'
import { shiftLocalDate } from '../../packages/core/src/derive/localDay.ts'

const DIR = process.argv[2] ?? process.env.HAELAN_DATA_DIR ?? './.local-archive'

const BANDS = [0.4, 0.5, 0.6]
const MIN_RUNS = [3, 5]

const source = RECOVERY_METRIC_SOURCES.find((s) => s.key === 'hrv')
if (source === undefined) throw new Error("no recovery metric source declared for 'hrv'")

const db = openReadOnly(DIR)
const pct = (n, d) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`)
const median = (xs) => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** The streaks of measured days on one side, in order: { side, days, reachedAt } per streak. */
function streaksOf(series) {
  const streaks = []
  let current = null
  for (const day of series) {
    if (!day.measured) continue
    if (day.side === 'within') { current = null; continue }
    if (current === null || current.side !== day.side) {
      current = { side: day.side, days: 0 }
      streaks.push(current)
    }
    current.days += 1
  }
  return streaks
}

console.log(`\n# HRV deviation, ${DIR}\n`)
console.log(`metric ${source.metric}, agg ${source.agg}; week ${HRV_WEEK_DAYS} days, baseline ${BASELINE_WINDOW_DAYS} days`)

const ids = db.$client.prepare('SELECT id FROM people ORDER BY id').all().map((r) => r.id)
console.log(`people: ${ids.length}`)

ids.forEach((personId, index) => {
  console.log(`\n${'='.repeat(70)}\n## person ${index + 1}\n`)

  const rows = db.$client.prepare(
    `SELECT MIN(local_date) AS first, MAX(local_date) AS last FROM daily
      WHERE person_id = ? AND metric = ? AND agg = ? AND value IS NOT NULL`,
  ).get(personId, source.metric, source.agg)
  if (rows === undefined || rows.first === null) { console.log('  no HRV readings\n'); return }

  const { points } = new PersonQuery(db, personId).series({
    metric: source.metric, agg: source.agg, from: rows.first, to: rows.last,
  })
  const readings = points.map((p) => ({ localDate: p.localDate, value: p.value, filled: p.filled }))
  const filled = readings.filter((r) => r.filled).length
  const from = shiftLocalDate(readings[0].localDate, HRV_WEEK_DAYS + BASELINE_WINDOW_DAYS - 1)
  const to = readings[readings.length - 1].localDate
  console.log(`  ${readings.length} readings (${filled} filled from the intraday mean)`)
  if (from > to) { console.log('  history too short for a baseline and a week\n'); return }

  for (const band of BANDS) {
    const series = hrvDeviationSeries(readings, { from, to }, band)
    const measured = series.filter((d) => d.measured)
    const unmeasured = series.length - measured.length
    const reasons = ['thin-week', 'thin-baseline', 'flat-baseline']
    console.log(`\n  band ${band.toFixed(1)}: ${series.length} scored days, ${measured.length} measured`
      + ` (${pct(unmeasured, series.length)} unmeasured:`
      + ` ${reasons.map((r) => `${r} ${pct(series.filter((d) => !d.measured && d.reason === r).length, series.length)}`).join(', ')})`)
    const below = measured.filter((d) => d.side === 'below').length
    const above = measured.filter((d) => d.side === 'above').length
    console.log(`    measured days outside the band: below ${pct(below, measured.length)}, above ${pct(above, measured.length)}`)
    if (measured.length === 0) continue

    const streaks = streaksOf(series)
    for (const minRun of MIN_RUNS) {
      const runs = streaks.filter((s) => s.days >= minRun)
      const per30 = (side) => ((runs.filter((r) => r.side === side).length / measured.length) * 30).toFixed(2)
      // A day is inside a run from the one that reaches the minimum: a streak of n >= minRun
      // contributes n - minRun + 1 of those days.
      const inside = runs.reduce((t, r) => t + r.days - minRun + 1, 0)
      const lengths = runs.map((r) => r.days)
      console.log(`    min run ${minRun}: runs per 30 measured days, below ${per30('below')}, above ${per30('above')}`
        + `; length median ${median(lengths) ?? 'n/a'}, longest ${lengths.length === 0 ? 0 : Math.max(...lengths)}`
        + `; inside a run ${pct(inside, measured.length)}`)
    }
  }
  console.log('')
})

console.log(`\n${'='.repeat(70)}`)
console.log('Reminder: these figures are about one household. Keep them out of git.')
