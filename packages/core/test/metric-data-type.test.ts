import { describe, expect, it } from 'vitest'
import { dataTypeForMetric } from '../src/api/metricDataType.ts'
import { DATA_TYPES } from '../src/api/catalogue.ts'

describe('dataTypeForMetric', () => {
  it('maps a plain metric to the type that produces it', () => {
    expect(dataTypeForMetric('steps')).toBe('steps')
  })

  it('maps a sub-dimensional metric to its type', () => {
    // active-minutes produces one metric per activity level; every one of them belongs to it.
    expect(dataTypeForMetric('active_minutes_moderate')).toBe('active-minutes')
  })

  it('answers null for a metric no catalogue entry produces', () => {
    expect(dataTypeForMetric('not_a_metric')).toBeNull()
  })

  // Derived from the catalogue rather than written out, so a type added tomorrow is covered.
  it('covers every metric every catalogue entry declares', () => {
    for (const type of DATA_TYPES) {
      if (type.metric !== '') expect(dataTypeForMetric(type.metric)).toBe(type.id)
      for (const metric of Object.values(type.subDimension?.metricByKey ?? {})) {
        expect(dataTypeForMetric(metric)).toBe(type.id)
      }
    }
  })
})
