import { describe, it, expect } from 'vitest'
import { dayMetricTarget } from '@haelan/core/target-key'
import { applyOverlay, createOverlay, writeThrough } from '../src/demo/overlay.js'

const PERSON = 'demo'
const notesUrl = `/api/v1/p/${PERSON}/notes?from=2026-09-01&to=2026-09-07`
const seriesUrl = `/api/v1/p/${PERSON}/series?agg=sum&from=2026-09-01&metric=steps&to=2026-09-07`

const CAPTURED_SERIES = {
  series: {
    steps: {
      points: [
        { date: '2026-09-01', value: 8123 },
        { date: '2026-09-02', value: 9111 },
      ],
    },
  },
}

describe('notes', () => {
  it('reads back the note that was just written, on the day it was written', () => {
    const overlay = createOverlay()
    const written = writeThrough('PUT', `/api/v1/p/${PERSON}/notes/2026-09-02`, { body: 'felt awful' }, overlay)
    expect(written).toHaveProperty('id')

    const composed = applyOverlay(notesUrl, { items: [] }, overlay) as { items: { localDate: string, body: string }[] }
    expect(composed.items).toHaveLength(1)
    expect(composed.items[0]).toMatchObject({ localDate: '2026-09-02', body: 'felt awful' })
  })

  it("leaves a note outside the range out of the range's answer", () => {
    const overlay = createOverlay()
    writeThrough('PUT', `/api/v1/p/${PERSON}/notes/2026-08-01`, { body: 'earlier' }, overlay)
    const composed = applyOverlay(notesUrl, { items: [] }, overlay) as { items: unknown[] }
    expect(composed.items).toHaveLength(0)
  })
})

describe('a day-metric exclusion', () => {
  it('answers the write the way the route does, so the chart is invalidated', () => {
    const overlay = createOverlay()
    const result = writeThrough('POST', `/api/v1/p/${PERSON}/overrides`, {
      scope: 'day_metric',
      targetKey: dayMetricTarget({ localDate: '2026-09-02', metric: 'steps' }),
      action: 'exclude',
      reason: 'watch on charger',
    }, overlay) as { id: string, applied: boolean, affected: { from: string, to: string } | null }

    expect(result.applied).toBe(true)
    // Not decoration: invalidateAffected returns early on a null affected or applied false, and
    // the chart then never refetches.
    expect(result.affected).toEqual({ from: '2026-09-02', to: '2026-09-02' })
  })

  it('removes the point from the series rather than marking it', () => {
    // deriveDay deletes the excluded metric's daily rows, so in a real instance the point is gone.
    const overlay = createOverlay()
    writeThrough('POST', `/api/v1/p/${PERSON}/overrides`, {
      scope: 'day_metric',
      targetKey: dayMetricTarget({ localDate: '2026-09-02', metric: 'steps' }),
      action: 'exclude',
      reason: 'watch on charger',
    }, overlay)

    const composed = applyOverlay(seriesUrl, CAPTURED_SERIES, overlay) as typeof CAPTURED_SERIES
    expect(composed.series.steps.points.map((p) => p.date)).toEqual(['2026-09-01'])
  })

  it("leaves a different metric's points alone", () => {
    const overlay = createOverlay()
    writeThrough('POST', `/api/v1/p/${PERSON}/overrides`, {
      scope: 'day_metric',
      targetKey: dayMetricTarget({ localDate: '2026-09-02', metric: 'calories' }),
      action: 'exclude',
      reason: 'x',
    }, overlay)
    const composed = applyOverlay(seriesUrl, CAPTURED_SERIES, overlay) as typeof CAPTURED_SERIES
    expect(composed.series.steps.points).toHaveLength(2)
  })

  it('puts the point back when the override is removed', () => {
    const overlay = createOverlay()
    const written = writeThrough('POST', `/api/v1/p/${PERSON}/overrides`, {
      scope: 'day_metric',
      targetKey: dayMetricTarget({ localDate: '2026-09-02', metric: 'steps' }),
      action: 'exclude',
      reason: 'x',
    }, overlay) as { id: string }
    writeThrough('DELETE', `/api/v1/p/${PERSON}/overrides/${written.id}`, undefined, overlay)

    const composed = applyOverlay(seriesUrl, CAPTURED_SERIES, overlay) as typeof CAPTURED_SERIES
    expect(composed.series.steps.points).toHaveLength(2)
  })

  it('lists the override it wrote', () => {
    const overlay = createOverlay()
    writeThrough('POST', `/api/v1/p/${PERSON}/overrides`, {
      scope: 'day_metric',
      targetKey: dayMetricTarget({ localDate: '2026-09-02', metric: 'steps' }),
      action: 'exclude',
      reason: 'watch on charger',
    }, overlay)
    const composed = applyOverlay(`/api/v1/p/${PERSON}/overrides`, { items: [] }, overlay) as { items: unknown[] }
    expect(composed.items).toHaveLength(1)
  })
})

describe('a source alias', () => {
  it('renames the source in the captured list, and clearing restores the captured name', () => {
    const overlay = createOverlay()
    const captured = { items: [{ sourceId: 'ab12', alias: null, displayName: 'ab12' }] }

    writeThrough('PUT', `/api/v1/p/${PERSON}/sources/ab12/alias`, { alias: 'My watch' }, overlay)
    let composed = applyOverlay(`/api/v1/p/${PERSON}/sources`, captured, overlay) as { items: { alias: string | null }[] }
    expect(composed.items[0]?.alias).toBe('My watch')

    writeThrough('DELETE', `/api/v1/p/${PERSON}/sources/ab12/alias`, undefined, overlay)
    composed = applyOverlay(`/api/v1/p/${PERSON}/sources`, captured, overlay) as { items: { alias: string | null }[] }
    expect(composed.items[0]?.alias).toBeNull()
  })
})

describe('an unrelated read', () => {
  it('passes through untouched when the overlay is empty', () => {
    const overlay = createOverlay()
    const captured = { items: [1, 2, 3] }
    expect(applyOverlay(`/api/v1/p/${PERSON}/data-types`, captured, overlay)).toBe(captured)
  })
})
