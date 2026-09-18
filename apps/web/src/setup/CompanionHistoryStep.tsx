import { useTranslation } from '../i18n/index.js'
import { useSession } from '../auth/session.js'
import { useHistoryStart } from '../data/useHistoryStart.js'
import { historyStartLocalDate } from '../controls/range.js'

/**
 * Where the backfill step would be on a phone path: there is no horizon
 * to walk, so there is no horizon to pick. What stands here instead is the
 * history start date, a fact rather than a choice: null until the phone first sends, the day
 * it started on afterwards. It deliberately promises no pairing screen: the copy names
 * the app's own Sync button, the same sentence already used for this path.
 */
export function CompanionHistoryStep() {
  const { t } = useTranslation()
  const session = useSession()
  const history = useHistoryStart()
  const timezone = session.data?.timezone
  const startMs = history.data?.historyStartMs ?? null
  const date = startMs !== null && timezone !== undefined
    ? historyStartLocalDate(startMs, timezone)
    : null
  // Pending, or a start with no zone to read it in yet: the date sentence cannot
  // be honestly rendered either way, so the loading line stands in for both.
  const loading = history.isPending || (startMs !== null && date === null)

  return (
    <section className="setup-step">
      <h1>{t('setup.companionHistory.title')}</h1>
      {loading
        ? <p className="empty">{t('setup.app.loadingProgress')}</p>
        : date !== null
          ? <p>{t('setup.companionHistory.startedOn', { date })}</p>
          : <p>{t('setup.companionHistory.intro')}</p>}
      {/* Information, not a dead end: whoever already synced on another screen
          still needs a way on to the dashboard from here. A plain anchor, because
          leaving the wizard is navigation rather than a step the server owns. */}
      <div className="form-actions">
        <a href="/" className="button button-primary">{t('setup.companionHistory.toDashboard')}</a>
      </div>
    </section>
  )
}
