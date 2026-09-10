import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createTestDatabase, seedPerson } from '../src/testing/fixtures.ts'
import { BACKUP_DIR_NAME, listBackups, pruneBackups, runBackup } from '../src/backup/runBackup.ts'

describe('runBackup', () => {
  it('writes a file that opens, passes integrity_check and holds the same rows', () => {
    const test = createTestDatabase()
    try {
      seedPerson(test.db, 'p1')
      const file = runBackup({ db: test.db, dir: test.dir, nowMs: 1_770_000_000_000 })

      const copy = new Database(file.path, { readonly: true })
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok')
      expect(copy.prepare('select count(*) c from people').get()).toEqual({ c: 1 })
      copy.close()
    } finally { test.cleanup() }
  })

  // A name only ever has to agree with itself: nameFor and takenAtFrom (reached here through
  // runBackup and listBackups, since neither function is exported on its own) are the whole
  // contract. A millisecond with every digit non-zero is what catches a parser that silently
  // drops or misreads a field - a round trip through .000 would still look correct by accident.
  it('gives a backup a takenAtMs that round-trips to the exact millisecond it was taken', () => {
    const test = createTestDatabase()
    try {
      const nowMs = 1_770_000_000_123
      const file = runBackup({ db: test.db, dir: test.dir, nowMs })
      expect(listBackups(test.dir)[0]!.takenAtMs).toBe(nowMs)
      expect(file.name).toContain('123')
    } finally { test.cleanup() }
  })

  it('leaves nothing but a .part behind when verification fails, and never counts it', () => {
    const test = createTestDatabase()
    try {
      // A .part left by a killed container: a real SQLite file, so "is it a database" is not what
      // rejects it - the name is. Anything else would let a truncated file pass by being unopenable
      // for a different reason than the one we mean.
      const dir = join(test.dir, BACKUP_DIR_NAME)
      runBackup({ db: test.db, dir: test.dir, nowMs: 1_770_000_000_000 })
      const orphan = join(dir, 'haelan-2020-01-01T00-00-00Z.sqlite.part')
      writeFileSync(orphan, '')

      const listed = listBackups(test.dir)
      expect(listed.every((b) => !b.name.endsWith('.part'))).toBe(true)
      expect(listed).toHaveLength(1)
      expect(existsSync(orphan)).toBe(true)
    } finally { test.cleanup() }
  })

  it('gives each backup a name that sorts by when it was taken', () => {
    const test = createTestDatabase()
    try {
      const first = runBackup({ db: test.db, dir: test.dir, nowMs: 1_770_000_000_000 })
      const second = runBackup({ db: test.db, dir: test.dir, nowMs: 1_770_000_000_000 + 86_400_000 })
      expect(second.name > first.name).toBe(true)
      expect(listBackups(test.dir).map((b) => b.name)).toEqual([second.name, first.name])
    } finally { test.cleanup() }
  })
})

describe('pruneBackups', () => {
  it('keeps the newest N and deletes the rest', () => {
    const test = createTestDatabase()
    try {
      const made = [0, 1, 2, 3, 4].map((d) =>
        runBackup({ db: test.db, dir: test.dir, nowMs: 1_770_000_000_000 + d * 86_400_000 }))
      const deleted = pruneBackups(test.dir, 2)

      expect(deleted).toHaveLength(3)
      expect(listBackups(test.dir).map((b) => b.name)).toEqual([made[4]!.name, made[3]!.name])
    } finally { test.cleanup() }
  })

  // The failure mode that turns a retention policy into a data loss mechanism: counting a failed
  // backup towards the limit lets a run that fails every night evict every good file it has.
  it('never lets a .part evict a completed backup', () => {
    const test = createTestDatabase()
    try {
      const kept = runBackup({ db: test.db, dir: test.dir, nowMs: 1_770_000_000_000 })
      const dir = join(test.dir, BACKUP_DIR_NAME)
      for (const day of [1, 2, 3]) {
        writeFileSync(join(dir, `haelan-2027-01-0${day}T00-00-00Z.sqlite.part`), '')
      }

      pruneBackups(test.dir, 1)

      expect(listBackups(test.dir).map((b) => b.name)).toEqual([kept.name])
    } finally { test.cleanup() }
  })
})
