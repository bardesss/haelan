import { describe, expect, it } from 'vitest'
import { asOfLabel } from '../src/pages/recovery/RecoveryIndexCard.js'

describe('asOfLabel', () => {
  it('says nothing when the scored day is today', () => {
    expect(asOfLabel('2026-09-19', '2026-09-19')).toBeNull()
  })

  it('names the scored day when it is not today, because sync lag is the normal state', () => {
    expect(asOfLabel('2026-09-14', '2026-09-19')).toBe('2026-09-14')
  })
})
