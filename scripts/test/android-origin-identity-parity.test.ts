import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// The phone marks a dataSource origin scoped and the instance keys on that marker; the instance
// answers the cutovers the phone reads. Each side is a literal in a different language, so this
// keeps the four from drifting apart unnoticed.
const root = new URL('../../', import.meta.url)

function mustContain(path: string, needle: string): void {
  // A checkout with CRLF line endings still has to match a needle spanning lines.
  const text = readFileSync(new URL(path, root), 'utf8').replace(/\r\n/g, '\n')
  expect(text.includes(needle), `${path}: ${needle} not found - has it moved or been renamed?`).toBe(true)
}

describe('android origin identity parity', () => {
  it('the phone sends the marker the core store keys on', () => {
    mustContain('apps/android/app/src/main/java/com/haelan/android/SyncEngine.kt', 'put("originScoped", true)')
    // The old identity's marker, which the instance archives as 'upgraded' and keeps off the cutover.
    mustContain('apps/android/app/src/main/java/com/haelan/android/SyncEngine.kt', 'put("originScoped", false)')
    mustContain('apps/server/src/routes/v1/ingest.ts', "marker === false ? { identity: 'upgraded' }")
    mustContain('packages/core/src/store/sources.ts', "dataSource['originScoped'] === true")
  })

  it('the phone reads the cutovers the companion route answers', () => {
    // The key as the reply object spells it, not the word, which comments also carry.
    mustContain('apps/server/src/routes/v1/companion.ts', 'items: [...legacyItems, ...perSourceItems],\n      identityCutovers,\n')
    mustContain('apps/android/app/src/main/java/com/haelan/android/SyncCursors.kt', '"identityCutovers"')
  })
})
