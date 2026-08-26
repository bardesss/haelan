import { describe, it, expect } from 'vitest'
import { deepLink } from '../src/controls/deepLink.js'

const controls = { tab: 'month', anchor: '2026-08-15', source: 'watch' } as const

describe('deepLink', () => {
  // The reason this exists: a card that drops the reader on today has made them navigate back
  // to where they already were.
  it('carries the range, the anchor and the source to the target page', () => {
    const link = deepLink('/sleep', controls)
    expect(link).toBe('/sleep?range=month&on=2026-08-15&source=watch')
  })

  it('leaves a default source out rather than pinning it', () => {
    expect(deepLink('/sleep', { ...controls, source: 'merged' }))
      .toBe('/sleep?range=month&on=2026-08-15')
  })

  it('does not carry a query already on the target path into a second question mark', () => {
    expect(deepLink('/sleep?tab=stages', controls))
      .toBe('/sleep?tab=stages&range=month&on=2026-08-15&source=watch')
  })
})
