import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * `0016_blue_kylun.sql` and its snapshot were assembled from two drizzle-kit passes merged by
 * hand, because drizzle-kit's rename prompt needs a TTY and CI has none - the `prevId` chain in
 * meta/ was set by hand as part of that merge, not generated the way every earlier migration's
 * was. A reviewer verified by running that an empty database migrates to head and that a
 * populated pre-change database upgrades cleanly, but neither of those runs would catch a broken
 * link in a chain drizzle-kit never produces this way on its own: the failure would surface on a
 * user's upgrade, not in CI. And a chain that has been hand-edited once can be hand-edited wrong
 * again, by someone who never reads this comment.
 *
 * So this reads the same files drizzle's migrator trusts at boot - the numbered snapshots, their
 * `id`/`prevId` links, and `_journal.json` - and checks the shape a hand-edit could break: every
 * snapshot naming the one immediately before it, no id reused, no gap in the journal's idx, and
 * every migration's tag matched to exactly one .sql file on disk.
 */

interface Snapshot { readonly id: string; readonly prevId: string }
interface JournalEntry { readonly idx: number; readonly tag: string }
interface Journal { readonly entries: readonly JournalEntry[] }

const HERE = dirname(fileURLToPath(import.meta.url))
const DRIZZLE_DIR = join(HERE, '../drizzle')
const META_DIR = join(DRIZZLE_DIR, 'meta')

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T

const snapshotFiles = readdirSync(META_DIR)
  .filter((name) => /^\d{4}_snapshot\.json$/.test(name))
  .sort()

const snapshots = snapshotFiles.map((name) => readJson<Snapshot>(join(META_DIR, name)))

const journal = readJson<Journal>(join(META_DIR, '_journal.json'))

const sqlFiles = readdirSync(DRIZZLE_DIR).filter((name) => name.endsWith('.sql'))

describe('the migration journal and snapshot chain', () => {
  it('found a chain to check, so the assertions below are not vacuously true', () => {
    // A moved or renamed meta/ directory would leave every loop below iterating zero files and
    // every assertion trivially passing - exactly the silent gap a hand-edited chain needs this
    // test not to have.
    expect(snapshots.length).toBeGreaterThan(0)
    expect(journal.entries.length).toBe(snapshots.length)
    expect(sqlFiles.length).toBe(snapshots.length)
  })

  it('names its root as whatever the first snapshot itself records, not an assumed constant', () => {
    // Not compared against a hardcoded all-zero UUID: drizzle owns what a rootless prevId looks
    // like, and hardcoding its choice here would make this test the thing that breaks the day
    // drizzle-kit changes it, rather than the migrator noticing a real break.
    const root = snapshots[0]!
    expect(typeof root.id).toBe('string')
    expect(typeof root.prevId).toBe('string')
    expect(root.id.length).toBeGreaterThan(0)
    expect(root.prevId.length).toBeGreaterThan(0)
  })

  it('has every later snapshot naming the one immediately before it as its prevId', () => {
    for (let i = 1; i < snapshots.length; i++) {
      expect(snapshots[i]!.prevId, snapshotFiles[i]).toBe(snapshots[i - 1]!.id)
    }
  })

  it('never reuses an id across two snapshots', () => {
    const ids = snapshots.map((snapshot) => snapshot.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has a journal whose idx runs contiguously from 0, with no gap and no repeat', () => {
    const sortedIdx = journal.entries.map((entry) => entry.idx).sort((a, b) => a - b)
    expect(sortedIdx).toEqual(sortedIdx.map((_, i) => i))
  })

  it('matches every journal tag to a .sql file, and every .sql file to a journal tag', () => {
    const sqlTags = new Set(sqlFiles.map((name) => name.replace(/\.sql$/, '')))
    const journalTags = new Set(journal.entries.map((entry) => entry.tag))

    // An orphan in either direction fails, and names the tag rather than just a count, so a
    // failure here says which migration is missing its half.
    const journalWithoutSql = journal.entries.map((entry) => entry.tag).filter((tag) => !sqlTags.has(tag))
    expect(journalWithoutSql).toEqual([])

    const sqlWithoutJournal = [...sqlTags].filter((tag) => !journalTags.has(tag))
    expect(sqlWithoutJournal).toEqual([])
  })
})
