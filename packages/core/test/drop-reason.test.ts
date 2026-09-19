import { describe, it, expect } from 'vitest'
import { dropReason } from '../src/rebuild/dropReason.ts'

describe('dropReason', () => {
  it('keeps a constraint failure verbatim, since it is already stable', () => {
    const e = Object.assign(new Error('UNIQUE constraint failed: session_segments.id'), {
      code: 'SQLITE_CONSTRAINT_PRIMARYKEY',
    })
    expect(dropReason(e)).toBe('UNIQUE constraint failed: session_segments.id')
  })

  it('groups two pages failing the same way into one reason', () => {
    const a = new Error('UNIQUE constraint failed: session_segments.id')
    const b = new Error('UNIQUE constraint failed: session_segments.id')
    expect(dropReason(a)).toBe(dropReason(b))
  })

  it('keeps two different constraints apart', () => {
    const a = new Error('UNIQUE constraint failed: session_segments.id')
    const b = new Error('NOT NULL constraint failed: observations.value')
    expect(dropReason(a)).not.toBe(dropReason(b))
  })

  it('strips a trailing row id, so the same fault on two rows groups', () => {
    const a = new Error('FOREIGN KEY constraint failed (rowid 4211)')
    const b = new Error('FOREIGN KEY constraint failed (rowid 9930)')
    expect(dropReason(a)).toBe(dropReason(b))
    expect(dropReason(a)).toBe('FOREIGN KEY constraint failed')
  })

  it('truncates an unrecognised message rather than dropping it', () => {
    const long = 'x'.repeat(500)
    const out = dropReason(new Error(long))
    expect(out).toHaveLength(200)
  })

  it('survives a thrown non-Error', () => {
    expect(dropReason('just a string')).toBe('just a string')
    expect(dropReason(undefined)).toBe('unknown error')
  })
})
