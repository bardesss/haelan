import { describe, it, expect, afterEach } from 'vitest'
import { DERIVATION_VERSION, schema } from '@haelan/core'
import { withServer } from './harness.ts'
import type { Harness } from './harness.ts'

let harness: Harness | null = null
afterEach(async () => { await harness?.cleanup(); harness = null })

// Same defaults as v1-series.test.ts's seedDaily, with updatedAtMs added: the field this route
// exists to read, and the one field the other file's tests never needed.
function seedDaily(h: Harness, input: {
  localDate: string
  value: number
  metric?: string
  agg?: string
  source?: string
  coverage?: number | null
  updatedAtMs: number | null
}): void {
  h.app.haelan.instance.db.insert(schema.daily).values({
    personId: 'p1',
    localDate: input.localDate,
    metric: input.metric ?? 'steps',
    agg: input.agg ?? 'sum',
    source: input.source ?? 'merged',
    value: input.value,
    coverage: input.coverage === undefined ? null : input.coverage,
    sourceMix: null,
    derivationVersion: DERIVATION_VERSION,
    updatedAtMs: input.updatedAtMs,
  }).run()
}

async function get(h: Harness, token: string, path: string) {
  return h.app.inject({
    method: 'GET',
    url: `/api/v1/p/p1${path}`,
    headers: { authorization: `Bearer ${token}` },
  })
}

describe('GET /changes', () => {
  it('reports a day whose rows were re-derived after the given moment', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', value: 900, updatedAtMs: 1_000 })
    seedDaily(harness, { localDate: '2026-08-02', value: 950, updatedAtMs: 5_000 })

    const body = (await get(harness, token, '/changes?since=2000')).json()
    expect(body.items).toEqual([{ localDate: '2026-08-02', metric: 'steps' }])
  })

  it('reports nothing for a moment after the newest change', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', value: 900, updatedAtMs: 1_000 })
    expect((await get(harness, token, '/changes?since=9999')).json().items).toEqual([])
  })

  it('answers 400 for a since that is not a number', async () => {
    harness = await withServer(); const token = await harness.signIn()
    const response = await get(harness, token, '/changes?since=yesterday')
    expect(response.statusCode).toBe(400)
    expect(response.json().error.kind).toBe('config')
  })

  // A rebuild stamps a person's whole history with one clock reading, so the first poll after any
  // version bump legitimately returns everything. That is correct, and worth pinning so nobody
  // later mistakes it for a bug and "fixes" it into silence.
  it('reports every day after a rebuild restamped them all', async () => {
    harness = await withServer(); const token = await harness.signIn()
    // What a rebuild leaves behind: one clock reading across a whole history.
    for (let day = 1; day <= 3; day += 1) {
      seedDaily(harness, { localDate: `2026-08-0${day}`, value: day * 100, updatedAtMs: 7_000 })
    }
    expect((await get(harness, token, '/changes?since=6999')).json().items).toHaveLength(3)
  })

  // Provider rows come from a rollup the API reconciled, and this branch stamps them too, so a
  // corrected figure with no samples underneath it still shows up as a change.
  it('reports a provider row that moved', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, {
      localDate: '2026-08-01', metric: 'total_calories', source: 'provider',
      value: 2500, coverage: null, updatedAtMs: 5_000,
    })
    const body = (await get(harness, token, '/changes?since=2000')).json()
    expect(body.items).toEqual([{ localDate: '2026-08-01', metric: 'total_calories' }])
  })

  it('caps a page at limit and hands back a cursor that walks to the rest', async () => {
    harness = await withServer(); const token = await harness.signIn()
    seedDaily(harness, { localDate: '2026-08-01', value: 1, updatedAtMs: 1_000 })
    seedDaily(harness, { localDate: '2026-08-02', value: 1, updatedAtMs: 2_000 })
    seedDaily(harness, { localDate: '2026-08-03', value: 1, updatedAtMs: 3_000 })

    const first = (await get(harness, token, '/changes?since=0&limit=2')).json()
    expect(first.items).toEqual([
      { localDate: '2026-08-01', metric: 'steps' },
      { localDate: '2026-08-02', metric: 'steps' },
    ])
    expect(first.cursor).not.toBeNull()

    const second = (await get(harness, token, `/changes?since=0&limit=2&cursor=${first.cursor}`)).json()
    expect(second.items).toEqual([{ localDate: '2026-08-03', metric: 'steps' }])
    expect(second.cursor).toBeNull()
  })
})
