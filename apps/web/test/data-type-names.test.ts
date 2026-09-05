import { describe, it, expect } from 'vitest'
// Importing @haelan/core's root export from a test file is allowed (e2e-dashboard.test.tsx's own
// comment records why apps/web's SHIPPED code cannot: the root export reaches better-sqlite3 and
// argon2, native modules no browser bundle can carry, and a test file is never bundled). DATA_TYPES
// is not on any of the browser-safe subpaths apps/web's runtime code actually uses, so the root
// export is the only way to reach the catalogue this test checks names against.
import { DATA_TYPES } from '@haelan/core'
import en from '../src/i18n/en.json' with { type: 'json' }
import nl from '../src/i18n/nl.json' with { type: 'json' }

/**
 * What actually keeps the catalogue and dataTypes.json in step, per the naming task's own framing:
 * dataTypeName.ts's raw-id fallback covers the moment between a catalogue addition and someone
 * naming it, but nothing stops that moment from lasting forever without a test that fails the day
 * it starts. Fetchable is `actions.length > 0`, the same predicate DataTypePicker's callers filter
 * GET /data-types through server-side (apps/server/src/routes/v1/dataTypes.ts) -- a type with no
 * actions can never appear on either screen this catalogue names for, and giving it a name nobody
 * can see would be untestable busywork.
 */
const FETCHABLE_IDS = DATA_TYPES.filter((type) => type.actions.length > 0).map((type) => type.id)

describe('data type names', () => {
  it('covers every fetchable catalogue id', () => {
    // Guards this test itself: a catalogue change that dropped every entry would otherwise make
    // the loop below vacuously pass.
    expect(FETCHABLE_IDS.length).toBeGreaterThan(0)
  })

  it('names every fetchable catalogue id in English', () => {
    const missing = FETCHABLE_IDS.filter((id) => typeof (en.dataTypes as Record<string, string>)[id] !== 'string')
    expect(missing).toEqual([])
  })

  it('names every fetchable catalogue id in Dutch', () => {
    const missing = FETCHABLE_IDS.filter((id) => typeof (nl.dataTypes as Record<string, string>)[id] !== 'string')
    expect(missing).toEqual([])
  })
})
