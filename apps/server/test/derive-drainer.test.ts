import { describe, expect, it } from 'vitest'
import { shouldDrain } from '../src/derive/drainer.ts'

describe('shouldDrain', () => {
  it('stands down while a rebuild holds the write lock', () => {
    // The boot rebuild holds the write lock for its whole run, so a second writer on the file is
    // an outage rather than a slow request.
    expect(shouldDrain({ rebuildRunning: true, queueSize: 500 })).toBe(false)
  })

  it('stays idle when nothing is queued', () => {
    expect(shouldDrain({ rebuildRunning: false, queueSize: 0 })).toBe(false)
  })

  it('drains when there is work and no rebuild', () => {
    expect(shouldDrain({ rebuildRunning: false, queueSize: 1 })).toBe(true)
  })
})
