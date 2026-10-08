// Fits the recovery index's four weights and its scale against Google Health's herstelscore,
// harvested by hand through `admin.ts harvest-recovery`. Step 4 of the calibration sequence: the
// calibration probe says how far apart the two are; this one says which constants close the gap
// without moving what 50 means.
//
// Run against a restored backup; DO NOT commit its output, which carries figures off a household
// archive - the same rule probe-recovery-scale.mjs and probe-recovery-calibration.mjs carry.
//
//   node --experimental-strip-types scripts/probe-recovery-fit.mjs .local-archive/haelan.sqlite [--exclude YYYY-MM-DD ...]
//
// What it does, in order:
//   1. The current weights' correlation with the harvested scores: the baseline to beat.
//   2. A search of every weight combination in steps of 0.05, each at least 0.05, summing to 1,
//      ranked by Pearson r of the composite against the harvested scores.
//   3. Leave-one-out: for each harvested day, the weights that score best on the OTHER days, then
//      that day's composite under them. r over those held-out composites is what the search can be
//      trusted to deliver on a day it has not seen. With a few dozen days, the in-sample best is
//      flattered; this number is not.
//   4. The scale that makes the index's spread on the harvested days match Google's, so the
//      swings agree without an offset: zero composite stays at 50, "your usual".
// It suggests changing the weights only when the leave-one-out r beats the current weights' r by
// at least MIN_GAIN; otherwise it keeps them and fits only the scale.
import { recoveryIndexSeries, RECOVERY_WEIGHTS, SLEEP_WEEK_DAYS, RECOVERY_METRIC_SOURCES, RECOVERY_HARVEST_EVENT_KIND } from '../packages/core/src/api/recoveryIndex.ts'
import { shiftLocalDate } from '../packages/core/src/derive/localDay.ts'
import { BASELINE_WINDOW_DAYS } from '../packages/core/src/query/baseline.ts'

let Database
try {
  ;({ default: Database } = await import('../packages/core/node_modules/better-sqlite3/lib/index.js'))
} catch (cause) {
  console.error('Could not load better-sqlite3 via packages/core/node_modules; see probe-recovery-scale.mjs.')
  console.error(cause)
  process.exit(1)
}

const STEP = 0.05
const MIN_WEIGHT = 0.05
const MIN_GAIN = 0.03
const MIN_PAIRED = 10
const excluded = new Set()
for (let i = 3; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--exclude' && process.argv[i + 1] !== undefined) excluded.add(process.argv[i += 1])
}
const KEYS = ['hrv', 'restingHeartRate', 'sleep', 'respiratoryRate']

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: probe-recovery-fit.mjs <path to haelan.sqlite>')
  process.exit(1)
}
const db = new Database(file, { readonly: true })

const rows = (metric, agg) => db.prepare(
  `select person_id, local_date, value from daily
   where metric = ? and agg = ? and source = 'merged' and value is not null
   order by local_date`,
).all(metric, agg)

const byPerson = new Map()
for (const source of RECOVERY_METRIC_SOURCES) {
  for (const row of rows(source.metric, source.agg)) {
    const person = byPerson.get(row.person_id) ?? {
      hrv: [], restingHeartRate: [], respiratoryRate: [], asleepMinutes: [], bedtimeMinutes: [],
    }
    person[source.key].push({ localDate: row.local_date, value: row.value })
    byPerson.set(row.person_id, person)
  }
}

// The harvested score's own local date, reconstructed exactly as probe-recovery-calibration.mjs does.
const harvestByPerson = new Map()
for (const row of db.prepare(
  `select person_id, started_at_ms, started_at_offset_minutes, value from events
   where kind = ? and value is not null order by started_at_ms`,
).all(RECOVERY_HARVEST_EVENT_KIND)) {
  const localDate = new Date(row.started_at_ms + row.started_at_offset_minutes * 60_000).toISOString().slice(0, 10)
  const map = harvestByPerson.get(row.person_id) ?? new Map()
  map.set(localDate, row.value)
  harvestByPerson.set(row.person_id, map)
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) }
const pearson = (xs, ys) => {
  const mx = mean(xs), my = mean(ys)
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < xs.length; i += 1) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b }
  return num / Math.sqrt(dx * dy)
}
const scoreOf = (composite, scale) => 100 / (1 + Math.exp(-scale * composite))

// Every weight vector on the 0.05 grid, each at least MIN_WEIGHT, summing to one.
const grid = []
const units = Math.round(1 / STEP), floor = Math.round(MIN_WEIGHT / STEP)
for (let a = floor; a <= units; a += 1) for (let b = floor; a + b <= units; b += 1) for (let c = floor; a + b + c <= units; c += 1) {
  const d = units - a - b - c
  if (d < floor) continue
  grid.push({ hrv: a * STEP, restingHeartRate: b * STEP, sleep: c * STEP, respiratoryRate: d * STEP })
}
const fmtW = (w) => KEYS.map((k) => `${k} ${w[k].toFixed(2)}`).join(', ')

for (const [personId, input] of byPerson) {
  const harvest = harvestByPerson.get(personId)
  if (harvest === undefined || harvest.size === 0) continue
  const earliest = input.hrv[0]?.localDate
  if (earliest === undefined) continue
  // A harvested day counts only once a full baseline window and sleep week stand behind it, the
  // clamp probe-recovery-calibration.mjs applies.
  const firstScored = shiftLocalDate(earliest, BASELINE_WINDOW_DAYS + SLEEP_WEEK_DAYS - 1)
  const allDates = [...harvest.keys()].filter((d) => !excluded.has(d)).sort()
  const dates = allDates.filter((d) => d >= firstScored)
  if (allDates.length > dates.length) {
    console.log(`${personId.slice(0, 6)}: ${allDates.length - dates.length} harvested days fall before a full window and are dropped`)
  }
  if (dates.length === 0) continue
  const range = { from: dates[0], to: dates.at(-1) }

  // Composites for every grid point over the harvested days. The scale cannot change which weights
  // correlate best with the composite, so the search runs on composites and the scale comes after.
  const compositesFor = (weights) => {
    const series = recoveryIndexSeries(input, range, { weights })
    const out = new Map()
    for (const date of dates) { const day = series.get(date); if (day?.enough) out.set(date, day.composite) }
    return out
  }
  const current = compositesFor(RECOVERY_WEIGHTS)
  const paired = dates.filter((d) => current.has(d))
  const theirs = paired.map((d) => harvest.get(d))
  const rOf = (comps, days) => pearson(days.map((d) => comps.get(d)), days.map((d) => harvest.get(d)))

  console.log(`\n=== ${personId.slice(0, 6)} ===  paired days: ${paired.length} of ${harvest.size}`)
  const rCurrent = rOf(current, paired)
  console.log(`current weights (${fmtW(RECOVERY_WEIGHTS)}): r=${rCurrent.toFixed(3)}`)

  const all = grid.map((weights) => ({ weights, comps: compositesFor(weights) }))
  const ranked = all.map((g) => ({ ...g, r: rOf(g.comps, paired) })).sort((a, b) => b.r - a.r)
  console.log('best in-sample:')
  for (const g of ranked.slice(0, 5)) console.log(`  r=${g.r.toFixed(3)}  ${fmtW(g.weights)}`)

  // Leave-one-out over the selection itself.
  const held = []
  for (const out of paired) {
    const rest = paired.filter((d) => d !== out)
    let best = null
    for (const g of all) { const r = rOf(g.comps, rest); if (best === null || r > best.r) best = { r, g } }
    held.push(best.g.comps.get(out))
  }
  const rLoo = pearson(held, theirs)
  console.log(`leave-one-out r of the search: ${rLoo.toFixed(3)}  (gain over current ${(rLoo - rCurrent >= 0 ? '+' : '')}${(rLoo - rCurrent).toFixed(3)})`)

  const chosen = rLoo - rCurrent >= MIN_GAIN ? ranked[0].weights : RECOVERY_WEIGHTS
  console.log(rLoo - rCurrent >= MIN_GAIN
    ? `suggested RECOVERY_WEIGHTS: ${fmtW(chosen)}`
    : `keep RECOVERY_WEIGHTS: the search does not beat them by ${MIN_GAIN} on days it has not seen`)

  // The scale that matches Google's spread on these days, by bisection: the logistic's spread
  // grows with the scale, monotonically on any fixed set of composites.
  const chosenComps = compositesFor(chosen)
  const comps = paired.map((d) => chosenComps.get(d))
  const target = sd(theirs)
  let lo = 0.05, hi = 10
  for (let i = 0; i < 60; i += 1) { const mid = (lo + hi) / 2; if (sd(comps.map((c) => scoreOf(c, mid))) < target) lo = mid; else hi = mid }
  const scale = (lo + hi) / 2
  const ours = comps.map((c) => scoreOf(c, scale))
  const mad = mean(ours.map((o, i) => Math.abs(o - theirs[i])))
  console.log(`suggested RECOVERY_SCALE: ${scale.toFixed(2)}  (spread ${sd(ours).toFixed(1)} against theirs ${target.toFixed(1)})`)
  console.log(`with these: r=${pearson(ours, theirs).toFixed(3)}  mean|diff|=${mad.toFixed(1)}  bias(ours-theirs)=${(mean(ours) - mean(theirs)).toFixed(1)}`)
}
db.close()
