import { describe, it, expect } from 'vitest'
import { ALL_SOURCES, resolveSource, sourceParam } from '../src/controls/source.js'
import { parseControls } from '../src/controls/range.js'

describe('resolveSource', () => {
  // A link can name a source this person does not have, and a source can be removed after a link
  // is made. The DOM cannot stand guard on this: a browser select silently defaults an unmatched
  // controlled value to whichever option renders first, which is always the sentinel, so an
  // assertion that reads the mounted select back passes with the check deleted.
  it('falls back to the all sources sentinel only when the source is not among the options', () => {
    expect(resolveSource('someone-elses', [ALL_SOURCES, 'watch'])).toBe(ALL_SOURCES)
    expect(resolveSource('watch', [ALL_SOURCES, 'watch'])).toBe('watch')
    expect(resolveSource(ALL_SOURCES, [ALL_SOURCES])).toBe(ALL_SOURCES)
  })

  // The list grows as the enumeration answers, so a real device reads as unknown for one round
  // trip. Resolving to the sentinel for that moment queries more than was asked for rather than
  // querying a source nothing has confirmed, and the select says "All sources" while it does.
  it('reads a real device as unknown until the enumeration has offered it', () => {
    expect(resolveSource('watch', [ALL_SOURCES])).toBe(ALL_SOURCES)
    expect(resolveSource('watch', [ALL_SOURCES, 'watch'])).toBe('watch')
  })
})

describe('parseControls and the source parameter', () => {
  it('reads a blank source as the all sources sentinel rather than as a source named ""', () => {
    expect(parseControls('?source=', '2026-08-15').source).toBe(ALL_SOURCES)
    expect(parseControls('', '2026-08-15').source).toBe(ALL_SOURCES)
    expect(parseControls('?source=watch', '2026-08-15').source).toBe('watch')
  })
})

describe('the all sources sentinel', () => {
  // The option name promises every source. merged is one particular source, the one we computed,
  // and two metrics in this database have none. Sending it is what made them invisible.
  it('omits the source parameter entirely, rather than sending merged', () => {
    expect(sourceParam(ALL_SOURCES)).toBeUndefined()
  })

  it('sends a named device through unchanged', () => {
    expect(sourceParam('watch')).toBe('watch')
  })

  it('resolves an unknown source back to the sentinel, not to merged', () => {
    expect(resolveSource('a-removed-device', [ALL_SOURCES, 'watch'])).toBe(ALL_SOURCES)
  })
})
