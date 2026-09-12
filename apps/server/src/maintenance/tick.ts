import { backupDecision, listBackups, McpCallLog, pruneBackups, runBackup } from '@haelan/core'
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
  #firstTick: ReturnType<typeof setTimeout> | null = null

  constructor(deps: MaintenanceTickDeps) { this.#deps = deps }

  dueNow(): boolean {
    if (this.#deps.keep <= 0) return false
    const [newest] = listBackups(this.#deps.dir)
    if (!newest) return true
    return this.#deps.now() - newest.takenAtMs >= this.#deps.intervalHours * 3_600_000
  }

  /**
   * A failed backup must leave the instance running. `runBackup` is fully synchronous and throws
   * on a verification failure, an `ENOSPC` from `VACUUM INTO` or `renameSync`, or `SQLITE_FULL` -
   * and this is called from inside a bare `setInterval` (or the delayed `setTimeout` `start()`
   * schedules for the first tick), with no `process.on('uncaughtException')` anywhere in this app
   * to catch what escapes one. Uncaught, that throw does not stay a failed backup; it takes the
   * whole process down, the same hazard SyncRunner guards on purpose (runner.ts's own `tryStart`,
   * `.catch(() => undefined)`). Caught here instead: logged where an operator can see it, and the
   * timer - and the next attempt - survive it.
   *
   * `backupDecision` sits inside this `try` too, not just `runBackup`/`pruneBackups`: it reads
   * three pragmas and calls `statfsSync` on the data directory, and a stale or removed mount
   * (ESTALE, ENOENT) or a pragma failure is exactly the kind of throw this function exists to
   * catch. Left outside the `try`, it would reopen this same hazard for the one call still able to
   * reach it uncaught.
   */
  runIfDue(): BackupFile | null {
    if (!this.dueNow()) return null
    try {
      // Spec section 1's reason B and C are one unit: this is the same disk-margin comparison the
      // vacuum uses, asked through the one function both the tick and the manual route call rather
      // than each carrying its own copy of it (see backupDecision's own comment). keep <= 0 never
      // reaches this branch in practice - dueNow() above already declined for it - but
      // backupDecision checks it too, since the manual route reaches this same gate with no
      // dueNow() in front of it.
      const decision = backupDecision(this.#deps.instance.db, this.#deps.dir, this.#deps.keep)
      if (!decision.run) {
        console.log(`maintenance: backup due, but declined - ${decision.reason}`)
        return null
      }
      const file = runBackup({ db: this.#deps.instance.db, dir: this.#deps.dir, nowMs: this.#deps.now() })
      pruneBackups(this.#deps.dir, this.#deps.keep)
      return file
    } catch (error) {
      console.error(`maintenance: backup failed, ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /**
   * Old `mcp_calls` rows, dropped on the same schedule as everything else this class decides is
   * old. One place that answers "what is past its horizon" rather than two.
   *
   * Its own method rather than a line inside `runIfDue`, because that returns early whenever a
   * backup is not due - and `HAELAN_BACKUP_KEEP=0` makes it never due at all. Folded in there, the
   * call log would grow forever on exactly the instances that turned backups off.
   *
   * Caught for the same reason `runIfDue` is: this is called from inside a bare `setInterval` with
   * no `process.on('uncaughtException')` anywhere in this app, so an escaping throw is not a failed
   * prune, it is the process.
   */
  pruneCallLog(): number {
    try {
      return new McpCallLog(this.#deps.instance.db).prune(this.#deps.now())
    } catch (error) {
      console.error(`maintenance: call log prune failed, ${error instanceof Error ? error.message : String(error)}`)
      return 0
    }
  }

  start(): void {
    if (this.#timer) return
    // Armed before either timer has ever run a tick, so a throw from one - runIfDue is caught
    // above, but arming first means the ordering itself never depends on that being true - can
    // never leave the hourly schedule unset. That used to be the same call, run synchronously
    // right here before this line: an instance that threw on its very first tick came back up
    // with no timer at all, silently never taking another backup - the failure this unit exists to
    // prevent, and worse than a single missed one.
    //
    // Hourly, like the sync scheduler, because the question is cheap - it reads one directory -
    // and asking it often is what lets a daily backup happen soon after an instance comes back up
    // rather than at whatever hour the process happened to start.
    this.#timer = setInterval(() => { this.runIfDue(); this.pruneCallLog() }, 3_600_000)
    this.#timer.unref?.()
    // An instance restarted more often than its interval would otherwise never back up at all -
    // setInterval waits a whole interval before its first tick, the exact hazard SyncRunner.start()
    // documents and avoids for the same reason (sync/runner.ts). But a first tick can mean a full
    // VACUUM INTO plus an integrity_check, synchronous, on top of the boot vacuum's own stall - and
    // running that before the app has answered a single request turns a restart into a stall
    // measured in tens of seconds on a large database. Delayed rather than dropped: dueNow() asks
    // the files, not a clock, so nothing already due stops being due a minute from now, and a
    // minute is enough that the app is up and serving first.
    this.#firstTick = setTimeout(() => { this.runIfDue(); this.pruneCallLog() }, 60_000)
    this.#firstTick.unref?.()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    // The delayed first tick is the same hazard a still-running interval would be at shutdown - a
    // backup starting against a database close() is about to pull the connection out from under -
    // and it is the one this method's own doc comment on shutdown's ordering already assumes it
    // covers, so it must clear this timer too, not only the recurring one.
    if (this.#firstTick) clearTimeout(this.#firstTick)
    this.#firstTick = null
  }
}
