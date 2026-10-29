// Body age gate, throwaway. Measures, on the real archive, how far each body age factor reaches in
// uncapped years, how often the provisional caps would bind, and whether the body age actually moves
// from month to month - and whether the VO2 max reading alone is doing the moving.
//
//   node --experimental-strip-types probe/scripts/body-age.mjs [dataDir]
//
// dataDir defaults to $HAELAN_DATA_DIR, then ./.local-archive. It must be a directory holding
// haelan.sqlite, not the file itself.
//
// Opens through `openReadOnly`, never `openHaelan`: that connection migrates nothing, writes
// nothing and creates no encryption key, so it is safe to point at a running instance's data
// directory.
//
// PRIVACY. This prints no reading, no date, no birth date and no person id. People appear as
// "person 1", "person 2" in an arbitrary order that carries no meaning. What it prints is counts,
// shares of days and percentiles of years of body age, which are the figures under test. Its
// output stays in the session and out of git: these are figures about one household and the
// repository is public. Anything added here has to be safe to paste into a terminal somebody is
// sharing.
//
// What it reads. `readBodyAgeInput`, exactly as production reads a person, then `bodyAgeAt` on
// every scored day (a day with a resting heart rate or HRV row, from the archive's start to the last
// such day on or before today). Uncapped years of a factor are logHazard / GOMPERTZ_SLOPE at the
// factor row's own value and reference. The monthly series is `bodyAgeHistory`'s months; a change
// is counted between two adjacent calendar months only.

import { openReadOnly } from '../../packages/core/src/db/openReadOnly.ts'
import { readBodyAgeInput } from '../../packages/core/src/query/bodyAgeRead.ts'
import {
  BODY_AGE_FACTORS, BODY_AGE_TOTAL_CAP, GOMPERTZ_SLOPE, bodyAgeAt, bodyAgeHistory, lastScoredDay,
} from '../../packages/core/src/api/bodyAge.ts'
import { shiftLocalDate } from '../../packages/core/src/derive/localDay.ts'

const DIR = process.argv[2] ?? process.env.HAELAN_DATA_DIR ?? './.local-archive'
const TODAY = process.env.BODY_AGE_TODAY ?? '2026-10-28'

const db = openReadOnly(DIR)
const pct = (n, d) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`)
const f2 = (x) => (x === null || x === undefined ? 'n/a' : x.toFixed(2))
const median = (xs) => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const percentile = (xs, p) => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const i = (s.length - 1) * p
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return s[lo] + (s[hi] - s[lo]) * (i - lo)
}
const dist = (xs) => `p5 ${f2(percentile(xs, 0.05))}, p50 ${f2(percentile(xs, 0.5))}, p95 ${f2(percentile(xs, 0.95))}`
const nextMonth = (m) => {
  const y = Number(m.slice(0, 4))
  const mo = Number(m.slice(5, 7))
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`
}

console.log(`\n# Body age gate, ${DIR}\n`)
console.log(`slope ${GOMPERTZ_SLOPE}, total cap ${BODY_AGE_TOTAL_CAP}`
  + `, factor caps ${BODY_AGE_FACTORS.map((f) => `${f.key} ${f.cap}`).join(', ')}`)
console.log('sleepRegularity: mean of the sample SDs of bedtime over the window\'s 7-day blocks')

const ids = db.$client.prepare('SELECT id FROM people ORDER BY id').all().map((r) => r.id)
console.log(`people: ${ids.length}`)

const skipped = { birthDate: 0, sex: 0, vo2Max: 0, noScoredDay: 0 }
const gate = []

ids.forEach((personId, index) => {
  console.log(`\n${'='.repeat(70)}\n## person ${index + 1}\n`)
  const { input, from } = readBodyAgeInput(db, personId, { today: TODAY })
  const end = lastScoredDay(input, TODAY)
  if (end === null) { skipped.noScoredDay += 1; console.log('  skipped: no scored day\n'); return }

  // Why a person is skipped, as the unavailable branch of bodyAgeAt names it.
  const probe = bodyAgeAt(input, end)
  if (!probe.enough) {
    for (const m of probe.missing) skipped[m] += 1
    console.log(`  skipped: missing ${probe.missing.join(', ')} on the last scored day\n`)
  }

  const scoredDates = new Set()
  for (const rows of [input.restingHeartRate, input.hrv]) {
    for (const r of rows) if (r.localDate >= from && r.localDate <= end) scoredDates.add(r.localDate)
  }
  const days = [...scoredDates].sort()
  const uncapped = Object.fromEntries(BODY_AGE_FACTORS.map((s) => [s.key, []]))
  const sums = []
  let available = 0
  for (const day of days) {
    const body = bodyAgeAt(input, day)
    if (!body.enough) continue
    available += 1
    let sum = 0
    for (const factor of body.factors) {
      if (factor.value === null) continue
      const spec = BODY_AGE_FACTORS.find((s) => s.key === factor.key)
      const years = spec.logHazard(factor.value, factor.reference) / GOMPERTZ_SLOPE
      uncapped[factor.key].push(years)
      sum += years
    }
    sums.push(sum)
  }

  const history = bodyAgeHistory(input, TODAY)
  console.log(`  scored days ${days.length}, with a body age ${available}, available months ${history.months.length}`)
  if (available === 0) { console.log('  no available body age\n'); return }

  console.log('\n  uncapped years per factor (days with the factor present):')
  for (const spec of BODY_AGE_FACTORS) {
    const xs = uncapped[spec.key]
    const atCap = xs.filter((x) => Math.abs(x) > spec.cap).length
    const atCapAbove = xs.filter((x) => x > spec.cap).length
    console.log(`    ${spec.key.padEnd(17)} n ${String(xs.length).padStart(5)} (${pct(xs.length, available)} of days)`
      + `: ${dist(xs)}; |p95| ${f2(percentile(xs.map(Math.abs), 0.95))}`
      + `; beyond the provisional cap ${spec.cap}: ${pct(atCap, xs.length)} (older side ${pct(atCapAbove, xs.length)})`)
  }
  const atTotal = sums.filter((x) => Math.abs(x) > BODY_AGE_TOTAL_CAP).length
  console.log(`\n  uncapped sum of modifiers: ${dist(sums)}; |p95| ${f2(percentile(sums.map(Math.abs), 0.95))}`
    + `; beyond the provisional total cap ${BODY_AGE_TOTAL_CAP}: ${pct(atTotal, sums.length)}`)

  // Month to month, between adjacent calendar months only. Per factor, the capped years as shown.
  const bodyAt = new Map()
  for (const m of history.months) bodyAt.set(m.month, bodyAgeAt(input, m.endDate))
  const changes = []
  const perFactor = Object.fromEntries(BODY_AGE_FACTORS.map((s) => [s.key, 0]))
  for (const m of history.months) {
    const a = bodyAt.get(m.month)
    const b = bodyAt.get(nextMonth(m.month))
    if (!a?.enough || !b?.enough) continue
    changes.push(Math.abs(b.bodyAge - a.bodyAge))
    for (const fb of b.factors) {
      const fa = a.factors.find((f) => f.key === fb.key)
      perFactor[fb.key] += Math.abs(fb.years - fa.years)
    }
  }
  console.log(`\n  month-to-month: ${changes.length} adjacent-month changes`)
  if (changes.length === 0) { console.log('  none, gate figures unavailable\n'); return }
  const med = median(changes)
  const totalBody = changes.reduce((t, x) => t + x, 0)
  const totalFactors = Object.values(perFactor).reduce((t, x) => t + x, 0)
  console.log(`  median absolute change in body age: ${f2(med)} years`
    + `; p25 ${f2(percentile(changes, 0.25))}, p75 ${f2(percentile(changes, 0.75))}, p95 ${f2(percentile(changes, 0.95))}`)
  console.log('  share of summed absolute factor movement, by factor:')
  for (const spec of BODY_AGE_FACTORS) {
    console.log(`    ${spec.key.padEnd(17)} ${pct(perFactor[spec.key], totalFactors)}`)
  }
  console.log(`  vo2Max |change| as a share of summed |change in body age|: ${pct(perFactor.vo2Max, totalBody)}`
    + ' (factors can offset one another, so this can exceed the share above)')
  gate.push({
    person: index + 1,
    median: med,
    vo2Share: totalFactors === 0 ? null : perFactor.vo2Max / totalFactors,
    vo2ShareOfBody: totalBody === 0 ? null : perFactor.vo2Max / totalBody,
  })
  console.log('')
})

console.log(`\n${'='.repeat(70)}`)
console.log(`skipped: no scored day ${skipped.noScoredDay}, no birth date ${skipped.birthDate}`
  + `, no sex ${skipped.sex}, no VO2 max ${skipped.vo2Max}`)
console.log('\nGATE (fails if median < 0.3 years or VO2 share > 0.5):')
for (const g of gate) {
  const fail = g.median < 0.3 || (g.vo2Share ?? 0) > 0.5
  console.log(`  person ${g.person}: median ${f2(g.median)} years, vo2Max share of factor movement ${pct(g.vo2Share ?? 0, 1)}`
    + ` (of body-age movement ${pct(g.vo2ShareOfBody ?? 0, 1)}) -> ${fail ? 'FAIL' : 'PASS'}`)
}
console.log(gate.length === 0 ? '  no person had a body age' : '')
console.log('Reminder: these figures are about one household. Keep them out of git.')
