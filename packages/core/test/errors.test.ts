import { describe, expect, it } from 'vitest'
import { HaelanError, AuthError, TransientError, SchemaDriftError, ConfigError, classifyHttp } from '../src/errors.ts'
import { RevokedError } from '../src/api/tokens.ts'

describe('the error taxonomy', () => {
  it('carries a kind a caller can branch on without reading the message', () => {
    expect(new AuthError('nope').kind).toBe('auth')
    expect(new TransientError('later').kind).toBe('transient')
    expect(new SchemaDriftError('what is this').kind).toBe('schema_drift')
    expect(new ConfigError('missing client').kind).toBe('config')
  })

  it('keeps every kind an instance of one base, so a catch can narrow once', () => {
    for (const e of [new AuthError('a'), new TransientError('b'), new SchemaDriftError('c'), new ConfigError('d')]) {
      expect(e).toBeInstanceOf(HaelanError)
      expect(e).toBeInstanceOf(Error)
    }
  })

  it('makes RevokedError an auth failure, because that is what it is', () => {
    const e = new RevokedError('p1')
    expect(e).toBeInstanceOf(AuthError)
    expect(e.kind).toBe('auth')
    expect(e.personId).toBe('p1')
  })

  it('preserves the cause, so the original failure is not lost', () => {
    const cause = new Error('socket hang up')
    expect(new TransientError('upstream', { cause }).cause).toBe(cause)
  })

  it('classifies 429 and 5xx as transient, because retrying them is the defined behaviour', () => {
    for (const status of [429, 500, 502, 503, 504]) expect(classifyHttp(status), String(status)).toBe('transient')
  })

  it('classifies a 4xx that is not 429 as schema drift, because retrying will not help', () => {
    for (const status of [400, 403, 404, 422]) expect(classifyHttp(status), String(status)).toBe('schema_drift')
  })

  it('names its kind in the message, so a log line carries the class', () => {
    expect(String(new TransientError('upstream said no'))).toContain('transient')
  })
})
