import { useTranslation } from '../i18n/index.js'
import type { SetupError } from './api.js'

// What a finished instance shows when Google's consent came back refused: the wizard is over, so
// there is no form to fix, only the reason and the way back to the account page.
export function ConsentFailed({ error }: { error: SetupError | null }) {
  const { t } = useTranslation()
  return (
    <section className="setup-step">
      <h1>{t('setup.callback.failedTitle')}</h1>
      {error !== null && <p className="form-error" role="alert">{error.message}</p>}
      <a className="button" href="/account">{t('setup.callback.backToAccount')}</a>
    </section>
  )
}
