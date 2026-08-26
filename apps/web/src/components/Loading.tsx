import { useTranslation } from '../i18n/index.js'

/**
 * What a card shows while its request is still in flight.
 *
 * A placeholder rather than a computed value, because the alternative is what this page used to
 * do: run the card's own formatter over an empty array and print "0" steps, "0 bpm" resting heart
 * rate and "0h 00m" sleep before anything had been asked, let alone answered. A pending claim is
 * the same defect as an unsupported one, and half this page already treated it that way.
 */
export function Loading() {
  const { t } = useTranslation()
  return <p className="empty">{t('common.loading')}</p>
}
