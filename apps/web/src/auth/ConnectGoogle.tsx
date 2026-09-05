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
 * reads the session directly rather than taking props, so it drops into the Dashboard and Settings
 * alike with nothing threaded through either page.
 *
 * Renders nothing once connected: the session's own comment on `connected` covers a revoked
 * credentials row the same as a person who never connected, one boolean for both, so there is
 * nothing else this component needs to check.
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

  return (
    <Card span={12} label={t('connect.title')}>
      <p className="connect-detail">{t('connect.detail')}</p>
      {mismatch && (
        <p className="form-error">{t('connect.wrongAddress', { baseUrl: session.data.baseUrl })}</p>
      )}
      <a href="/oauth/start" className="button button-primary connect-action">{t('connect.action')}</a>
    </Card>
  )
}
