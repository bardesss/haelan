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

// sourceMix is real JSON (see merge.ts's encodeMix), never plain text, and it is the one column
// among the exported seven that can actually contain a comma, a quote or a newline on real data:
// localDate is a fixed date shape, metric and agg come from a hardcoded catalogue, source is a
// hex hash, and value and coverage are numbers. Ruling R18.
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

/**
 * A minimal RFC 4180 reader, the inverse of the escaper in export.ts, used only to prove the
 * round trip. Splitting on a bare '\n' cannot tell a row break from a newline sitting inside a
 * quoted field, and checking for a doubled quote as a substring cannot tell a properly quoted
 * field from one that lost its outer quotes while the interior happened to look escaped anyway;
 * parsing the whole body back into rows of fields is what actually proves both.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; continue }
      if (c === '"') { inQuotes = false; continue }
      field += c; continue
    }
    if (c === '"') { inQuotes = true; continue }
    if (c === ',') { row.push(field); field = ''; continue }
    if (c === '\r') { continue }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += c
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

describe('GET /export', () => {
  it('answers csv with a header row naming every column', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', value: 900 })
    const response = await get(harness, token, '/export?format=csv&metric=steps&agg=sum&from=2026-08-01&to=2026-08-01')
    const [header, first] = response.body.trim().split('\n')
    expect(header).toBe('localDate,metric,agg,source,value,coverage,sourceMix')
    expect(first).toContain('2026-08-01,steps,sum,merged,900')
  })

  // sourceMix is the one free text column, and it is JSON, so it always contains a comma and a
  // quote on every merged row (Ruling R18). This is the whole reason to write a serialiser rather
  // than join with commas. The fixture below carries no newline, so the title only claims what it
  // seeds; the newline and carriage return cases get their own tests just after this one.
  it('quotes a field containing a comma and a quote, and reads back the exact original value', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const sourceMix = '[{"source":"a,b","hours":3}]'
    seedDailyWithMix(harness, { localDate: '2026-08-01', value: 900, sourceMix })
    const response = await get(harness, token, '/export?format=csv&metric=steps&agg=sum&from=2026-08-01&to=2026-08-01')
    const rows = parseCsv(response.body)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toEqual(['2026-08-01', 'steps', 'sum', 'merged', '900', '', sourceMix])
  })

  // daily.source_mix is an unconstrained text column, so nothing stops a raw newline from landing
  // in it even though a real merge only ever writes encodeMix's JSON. Split on '\n' cannot be used
  // to count rows here, since the field's own newline is indistinguishable from a row break to a
  // reader that is not itself CSV aware; parsing the body back into fields is what actually proves
  // the row stayed one row.
  it('wraps a sourceMix value containing a bare newline in quotes and keeps it one row', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const sourceMix = 'line one\nline two'
    seedDailyWithMix(harness, { localDate: '2026-08-01', value: 900, sourceMix })
    const response = await get(harness, token, '/export?format=csv&metric=steps&agg=sum&from=2026-08-01&to=2026-08-01')
    const rows = parseCsv(response.body)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toEqual(['2026-08-01', 'steps', 'sum', 'merged', '900', '', sourceMix])
  })

  // A lone carriage return is the same unconstrained column allowing the same kind of value, and
  // it is not covered by the comma-quote-newline character class: '\r' has to be quoted too, or a
  // bare one is written straight into the row and corrupts it.
  it('wraps a sourceMix value containing a bare carriage return in quotes and keeps it one row', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const sourceMix = 'line one\rline two'
    seedDailyWithMix(harness, { localDate: '2026-08-01', value: 900, sourceMix })
    const response = await get(harness, token, '/export?format=csv&metric=steps&agg=sum&from=2026-08-01&to=2026-08-01')
    const rows = parseCsv(response.body)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toEqual(['2026-08-01', 'steps', 'sum', 'merged', '900', '', sourceMix])
  })

  it('answers a null coverage and sourceMix as an empty field, not the text null', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', value: 900, coverage: null })
    const response = await get(harness, token, '/export?format=csv&metric=steps&agg=sum&from=2026-08-01&to=2026-08-01')
    const [, first] = response.body.trim().split('\n')
    expect(first).toBe('2026-08-01,steps,sum,merged,900,,')
  })

  // coverage and sourceMix both state the basis of a merged number; nothing requires every row in
  // an export to carry the same shape of basis, so a day with neither and a day with one both
  // have to sit in the same file and both still parse as ordinary rows.
  it('exports a null sourceMix and a populated one in the same file, and both rows parse', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const sourceMix = '[{"source":"watch","hours":24}]'
    seedDaily(harness, { localDate: '2026-08-01', value: 900 })
    seedDailyWithMix(harness, { localDate: '2026-08-02', value: 950, sourceMix })
    const response = await get(harness, token, '/export?format=csv&metric=steps&agg=sum&from=2026-08-01&to=2026-08-02')
    const rows = parseCsv(response.body)
    expect(rows).toHaveLength(3)
    expect(rows[1]).toEqual(['2026-08-01', 'steps', 'sum', 'merged', '900', '', ''])
    expect(rows[2]).toEqual(['2026-08-02', 'steps', 'sum', 'merged', '950', '', sourceMix])
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
