// Prints the recovery composite's distribution over a real archive, so RECOVERY_SCALE is measured
// rather than chosen. Run against .local-archive; DO NOT commit its output, which carries figures
// off a household archive.
//
//   node --experimental-strip-types scripts/probe-recovery-scale.mjs .local-archive/haelan.sqlite
import { recoveryIndexSeries, recoveryWindowStart } from '../packages/core/src/api/recoveryIndex.ts'

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
collect('hrv', 'daily_hrv', 'last')
collect('restingHeartRate', 'resting_heart_rate', 'last')
collect('respiratoryRate', 'respiratory_rate', 'last')
collect('asleepMinutes', 'sleep_asleep_minutes', 'sum')
collect('bedtimeMinutes', 'sleep_bedtime_minutes', 'last')

for (const [personId, input] of byPerson) {
  const dates = input.hrv.map((d) => d.localDate)
  if (dates.length === 0) continue
  const to = dates[dates.length - 1]
  // Start scoring only once a full window exists behind the first scorable day.
  const from = recoveryWindowStart(to)
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
}
