import { useState } from 'react'
import { useTranslation } from '../i18n/index.js'
import { CopyField } from './CopyField.js'
import { putGoogleClient } from './api.js'
import type { RedirectCandidate, SetupError } from './api.js'

export function GoogleStep({ candidates, scopes = [], error, onDone }: {
  candidates: RedirectCandidate[]
  scopes?: string[]
  error: SetupError | null
  onDone: () => void
}) {
  const { t } = useTranslation()
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <section className="setup-step">
      <h1>{t('setup.google.title')}</h1>
      <p>{t('setup.google.intro')}</p>

      <ol className="setup-instructions">
        <li>{t('setup.google.step1')}</li>
        <li>{t('setup.google.step2')}</li>
        <li>
          {t('setup.google.step3', { count: scopes.length })}
          <ul className="setup-scopes">
            {scopes.map((scope) => (
              <li key={scope}><code className="copy-value">{scope}</code></li>
            ))}
          </ul>
          {scopes.length > 0 && <CopyField label={t('setup.google.allScopesLabel')} value={scopes.join('\n')} />}
        </li>
        <li>
          {t('setup.google.publishingIntro')} <strong>{t('setup.google.inProduction')}</strong>. {t('setup.google.publishingWarning')}
        </li>
        <li>{t('setup.google.step5')}</li>
        <li>{t('setup.google.step6')}</li>
      </ol>

      <div className="setup-uris">
        {candidates.map((candidate) => (
          <div key={candidate.uri || candidate.label} data-registrable={String(candidate.registrable)}>
            {candidate.registrable
              ? <CopyField label={candidate.label} value={candidate.uri} />
              : (
                <p className="setup-rejected">
                  <code>{candidate.uri === '' ? candidate.label : candidate.uri}</code>
                  {' '}{t('setup.google.cannotBeRegistered')} {candidate.reason}
                </p>
              )}
          </div>
        ))}
      </div>

      <p className="setup-note">{t('setup.google.unverifiedNote')}</p>

      {error && <p className="form-error" role="alert">{error.message}</p>}
      {failure && <p className="form-error" role="alert">{failure}</p>}

      <form
        onSubmit={(event) => {
          event.preventDefault()
          setBusy(true)
          setFailure(null)
          putGoogleClient({ clientId, clientSecret })
            .then(onDone)
            .catch((cause: unknown) => {
              setFailure(cause instanceof Error ? cause.message : t('setup.genericError'))
              setBusy(false)
            })
        }}
      >
        <label className="field">
          <span className="label">{t('setup.google.clientIdLabel')}</span>
          <input className="input" value={clientId} autoComplete="off"
            onChange={(e) => setClientId(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">{t('setup.google.clientSecretLabel')}</span>
          <input className="input" type="password" value={clientSecret} autoComplete="off"
            onChange={(e) => setClientSecret(e.target.value)} />
        </label>

        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? t('setup.google.saving') : t('setup.google.submit')}
          </button>
        </div>
      </form>
    </section>
  )
}
