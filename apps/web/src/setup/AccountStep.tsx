import { useState } from 'react'
import { useTranslation } from '../i18n/index.js'
import { createAccount } from './api.js'

const LOCAL_ZONE = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

// Offered as a datalist rather than a select: the list is several hundred long and typing
// three letters of your own city beats scrolling to it.
const ZONES = (): string[] => {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
  try {
    return supported ? supported('timeZone') : []
  } catch {
    return []
  }
}

export function AccountStep({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const [displayName, setDisplayName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [timezone, setTimezone] = useState(LOCAL_ZONE())
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <section className="setup-step">
      <h1>{t('setup.account.title')}</h1>
      <p>{t('setup.account.intro')}</p>

      {failure && <p className="form-error" role="alert">{failure}</p>}

      <form
        onSubmit={(event) => {
          event.preventDefault()
          setBusy(true)
          setFailure(null)
          createAccount({ username, password, displayName, timezone })
            .then(onDone)
            .catch((cause: unknown) => {
              setFailure(cause instanceof Error ? cause.message : t('setup.genericError'))
              setBusy(false)
            })
        }}
      >
        <label className="field">
          <span className="label">{t('setup.account.nameLabel')}</span>
          <input className="input" value={displayName} autoComplete="name"
            onChange={(e) => setDisplayName(e.target.value)} />
          <span className="field-hint">{t('setup.account.nameHint')}</span>
        </label>

        <label className="field">
          <span className="label">{t('setup.account.usernameLabel')}</span>
          <input className="input" value={username} autoComplete="username"
            onChange={(e) => setUsername(e.target.value)} />
        </label>

        <label className="field">
          <span className="label">{t('setup.account.passwordLabel')}</span>
          <input className="input" type="password" value={password} autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)} />
          <span className="field-hint">{t('setup.account.passwordHint')}</span>
        </label>

        <label className="field">
          <span className="label">{t('setup.account.timezoneLabel')}</span>
          <input className="input" value={timezone} list="haelan-timezones"
            onChange={(e) => setTimezone(e.target.value)} />
          <datalist id="haelan-timezones">
            {ZONES().map((zone) => <option key={zone} value={zone} />)}
          </datalist>
          <span className="field-hint">{t('setup.account.timezoneHint')}</span>
        </label>

        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? t('setup.account.submitting') : t('setup.account.submit')}
          </button>
        </div>
      </form>
    </section>
  )
}
