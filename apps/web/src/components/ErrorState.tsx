import { useTranslation } from '../i18n/index.js'

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
 */
export function ErrorState({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="empty">
      {t('errorState.title')}<br /><small>{t('errorState.detail')}</small>
      <div className="form-actions">
        <button type="button" className="button" onClick={onRetry}>{t('errorState.retry')}</button>
      </div>
    </div>
  )
}
