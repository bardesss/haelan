// Issue #143, throwaway. Measures whether haelan's two families of activity-minute metrics
// count the same clock minutes, which decides whether a chart may stack them.
//
//   node probe/scripts/activity-minute-overlap.mjs [samplesDir]
//
// Reads the M0 archive in probe/samples/ rather than the live API: both types are already
// archived there over the same seven day window, and the question is about what the payloads
// say, not about what a fresh fetch would add. The optional argument exists because
// probe/samples/ is gitignored and therefore absent from a fresh worktree; point it at the
// samples directory of a checkout that has them.
//
// Prints to stdout only, and prints only counts, percentages and enum values. No health
// measurement and no row leaves this script.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SAMPLES = process.argv[2]
  ? pathToFileURL(process.argv[2].replace(/\/?$/, '/'))
  : new URL('../samples/', import.meta.url)

const load = (t) => JSON.parse(readFileSync(new URL(`./${t}.json`, SAMPLES), 'utf8')).dataPoints ?? []

const amPoints = load('active-minutes')
const azPoints = load('active-zone-minutes')
const AM = amPoints.map((p) => p.activeMinutes)
const AZ = azPoints.map((p) => p.activeZoneMinutes)

const start = (x) => x.interval.startTime
const minutes = (x) => (Date.parse(x.interval.endTime) - Date.parse(x.interval.startTime)) / 60_000
const levels = (x) => (x.activeMinutesByActivityLevel ?? []).map((e) => e.activityLevel)
// The civil date the point's own payload carries, so a day boundary means the household's
// midnight rather than UTC's. proto3 omits zero valued fields, so an absent day is the 1st.
const civilDay = (x) => {
  const d = x.interval.civilStartTime.date
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day ?? 1).padStart(2, '0')}`
}

const tally = (xs, f) => xs.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {})
const show = (label, obj) =>
  console.log(`  ${label.padEnd(34)} ${Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('  ')}`)

// ---------------------------------------------------------------- interval geometry

console.log('\n## Interval geometry\n')
console.log(`  active-minutes points            ${AM.length}`)
console.log(`  active-zone-minutes points       ${AZ.length}`)
show('AM interval lengths (min)', tally(AM, minutes))
show('AZM interval lengths (min)', tally(AZ, minutes))
console.log(`  intervals off the whole minute   ${[...AM, ...AZ].filter((x) => !start(x).endsWith(':00Z')).length}`)

const amByStart = new Map()
const azByStart = new Map()
let amDup = 0
let azDup = 0
for (const x of AM) amByStart.has(start(x)) ? amDup++ : amByStart.set(start(x), x)
for (const x of AZ) azByStart.has(start(x)) ? azDup++ : azByStart.set(start(x), x)
console.log(`  distinct AM start instants       ${amByStart.size} (${amDup} repeated)`)
console.log(`  distinct AZM start instants      ${azByStart.size} (${azDup} repeated)`)

// ---------------------------------------------------------------- the jointly covered window
//
// The AM sample is one page and field-map.md marks it as having hit the page cap: it holds the
// tail of the seven day window and nothing before its first point. Comparing the two families
// outside the range both cover would read that truncation as a real absence, so every overlap
// figure below is computed inside it.

const amStarts = [...amByStart.keys()].sort()
const lo = amStarts[0]
const hi = amStarts[amStarts.length - 1]

const azIn = [...azByStart.entries()].filter(([k]) => k >= lo && k <= hi)
console.log(`\n  jointly covered window           ${lo} .. ${hi}`)
console.log(`  AZM points inside it             ${azIn.length}`)
console.log(`  AZM points outside it (excluded) ${azByStart.size - azIn.length}`)
show('excluded AZM points by UTC day', tally([...azByStart.keys()].filter((k) => k < lo || k > hi), (k) => k.slice(0, 10)))

// ---------------------------------------------------------------- Q2: within active-minutes

console.log('\n## Q2. Are LIGHT / MODERATE / VIGOROUS mutually exclusive of each other?\n')
show('levels carried per point', tally(AM, (x) => levels(x).length))
show('which level set', tally(AM, (x) => levels(x).sort().join('+') || '(none)'))
show('sum of activeMinutes per point', tally(AM, (x) => (x.activeMinutesByActivityLevel ?? []).reduce((s, e) => s + Number(e.activeMinutes), 0)))

// ---------------------------------------------------------------- Q3a: within active-zone-minutes

console.log('\n## Q3a. What does one active-zone-minutes point count?\n')
const zoneValue = {}
for (const x of AZ) {
  const v = ((zoneValue[x.heartRateZone] ??= {}))
  v[Number(x.activeZoneMinutes)] = (v[Number(x.activeZoneMinutes)] ?? 0) + 1
}
for (const [z, vs] of Object.entries(zoneValue)) show(`${z}: activeZoneMinutes value`, vs)

// ---------------------------------------------------------------- Q1: across the two families

console.log('\n## Q1. Can one clock minute be counted in both families?\n')
const cross = {}
let both = 0
for (const [k, z] of azIn) {
  const a = amByStart.get(k)
  if (!a) continue
  both++
  const key = `${levels(a).join('+') || '(none)'} x ${z.heartRateZone}`
  cross[key] = (cross[key] ?? 0) + 1
}
console.log(`  AZM minutes in window            ${azIn.length}`)
console.log(`  of those, also an AM minute      ${both}  (${(100 * both / azIn.length).toFixed(1)}%)`)
console.log(`  AM minutes in window             ${amByStart.size}`)
console.log(`  of those, also an AZM minute     ${both}  (${(100 * both / amByStart.size).toFixed(1)}%)`)
console.log('\n  cross tabulation, one distinct clock minute per cell:')
for (const [k, v] of Object.entries(cross).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(28)} ${v}`)

// ---------------------------------------------------------------- Q3b: daily totals

console.log('\n## Q3b. Do the three members of a family sum to anything?\n')
const blank = () => ({ amMin: 0, azMin: 0, azScore: 0, peakScore: 0, both: 0, LIGHT: 0, MODERATE: 0, VIGOROUS: 0 })
const days = {}
for (const x of AM) {
  const d = (days[civilDay(x)] ??= blank())
  d.amMin++
  for (const e of x.activeMinutesByActivityLevel ?? []) d[e.activityLevel] += Number(e.activeMinutes)
}
for (const [k, z] of azIn) {
  const d = (days[civilDay(z)] ??= blank())
  d.azMin++
  d.azScore += Number(z.activeZoneMinutes)
  if (z.heartRateZone === 'PEAK') d.peakScore += Number(z.activeZoneMinutes)
  if (amByStart.has(k)) d.both++
}
console.log('  civil day       L    M    V  L+M+V  AZMmin  AZMscore  both  distinct  proposed total')
for (const day of Object.keys(days).sort()) {
  const d = days[day]
  const lmv = d.LIGHT + d.MODERATE + d.VIGOROUS
  // The union is how many distinct clock minutes the proposed stack actually describes; the
  // proposed total is what it would print above them.
  const union = d.amMin + d.azMin - d.both
  const cells = [d.LIGHT, d.MODERATE, d.VIGOROUS, lmv, d.azMin, d.azScore, d.both, union, lmv + d.peakScore]
  console.log(`  ${day} ${cells.map((c, i) => String(c).padStart([5, 5, 5, 6, 7, 9, 6, 9, 15][i])).join('')}`)
}

// ---------------------------------------------------------------- provenance

console.log('\n## Provenance\n')
const src = (ps) => tally(ps, (p) => `${p.dataSource.platform}/${p.dataSource.recordingMethod}`)
show('AM dataSource', src(amPoints))
show('AZM dataSource', src(azPoints))
// Counted, not named: field-map.md records enum-like values only, never a device name.
const devices = new Set([...amPoints, ...azPoints].map((p) => p.dataSource.device?.displayName ?? '(none)'))
console.log(`  distinct devices across both     ${devices.size}`)
console.log()
