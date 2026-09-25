import { useTranslation } from '../i18n/index.js'
import { Icon } from './icons.js'
import { Link } from '../router.js'
import { formatShortDate, formatSince } from '../format.js'
import { sourceLabel } from '../data/useSourceNames.js'
import { addDays } from '../controls/range.js'
import { dataTypeForMetric } from '@haelan/core/metric-data-type'
import { dataTypeName } from '../data/dataTypeName.js'
import type { StatusPanel as StatusPanelData, StatusConnection, StatusFailure } from '../data/useStatusPanel.js'

/**
 * What the sync button's last press, or the last run this panel watched, came to. Decided by
 * StatusControl, which is mounted for the whole session and so is the one that can know a run
 * started and ended - this component exists only while the panel is open.
 *
 * No 'cooldown': a press refused with 429 is said by the sync button itself ("Synced just now",
 * disabled), and a result line repeating it printed the same words twice. See StatusControl.
 */
export type SyncOutcome = 'failed' | 'nothingNew' | 'newData' | 'alreadyRunning' | 'didNotStart'

/**
 * The panel's content, shared by the desktop popover and the phone sheet so the two cannot come
 * to say different things about the same household.
 *
 * Everything it shows is already decided on the server (composeStatus in
 * packages/core/src/api/statusPanel.ts): which devices are visible, which count as stale, which
 * connection has a problem, and what a quiet device routinely sent. This only spells those answers
 * out. The judgements made here are how to say a date and what to call a metric, because both are
 * questions about the reader's language rather than the data.
 *
 * It is also the only place a quiet source is announced. The range pages used to say it on every
 * card the source fed, and again under their control row; the same fact said a dozen times a page
 * read as a dozen problems, so it is said here, once, beside the name it belongs to.
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
          {connection.problem === 'sync_failed' && (connection.failures ?? []).length > 0
            ? <SyncFailures failures={connection.failures!} />
            : connection.problem !== null && <p className="status-problem">{t(`status.problem.${connection.problem}`)}</p>}
          {connection.kind === 'google' && outcome !== null && (
            <p className="status-result" role="status">{t(`status.sync.${outcome}`)}</p>
          )}
          {connection.devices.length > 0 && (
            <ul className="status-devices">
              {connection.devices.map((device) => {
                const label = device.lastReportedDate === null ? null : dayLabel(device.lastReportedDate, today, language)
                const day = label === null ? t('status.delivered.never') : t('status.lastDay', { day: label })
                const name = sourceLabel(device, t, language, today)
                return (
                  <li key={device.sourceId} className="status-device" data-stale={device.stale ? 'true' : undefined}>
                    {/* One line, cut with an ellipsis, the whole name on the title. A Health Connect
                        package name with its hash suffix ("com.android.healthconnect.phone." and
                        thirty hex digits) is one unbroken word far wider than the panel; left to
                        itself it widened the row past the popover, which then scrolled sideways
                        and cut the left edge off every row in it. Truncated rather than wrapped,
                        the owner's call: a line per device keeps the list scannable, and the title
                        still carries the rest to anyone who hovers. The day beside it never shrinks
                        or wraps (app.css), so the dates stay in one column whatever the names do.
                        Row and title both say sourceLabel's name, so a known app reads in the
                        reader's language in either place. */}
                    <span className="status-device-name" title={name}>{name}</span>
                    {/* A stale device says so in place of its date, and says since when in the same
                        breath: "gone quiet since 21 Aug". The date used to live only on a hover
                        title, but now that the cards no longer warn, this row is the only place a
                        reader learns how long a device has been silent, and a title never reaches
                        a phone. dayLabel is the same formatter the other rows use; a stale device
                        is at least two weeks quiet, so it always lands on the short date, with the
                        year only when it is not this one. The server never calls a source stale
                        without a last date, and the null arm is only there because the type
                        allows it. */}
                    <span className="status-device-day">{device.stale && label !== null ? t('status.stale', { day: label }) : day}</span>
                    {/* What stopped arriving, under the row it belongs to. This is the one place a
                        quiet source is announced now - the cards' triangles and the control row's
                        "stopped in this range" line are gone - so it has to carry what those told
                        the reader: which of their charts the silence reaches. */}
                    {device.stale && <QuietMetrics metrics={device.metrics} />}
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

function QuietMetrics({ metrics }: { metrics: readonly string[] }) {
  const { t, i18n } = useTranslation()
  const text = metricNames(metrics, t, i18n.language)
  return text === null ? null : <span className="status-device-metrics">{text}</span>
}

/**
 * What the last sync failed on: "2 data types failed in the last sync:", then each type by its
 * readable name, a plain reason where one can be given, and the stored message under Details.
 *
 * Takes the place of "Part of the last sync failed." rather than sitting under it, because the
 * count says the same thing and more; that sentence is still what a connection with an absent or
 * empty list says (StatusPanel above), which is what a demo capture older than the field sends.
 *
 * Named through dataTypeName, which falls back to the raw id - the right call here, unlike
 * metricNames below, which drops an unnamed metric: a failing type the catalogue has not named yet
 * is still failing, and leaving it off would make the list shorter than the count above it.
 */
function SyncFailures({ failures }: { failures: readonly StatusFailure[] }) {
  const { t } = useTranslation()
  return (
    <>
      <p className="status-problem">{t('status.failures.heading', { count: failures.length })}</p>
      <ul className="status-failures">
        {failures.map((failure) => {
          const kind = failureKind(failure.lastError)
          return (
            <li key={failure.dataType} className="status-failure">
              <span className="status-failure-name">{dataTypeName(t, failure.dataType)}</span>
              {kind !== null && <span className="status-failure-reason">{t(`status.failures.reason.${kind}`)}</span>}
              {failure.lastError !== null && (
                <details className="status-failure-details">
                  <summary>{t('status.failures.details')}</summary>
                  <code className="status-failure-raw">{truncateRaw(failure.lastError)}</code>
                </details>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}

/**
 * The error kinds a stored message can be read as, with a reason in the catalogues for each: every
 * kind packages/core/src/errors.ts defines. A message carries its kind as a leading `[kind] ` tag
 * because recordFailure stores a HaelanError's `message`, and the HaelanError constructor writes
 * the tag there; runJob's `classify` turns anything else into a TransientError first, so nearly
 * every failure sync_state holds is tagged. The one path that stores an untagged message is the
 * runner's backfill catch for the unexpected, and that is exactly the case with no honest summary.
 *
 * The tag is the only thing read. The detail after it is free text from Google or from our own
 * code - "token refresh failed 400: ...", an HTTP body - and matching words in it would be the
 * message-text matching errors.ts's own header warns against: it eventually reads a schema change
 * as a rate limit. So the reasons are said at the level the kind is certain of, and the rest stays
 * in Details, raw.
 */
const FAILURE_KINDS = ['auth', 'transient', 'schema_drift', 'data_quality', 'config'] as const
type FailureKind = typeof FAILURE_KINDS[number]

export function failureKind(message: string | null): FailureKind | null {
  const tag = message?.match(/^\[([a-z_]+)\] /)?.[1]
  return (FAILURE_KINDS as readonly string[]).includes(tag ?? '') ? tag as FailureKind : null
}

/**
 * The stored message, cut to a length that reads in a 20rem panel. recordFailure already keeps up
 * to 500 characters, and most of that is an HTTP body's JSON; the first 200 hold the tag, the
 * status and the start of the body, which is what anyone reading it to diagnose a failure needs.
 */
const RAW_MAX = 200
function truncateRaw(message: string): string {
  return message.length > RAW_MAX ? `${message.slice(0, RAW_MAX)}…` : message
}

/**
 * A quiet device's routine metrics as a reader would say them: "Heart rate (continuous), sleep,
 * steps". Null when none of them has a name, so the row prints nothing rather than an empty line.
 *
 * Named through the data type each metric comes from (`dataTypeForMetric`, then the catalogue's
 * `dataTypes.<id>` labels that the sync picker already shows), because that is the one set of
 * names this app keeps for everything a device can send. It also folds a family into one word:
 * a watch's eleven sleep metrics are one data type, so the list says "sleep" once instead of
 * spelling out stage minutes nobody thinks of as separate things a watch stopped doing.
 *
 * Not dataTypeName.ts: that falls back to the raw id, which is right on a picker listing every
 * type, and wrong here, where a catalogue key nobody has named yet is a string of snake case in
 * the middle of a sentence. An unnamed metric is left out instead.
 *
 * Sorted by name in the reader's language, and every name after the first lowered at its first
 * letter so the list reads as one phrase - except a name whose second letter is not lowercase
 * ("VO2 max", "ECG"), which is an abbreviation and keeps its capital. Joined with Intl's unit
 * list, which in English and Dutch alike is plain commas: "and" would make a list of what stopped
 * read like a sentence missing its verb.
 */
export function metricNames(metrics: readonly string[], t: Translate, language: string): string | null {
  const names = new Set<string>()
  for (const metric of metrics) {
    const type = dataTypeForMetric(metric)
    if (type === null) continue
    const key = `dataTypes.${type}`
    const name = t(key)
    if (name !== key) names.add(name)
  }
  if (names.size === 0) return null
  const phrased = [...names]
    .sort((a, b) => a.localeCompare(b, language))
    .map((name, i) => (i === 0 || !/^.\p{Ll}/u.test(name) ? name : name.charAt(0).toLocaleLowerCase(language) + name.slice(1)))
  return new Intl.ListFormat(language, { type: 'unit', style: 'short' }).format(phrased)
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
  // The year only when it is not this one - formatShortDate's rule, shared with sourceLabel.
  return formatShortDate(date, today, language)
}
