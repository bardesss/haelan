import { useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslation } from '../i18n/index.js'
import { BrandMark } from '../components/BrandMark.js'
import { submitSignIn } from './signInRequest.js'

export function SignIn({ onSignedIn, expired = false }: { onSignedIn: () => void, expired?: boolean }) {
  const { t } = useTranslation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [errorKey, setErrorKey] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setErrorKey(null)
    const result = await submitSignIn({ username, password })
    setBusy(false)
    if (result.ok) onSignedIn()
    else setErrorKey(result.messageKey)
  }

  return (
    <main className="signin">
      <form className="card" onSubmit={(e) => void submit(e)}>
        <BrandMark />
        <h1>{t('signIn.title')}</h1>

        {expired && <p className="form-error" role="alert">{t('shell.sessionExpired')}</p>}

        <label className="field">
          <span className="label">{t('signIn.username')}</span>
          <input className="input" autoComplete="username" value={username}
            onChange={(e) => setUsername(e.target.value)} />
        </label>

        <label className="field">
          <span className="label">{t('signIn.password')}</span>
          <input className="input" type="password" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>

        {errorKey === null ? null : <p className="form-error" role="alert">{t(errorKey)}</p>}

        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? t('signIn.working') : t('signIn.submit')}
          </button>
        </div>
      </form>
    </main>
  )
}
