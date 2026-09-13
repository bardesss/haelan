import type { Instance, BackupPolicy } from '@haelan/core'

/**
 * The last thing `HAELAN_BACKUP_KEEP` and `HAELAN_BACKUP_INTERVAL_HOURS` still do.
 *
 * Both were configuration until the two numbers became instance settings, and a household that
 * had switched backups off with `HAELAN_BACKUP_KEEP=0` must not come back from that migration
 * quietly keeping seven daily copies of a database they deliberately never wanted copied. So the
 * value they already set is written once, into whichever column is still null, and after that the
 * setting wins and the variable stops mattering - see `SettingsStore.seedBackupPolicy`.
 *
 * A value that does not parse is warned about and ignored rather than thrown on, which is the one
 * behaviour this deliberately changed: `readConfig` used to refuse to boot over it. Refusing to
 * start an instance over a variable that is no longer documented, and whose effect a household can
 * now see and correct on the Maintenance card, would be the wrong end of that trade.
 */
export function seedBackupPolicyFromEnv(
  instance: Instance,
  env: NodeJS.ProcessEnv,
  nowMs: number,
  log: (line: string) => void = (line) => { console.log(line) },
): Partial<BackupPolicy> {
  const seed: Partial<BackupPolicy> = {}
  const keep = readNumber(env, 'HAELAN_BACKUP_KEEP', log)
  if (keep !== undefined) seed.keep = keep
  const intervalHours = readNumber(env, 'HAELAN_BACKUP_INTERVAL_HOURS', log)
  if (intervalHours !== undefined) seed.intervalHours = intervalHours
  if (seed.keep === undefined && seed.intervalHours === undefined) return {}

  let written: Partial<BackupPolicy>
  try {
    written = instance.settings.seedBackupPolicy(seed, nowMs)
  } catch (error) {
    // seedBackupPolicy enforces the same bounds the Maintenance card does, so a value that parses
    // as a number and is still out of range lands here. Same trade as an unparseable one: said
    // out loud, not fatal.
    log(`ignoring ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
  if (written.keep !== undefined) {
    log(`backups to keep taken from HAELAN_BACKUP_KEEP (${written.keep}) into instance settings, once`)
  }
  if (written.intervalHours !== undefined) {
    log(`hours between backups taken from HAELAN_BACKUP_INTERVAL_HOURS (${written.intervalHours}) into instance settings, once`)
  }
  return written
}

function readNumber(env: NodeJS.ProcessEnv, name: string, log: (line: string) => void): number | undefined {
  const raw = env[name]
  if (raw === undefined || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isInteger(value)) {
    log(`ignoring ${name}=${raw}, which is not a whole number; set it on the Maintenance settings card instead`)
    return undefined
  }
  return value
}
