// Compares haelan's recovery index against Google Health's herstelscore, harvested by hand through
// `admin.ts harvest-recovery`. Step 3 of the calibration sequence in the recovery index design doc.
//
// Run against a restored backup; DO NOT commit its output, which carries figures off a household
// archive - the same rule probe-recovery-scale.mjs carries.
//
//   node --experimental-strip-types scripts/probe-recovery-calibration.mjs .local-calib/haelan.sqlite [--exclude YYYY-MM-DD]
import { recoveryIndexSeries, SLEEP_WEEK_DAYS, RECOVERY_METRIC_SOURCES, RECOVERY_HARVEST_EVENT_KIND } from '../packages/core/src/api/recoveryIndex.ts'
import { shiftLocalDate } from '../packages/core/src/derive/localDay.ts'
import { BASELINE_WINDOW_DAYS } from '../packages/core/src/query/baseline.ts'

// Same resolution detail, and the same reason, as probe-recovery-scale.mjs: better-sqlite3 is a
// dependency of packages/core rather than of the repo root, so pnpm does not hoist it here.
let Database
try {
  ;({ default: Database } = await import('../packages/core/node_modules/better-sqlite3/lib/index.js'))
} catch (cause) {
  console.error('Could not load better-sqlite3 via packages/core/node_modules; see probe-recovery-scale.mjs.')
  console.error(cause)
  process.exit(1)
}

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: probe-recovery-calibration.mjs <path to haelan.sqlite> [--exclude YYYY-MM-DD ...]')
  process.exit(1)
}
const excluded = new Set()
for (let i = 3; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--exclude' && process.argv[i + 1] !== undefined) excluded.add(process.argv[i += 1])
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
for (const source of RECOVERY_METRIC_SOURCES) collect(source.key, source.metric, source.agg)

// The harvested score's own local date, reconstructed the way harvest-recovery wrote it: the row's
// startedAtMs is local midnight opening that date, and the offset is the one in force at that
// instant. Adding the offset back and reading the UTC date returns the original YYYY-MM-DD without
// this probe needing a timezone database of its own.
const harvestRows = db.prepare(
  `select person_id, started_at_ms, started_at_offset_minutes, value from events
   where kind = ? and value is not null order by started_at_ms`,
).all(RECOVERY_HARVEST_EVENT_KIND)

const harvestByPerson = new Map()
for (const row of harvestRows) {
  const localDate = new Date(row.started_at_ms + row.started_at_offset_minutes * 60_000)
    .toISOString().slice(0, 10)
  const map = harvestByPerson.get(row.person_id) ?? new Map()
  map.set(localDate, row.value)
  harvestByPerson.set(row.person_id, map)
}

const pearson = (xs, ys) => {
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i += 1) {
    const a = xs[i] - mx, b = ys[i] - my
    num += a * b; dx += a * a; dy += b * b
  }
  return num / Math.sqrt(dx * dy)
}

// Fisher z interval, so the number is reported with its uncertainty rather than as a point estimate
// a reader would over-trust at n of this size.
const ciFor = (r, n) => {
  if (n < 4) return null
  const z = 0.5 * Math.log((1 + r) / (1 - r))
  const se = 1 / Math.sqrt(n - 3)
  const lo = Math.tanh(z - 1.96 * se), hi = Math.tanh(z + 1.96 * se)
  return [lo, hi]
}

for (const [personId, input] of byPerson) {
  const harvest = harvestByPerson.get(personId)
  if (harvest === undefined || harvest.size === 0) continue

  const dates = input.hrv.map((d) => d.localDate)
  if (dates.length === 0) continue
  const from = shiftLocalDate(dates[0], BASELINE_WINDOW_DAYS + SLEEP_WEEK_DAYS - 1)
  const series = recoveryIndexSeries(input, { from, to: dates[dates.length - 1] })

  console.log(`\n=== ${personId.slice(0, 6)} ===`)
  console.log(`harvested scores: ${harvest.size}${excluded.size > 0 ? `  (excluding ${[...excluded].join(', ')})` : ''}`)

  // Every harvested day that the index could not score, and why - reported before the correlation,
  // because a pairing that silently dropped a third of the sample would otherwise look like a
  // clean result computed over a set nobody named.
  const unscored = []
  for (const date of harvest.keys()) {
    if (excluded.has(date)) continue
    const day = series.get(date)
    if (day === undefined) unscored.push([date, 'outside the scorable window'])
    else if (!day.enough) unscored.push([date, `withheld: missing ${day.missing.join(', ')}`])
  }
  if (unscored.length > 0) {
    console.log(`unpaired (${unscored.length}):`)
    for (const [date, why] of unscored) console.log(`  ${date}  ${why}`)
  } else {
    console.log('unpaired: none')
  }

  // Lag 0 is the aligned comparison. -1 and +1 exist to catch a date-convention mismatch: if the
  // app's score for day D describes the night entering D while ours describes something a day
  // either side, a lagged correlation beats the aligned one and says so plainly.
  for (const lag of [-1, 0, 1]) {
    const ours = [], theirs = [], diffs = []
    for (const [date, score] of harvest) {
      if (excluded.has(date)) continue
      const day = series.get(shiftLocalDate(date, lag))
      if (day === undefined || !day.enough) continue
      ours.push(day.score); theirs.push(score); diffs.push(Math.abs(day.score - score))
    }
    if (ours.length < 4) { console.log(`lag ${lag >= 0 ? '+' : ''}${lag}: too few pairs (${ours.length})`); continue }
    const r = pearson(ours, theirs)
    const ci = ciFor(r, ours.length)
    const mad = diffs.reduce((a, b) => a + b, 0) / diffs.length
    const bias = ours.reduce((a, b) => a + b, 0) / ours.length - theirs.reduce((a, b) => a + b, 0) / theirs.length
    const label = lag === 0 ? 'lag  0 (aligned)' : `lag ${lag > 0 ? '+' : ''}${lag}`
    console.log(
      `${label}: n=${ours.length}  r=${r.toFixed(3)}` +
      `${ci ? `  95% CI [${ci[0].toFixed(2)}, ${ci[1].toFixed(2)}]` : ''}` +
      `  mean|diff|=${mad.toFixed(1)}  bias(ours-theirs)=${bias >= 0 ? '+' : ''}${bias.toFixed(1)}`,
    )
  }

  // The two spreads side by side. A correlation says nothing about whether the two use their range
  // the same way, and RECOVERY_SCALE controls exactly that - so a good r with very different
  // spreads is a different finding from a good r with matching ones.
  const paired = []
  for (const [date, score] of harvest) {
    if (excluded.has(date)) continue
    const day = series.get(date)
    if (day !== undefined && day.enough) paired.push([day.score, score])
  }
  if (paired.length >= 4) {
    const sd = (xs) => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length
      return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
    }
    const o = paired.map((p) => p[0]), t = paired.map((p) => p[1])
    const fmt = (xs) => `min ${Math.min(...xs).toFixed(0)}  median ${[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(0)}  max ${Math.max(...xs).toFixed(0)}  sd ${sd(xs).toFixed(1)}`
    console.log(`  ours   ${fmt(o)}`)
    console.log(`  theirs ${fmt(t)}`)
  }
}
db.close()
