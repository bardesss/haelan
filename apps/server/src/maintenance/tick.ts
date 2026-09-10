import { listBackups, pruneBackups, runBackup } from '@haelan/core'
import type { BackupFile, Instance } from '@haelan/core'

export interface MaintenanceTickDeps {
  instance: Instance
  dir: string
  keep: number
  intervalHours: number
  now: () => number
}

/**
 * Decides when a backup is due by looking at the files rather than by holding a timer.
 *
 * A timer would reset on every restart and would skip the night an instance was off; the newest
 * completed backup's own timestamp survives both. It is also the same fact the Settings screen
 * reports, so there is no second copy of "when did we last back up" to disagree with the folder.
 *
 * Its own tick rather than SyncRunner's: that timer decides when a person is due for a sync and
 * its state is per person, and a backup failure must not be able to look like a sync failure. The
 * two are serialized anyway by sharing one database connection, so a shared timer would buy
 * nothing and cost the distinction.
 */
export class MaintenanceTick {
  readonly #deps: MaintenanceTickDeps
  #timer: ReturnType<typeof setInterval> | null = null

  constructor(deps: MaintenanceTickDeps) { this.#deps = deps }

  dueNow(): boolean {
    if (this.#deps.keep <= 0) return false
    const [newest] = listBackups(this.#deps.dir)
    if (!newest) return true
    return this.#deps.now() - newest.takenAtMs >= this.#deps.intervalHours * 3_600_000
  }

  runIfDue(): BackupFile | null {
    if (!this.dueNow()) return null
    const file = runBackup({ db: this.#deps.instance.db, dir: this.#deps.dir, nowMs: this.#deps.now() })
    pruneBackups(this.#deps.dir, this.#deps.keep)
    return file
  }

  start(): void {
    if (this.#timer) return
    // Hourly, like the sync scheduler, because the question is cheap - it reads one directory -
    // and asking it often is what lets a daily backup happen soon after an instance comes back up
    // rather than at whatever hour the process happened to start.
    this.#timer = setInterval(() => { this.runIfDue() }, 3_600_000)
    this.#timer.unref?.()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }
}
