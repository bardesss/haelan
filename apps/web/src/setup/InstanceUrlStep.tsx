import { useState } from 'react'
import { useTranslation } from '../i18n/index.js'
import { putInstanceUrl } from './api.js'

// The three ways a browser reaches this instance, from probe/findings/console-steps.md. A LAN
// IP is deliberately not among them, and the note below says so rather than letting somebody
// discover it from a console error.
const PATHS = [
  { id: 'localhost', titleKey: 'setup.instanceUrl.paths.localhost.title', detailKey: 'setup.instanceUrl.paths.localhost.detail' },
  { id: 'tailscale', titleKey: 'setup.instanceUrl.paths.tailscale.title', detailKey: 'setup.instanceUrl.paths.tailscale.detail' },
  { id: 'proxy', titleKey: 'setup.instanceUrl.paths.proxy.title', detailKey: 'setup.instanceUrl.paths.proxy.detail' },
] as const

const originOr = (fallback: string) =>
  typeof window === 'undefined' ? fallback : window.location.origin

export function InstanceUrlStep({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const [baseUrl, setBaseUrl] = useState(originOr('http://localhost:4235'))
  const [consentPath, setConsentPath] = useState<string>('localhost')
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <section className="setup-step">
      <h1>{t('setup.instanceUrl.title')}</h1>
      <p>{t('setup.instanceUrl.intro')}</p>

      {failure && <p className="form-error" role="alert">{failure}</p>}

      <form
        onSubmit={(event) => {
          event.preventDefault()
          setBusy(true)
          setFailure(null)
          putInstanceUrl({ baseUrl, consentPath })
            .then(onDone)
            .catch((cause: unknown) => {
              setFailure(cause instanceof Error ? cause.message : t('setup.genericError'))
              setBusy(false)
            })
        }}
      >
        {PATHS.map((path) => (
          <label className="choice" key={path.id}>
            <input
              type="radio" name="consent-path" value={path.id}
              checked={consentPath === path.id}
              onChange={() => setConsentPath(path.id)}
            />
            <span>
              <span className="choice-title">{t(path.titleKey)}</span>
              <span className="choice-detail">{t(path.detailKey)}</span>
            </span>
          </label>
        ))}

        <label className="field">
          <span className="label">{t('setup.instanceUrl.addressLabel')}</span>
          <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <span className="field-hint">{t('setup.instanceUrl.addressHint')}</span>
        </label>

        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? t('setup.instanceUrl.saving') : t('setup.instanceUrl.submit')}
          </button>
        </div>
      </form>
    </section>
  )
}
