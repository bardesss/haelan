// Anomaly detection, throwaway. Measures whether a per-person baseline can separate an unusual day
// from an ordinary one on this archive, and at what threshold - before anything is designed around
// the idea that it can.
//
//   node --experimental-strip-types probe/scripts/anomaly-thresholds.mjs [dataDir]
//
// dataDir defaults to $HAELAN_DATA_DIR, then ./.local-archive. It must be a directory holding
// haelan.sqlite, not the file itself.
//
// Opens through `openReadOnly`, never `openHaelan`. That is not a detail: openHaelan migrates on
// open and can set a boot rebuild going, which against a live instance means the write lock held
// for the length of a rebuild. This connection migrates nothing, writes nothing and creates no
// encryption key, so it is safe to point at a running instance's data directory.
//
// PRIVACY. This prints no health measurement: no step count, no heart rate, no sleep duration, no
// date a reading was taken. It prints flag rates, day counts, coverage fractions and z-thresholds,
// which are the figures under test. Its write-up stays out of git for the same reason M6-0's did -
// these are counts about one household and the repository is public. Anything added here has to be
// safe to paste into a terminal somebody is sharing.
//
// The four questions, in the order the design needs them answered:
//
//   1. Does a usable baseline exist at all, and how often? `thin` needs 14 contributing days and
//      70% of the window, so early-archive days and days after a gap have no baseline. Those are
//      refusals, not findings, and a feature whose refusal rate is high is a different feature.
//   2. What does each threshold actually flag? High and low tails counted separately, because a
//      low-step day and a high-step day are different events with different meanings.
//   3. Does coverage decide it? A day at 40% wear has low steps because the watch was charging.
//      M6-0 found coverage never decides a RECORD - a big day is a worn day - and that finding
//      does not transfer here: it inverts, because anomaly detection lives in the thin tail that
//      records never touch. If the low tail is mostly thin-coverage days, the detector detects
//      charging and the feature is not buildable as specified.
//   4. Are flagged days isolated or clustered? Five consecutive flagged days is one holiday, not
//      five anomalies, and that decides whether a feed lists days or episodes.

import { openReadOnly } from '../../packages/core/src/db/openReadOnly.ts'
import { baselineOf, zScoreOf, BASELINE_WINDOW_DAYS, BASELINE_MIN_DAYS } from '../../packages/core/src/query/baseline.ts'
import { coverageIsMeaningful } from '../../packages/core/src/query/coverageSignal.ts'

const DIR = process.argv[2] ?? process.env.HAELAN_DATA_DIR ?? './.local-archive'

// The thresholds a design would plausibly pick. 2 is the conventional one and the reason for the
// sweep: if roughly normal, z>2 flags about 5% of days by construction, which is ~18 a year per
// metric before anything interesting has happened.
const Z_THRESHOLDS = [1.5, 2, 2.5, 3]

// Swept rather than chosen, the same way M6-0 swept its eligibility gates. If the answer is the
// same at every floor the choice does not matter and this says so; if it swings, the swing is the
// finding.
const COVERAGE_FLOORS = [0, 0.25, 0.5, 0.75]

// The metrics an anomaly could mean something for: a daily figure that varies day to day and whose
// movement a person could act on. Deliberately not every metric in the catalogue.
const METRICS = [
  'sleep_asleep_minutes',
  'sleep_efficiency',
  'resting_heart_rate',
  'daily_hrv',
  'daily_spo2',
  'steps',
]

// Merged first, then provider. M6-0's own first wrong answer was filtering to 'merged' alone:
// some metrics are written only under 'provider' and have no merged row at all, so a reader doing
// that reports them as absent while the archive holds years of them.
const TIERS = ['merged', 'provider']

const db = openReadOnly(DIR).$client
const rows = (sqlText, ...args) => db.prepare(sqlText).all(...args)
const pct = (n, d) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`)

const DAY_MS = 86_400_000
const dayNumber = (localDate) => Math.round(Date.parse(`${localDate}T00:00:00Z`) / DAY_MS)

console.log(`\n# Anomaly thresholds, ${DIR}\n`)
console.log(`baseline window ${BASELINE_WINDOW_DAYS} days, minimum ${BASELINE_MIN_DAYS} contributing`)

const people = rows(`SELECT id FROM people ORDER BY id`)
console.log(`people: ${people.length}`)

for (const person of people) {
  console.log(`\n${'='.repeat(70)}\n## person ${person.id.slice(0, 4)}…\n`)

  for (const metric of METRICS) {
    // Whichever tier actually holds this metric, preferring merged. Printed, because "which tier
    // holds this" is a question the feature has to answer before it can read anything.
    let tier = null
    let series = []
    for (const candidate of TIERS) {
      const found = rows(
        `SELECT local_date, value, coverage, agg FROM daily
          WHERE person_id = ? AND metric = ? AND source = ? AND value IS NOT NULL
          ORDER BY local_date`,
        person.id, metric, candidate,
      )
      if (found.length > 0) { tier = candidate; series = found; break }
    }

    if (tier === null) {
      console.log(`### ${metric}\n  no rows in any tier\n`)
      continue
    }

    // One aggregate only. A metric declaring two aggs would otherwise contribute each day twice
    // with different values, and the baseline would be computed over a mixture of two series.
    const aggs = [...new Set(series.map((r) => r.agg))]
    const agg = aggs[0]
    series = series.filter((r) => r.agg === agg)

    const byDay = new Map(series.map((r) => [dayNumber(r.local_date), r]))
    const days = [...byDay.keys()].sort((a, b) => a - b)
    const span = days.length === 0 ? 0 : days[days.length - 1] - days[0] + 1

    console.log(`### ${metric}`)
    console.log(`  tier ${tier}, agg ${agg}${aggs.length > 1 ? ` (of ${aggs.length}: ${aggs.join(', ')})` : ''}`)
    console.log(`  ${series.length} days with a value, over a ${span} day span`)
    console.log(`  coverage recorded on ${series.filter((r) => r.coverage !== null).length} of them`)

    // ---------------------------------------------------------------- question 1: is there a baseline
    //
    // Judged exactly as the app would judge it: the 60 days ENDING THE DAY BEFORE, never including
    // the day under test - baseline.ts is explicit that a reading is never part of the baseline it
    // is judged against.
    const scored = []
    let thin = 0
    let noBaseline = 0
    let zeroSpread = 0

    for (const day of days) {
      const window = []
      for (let back = 1; back <= BASELINE_WINDOW_DAYS; back += 1) {
        const prior = byDay.get(day - back)
        if (prior !== undefined) window.push(prior.value)
      }
      const baseline = baselineOf(window, BASELINE_WINDOW_DAYS)
      if (baseline === null) { noBaseline += 1; continue }
      if (baseline.thin) { thin += 1; continue }
      const z = zScoreOf(byDay.get(day).value, baseline)
      // Null means the spread was zero: a distance measured in units of nothing. Counted rather
      // than dropped silently, because a metric where this is common cannot be judged this way at
      // all.
      if (z === null) { zeroSpread += 1; continue }
      scored.push({ day, z, coverage: byDay.get(day).coverage })
    }

    const judged = scored.length
    console.log(`  judgeable: ${judged} (${pct(judged, days.length)})`)
    console.log(`    refused - no prior days at all: ${noBaseline}`)
    console.log(`    refused - baseline too thin:    ${thin}`)
    console.log(`    refused - spread was zero:      ${zeroSpread}`)

    if (judged === 0) { console.log('') ; continue }

    // ---------------------------------------------------------------- question 2: what gets flagged
    console.log(`  flagged, of ${judged} judgeable days:`)
    for (const z of Z_THRESHOLDS) {
      const high = scored.filter((s) => s.z >= z).length
      const low = scored.filter((s) => s.z <= -z).length
      const perYear = ((high + low) / judged) * 365
      console.log(
        `    z>=${z.toFixed(1)}  high ${String(high).padStart(4)} ${pct(high, judged).padStart(6)}`
        + `   low ${String(low).padStart(4)} ${pct(low, judged).padStart(6)}`
        + `   ~${perYear.toFixed(0)}/year`,
      )
    }

    // ---------------------------------------------------------------- question 3: does coverage decide it
    //
    // Only asked where coverage means something. coverageIsMeaningful is the app's own rule for
    // that, reused rather than reimplemented: a provider reconciled row has no samples underneath
    // it and its coverage is null, which is not the same as zero.
    const withCoverage = scored.filter((s) => s.coverage !== null)
    if (!coverageIsMeaningful(metric) || withCoverage.length === 0) {
      console.log(`  coverage: not meaningful for this metric, or never recorded`)
    } else {
      const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length)
      const lowTail = withCoverage.filter((s) => s.z <= -2)
      const highTail = withCoverage.filter((s) => s.z >= 2)
      const rest = withCoverage.filter((s) => s.z > -2 && s.z < 2)
      const show = (label, xs) => {
        const m = mean(xs.map((s) => s.coverage))
        console.log(`    ${label.padEnd(22)} n=${String(xs.length).padStart(4)}  mean coverage ${m === null ? 'n/a' : m.toFixed(3)}`)
      }
      console.log(`  coverage of the tails (the question that decides whether this is buildable):`)
      show('low tail (z<=-2)', lowTail)
      show('high tail (z>=2)', highTail)
      show('everything else', rest)

      console.log(`  low-tail flags surviving a coverage floor:`)
      for (const floor of COVERAGE_FLOORS) {
        const survivors = lowTail.filter((s) => s.coverage >= floor).length
        console.log(`    floor ${floor.toFixed(2)}  ${String(survivors).padStart(4)} of ${lowTail.length}  ${pct(survivors, lowTail.length)}`)
      }
    }

    // ---------------------------------------------------------------- question 4: isolated or clustered
    //
    // Runs of consecutive CALENDAR days among the flagged ones. A run is one event to a reader -
    // an illness, a holiday, a week of shift work - and a feed that lists each of its days as a
    // separate finding is five notifications for one thing.
    const flaggedDays = scored.filter((s) => Math.abs(s.z) >= 2).map((s) => s.day).sort((a, b) => a - b)
    const runs = []
    for (const day of flaggedDays) {
      const last = runs[runs.length - 1]
      if (last !== undefined && day === last.end + 1) last.end = day
      else runs.push({ start: day, end: day })
    }
    const lengths = runs.map((r) => r.end - r.start + 1)
    const isolated = lengths.filter((n) => n === 1).length
    console.log(`  clustering at z>=2: ${flaggedDays.length} flagged days form ${runs.length} runs`)
    console.log(`    isolated single days: ${isolated} (${pct(isolated, runs.length)})`)
    console.log(`    longest run: ${lengths.length === 0 ? 0 : Math.max(...lengths)} days`)
    console.log('')
  }
}

console.log(`\n${'='.repeat(70)}`)
console.log('Reminder: these figures are about one household. Keep them out of git.')
