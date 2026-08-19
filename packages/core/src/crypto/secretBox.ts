import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const IV_BYTES = 12
const TAG_BYTES = 16

export function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

export function open(key: Buffer, sealed: string): string {
  const raw = Buffer.from(sealed, 'base64')
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error('sealed value is truncated')
  const iv = raw.subarray(0, IV_BYTES)
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()])
    .toString('utf8')
}
