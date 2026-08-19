import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const KEY_FILENAME = 'instance.key'
export const KEY_ENV_VAR = 'HAELAN_ENCRYPTION_KEY'
const KEY_BYTES = 32

function readKeyFile(path: string): Buffer {
  const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64')
  if (key.length !== KEY_BYTES) {
    throw new Error(`${path} is corrupt: expected 32 bytes, got ${key.length}`)
  }
  return key
}

// The key lives in the same volume as the database, so it defends against a copied database
// file, not against someone holding the volume. Deriving it from a password would be stronger
// and would stop the instance syncing unattended after a restart. Spec section 15 states the
// trade openly rather than implying more protection than this provides.
export function loadOrCreateKey(dir: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const override = env[KEY_ENV_VAR]
  if (override) {
    const key = Buffer.from(override, 'base64')
    if (key.length !== KEY_BYTES) {
      throw new Error(`${KEY_ENV_VAR} must decode to exactly 32 bytes, got ${key.length}`)
    }
    return key
  }

  mkdirSync(dir, { recursive: true })
  const path = join(dir, KEY_FILENAME)
  if (existsSync(path)) return readKeyFile(path)

  const key = randomBytes(KEY_BYTES)
  try {
    // 'wx' makes the write fail if the file appeared between the existsSync check above and
    // here. Two processes booting a fresh volume at the same time would otherwise each generate
    // a key and write it, and the loser's already-sealed values become permanently unreadable.
    writeFileSync(path, key.toString('base64'), { mode: 0o600, flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return readKeyFile(path)
    throw err
  }
  return key
}
