import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from '../../i18n/index.js'
import { useSession } from '../../auth/session.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import { formatNumber } from '../../format.js'
import {
  maintenanceKey, useBackupNow, useMaintenanceStatus, useReclaimSpace,
} from '../../data/useMaintenance.js'
import type { BackupDeclineReason, VacuumDeclineReason } from '../../data/useMaintenance.js'

// Decimal, not the binary 1024*1024 an OS "MB" usually means: nothing else in this app's own
// unit conversions (Activity.tsx's millimeters-to-kilometers, Weight.tsx's grams-to-kilograms)
// reaches for a binary base, and a reader comparing this figure against du or df on the machine
// itself is better served by matching what those tools already call a megabyte.
const BYTES_PER_MB = 1_000_000

function toMb(bytes: number, language: string): string {
  return formatNumber(bytes / BYTES_PER_MB, 1, language, '')
}

/**
 * Why a reclaim declined, in words a person can act on rather than the bare reason the route
 * answers with. A Record rather than a switch with a default: a fifth reason the route started
 * sending would fail typechecking here rather than silently falling through to whatever a
 * default case happened to render -- see vacuumDecision's own comment in
 * packages/core/src/db/vacuum.ts for what below_fraction/below_floor/not_enough_disk mean.
 * below_fraction and below_floor both say there is nothing worth reclaiming yet; not_enough_disk
 * is the one this household can act on, so it is also the only one that names what would fix it.
 * rebuild_in_progress is routes/maintenance.ts's own reason, not core's -- see
 * ServerDeps.rebuildInFlight -- and needs no action beyond waiting the few seconds boot takes.
 */
const RECLAIM_DECLINE_KEY: Record<VacuumDeclineReason, string> = {
  below_fraction: 'settings.maintenance.declined.belowFraction',
  below_floor: 'settings.maintenance.declined.belowFloor',
  not_enough_disk: 'settings.maintenance.declined.notEnoughDisk',
  rebuild_in_progress: 'settings.maintenance.declined.rebuildInProgress',
}

/**
 * The backup route's own three reasons. not_enough_disk and rebuild_in_progress share their
 * sentence with the reclaim table above -- the same fact, whichever button asked -- and
 * backups_disabled is the one specific to this button: HAELAN_BACKUP_KEEP=0, which README and
 * config.ts both say turns backups off.
 */
const BACKUP_DECLINE_KEY: Record<BackupDeclineReason, string> = {
  backups_disabled: 'settings.maintenance.declined.backupsDisabled',
  not_enough_disk: 'settings.maintenance.declined.notEnoughDisk',
  rebuild_in_progress: 'settings.maintenance.declined.rebuildInProgress',
}

/**
 * What the database file is costing, and the two levers a household has over it: a backup taken
 * on demand rather than waiting for the nightly one, and a vacuum run outside the once-per-boot
 * schedule. Reads as SourceNames.tsx's sibling: one query for the figures, one mutation per
 * button, and the last mutation's own result rendered inline once it resolves rather than folded
 * into a toast that would be gone before a reader who left the tab in the background ever saw it.
 *
 * Admin only, mounted the same way Members.tsx is: Settings.tsx's own guard on
 * session.data?.isAdmin, which is also who the three routes this file calls accept -- everyone
 * else already gets 'forbidden' from the server regardless of what renders here.
 */
export function Maintenance() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const session = useSession()
  const status = useMaintenanceStatus()
  const backup = useBackupNow()
  const reclaim = useReclaimSpace()

  if (status.isPending) return <Loading />
  if (status.isError) {
    return (
      <ErrorState onRetry={() => {
        void queryClient.refetchQueries({ queryKey: maintenanceKey(), exact: true })
      }} />
    )
  }

  const { bloat, backups, keep, intervalHours, vacuumBlocked } = status.data
  const latest = backups[0] ?? null

  return (
    <div className="maintenance">
      {/* ConnectGoogle.tsx already carries this - ConnectGoogle sits at the top of Settings.tsx,
          above this card, and ConnectGoogle.tsx's own doc comment explains what credentialsUnreadable
          means. But someone who restored a backup without instance.key is reading *this* section
          when they notice their data looks gone, not the card above it, and this section said
          nothing. settings.maintenance.credentialsUnreadable is a $t() reference to
          connect.restoreDetail rather than a second copy of its wording, so the two places that
          explain this state cannot drift apart the way two independently written accounts would. */}
      {session.data?.credentialsUnreadable === true && (
        <p className="maintenance-credentials">{t('settings.maintenance.credentialsUnreadable')}</p>
      )}
      <p className="maintenance-bloat">
        {t('settings.maintenance.bloat', { mb: toMb(bloat.freeBytes, i18n.language) })}
      </p>

      {latest === null ? (
        <p className="maintenance-backups">{t('settings.maintenance.backups.none')}</p>
      ) : (
        <p className="maintenance-backups">
          {t('settings.maintenance.backups.latest', {
            // dateStyle only, no timeStyle: a date a person recognises, not the moment down to
            // the minute OverrideList.tsx's own instant column shows -- a backup names a day this
            // household would look for, not an hour.
            date: new Date(latest.takenAtMs).toLocaleString(i18n.language, { dateStyle: 'medium' }),
            size: toMb(latest.bytes, i18n.language),
          })}
        </p>
      )}
      {/* keep === 0 is HAELAN_BACKUP_KEEP=0, README's and config.ts's own "turn backups off" --
          backupDecision declines every write this instance would otherwise make, so
          "Keeps the last 0, taken every N hours" described a schedule that does not exist and a
          household had no way to learn backups were off short of pressing the button below and
          reading the decline. */}
      <p className="maintenance-retention">
        {keep === 0
          ? t('settings.maintenance.backups.off')
          : t('settings.maintenance.backups.retention', { keep, hours: intervalHours })}
      </p>

      {/* The one reason worth telling a household before they click, not after: the route's own
          vacuumBlocked answers true only for not_enough_disk, so this reaches for the identical
          copy the post-click decline below uses for that same reason rather than inventing a
          second sentence that could drift from it. */}
      {vacuumBlocked && (
        <p className="maintenance-blocked">{t(RECLAIM_DECLINE_KEY.not_enough_disk)}</p>
      )}

      <div className="form-actions">
        {/* Not merely disabled: a button that is always going to answer backups_disabled is not
            a control, it is a decline waiting to happen, and disabled-but-visible still invites
            the click that finds that out the hard way. */}
        {keep > 0 && (
          <button type="button" className="button" disabled={backup.isPending} onClick={() => backup.mutate()}>
            {backup.isPending ? t('settings.maintenance.backingUp') : t('settings.maintenance.backupNow')}
          </button>
        )}
        <button type="button" className="button" disabled={reclaim.isPending} onClick={() => reclaim.mutate()}>
          {reclaim.isPending ? t('settings.maintenance.reclaiming') : t('settings.maintenance.reclaim')}
        </button>
      </div>

      {backup.isError && (
        <p className="field-error maintenance-backup-error">{t('settings.maintenance.backupFailed')}</p>
      )}
      {backup.isSuccess && (
        <p className="maintenance-backup-result">
          {backup.data.ran
            ? t('settings.maintenance.backupResult', {
              name: backup.data.name, size: toMb(backup.data.bytes, i18n.language),
            })
            : t(BACKUP_DECLINE_KEY[backup.data.reason])}
        </p>
      )}

      {reclaim.isError && (
        <p className="field-error maintenance-reclaim-error">{t('settings.maintenance.reclaimFailed')}</p>
      )}
      {reclaim.isSuccess && (
        <p className="maintenance-reclaim-result">
          {reclaim.data.ran
            ? t(
              // checkpointed: false means the VACUUM committed but the truncate that would
              // actually shrink the file found another connection mid-read and backed off -- see
              // vacuumIfBloated's own comment in packages/core/src/db/vacuum.ts. That is not a
              // failure, but it is not what reclaimedResult says either: the file has not
              // shrunk yet, and telling a household it has is exactly the shape finding 1 on
              // this branch was blocked for.
              reclaim.data.checkpointed
                ? 'settings.maintenance.reclaimedResult'
                : 'settings.maintenance.reclaimedPendingResult',
              { mb: toMb(reclaim.data.reclaimedBytes, i18n.language) },
            )
            : t(RECLAIM_DECLINE_KEY[reclaim.data.reason])}
        </p>
      )}
    </div>
  )
}
