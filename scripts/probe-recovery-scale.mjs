// Prints the recovery composite's distribution over a real archive, so RECOVERY_SCALE is measured
// rather than chosen. Run against .local-archive; DO NOT commit its output, which carries figures
// off a household archive.
//
//   node --experimental-strip-types scripts/probe-recovery-scale.mjs .local-archive/haelan.sqlite
import { recoveryIndexSeries, RECOVERY_SCALE, SLEEP_WEEK_DAYS, RECOVERY_METRIC_SOURCES } from '../packages/core/src/api/recoveryIndex.ts'
import { shiftLocalDate } from '../packages/core/src/derive/localDay.ts'
import { BASELINE_WINDOW_DAYS } from '../packages/core/src/query/baseline.ts'

// better-sqlite3 is a dependency of packages/core, not of the repo root, so pnpm only links it
// under packages/core/node_modules - a bare `import Database from 'better-sqlite3'` run from here
// cannot see it. Importing it by that relative path is a resolution detail, not a change to the
// query - but that path is fragile to a pnpm layout change, so a failure here is disambiguated
// below rather than left to surface as a bare module-not-found.
let Database
try {
  ;({ default: Database } = await import('../packages/core/node_modules/better-sqlite3/lib/index.js'))
} catch (cause) {
  console.error(
    'Could not load better-sqlite3 via packages/core/node_modules. ' +
    'This probe reaches into that package\'s own node_modules because better-sqlite3 is a ' +
    'dependency of packages/core, not of the repo root, so pnpm does not hoist it here - if ' +
    'that layout has changed, this relative import needs updating.',
  )
  console.error(cause)
  process.exit(1)
}

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: probe-recovery-scale.mjs <path to haelan.sqlite>')
  process.exit(1)
}
const db = new Database(file, { readonly: true })

const rows = (metric, agg) => db.prepare(
  `select person_id, local_date, value from daily
   where metric = ? and agg = ? and source = 'merged' and value is not null
   order by local_date`,
).all(metric, agg)

const byPerson = new Map()
const collect = (field, metric, agg) => {
  for (const row of rows(metric, agg)) {
    const person = byPerson.get(row.person_id) ?? {
      hrv: [], restingHeartRate: [], respiratoryRate: [], asleepMinutes: [], bedtimeMinutes: [],
    }
    person[field].push({ localDate: row.local_date, value: row.value })
    byPerson.set(row.person_id, person)
  }
}
// The same metric/agg pairing every surface reads, rather than a sixth independent copy of it.
for (const source of RECOVERY_METRIC_SOURCES) collect(source.key, source.metric, source.agg)

for (const [personId, input] of byPerson) {
  const dates = input.hrv.map((d) => d.localDate)
  if (dates.length === 0) continue
  const to = dates[dates.length - 1]
  // Score every day the data can support, not only the final ~67 days. `recoveryWindowStart(to)`
  // is the window BEHIND the last date - anchoring `from` on it scores only the tail of the
  // archive regardless of how much history actually exists. The first day that can be scored at
  // all is the earliest day whose own baseline-plus-sleep-week window (recoveryWindowStart) does
  // not reach earlier than this person's first recorded day - which inverts to: this person's
  // first recorded day, walked forward by that same window length.
  const earliest = dates[0]
  const from = shiftLocalDate(earliest, BASELINE_WINDOW_DAYS + SLEEP_WEEK_DAYS - 1)
  const series = recoveryIndexSeries(input, { from, to })
  const composites = [...series.values()].filter((r) => r.enough).map((r) => r.composite).sort((a, b) => a - b)
  if (composites.length === 0) {
    console.log(`${personId.slice(0, 6)}: no scorable days`)
    continue
  }
  const at = (q) => composites[Math.min(composites.length - 1, Math.floor(q * composites.length))]
  console.log(`${personId.slice(0, 6)}: n=${composites.length}`)
  console.log(`  p05 ${at(0.05).toFixed(3)}  p25 ${at(0.25).toFixed(3)}  p50 ${at(0.50).toFixed(3)}  p75 ${at(0.75).toFixed(3)}  p95 ${at(0.95).toFixed(3)}`)
  // k such that the 5th and 95th percentile land near 10 and 90, which is a score using its range.
  const suggested = Math.log(9) / Math.max(Math.abs(at(0.05)), Math.abs(at(0.95)))
  console.log(`  suggested RECOVERY_SCALE: ${suggested.toFixed(3)}`)
  // The four percentiles bandOf's five-way split needs (bottom tenth / next fifth / middle two
  // fifths / next fifth / top tenth), read straight off the data rather than estimated from a
  // single tail under a normality assumption - the composite need not be symmetric.
  console.log(`  p10 ${at(0.10).toFixed(3)}  p30 ${at(0.30).toFixed(3)}  p70 ${at(0.70).toFixed(3)}  p90 ${at(0.90).toFixed(3)}`)
  // Each mapped through the same curve recoveryIndexSeries uses, at the shipped RECOVERY_SCALE, so
  // this prints the bandOf cut points directly rather than leaving that arithmetic to be redone by
  // hand from the raw composite percentiles above.
  const scoreAt = (composite) => 100 / (1 + Math.exp(-RECOVERY_SCALE * composite))
  console.log(
    `  band cuts at shipped scale (score)  low/below ${scoreAt(at(0.10)).toFixed(2)}` +
    `  below/usual ${scoreAt(at(0.30)).toFixed(2)}` +
    `  usual/above ${scoreAt(at(0.70)).toFixed(2)}` +
    `  above/high ${scoreAt(at(0.90)).toFixed(2)}`,
  )
  // The same four cuts, but mapped through the scale this run just suggested - what bandOf's cut
  // points must become if RECOVERY_SCALE is refit to this sample.
  const scoreAtSuggested = (composite) => 100 / (1 + Math.exp(-suggested * composite))
  console.log(
    `  band cuts at suggested scale (score)  low/below ${scoreAtSuggested(at(0.10)).toFixed(2)}` +
    `  below/usual ${scoreAtSuggested(at(0.30)).toFixed(2)}` +
    `  usual/above ${scoreAtSuggested(at(0.70)).toFixed(2)}` +
    `  above/high ${scoreAtSuggested(at(0.90)).toFixed(2)}`,
  )
}
