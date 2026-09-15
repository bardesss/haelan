// M6-0, throwaway. Measures whether a day the reader excluded, or a day whose coverage is thin,
// would ever hold an all-time record or move an Eddington number. The answer decides one rule
// that M6b and M6c both read through, and it is measured rather than decided because the honest
// answer may differ between the two kinds of figure: a record is a single winning day, so one bad
// day decides it outright, while an Eddington number is a threshold count over the whole history
// and may be almost immune.
//
//   node --experimental-strip-types probe/scripts/all-time-eligibility.mjs [dataDir]
//
// dataDir defaults to $HAELAN_DATA_DIR, then ./.local-demo. It must be a directory holding
// haelan.sqlite, not the file itself.
//
// Opens through `openReadOnly`, never `openHaelan`. That is not a detail: openHaelan migrates on
// open and can set a boot rebuild going, which against a live instance means a write lock held
// for the length of a rebuild. This connection migrates nothing, writes nothing and creates no
// encryption key, so it is safe to point at a running instance's data directory.
//
// PRIVACY. This prints no health measurement: no step count, no distance, no record value. It
// prints ranks, day counts, coverage fractions, percentages, and the Eddington integers, which
// are the figures under test. Even so, this run's own write-up was kept out of git: the counts and
// the Eddington integer are figures about one household, and this repository is public. Anything
// added to this script has to be safe to paste into a terminal somebody is sharing.

import { openReadOnly } from '../../packages/core/src/db/openReadOnly.ts'
import { parseDayMetricTarget } from '../../packages/core/src/derive/targetKey.ts'
import { coverageIsMeaningful } from '../../packages/core/src/query/coverageSignal.ts'

const DIR = process.argv[2] ?? process.env.HAELAN_DATA_DIR ?? './.local-demo'

// The two derived tiers, in the order a reader should prefer them. A record read off one DEVICE's
// rows would be a record for that device rather than for the person, so a real source id is never
// used here - but 'merged' alone is not enough either, and that was this probe's first wrong
// answer: floors and total_calories are written under 'provider' and have no merged row at all,
// so filtering to merged reported two of the five metrics as absent when this archive holds 230
// and 750 days of them. Each metric is read from whichever tier actually has rows, and the tier
// is printed, because "which tier holds this metric" turns out to be a question M6c has to answer
// before it can show a record for one.
const TIERS = ['merged', 'provider']

// The metrics an all-time record would mean something for: a daily quantity that varies day to
// day and that somebody could plausibly beat. Deliberately not every metric in the catalogue -
// an all-time maximum resting heart rate is not an achievement, it is a bad night.
const RECORD_METRICS = ['steps', 'distance', 'floors', 'active_energy', 'total_calories']

// No threshold for "thin" exists in the app yet, so the probe refuses to invent one and sweeps
// instead. If the answer is the same at every threshold the choice does not matter and the
// finding says so; if it swings, that swing IS the finding.
const COVERAGE_THRESHOLDS = [0.25, 0.5, 0.75]

// The Eddington step scale: E days of at least E thousand steps.
const EDDINGTON_UNIT = 1000

// openReadOnly hands back a drizzle handle. This takes the better-sqlite3 client off it with
// `$client` rather than importing drizzle's `sql` template, because `probe/` is not a workspace
// package and cannot resolve `drizzle-orm` at all - the existing probe scripts only get away with
// importing core's TypeScript because core resolves its own dependencies. The placeholders below
// are better-sqlite3's own, so every interpolated value is still bound rather than pasted.
const db = openReadOnly(DIR).$client
const rows = (sqlText, ...args) => db.prepare(sqlText).all(...args)
const pct = (n, d) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`)

console.log(`\n# All-time eligibility, ${DIR}\n`)

const people = rows(`SELECT id FROM people ORDER BY id`)
console.log(`people: ${people.length}`)

// ------------------------------------------------------------------ the exclusion inventory
//
// This block guards against the failure this probe could most easily commit: reporting "no
// excluded day ever holds a record" from an archive that holds no exclusions at all. Those are
// opposite findings and they look identical in a count of zero.

const overrideTally = rows(
  `SELECT scope, action, COUNT(*) AS n FROM overrides GROUP BY scope, action ORDER BY scope, action`,
)
console.log(`\n## Overrides on disk\n`)
if (overrideTally.length === 0) {
  console.log('  none, of any scope')
} else {
  for (const r of overrideTally) console.log(`  ${r.scope.padEnd(12)} ${r.action.padEnd(8)} ${r.n}`)
}

const dayMetricExcludes = rows(
  `SELECT person_id, target_key FROM overrides WHERE scope = 'day_metric' AND action = 'exclude'`,
).map((r) => ({ personId: r.person_id, ...parseDayMetricTarget(r.target_key) }))

const excludedKey = new Set(dayMetricExcludes.map((e) => `${e.personId}|${e.localDate}|${e.metric}`))

console.log(`\n  day_metric exclusions parsed: ${dayMetricExcludes.length}`)
if (dayMetricExcludes.length === 0) {
  console.log(`  !! THE EXCLUSION HALF OF THIS PROBE IS UNMEASURED.`)
  console.log(`     Nothing below about excluded days is evidence. An archive with no exclusions`)
  console.log(`     cannot show whether an exclusion would matter, and a zero here means only`)
  console.log(`     that nobody has excluded anything.`)
}

for (const [i, person] of people.entries()) {
  // Indexed rather than named. The id is not a health measurement, but it is an identifier, and
  // nothing in this write-up needs it.
  console.log(`\n## Person ${i + 1} of ${people.length}\n`)

  const span = rows(
    `SELECT MIN(local_date) AS first, MAX(local_date) AS last, COUNT(DISTINCT local_date) AS days
       FROM daily WHERE person_id = ? AND source = ?`,
    person.id, TIERS[0],
  )[0]
  if (!span || span.days === 0) { console.log('  no merged daily rows'); continue }
  console.log(`  span ${span.first} to ${span.last}, ${span.days} distinct days with any merged row`)

  for (const metric of RECORD_METRICS) {
    const tier = TIERS.find((candidate) => rows(
      `SELECT 1 FROM daily WHERE person_id = ? AND source = ? AND metric = ? AND value IS NOT NULL LIMIT 1`,
      person.id, candidate, metric,
    ).length > 0)
    if (tier === undefined) { console.log(`\n  ${metric}: no rows in any derived tier`); continue }

    const aggs = rows(
      `SELECT DISTINCT agg FROM daily
        WHERE person_id = ? AND source = ? AND metric = ? AND value IS NOT NULL`,
      person.id, tier, metric,
    ).map((r) => r.agg)

    for (const agg of aggs) {
      const days = rows(
        `SELECT local_date, value, coverage FROM daily
          WHERE person_id = ? AND source = ? AND metric = ? AND agg = ? AND value IS NOT NULL
          ORDER BY value DESC`,
        person.id, tier, metric, agg,
      )
      const meaningful = coverageIsMeaningful(metric)
      const isExcluded = (d) => excludedKey.has(`${person.id}|${d.local_date}|${metric}`)
      const withCoverage = days.filter((d) => d.coverage !== null).length

      console.log(`\n  ${metric} (${agg}) from the ${tier} tier, ${days.length} days with a value`)
      console.log(`    coverage meaningful for this metric: ${meaningful}`)
      console.log(`    rows carrying a coverage number: ${withCoverage} of ${days.length} (${pct(withCoverage, days.length)})`)

      const record = days[0]
      console.log(`    record day: excluded=${isExcluded(record)} coverage=${record.coverage === null ? 'null' : record.coverage.toFixed(3)}`)

      const top = days.slice(0, 10)
      console.log(`    of the top 10: ${top.filter(isExcluded).length} excluded`)
      if (meaningful) {
        for (const t of COVERAGE_THRESHOLDS) {
          const thin = top.filter((d) => d.coverage !== null && d.coverage < t).length
          console.log(`      coverage < ${t}: ${thin} of the top 10`)
        }
      }

      // Would a rule change who holds the record? Each rule is asked ON ITS OWN as well as in
      // combination, because a first version of this block folded the exclusion filter into
      // every coverage rule and so reported coverage as changing a record that corrections had
      // already changed - crediting a rule for somebody else's effect, which is the one thing
      // this measurement exists to get right.
      const keeps = (d, { corrections, threshold }) => {
        if (corrections && isExcluded(d)) return false
        if (threshold !== null && meaningful && d.coverage !== null && d.coverage < threshold) return false
        return true
      }
      const promotes = (rule) => days.findIndex((d) => keeps(d, rule)) + 1

      const rules = [{ label: 'corrections only', rule: { corrections: true, threshold: null } }]
      if (meaningful) {
        for (const t of COVERAGE_THRESHOLDS) {
          rules.push({ label: `coverage<${t} only`, rule: { corrections: false, threshold: t } })
          rules.push({ label: `both+coverage<${t}`, rule: { corrections: true, threshold: t } })
        }
      }
      const moved = rules.filter((r) => promotes(r.rule) > 1)
      console.log(`    record holder changes under: ${moved.length === 0 ? 'none of the rules tested' : moved.map((r) => r.label).join(', ')}`)
      for (const r of moved) {
        console.log(`      rule ${r.label.padEnd(20)} promotes the day ranked ${promotes(r.rule)}`)
      }
    }
  }

  // E days of at least E thousand steps, computed four ways over the same history. The integer is
  // the deliverable, so it is printed; what matters is whether the rules move it at all.
  const stepDays = rows(
    `SELECT local_date, value, coverage FROM daily
      WHERE person_id = ? AND source = ? AND metric = 'steps' AND agg = 'sum' AND value IS NOT NULL`,
    person.id, TIERS[0],
  )
  if (stepDays.length === 0) { console.log('\n  eddington: no merged step days'); continue }

  const eddington = (kept) => {
    const sorted = kept.map((d) => d.value / EDDINGTON_UNIT).sort((a, b) => b - a)
    let e = 0
    while (e < sorted.length && sorted[e] >= e + 1) e += 1
    return e
  }
  const notExcluded = stepDays.filter((d) => !excludedKey.has(`${person.id}|${d.local_date}|steps`))

  // Each rule on its own as well as combined, and each line says how many days ITS OWN filter
  // dropped, for the same reason the record block above does it: a combined line alone cannot
  // show which half of the rule did the work.
  console.log(`\n  eddington over ${stepDays.length} step days`)
  console.log(`    ${'raw'.padEnd(23)} E=${eddington(stepDays)}`)
  console.log(`    ${'corrections only'.padEnd(23)} E=${eddington(notExcluded)}  (dropped ${stepDays.length - notExcluded.length})`)
  for (const t of COVERAGE_THRESHOLDS) {
    const thinOnly = stepDays.filter((d) => d.coverage === null || d.coverage >= t)
    console.log(`    ${`coverage >= ${t} only`.padEnd(23)} E=${eddington(thinOnly)}  (dropped ${stepDays.length - thinOnly.length})`)
  }
  for (const t of COVERAGE_THRESHOLDS) {
    const both = notExcluded.filter((d) => d.coverage === null || d.coverage >= t)
    console.log(`    ${`both, coverage >= ${t}`.padEnd(23)} E=${eddington(both)}  (dropped ${stepDays.length - both.length})`)
  }
}

db.close()
console.log('')
