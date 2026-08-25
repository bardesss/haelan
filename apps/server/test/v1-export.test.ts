import { describe, it, expect, afterEach } from 'vitest'
import { DERIVATION_VERSION, schema } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

// The seed every test in this file builds on. Defaults match what a merged steps row looks like
// day to day; a test overrides only the field it cares about.
function seedDaily(h: Harness, input: {
  localDate: string
  value: number
  metric?: string
  agg?: string
  source?: string
  coverage?: number | null
  personId?: string
}): void {
  h.app.haelan.instance.db.insert(schema.daily).values({
    personId: input.personId ?? 'p1',
    localDate: input.localDate,
    metric: input.metric ?? 'steps',
    agg: input.agg ?? 'sum',
    source: input.source ?? 'merged',
    value: input.value,
    coverage: input.coverage === undefined ? null : input.coverage,
    sourceMix: null,
    derivationVersion: DERIVATION_VERSION,
  }).run()
}

// Only the JSON round trip test needs a sourceMix, to prove export's JSON body carries it through
// exactly as /series does. sourceMix is real JSON (see merge.ts's encodeMix), never plain text.
function seedDailyWithMix(h: Harness, input: {
  localDate: string
  value: number
  sourceMix: string
  metric?: string
  agg?: string
  source?: string
  coverage?: number | null
  personId?: string
}): void {
  h.app.haelan.instance.db.insert(schema.daily).values({
    personId: input.personId ?? 'p1',
    localDate: input.localDate,
    metric: input.metric ?? 'steps',
    agg: input.agg ?? 'sum',
    source: input.source ?? 'merged',
    value: input.value,
    coverage: input.coverage === undefined ? null : input.coverage,
    sourceMix: input.sourceMix,
    derivationVersion: DERIVATION_VERSION,
  }).run()
}

async function get(h: Harness, token: string, path: string) {
  return h.app.inject({
    method: 'GET',
    url: `/api/v1/p/p1${path}`,
    headers: { authorization: `Bearer ${token}` },
  })
}

describe('GET /export', () => {
  it('answers csv with a header row naming every column', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', value: 900 })
    const response = await get(harness, token, '/export?format=csv&metric=steps&agg=sum&from=2026-08-01&to=2026-08-01')
    const [header, first] = response.body.trim().split('\n')
    expect(header).toBe('localDate,metric,agg,source,value,coverage')
    expect(first).toContain('2026-08-01,steps,sum,merged,900')
  })

  // The pinned header above names every column the CSV has: six, not seven, so sourceMix (a JSON
  // blob) never lands in it. `source` is the one free text column among the six a device can set
  // to almost anything, so it is what carries a comma and a quote for this round trip. This is
  // the whole reason to write a serialiser rather than join with commas.
  it('quotes a field containing a comma or a quote, doubling the quote, and keeps the row on one line', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const weirdSource = 'a,"b"'
    seedDaily(harness, { localDate: '2026-08-01', value: 900, source: weirdSource })
    const response = await get(
      harness, token,
      `/export?format=csv&metric=steps&agg=sum&from=2026-08-01&to=2026-08-01&source=${encodeURIComponent(weirdSource)}`,
    )
    expect(response.body.trim().split('\n')).toHaveLength(2)
    expect(response.body).toContain('"a,""b"""')
  })

  // A bare newline alone (no comma, no quote) still has to trigger quoting, per RFC 4180. Split
  // on '\n' cannot be used to count rows here, since the field's own newline is indistinguishable
  // from a row break to a reader that is not itself CSV aware; checking the quoted field verbatim
  // is what actually proves the escaper, not a naive line count.
  it('wraps a field containing a bare newline in quotes', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const weirdSource = 'a\nb'
    seedDaily(harness, { localDate: '2026-08-01', value: 900, source: weirdSource })
    const response = await get(
      harness, token,
      `/export?format=csv&metric=steps&agg=sum&from=2026-08-01&to=2026-08-01&source=${encodeURIComponent(weirdSource)}`,
    )
    expect(response.body).toContain('"a\nb"')
  })

  it('answers a null coverage and a null value as an empty field, not the text null', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', value: 900, coverage: null })
    const response = await get(harness, token, '/export?format=csv&metric=steps&agg=sum&from=2026-08-01&to=2026-08-01')
    const [, first] = response.body.trim().split('\n')
    expect(first).toBe('2026-08-01,steps,sum,merged,900,')
  })

  it('answers json as the same shape the read route returns, sourceMix included', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDailyWithMix(harness, { localDate: '2026-08-01', value: 900, sourceMix: '[{"source":"watch","hours":3}]' })
    const query = 'metric=steps&agg=sum&from=2026-08-01&to=2026-08-01'
    const exported = await get(harness, token, `/export?format=json&${query}`)
    const read = await get(harness, token, `/series?${query}`)
    expect(exported.json()).toEqual(read.json())
  })

  it('answers 400 for a format that is neither csv nor json', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const response = await get(harness, token, '/export?format=xlsx&metric=steps&agg=sum&from=2026-08-01&to=2026-08-01')
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
  })

  // The reader downloads this to keep. A file named export with no extension helps nobody.
  it('sets a content type and a filename that name the metric and the range', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', value: 900 })
    const response = await get(harness, token, '/export?format=csv&metric=steps&agg=sum&from=2026-08-01&to=2026-08-03')
    expect(response.headers['content-type']).toContain('text/csv')
    expect(response.headers['content-disposition']).toContain('haelan-steps-2026-08-01-2026-08-03.csv')
  })

  // R17: several metrics join in request order with a hyphen in the filename, and the CSV carries
  // all of them in one file, distinguished by the metric column.
  it('joins several metrics with a hyphen in the filename and carries them all in one file', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', metric: 'steps', value: 900 })
    seedDaily(harness, { localDate: '2026-08-01', metric: 'floors', value: 12 })
    const response = await get(
      harness, token,
      '/export?format=csv&metric=steps&metric=floors&agg=sum&from=2026-08-01&to=2026-08-01',
    )
    expect(response.headers['content-disposition']).toContain('haelan-steps-floors-2026-08-01-2026-08-01.csv')
    const rows = response.body.trim().split('\n').slice(1)
    expect(rows.some((row) => row.startsWith('2026-08-01,steps,'))).toBe(true)
    expect(rows.some((row) => row.startsWith('2026-08-01,floors,'))).toBe(true)
  })

  // R15: export never thins. `points` is accepted, for parity with the read this covers, but
  // silently thinning what a reader downloads to keep would be worse than refusing the parameter,
  // so it is honoured by being ignored rather than rejected.
  it('ignores points and always answers the whole range with reduction null', async () => {
    harness = await withServer(); const token = await harness.signIn()
    for (let day = 1; day <= 28; day += 1) {
      seedDaily(harness, { localDate: `2026-08-${String(day).padStart(2, '0')}`, value: day * 100 })
    }
    const response = await get(
      harness, token,
      '/export?format=json&metric=steps&agg=sum&from=2026-08-01&to=2026-08-28&points=5',
    )
    expect(response.json().steps.points).toHaveLength(28)
    expect(response.json().steps.reduction).toBeNull()
  })

  it('answers 400 with the real reason for a metric that does not exist, the same as the read', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const response = await get(harness, token, '/export?format=csv&metric=hart_rate&agg=mean&from=2026-08-01&to=2026-08-02')
    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toContain('hart_rate')
  })
})
