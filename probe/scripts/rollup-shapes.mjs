// M2p, throwaway. Measures the rollUp and dailyRollUp request and response shapes so M2b can
// fetch total-calories and floors, the two types that reject list. Comparison types are here to
// answer whether the rollup path generalises or is a two type special case.
//
//   node probe/scripts/rollup-shapes.mjs
//
// Writes raw responses to probe/samples/rollup/ and a summary to stdout.

import { writeFileSync, mkdirSync } from 'node:fs'
import { accessToken } from './creds.mjs'

const API_ROOT = 'https://health.googleapis.com/v4'
const OUT = new URL('../samples/rollup/', import.meta.url)
mkdirSync(OUT, { recursive: true })

const iso = (ms) => new Date(ms).toISOString()
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10)
const civilDate = (ms) => {
  const [y, m, d] = ymd(ms).split('-').map(Number)
  return { date: { year: y, month: m, day: d } }
}

async function post(dataType, method, body) {
  const url = `${API_ROOT}/users/me/dataTypes/${dataType}/dataPoints:${method}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, text, url, request: body }
}

const results = []

async function probe(label, dataType, method, body) {
  const r = await post(dataType, method, body)
  writeFileSync(new URL(`./${label}.json`, OUT), JSON.stringify(
    { url: r.url, request: r.request, status: r.status, response: safeParse(r.text) }, null, 2))
  const points = safeParse(r.text)?.rollupDataPoints
  const note = r.status === 200
    ? `${points?.length ?? 0} windows${safeParse(r.text)?.nextPageToken ? ', paginated' : ''}`
    : firstLine(r.text)
  results.push({ label, status: r.status, note })
  console.log(`${label.padEnd(38)} ${String(r.status).padEnd(4)} ${note}`)
  return r
}

const safeParse = (t) => { try { return JSON.parse(t) } catch { return null } }
const firstLine = (t) => (safeParse(t)?.error?.message ?? t).slice(0, 180).replace(/\s+/g, ' ')

const now = Date.now()
const midnightUtc = Math.floor(now / 864e5) * 864e5
const weekAgo = midnightUtc - 7 * 864e5

// 1. The two targets, both methods. This is the measurement M2b is blocked on.
for (const type of ['total-calories', 'floors']) {
  await probe(`${type}.rollUp.7d`, type, 'rollUp', {
    range: { startTime: iso(weekAgo), endTime: iso(midnightUtc) },
    windowSize: '86400s',
  })
  await probe(`${type}.dailyRollUp.7d`, type, 'dailyRollUp', {
    range: { start: civilDate(weekAgo), end: civilDate(midnightUtc) },
  })
}

// 2. Does the rollup path generalise to types we already fetch through list, or is it a two
// type special case? Decides whether M2b builds one path or a branch.
for (const type of ['steps', 'heart-rate', 'daily-resting-heart-rate', 'sleep']) {
  await probe(`${type}.dailyRollUp.7d`, type, 'dailyRollUp', {
    range: { start: civilDate(weekAgo), end: civilDate(midnightUtc) },
  })
}

// 3. Rollups are documented as reconciled across all data sources, which is a server side merge
// policy competing with spec section 9. dataSourceFamily is the only lever, and it is three
// families rather than per source. Measure whether the numbers actually differ.
for (const family of ['all-sources', 'google-wearables', 'google-sources']) {
  await probe(`total-calories.dailyRollUp.${family}`, 'total-calories', 'dailyRollUp', {
    range: { start: civilDate(weekAgo), end: civilDate(midnightUtc) },
    dataSourceFamily: `users/me/dataSourceFamilies/${family}`,
  })
}

// 4. The documented 14 day cap for total-calories, and 90 days for the rest. A cap the client
// does not know about becomes a sync that fails at the horizon.
await probe('total-calories.dailyRollUp.20d', 'total-calories', 'dailyRollUp', {
  range: { start: civilDate(midnightUtc - 20 * 864e5), end: civilDate(midnightUtc) },
})
await probe('floors.dailyRollUp.100d', 'floors', 'dailyRollUp', {
  range: { start: civilDate(midnightUtc - 100 * 864e5), end: civilDate(midnightUtc) },
})

// 5. Retention. retention.md measured no cliff for heart rate within the account's 209 days,
// and that bound was heart rate only. These two have never been fetched at all.
await probe('floors.dailyRollUp.180d-ago', 'floors', 'dailyRollUp', {
  range: { start: civilDate(midnightUtc - 187 * 864e5), end: civilDate(midnightUtc - 180 * 864e5) },
})
await probe('total-calories.dailyRollUp.180d-ago', 'total-calories', 'dailyRollUp', {
  range: { start: civilDate(midnightUtc - 187 * 864e5), end: civilDate(midnightUtc - 180 * 864e5) },
})

// 6. Sub-day windows, which decide whether these two can ever back an intraday chart.
await probe('total-calories.rollUp.1h', 'total-calories', 'rollUp', {
  range: { startTime: iso(midnightUtc - 864e5), endTime: iso(midnightUtc) },
  windowSize: '3600s',
})

// 7. The cap error blames `window_size_days * page_size`, not the range, so a smaller page may
// buy a longer range. Decides whether M2b's backfill walks 14 day steps or pages one request.
await probe('total-calories.dailyRollUp.20d.page14', 'total-calories', 'dailyRollUp', {
  range: { start: civilDate(midnightUtc - 20 * 864e5), end: civilDate(midnightUtc) },
  pageSize: 14,
})

// 8. DailyRollUpDataPointsResponse declares no nextPageToken in the discovery document while its
// request accepts a pageToken. If daily rollups cannot paginate, the range is the only lever.
await probe('total-calories.dailyRollUp.14d.page5', 'total-calories', 'dailyRollUp', {
  range: { start: civilDate(midnightUtc - 14 * 864e5), end: civilDate(midnightUtc) },
  pageSize: 5,
})

// 9. The physical rollUp does declare nextPageToken. Same question, other method.
await probe('floors.rollUp.90d.page5', 'floors', 'rollUp', {
  range: { startTime: iso(midnightUtc - 90 * 864e5), endTime: iso(midnightUtc) },
  windowSize: '86400s',
  pageSize: 5,
})

writeFileSync(new URL('./_summary.json', OUT), JSON.stringify(results, null, 2))
console.log(`\n${results.filter((r) => r.status === 200).length}/${results.length} ok`)
