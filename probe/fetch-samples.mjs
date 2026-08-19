import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { api } from './lib.mjs'

// One data type wears three casings in a single request: kebab in the path, snake in the
// filter, camel in the response.
const snake = (id) => id.replaceAll('-', '_')

const iso = (d) => d.toISOString()
const day = (d) => d.toISOString().slice(0, 10)
const civil = (d) => d.toISOString().slice(0, 19)

// Four filter shapes, discovered by probing because none of this is documented. The order
// matters only for speed: each type matches exactly one.
const FILTERS = [
  { name: 'interval.start_time', build: (t, a, b) => `${snake(t)}.interval.start_time >= "${iso(a)}" AND ${snake(t)}.interval.start_time < "${iso(b)}"` },
  { name: 'sample_time.physical_time', build: (t, a, b) => `${snake(t)}.sample_time.physical_time >= "${iso(a)}" AND ${snake(t)}.sample_time.physical_time < "${iso(b)}"` },
  { name: 'date', build: (t, a, b) => `${snake(t)}.date >= "${day(a)}" AND ${snake(t)}.date < "${day(b)}"` },
  // Sessions are bounded by when they end, so a night spanning a window boundary lands in the
  // window it woke up in, not the one it began in.
  { name: 'interval.end_time', build: (t, a, b) => `${snake(t)}.interval.end_time >= "${iso(a)}" AND ${snake(t)}.interval.end_time < "${iso(b)}"` },
  // Exercise and the logs filter only on civil time, which carries no zone, so a window
  // expressed in UTC quietly means something else here.
  { name: 'interval.civil_start_time', build: (t, a, b) => `${snake(t)}.interval.civil_start_time >= "${civil(a)}" AND ${snake(t)}.interval.civil_start_time < "${civil(b)}"` },
]

const TYPES = process.argv.length > 2 ? process.argv.slice(2) : [
  'steps', 'distance', 'active-minutes', 'active-zone-minutes', 'active-energy-burned',
  'total-calories', 'floors', 'exercise',
  'heart-rate', 'daily-resting-heart-rate', 'heart-rate-variability',
  'daily-heart-rate-variability', 'oxygen-saturation', 'daily-oxygen-saturation',
  'daily-respiratory-rate',
  'sleep', 'weight', 'body-fat', 'nutrition-log', 'hydration-log',
]

const end = new Date()
const DAYS = Number(process.env.DAYS ?? 7)
const start = new Date(end.getTime() - DAYS * 864e5)
// Partial runs must not erase what a wider window already found, so the summary merges by
// type and an empty result never overwrites a populated sample.
const SUMMARY = new URL('./samples/_summary.json', import.meta.url)
const prior = existsSync(SUMMARY) ? JSON.parse(readFileSync(SUMMARY, 'utf8')) : []
const results = prior.filter((r) => !TYPES.includes(r.type))

for (const type of TYPES) {
  const path = `/users/me/dataTypes/${type}/dataPoints`
  let hit = null, unsupported = null

  for (const f of FILTERS) {
    try {
      const res = await api(path, { filter: f.build(type, start, end), pageSize: 10000 })
      hit = { f, res }
      break
    } catch (e) {
      const msg = String(e.message)
      if (msg.includes('not supported for data type')) {
        unsupported = msg.match(/supported: ([a-zA-Z, ]+)/)?.[1]?.trim() ?? 'rollup only'
        break
      }
    }
  }

  if (unsupported) {
    console.log(`${type.padEnd(30)} LIST UNSUPPORTED, supports ${unsupported}`)
    results.push({ type, list: false, supports: unsupported })
    continue
  }
  if (!hit) {
    console.log(`${type.padEnd(30)} no working filter found`)
    results.push({ type, list: false, supports: 'unknown' })
    continue
  }

  const n = (hit.res.json.dataPoints ?? []).length
  const target = new URL(`./samples/${type}.json`, import.meta.url)
  const kept = n === 0 && existsSync(target) && JSON.parse(readFileSync(target, 'utf8')).dataPoints?.length
  if (kept) {
    const keptResult = prior.find((r) => r.type === type)
    if (keptResult) results.push(keptResult)
    console.log(`${type.padEnd(30)} ${String(n).padStart(5)} points in window, keeping ${kept} from a wider one`)
    continue
  }
  writeFileSync(target, hit.res.raw)
  const more = Boolean(hit.res.json.nextPageToken)
  results.push({ type, list: true, filter: hit.f.name, points: n, kb: +(hit.res.raw.length / 1024).toFixed(1), truncated: more })
  console.log(`${type.padEnd(30)} ${String(n).padStart(5)} points  ${String((hit.res.raw.length / 1024).toFixed(1)).padStart(7)} kB  ${hit.f.name}${more ? '  (page cap hit)' : ''}`)
}

results.sort((a, b) => a.type.localeCompare(b.type))
writeFileSync(SUMMARY, JSON.stringify(results, null, 2))
