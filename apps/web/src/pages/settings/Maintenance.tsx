import { useState } from 'react'
import type { FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from '../../i18n/index.js'
import { useSession } from '../../auth/session.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import { formatNumber } from '../../format.js'
import {
  maintenanceKey, useBackupNow, useMaintenanceStatus, useReclaimSpace, useSaveBackupPolicy,
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
 * backups_disabled is the one specific to this button: retention set to 0 on the form below,
 * which is how a household turns backups off.
 */
const BACKUP_DECLINE_KEY: Record<BackupDeclineReason, string> = {
  backups_disabled: 'settings.maintenance.declined.backupsDisabled',
  not_enough_disk: 'settings.maintenance.declined.notEnoughDisk',
  rebuild_in_progress: 'settings.maintenance.declined.rebuildInProgress',
}

/**
 * What the database file is costing, and the two levers a household has over it: a backup taken
 * on demand rather than waiting for the nightly one, and a vacuum run outside the once-per-boot
 * schedule, plus the schedule itself: how many copies to keep and how long to leave between
 * them, which were HAELAN_BACKUP_KEEP and HAELAN_BACKUP_INTERVAL_HOURS until they became settings
 * a household can change without restarting the container. Reads as SourceNames.tsx's sibling:
 * one query for the figures, one mutation per button, and the last mutation's own result rendered
 * inline once it resolves rather than folded into a toast that would be gone before a reader who
 * left the tab in the background ever saw it.
 *
 * Admin only, mounted the same way Members.tsx is: Settings.tsx's own guard on
 * session.data?.isAdmin, which is also who the four routes this file calls accept -- everyone
 * else already gets 'forbidden' from the server regardless of what renders here.
 */
export function Maintenance() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const session = useSession()
  const status = useMaintenanceStatus()
  const backup = useBackupNow()
  const reclaim = useReclaimSpace()
  const savePolicy = useSaveBackupPolicy()
  // Null until the reader types, so each field follows the server's value through a save and an
  // invalidation without a second effect to push it back. Strings rather than numbers: a number
  // input mid-edit is legitimately empty, and storing that as NaN would make a half-typed field
  // indistinguishable from one the reader has not touched.
  const [keepDraft, setKeepDraft] = useState<string | null>(null)
  const [hoursDraft, setHoursDraft] = useState<string | null>(null)

  if (status.isPending) return <Loading />
  if (status.isError) {
    return (
      <ErrorState onRetry={() => {
        void queryClient.refetchQueries({ queryKey: maintenanceKey(), exact: true })
      }} error={status.error} />
    )
  }

  const { bloat, backups, keep, intervalHours, vacuumBlocked } = status.data
  const latest = backups[0] ?? null
  const keepValue = keepDraft ?? String(keep)
  const hoursValue = hoursDraft ?? String(intervalHours)
  const nextKeep = Number(keepValue)
  const nextHours = Number(hoursValue)
  // Whole numbers only, and the same floors the store enforces. The server is still the authority
  // - it answers the ceilings too, and its message names the bound that was missed - but a button
  // that submits a value this screen can already see is impossible would only spend a round trip
  // to be told so.
  //
  // The emptiness check is not redundant with the rest: Number('') is 0, and 0 is a legitimate
  // retention meaning "turn backups off". Without it, clearing the field and saving would switch
  // this household's backups off without anybody having typed a zero.
  const wholeAtLeast = (raw: string, value: number, floor: number): boolean =>
    raw.trim() !== '' && Number.isInteger(value) && value >= floor
  const policyValid = wholeAtLeast(keepValue, nextKeep, 0) && wholeAtLeast(hoursValue, nextHours, 1)
  const policyChanged = nextKeep !== keep || nextHours !== intervalHours

  const savePolicySubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    savePolicy.mutate({ keep: nextKeep, intervalHours: nextHours }, {
      onSuccess: () => { setKeepDraft(null); setHoursDraft(null) },
    })
  }

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
      {/* A plain link, not a fetch into a Blob: the session rides on a cookie (auth/cookie.ts),
          so the browser authenticates this GET on its own, and the file streams to disk instead
          of being held in memory - which for a household archive is hundreds of megabytes. The
          same shape ControlRow uses for its CSV export. Rendered only when a backup exists,
          since the route answers 404 for a name listBackups does not report. */}
      {latest !== null && (
        <p className="maintenance-download-row">
          <a className="button maintenance-download"
            href={`/api/settings/maintenance/backups/${encodeURIComponent(latest.name)}/download`}
            download>
            {t('settings.maintenance.backups.download')}
          </a>
        </p>
      )}
      {latest !== null && (
        <p className="maintenance-download-note">{t('settings.maintenance.backups.downloadNote')}</p>
      )}
      {/* keep === 0 is the form below set to zero, which is this instance's "turn backups off" --
          backupDecision declines every write this instance would otherwise make, so
          "Keeps the last 0, taken every N hours" described a schedule that does not exist and a
          household had no way to learn backups were off short of pressing the button below and
          reading the decline. */}
      <p className="maintenance-retention">
        {keep === 0
          ? t('settings.maintenance.backups.off')
          : t('settings.maintenance.backups.retention', { keep, hours: intervalHours })}
      </p>

      {/* Both numbers in one form with one button, because the server writes them together on
          purpose: see useSaveBackupPolicy for why half a policy is a policy an environment
          variable left behind in a compose file can still overwrite. */}
      <form className="maintenance-policy" onSubmit={savePolicySubmit}>
        <label className="field">
          <span className="label">{t('settings.maintenance.policy.keepLabel')}</span>
          <input
            className="input" type="number" min={0} step={1} inputMode="numeric"
            value={keepValue} onChange={(e) => setKeepDraft(e.currentTarget.value)}
          />
          <span className="field-hint">{t('settings.maintenance.policy.keepHint')}</span>
        </label>
        <label className="field">
          <span className="label">{t('settings.maintenance.policy.hoursLabel')}</span>
          <input
            className="input" type="number" min={1} step={1} inputMode="numeric"
            value={hoursValue} onChange={(e) => setHoursDraft(e.currentTarget.value)}
          />
          <span className="field-hint">{t('settings.maintenance.policy.hoursHint')}</span>
        </label>
        <div className="form-actions">
          <button
            type="submit" className="button"
            disabled={savePolicy.isPending || !policyValid || !policyChanged}
          >
            {savePolicy.isPending
              ? t('settings.maintenance.policy.saving')
              : t('settings.maintenance.policy.save')}
          </button>
        </div>
        {/* The server's own message, not a sentence of this panel's: a refused number comes back
            naming the bound it missed, and replacing that with "that did not work" would throw
            away the only thing telling the reader what to type instead. */}
        {savePolicy.isError && (
          <p className="field-error maintenance-policy-error" role="alert">
            {t('settings.maintenance.policy.failed', { reason: savePolicy.error.message })}
          </p>
        )}
        {savePolicy.isSuccess && !savePolicy.isPending && (
          <p className="maintenance-policy-result" role="status">
            {t('settings.maintenance.policy.saved')}
          </p>
        )}
      </form>

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
