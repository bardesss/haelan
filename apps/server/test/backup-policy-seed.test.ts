import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { openHaelan, SettingsStore } from '@haelan/core'
import { seedBackupPolicyFromEnv } from '../src/maintenance/backupPolicySeed.ts'

const NOW_MS = 1_770_000_000_000

function withInstance<T>(fn: (instance: ReturnType<typeof openHaelan>) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'haelan-seed-'))
  const instance = openHaelan(dir, {})
  try { return fn(instance) } finally {
    instance.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const withRow = (instance: ReturnType<typeof openHaelan>) =>
  new SettingsStore(instance.db)
    .put({ baseUrl: 'http://localhost:4235', consentPath: 'localhost', nowMs: 1 })

describe('seeding the backup policy from the environment, once', () => {
  // The case this exists for. An instance that was running with backups deliberately off must not
  // come back from the migration keeping seven daily copies of a database nobody wanted copied.
  it('carries HAELAN_BACKUP_KEEP=0 onto the settings row', () => {
    withInstance((instance) => {
      withRow(instance)
      const written = seedBackupPolicyFromEnv(instance, { HAELAN_BACKUP_KEEP: '0' }, NOW_MS, () => {})
      expect(written).toEqual({ keep: 0 })
      expect(instance.settings.backupPolicy()).toEqual({ keep: 0, intervalHours: 24 })
    })
  })

  it('does not touch a policy the household has already chosen', () => {
    withInstance((instance) => {
      withRow(instance)
      instance.settings.putBackupPolicy({ keep: 5, intervalHours: 12 }, NOW_MS)
      expect(seedBackupPolicyFromEnv(instance, { HAELAN_BACKUP_KEEP: '0' }, NOW_MS, () => {})).toEqual({})
      expect(instance.settings.backupPolicy()).toEqual({ keep: 5, intervalHours: 12 })
    })
  })

  it('does nothing when neither variable is set, which is every install since they stopped being documented', () => {
    withInstance((instance) => {
      withRow(instance)
      expect(seedBackupPolicyFromEnv(instance, {}, NOW_MS, () => {})).toEqual({})
      expect(instance.settings.get()).toMatchObject({ backupKeep: null, backupIntervalHours: null })
    })
  })

  // readConfig used to refuse to boot over either of these. Deliberately changed: refusing to
  // start an instance over a variable that is no longer documented, and whose effect is now
  // visible and correctable on a settings card, is the wrong end of that trade.
  it('says so and carries on rather than throwing, for a value that does not parse', () => {
    withInstance((instance) => {
      withRow(instance)
      const lines: string[] = []
      const written = seedBackupPolicyFromEnv(
        instance, { HAELAN_BACKUP_KEEP: 'off', HAELAN_BACKUP_INTERVAL_HOURS: '6' }, NOW_MS,
        (line) => lines.push(line),
      )
      expect(written).toEqual({ intervalHours: 6 })
      expect(lines.join('\n')).toContain('HAELAN_BACKUP_KEEP=off')
      expect(instance.settings.backupPolicy()).toEqual({ keep: 7, intervalHours: 6 })
    })
  })

  it('says so and carries on for a number the store itself refuses', () => {
    withInstance((instance) => {
      withRow(instance)
      const lines: string[] = []
      expect(seedBackupPolicyFromEnv(
        instance, { HAELAN_BACKUP_KEEP: '-4' }, NOW_MS, (line) => lines.push(line),
      )).toEqual({})
      expect(lines.join('\n')).toContain('0 to 365')
      expect(instance.settings.get()?.backupKeep).toBeNull()
    })
  })

  it('is a no-op, not a throw, before the wizard has written a settings row', () => {
    withInstance((instance) => {
      expect(seedBackupPolicyFromEnv(instance, { HAELAN_BACKUP_KEEP: '0' }, NOW_MS, () => {})).toEqual({})
      expect(instance.settings.get()).toBeNull()
    })
  })
})

/**
 * The other half of issue #150: the two names leave the README's configuration table, because a
 * table that still lists them is a household restarting a container to change a setting they can
 * change on a screen. Asserted against the table itself rather than the whole file, so prose that
 * names the variables while explaining where they went would not have to be deleted to pass.
 */
describe('the README configuration table', () => {
  const table = (): string => {
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8')
    const start = readme.indexOf('| Variable | Default | What it is for |')
    expect(start, 'the configuration table was not found in README.md').toBeGreaterThan(-1)
    const end = readme.indexOf('\n\n', start)
    return readme.slice(start, end === -1 ? undefined : end)
  }

  it('no longer names either backup variable', () => {
    expect(table()).not.toContain('HAELAN_BACKUP_KEEP')
    expect(table()).not.toContain('HAELAN_BACKUP_INTERVAL_HOURS')
  })

  // The four that stay: each has to be true before the process binds a port or opens the
  // database, which is exactly what the two that left were not.
  it('still names the four that have to exist before the server starts', () => {
    for (const name of ['HAELAN_DATA_DIR', 'HAELAN_PORT', 'HAELAN_HOST', 'HAELAN_ENCRYPTION_KEY']) {
      expect(table()).toContain(name)
    }
  })
})
