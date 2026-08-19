import { describe, it, expect } from 'vitest'
import { VERSION } from '../src/index.js'

describe('tokens package', () => {
  it('exports a version', () => {
    expect(VERSION).toBe('0.1.0')
  })
})
