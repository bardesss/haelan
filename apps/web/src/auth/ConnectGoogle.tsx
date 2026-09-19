import { useTranslation } from '../i18n/index.js'
import { Card } from '../components/Card.js'
import { useSession } from './session.js'

/**
 * True when the browser cannot receive Google's redirect back to this instance.
 *
 * Origins, not raw strings: a stored base URL carrying a trailing slash or a path would compare
 * unequal to window.location.origin as a string while still redirecting to the same place consent
 * actually needs, which would warn on an instance where the flow works. An address that fails to
 * parse at all is treated as a mismatch rather than ignored, because it cannot receive a redirect
 * either, and that failure mode is exactly the one this warning exists to catch before consent
 * starts rather than after Google has already recorded a grant against it.
 */
function addressMismatch(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).origin !== window.location.origin
  } catch {
    return true
  }
}

/**
 * The control that closes the gap the whole milestone exists for: `/oauth/start` used to be
 * reachable from exactly one place in this app, the setup wizard, so an invited member who signs
 * in afterward - or anyone whose refresh token gets revoked later - had no way back to it. This
 * reads the session directly rather than taking props, so it drops into Settings with nothing
 * threaded through the page. It stays out of the Dashboard on purpose: a phone-only member
 * would read "connect your Google account" there seconds after choosing not to.
 *
 * Renders nothing once connected, but "not connected" is not one state to explain - it is two.
 * A revoked credential was refused by Google: the row on file is no good to anyone, and the
 * generic invitation is the whole truth. An unreadable credential is different - the row is
 * intact and Google never refused it, but instance.key cannot open it, the shape a database
 * restore leaves behind when the key file did not travel with it. Nothing was lost there except
 * the ability to read what is already stored, and a person in that state deserves to be told
 * that, not handed the same "nothing appears here until you connect" line as someone who has
 * never touched this instance. Only `credentialsUnreadable` distinguishes the two; `connected`
 * alone cannot, which is why this component now checks it before picking which detail to show.
 *
 * The link renders even when the address looks wrong. A blocked control teaches a reader nothing;
 * the address on screen right now may not be the one they are about to open this same page from.
 */
export function ConnectGoogle() {
  const { t } = useTranslation()
  const session = useSession()

  // Undefined while the session is still loading: nothing to decide yet, so nothing is drawn
  // rather than assuming either state and flashing the other once the query settles.
  if (session.data === undefined || session.data.connected) return null

  const mismatch = addressMismatch(session.data.baseUrl)
  const detail = session.data.credentialsUnreadable ? t('connect.restoreDetail') : t('connect.detail')

  return (
    <Card span={12} label={t('connect.title')}>
      <p className="connect-detail">{detail}</p>
      {mismatch && (
        <p className="connect-warning">{t('connect.wrongAddress', { baseUrl: session.data.baseUrl })}</p>
      )}
      <a href="/oauth/start" className="button button-primary connect-action">{t('connect.action')}</a>
    </Card>
  )
}
