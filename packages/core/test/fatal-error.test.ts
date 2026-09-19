import { describe, it, expect } from 'vitest'
import { isFatalRebuildError } from '../src/rebuild/fatalError.ts'

const withCode = (code: string) => Object.assign(new Error('x'), { code })

describe('isFatalRebuildError', () => {
  it('treats a full disk as fatal, never as a bad page', () => {
    expect(isFatalRebuildError(withCode('SQLITE_FULL'))).toBe(true)
  })

  it('treats io, corruption, memory and lock contention as fatal', () => {
    for (const code of ['SQLITE_IOERR', 'SQLITE_CORRUPT', 'SQLITE_NOMEM', 'SQLITE_BUSY']) {
      expect(isFatalRebuildError(withCode(code))).toBe(true)
    }
  })

  it('matches an extended code, which is what better-sqlite3 usually reports', () => {
    expect(isFatalRebuildError(withCode('SQLITE_IOERR_WRITE'))).toBe(true)
  })

  it('treats a constraint violation as a droppable page', () => {
    expect(isFatalRebuildError(withCode('SQLITE_CONSTRAINT_PRIMARYKEY'))).toBe(false)
  })

  it('treats an error with no code as droppable, which a mapper bug is', () => {
    expect(isFatalRebuildError(new Error('cannot read property of undefined'))).toBe(false)
  })
})
