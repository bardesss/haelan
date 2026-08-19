import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadOrCreateKey, KEY_FILENAME } from '../src/crypto/key.ts'
import { seal, open } from '../src/crypto/secretBox.ts'

describe('loadOrCreateKey', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'haelan-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('generates 32 bytes on first call', () => {
    expect(loadOrCreateKey(dir, {})).toHaveLength(32)
  })

  it('returns the same key on the next boot', () => {
    const first = loadOrCreateKey(dir, {})
    expect(loadOrCreateKey(dir, {}).equals(first)).toBe(true)
  })

  it('writes the key file readable only by its owner', () => {
    loadOrCreateKey(dir, {})
    const mode = statSync(join(dir, KEY_FILENAME)).mode & 0o777
    // Windows does not honour POSIX bits, so this only asserts where it means something.
    if (process.platform !== 'win32') expect(mode).toBe(0o600)
  })

  it('prefers an environment override, for anyone wanting an external secret store', () => {
    const override = Buffer.alloc(32, 7).toString('base64')
    const key = loadOrCreateKey(dir, { HAELAN_ENCRYPTION_KEY: override })
    expect(key.equals(Buffer.alloc(32, 7))).toBe(true)
    expect(() => readFileSync(join(dir, KEY_FILENAME))).toThrow()
  })

  it('rejects an override that is not 32 bytes rather than silently truncating', () => {
    const short = Buffer.alloc(8, 1).toString('base64')
    expect(() => loadOrCreateKey(dir, { HAELAN_ENCRYPTION_KEY: short })).toThrow(/32 bytes/)
  })
})

describe('seal and open', () => {
  const key = Buffer.alloc(32, 3)

  it('round-trips', () => {
    expect(open(key, seal(key, 'a refresh token'))).toBe('a refresh token')
  })

  it('produces different ciphertext each time, so equal secrets are not detectable', () => {
    expect(seal(key, 'same')).not.toBe(seal(key, 'same'))
  })

  it('refuses to open with the wrong key', () => {
    expect(() => open(Buffer.alloc(32, 4), seal(key, 'secret'))).toThrow()
  })

  it('refuses to open tampered ciphertext', () => {
    const sealed = seal(key, 'secret')
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'B' : 'A')
    expect(() => open(key, tampered)).toThrow()
  })
})
