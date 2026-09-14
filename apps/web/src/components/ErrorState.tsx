import { useTranslation } from '../i18n/index.js'
import { ApiError } from '../api/apiError.js'

/**
 * What a card shows when its request failed, which is not the same thing as having no data.
 *
 * An errored query has isPending false and data undefined, so without this every card fell
 * through to the empty state and told the reader "No data yet. Nothing has been recorded for this
 * period." over a 500, a bad source parameter or a dropped connection. The read stack's own doc
 * comment names that outcome: a route that quietly returns nothing "becomes an agent saying there
 * is no data for that period, which is a false statement about somebody's health record made with
 * total confidence". The retry is part of the fix rather than a courtesy: a card that cannot say
 * what went wrong must at least let the reader ask again.
 *
 * `error` is optional and, on a real instance, never carries a `not_found` kind here: every caller
 * of this component gates a range or list read (a series, a night list, a sources list, a session's
 * own status query), and none of those routes ever answer 404 - a person, override, session or
 * source id can be missing, but a list cannot (apps/server/src/routes/v1/tier2.ts's /sleep/nights
 * answers an empty `items` for a range nothing covers, never a 404, and the same is true of every
 * other list route this component's callers read). The one place that kind is actually reachable
 * is the demo build: apps/web/src/demo/client.ts throws exactly `not_found` for a url the recorder
 * never captured, which is a fact about the demo's own coverage, not a server failure, and telling
 * the reader "this did not load" over it would be false in the specific way the review that added
 * this branch called out - there is no instance and nothing failed. The branch below is therefore
 * dead code on a real instance and live only in the demo.
 */
export function ErrorState({ onRetry, error }: { onRetry: () => void, error?: unknown }) {
  const { t } = useTranslation()
  if (error instanceof ApiError && error.kind === 'not_found') {
    return (
      <div className="empty">
        {t('errorState.notCapturedTitle')}<br /><small>{t('errorState.notCapturedDetail')}</small>
      </div>
    )
  }
  return (
    <div className="empty">
      {t('errorState.title')}<br /><small>{t('errorState.detail')}</small>
      <div className="form-actions">
        <button type="button" className="button" onClick={onRetry}>{t('errorState.retry')}</button>
      </div>
    </div>
  )
}
