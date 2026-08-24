import { useState } from 'react'
import type { FormEvent } from 'react'
import { useTranslation } from '../i18n/index.js'
import { submitSignIn } from './signIn.js'

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
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
        <h1>{t('signIn.title')}</h1>

        <label htmlFor="username">{t('signIn.username')}</label>
        <input id="username" name="username" autoComplete="username" value={username}
               onChange={(e) => setUsername(e.target.value)} />

        <label htmlFor="password">{t('signIn.password')}</label>
        <input id="password" name="password" type="password" autoComplete="current-password"
               value={password} onChange={(e) => setPassword(e.target.value)} />

        {errorKey === null ? null : <p className="form-error" role="alert">{t(errorKey)}</p>}

        <button className="button-primary" type="submit" disabled={busy}>
          {busy ? t('signIn.working') : t('signIn.submit')}
        </button>
      </form>
    </main>
  )
}
