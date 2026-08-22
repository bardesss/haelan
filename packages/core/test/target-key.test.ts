import { describe, expect, it } from 'vitest'
import {
  sampleTarget, sessionTarget, dayMetricTarget,
  parseSampleTarget, parseSessionTarget, parseDayMetricTarget,
} from '../src/derive/targetKey.ts'
import { ConfigError } from '../src/errors.ts'

describe('target keys', () => {
  it('writes a sample key with a fixed field order, so the unique index still catches a duplicate', () => {
    expect(sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: 1000 }))
      .toBe('{"source":"watch","metric":"heart_rate","utcMs":1000}')
  })

  it('builds the same key from the same target however the object was written', () => {
    const a = sampleTarget({ source: 'watch', metric: 'heart_rate', utcMs: 1000 })
    const b = sampleTarget({ metric: 'heart_rate', utcMs: 1000, source: 'watch' })
    expect(a).toBe(b)
  })

  it('leaves a delimiter in a source id alone, which is why this is JSON', () => {
    // rollup.ts refused joined string keys for exactly this: a source id or a metric name that
    // contains the delimiter turns one key into another silently.
    const key = sampleTarget({ source: 'a:b|c', metric: 'steps', utcMs: 1 })
    expect(parseSampleTarget(key).source).toBe('a:b|c')
  })

  it('round trips every scope', () => {
    expect(parseSampleTarget(sampleTarget({ source: 'w', metric: 'steps', utcMs: 7 })))
      .toEqual({ source: 'w', metric: 'steps', utcMs: 7 })
    expect(parseSessionTarget(sessionTarget('sess-1'))).toBe('sess-1')
    expect(parseDayMetricTarget(dayMetricTarget({ localDate: '2026-08-22', metric: 'steps' })))
      .toEqual({ localDate: '2026-08-22', metric: 'steps' })
  })

  it('refuses a key that is not the shape its scope promises', () => {
    // A malformed key means a row written by something that did not use these builders. Failing
    // loudly is the only way that reaches a person rather than deriving as if the day were clean.
    expect(() => parseSampleTarget('not json')).toThrow(ConfigError)
    expect(() => parseSampleTarget('{"source":"w","metric":"steps"}')).toThrow(ConfigError)
    expect(() => parseSampleTarget('{"source":"w","metric":"steps","utcMs":"7"}')).toThrow(ConfigError)
    expect(() => parseSessionTarget('{"nope":1}')).toThrow(ConfigError)
    expect(() => parseDayMetricTarget('{"localDate":"2026-08-22"}')).toThrow(ConfigError)
  })
})
