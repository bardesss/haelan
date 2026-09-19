// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { readRange, writeRange, RANGE_STORAGE_KEY } from '../src/ui/rangePreference.js'

// The same installation rail-collapse.test.tsx does, and for the same reason: Node ships an inert
// `localStorage` global, vitest's happy-dom environment refuses to overwrite a global that already
// exists, and so the bare `localStorage` this module reads resolves to Node's inert one rather
// than happy-dom's working one. A fresh Storage per test, never one shared across the file.
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: new Storage(), configurable: true, writable: true })
})

describe('the remembered range', () => {
  it('is nothing at all until one is chosen', () => {
    expect(readRange()).toBeNull()
  })

  it('reads back what was written', () => {
    writeRange('week')
    expect(readRange()).toBe('week')
  })

  it('keeps only the most recent choice', () => {
    writeRange('week')
    writeRange('year')
    expect(readRange()).toBe('year')
  })

  // A key this app wrote under an older RANGE_KEYS, or one edited by hand, is not a range. It has
  // to read as "no preference" rather than flow on into datesFor, which switches exhaustively on
  // a RangeKey and would fall off the end of every case for an unrecognised string.
  it('refuses a stored value that is not a range', () => {
    localStorage.setItem(RANGE_STORAGE_KEY, 'fortnight')
    expect(readRange()).toBeNull()
  })

  // localStorage throws in some privacy modes and is missing entirely in a sandboxed iframe. A
  // preference that cannot be remembered must leave the reader on the ordinary default, not take
  // the page down on the way to it.
  it('answers nothing when storage refuses to be read', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } },
      configurable: true, writable: true,
    })
    expect(readRange()).toBeNull()
    expect(() => writeRange('day')).not.toThrow()
  })
})
