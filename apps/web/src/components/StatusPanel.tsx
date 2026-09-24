import { useTranslation } from '../i18n/index.js'
import { Icon } from './icons.js'
import { Link } from '../router.js'
import { formatSince } from '../format.js'
import { addDays } from '../controls/range.js'
import type { StatusPanel as StatusPanelData, StatusConnection } from '../data/useStatusPanel.js'

/**
 * What the sync button's last press, or the last run this panel watched, came to. Decided by
 * StatusControl, which is mounted for the whole session and so is the one that can know a run
 * started and ended - this component exists only while the panel is open.
 */
export type SyncOutcome = 'failed' | 'nothingNew' | 'newData' | 'cooldown' | 'alreadyRunning' | 'didNotStart'

/**
 * The panel's content, shared by the desktop popover and the phone sheet so the two cannot come
 * to say different things about the same household.
 *
 * Everything it shows is already decided on the server (composeStatus in
 * packages/core/src/api/statusPanel.ts): which devices are visible, which count as stale, which
 * connection has a problem. This only spells those answers out. The one judgement made here is
 * how to say a date, because that is a question about the reader's language rather than the data.
 */
export function StatusPanel({ status, today, syncPending, outcome, onSync }: {
  status: StatusPanelData
  /** The person's own local date, for "today" and "yesterday" on the device rows. */
  today: string
  syncPending: boolean
  outcome: SyncOutcome | null
  onSync: () => void
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const nowMs = Date.now()

  if (status.connections.length === 0) {
    return (
      <>
        <p className="status-result">{t('status.empty')}</p>
        <Foot hiddenDevices={status.hiddenDevices} />
      </>
    )
  }

  return (
    <>
      {status.connections.map((connection) => (
        <section key={connection.kind} className="status-connection" aria-label={t(`status.connection.${connection.kind}`)}>
          <div className="status-connection-head">
            <span className="status-connection-name">{t(`status.connection.${connection.kind}`)}</span>
            <span className="status-connection-when">{deliveredLabel(connection, nowMs, language, t)}</span>
            {/* Only on Google, and only while the server says there is something to sync by hand:
                sync is null for a revoked or unreadable connection, where a press would start a run
                with no credentials to run on. The phone uploads on its own schedule and nothing here
                can make it hurry. */}
            {connection.kind === 'google' && status.sync !== null && (
              <SyncButton sync={status.sync} pending={syncPending} onSync={onSync} />
            )}
          </div>
          {connection.problem !== null && <p className="status-problem">{t(`status.problem.${connection.problem}`)}</p>}
          {connection.kind === 'google' && outcome !== null && (
            <p className="status-result" role="status">{t(`status.sync.${outcome}`)}</p>
          )}
          {connection.devices.length > 0 && (
            <ul className="status-devices">
              {connection.devices.map((device) => {
                const day = device.lastReportedDate === null
                  ? t('status.delivered.never')
                  : t('status.lastDay', { day: dayLabel(device.lastReportedDate, today, language) })
                return (
                  <li key={device.sourceId} className="status-device" data-stale={device.stale ? 'true' : undefined}>
                    <span>{device.name}</span>
                    {/* A stale device says so in place of its date, with the date kept on the
                        title: "gone quiet" is the fact that needs reading at a glance, and the
                        day it went quiet is the detail a reader hovers for. */}
                    <span title={device.stale ? day : undefined}>{device.stale ? t('status.stale') : day}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      ))}
      <Foot hiddenDevices={status.hiddenDevices} />
    </>
  )
}

function Foot({ hiddenDevices }: { hiddenDevices: number }) {
  const { t } = useTranslation()
  return (
    <div className="status-foot">
      {/* The source list on the account page is where each device's "Show in status panel" switch
          lives; the anchor lands on that card rather than at the top of a long page. */}
      <Link to="/account#sources">{t('status.choose')}</Link>
      {hiddenDevices > 0 && <span>{t('status.hidden', { count: hiddenDevices })}</span>}
    </div>
  )
}

function SyncButton({ sync, pending, onSync }: {
  sync: NonNullable<StatusPanelData['sync']>
  pending: boolean
  onSync: () => void
}) {
  const { t } = useTranslation()
  // Three disabled states, each for its own reason. Running: the server would answer 409. Pending:
  // the press is in flight and a second would race it. Cooldown: the server refuses a run inside a
  // minute of the last one (429), and "Synced just now" is the true thing to say about that minute
  // - a live button that is certain to be refused is a control that lies.
  const coolingDown = !sync.running && sync.cooldownRemainingMs > 0
  const label = sync.running ? t('status.sync.running') : coolingDown ? t('status.sync.cooldown') : t('status.sync.run')
  return (
    <button type="button" className="button status-sync" data-running={sync.running ? 'true' : undefined}
      disabled={sync.running || pending || coolingDown} onClick={onSync}>
      {sync.running && <Icon name="sync" />}{label}
    </button>
  )
}

type Translate = ReturnType<typeof useTranslation>['t']

/**
 * "synced 7 minutes ago", "uploaded 55 minutes ago". formatSince is the members list's own
 * relative formatter, reused rather than rewritten: it already picks minutes, hours or days by
 * magnitude in the reader's language and clamps a skewed clock to zero. Days rather than a date
 * past a day, on purpose: a connection that went quiet a week ago reads more plainly as "6 days
 * ago" than as a date the reader has to subtract from today.
 */
function deliveredLabel(connection: StatusConnection, nowMs: number, language: string, t: Translate): string {
  if (connection.lastDeliveryAtMs === null) return t('status.delivered.never')
  const when = formatSince(connection.lastDeliveryAtMs, nowMs, language)
  return connection.kind === 'google' ? t('status.delivered.google', { when }) : t('status.delivered.phone', { when })
}

/**
 * A device's last day, said the way a person would: today, yesterday, a weekday within the last
 * week, and a short date beyond that, where a weekday would be ambiguous. Intl for all four, so
 * the words are the language's own ("vandaag", "gisteren") and no catalogue has to carry them.
 * Local dates are anchored at UTC midnight and read back in UTC, the convention formatLocalDate
 * uses, so the answer never depends on the browser's own zone.
 */
export function dayLabel(date: string, today: string, language: string): string {
  if (date === today || date === addDays(today, -1)) {
    return new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(date === today ? 0 : -1, 'day')
  }
  const anchored = new Date(`${date}T00:00:00Z`)
  if (date < today && date >= addDays(today, -6)) {
    return anchored.toLocaleString(language, { weekday: 'long', timeZone: 'UTC' })
  }
  // The year only when it is not this one: "Aug 1" is unambiguous in September, but a scale last
  // heard from in December of last year would otherwise read as a date three months ahead.
  const otherYear = date.slice(0, 4) !== today.slice(0, 4)
  return anchored.toLocaleString(language, {
    day: 'numeric', month: 'short', timeZone: 'UTC', ...(otherYear ? { year: 'numeric' } : {}),
  })
}
