import { describe, it, expect } from 'vitest'
import { resolveSource } from '../src/controls/source.js'
import { parseControls } from '../src/controls/range.js'

describe('resolveSource', () => {
  // A link can name a source this person does not have, and a source can be removed after a link
  // is made. The DOM cannot stand guard on this: a browser select silently defaults an unmatched
  // controlled value to whichever option renders first, which is always merged, so an assertion
  // that reads the mounted select back passes with the check deleted.
  it('falls back to merged only when the source is not among the options', () => {
    expect(resolveSource('someone-elses', ['merged', 'watch'])).toBe('merged')
    expect(resolveSource('watch', ['merged', 'watch'])).toBe('watch')
    expect(resolveSource('merged', ['merged'])).toBe('merged')
  })

  // The list grows as the enumeration answers, so a real device reads as unknown for one round
  // trip. Resolving to merged for that moment queries more than was asked for rather than
  // querying a source nothing has confirmed, and the select says merged while it does.
  it('reads a real device as unknown until the enumeration has offered it', () => {
    expect(resolveSource('watch', ['merged'])).toBe('merged')
    expect(resolveSource('watch', ['merged', 'watch'])).toBe('watch')
  })
})

describe('parseControls and the source parameter', () => {
  it('reads a blank source as merged rather than as a source named ""', () => {
    expect(parseControls('?source=', '2026-08-15').source).toBe('merged')
    expect(parseControls('', '2026-08-15').source).toBe('merged')
    expect(parseControls('?source=watch', '2026-08-15').source).toBe('watch')
  })
})
