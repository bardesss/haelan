import { describe, expect, it } from 'vitest'
import { dataTypeForMetric } from '../src/api/metricDataType.ts'
import { DATA_TYPES } from '../src/api/catalogue.ts'
import { SLEEP_METRICS } from '../src/derive/metrics.ts'

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

  // The Important this file did not catch: sleep and exercise are session-derived families with
  // no data type of their own to inherit from on the catalogue, which used to leave every metric
  // below answering null -- and so unexcludable -- despite the picker offering 'sleep' and
  // 'exercise' as ordinary types a person can turn off.
  it('maps every sleep metric to the sleep session type', () => {
    for (const metric of SLEEP_METRICS) expect(dataTypeForMetric(metric)).toBe('sleep')
  })

  it('maps both workout metrics to the exercise session type', () => {
    expect(dataTypeForMetric('workout_count')).toBe('exercise')
    expect(dataTypeForMetric('workout_minutes')).toBe('exercise')
  })

  // cardio_load_edwards is derived from the four time-in-heart-rate-zone metrics after exclusions
  // and source priority are already applied (derive/cardioLoad.ts), not read from the catalogue,
  // so the loop that builds this map from DATA_TYPES never sees it on its own. Named by hand for
  // the same reason sleep and exercise are: without an entry, turning off time-in-heart-rate-zone
  // would make a page showing cardio load say "nothing has been recorded" instead of "you turned
  // this off".
  it('maps cardio_load_edwards to the data type it is derived from', () => {
    expect(dataTypeForMetric('cardio_load_edwards')).toBe('time-in-heart-rate-zone')
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
