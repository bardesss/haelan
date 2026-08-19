import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { api } from './lib.mjs'

const dir = new URL('./samples/', import.meta.url)
const summary = JSON.parse(readFileSync(new URL('_summary.json', dir), 'utf8'))
const snake = (id) => id.replaceAll('-', '_')

// The payload lives under the one camel key that is not envelope metadata.
const payloadOf = (p) => {
  const k = Object.keys(p).find((k) => k !== 'dataSource' && k !== 'name')
  return k ? p[k] : null
}

const timeOf = (p) => {
  const v = payloadOf(p)
  if (!v) return null
  const t = v.interval?.startTime ?? v.sampleTime?.physicalTime ?? v.interval?.endTime
  if (t) return Date.parse(t)
  if (v.date) return Date.UTC(v.date.year, (v.date.month ?? 1) - 1, v.date.day ?? 1)
  return null
}

const median = (xs) => xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null

const rows = []
for (const file of readdirSync(dir).filter((f) => !f.startsWith('_')).sort()) {
  const type = file.replace(/\.json$/, '')
  const points = JSON.parse(readFileSync(new URL(file, dir), 'utf8')).dataPoints ?? []
  const meta = summary.find((r) => r.type === type) ?? {}
  if (points.length < 2) { rows.push({ type, points: points.length, note: 'too few to measure' }); continue }

  const times = points.map(timeOf).filter(Number.isFinite).sort((a, b) => a - b)
  const gaps = times.slice(1).map((t, i) => t - times[i]).filter((g) => g > 0)
  const med = median(gaps)
  rows.push({
    type,
    points: points.length,
    medianSeconds: med === null ? null : med / 1000,
    truncated: Boolean(meta.truncated),
    kb: meta.kb,
  })
}

// A truncated page cannot answer rows per day, so the dense types get one fully paginated
// day instead of an estimate scaled from a partial window.
const DENSE = rows.filter((r) => r.truncated).map((r) => r.type)
const end = new Date(Date.UTC(2026, 7, 18, 0, 0, 0))
const start = new Date(end.getTime() - 864e5)
const exact = {}

for (const type of DENSE) {
  const meta = summary.find((r) => r.type === type)
  const member = `${snake(type)}.${meta.filter}`
  const filter = `${member} >= "${start.toISOString()}" AND ${member} < "${end.toISOString()}"`
  let token, total = 0, pages = 0, bytes = 0
  do {
    const res = await api(`/users/me/dataTypes/${type}/dataPoints`,
      token ? { filter, pageSize: 10000, pageToken: token } : { filter, pageSize: 10000 })
    total += (res.json.dataPoints ?? []).length
    bytes += res.raw.length
    token = res.json.nextPageToken
    pages++
  } while (token && pages < 40)
  exact[type] = { rowsPerDay: total, pages, kbPerDay: +(bytes / 1024).toFixed(1), capped: Boolean(token) }
  console.log(`${type.padEnd(24)} ${String(total).padStart(6)} rows in 24h over ${pages} pages, ${(bytes / 1024).toFixed(1)} kB`)
}

writeFileSync(new URL('./samples/_volume.json', import.meta.url), JSON.stringify({ rows, exact }, null, 2))
console.log('\nwrote probe/samples/_volume.json')
