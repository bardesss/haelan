import { useState } from 'react'
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
  const [displayName, setDisplayName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [timezone, setTimezone] = useState(LOCAL_ZONE())
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <section className="setup-step">
      <h1>Create your account</h1>
      <p>
        This is the first account on this instance, and it is the one that owns the Google
        connection. Nothing here leaves the machine haelan is running on.
      </p>

      {failure && <p className="form-error" role="alert">{failure}</p>}

      <form
        onSubmit={(event) => {
          event.preventDefault()
          setBusy(true)
          setFailure(null)
          createAccount({ username, password, displayName, timezone })
            .then(onDone)
            .catch((cause: unknown) => {
              setFailure(cause instanceof Error ? cause.message : 'that did not work')
              setBusy(false)
            })
        }}
      >
        <label className="field">
          <span className="label">Your name</span>
          <input className="input" value={displayName} autoComplete="name"
            onChange={(e) => setDisplayName(e.target.value)} />
          <span className="field-hint">Shown on your own pages. Nobody else sees it.</span>
        </label>

        <label className="field">
          <span className="label">Username</span>
          <input className="input" value={username} autoComplete="username"
            onChange={(e) => setUsername(e.target.value)} />
        </label>

        <label className="field">
          <span className="label">Password</span>
          <input className="input" type="password" value={password} autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)} />
          <span className="field-hint">At least 8 characters. There is no reset link: this instance sends no email.</span>
        </label>

        <label className="field">
          <span className="label">Time zone</span>
          <input className="input" value={timezone} list="haelan-timezones"
            onChange={(e) => setTimezone(e.target.value)} />
          <datalist id="haelan-timezones">
            {ZONES().map((zone) => <option key={zone} value={zone} />)}
          </datalist>
          <span className="field-hint">
            Every day boundary is computed in this zone, so a night that ends at 07:00 belongs to
            the right day. Change it later and the days are recomputed.
          </span>
        </label>

        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Creating' : 'Create account'}
          </button>
        </div>
      </form>
    </section>
  )
}
