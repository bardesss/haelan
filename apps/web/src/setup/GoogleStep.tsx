import { useState } from 'react'
import { CopyField } from './CopyField.js'
import { putGoogleClient } from './api.js'
import type { RedirectCandidate, SetupError } from './api.js'

export function GoogleStep({ candidates, scopes = [], error, onDone }: {
  candidates: RedirectCandidate[]
  scopes?: string[]
  error: SetupError | null
  onDone: () => void
}) {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <section className="setup-step">
      <h1>Connect Google</h1>
      <p>
        This is the one step nobody can automate. Google exposes no API for creating an OAuth
        client, so you create one once, in the console, and paste it back here.
      </p>

      <ol className="setup-instructions">
        <li>Open console.cloud.google.com and create a project, or pick an existing one.</li>
        <li>Under APIs and services, enable the Google Health API.</li>
        <li>
          Configure the OAuth consent screen and declare the {scopes.length} scopes listed
          below, even the data types you do not want today: declaring is once, granting is per
          person, and a scope you skip now means a second visit later. The console sorts them
          into sensitive and restricted groups by itself, which is expected.
          <ul className="setup-scopes">
            {scopes.map((scope) => (
              <li key={scope}><code className="copy-value">{scope}</code></li>
            ))}
          </ul>
          {scopes.length > 0 && <CopyField label="All of them" value={scopes.join('\n')} />}
        </li>
        <li>
          Set publishing status to <strong>In production</strong>. Leaving it in Testing gives
          every refresh token a seven day life, and the household&apos;s sync stops a week after
          setup with no obvious cause.
        </li>
        <li>
          Create an OAuth client of type Web application, and register every redirect URI below
          in one pass. An unused URI costs nothing. A missing one costs a return trip.
        </li>
        <li>Copy the client ID and secret into the fields underneath.</li>
      </ol>

      <div className="setup-uris">
        {candidates.map((candidate) => (
          <div key={candidate.uri || candidate.label} data-registrable={String(candidate.registrable)}>
            {candidate.registrable
              ? <CopyField label={candidate.label} value={candidate.uri} />
              : (
                <p className="setup-rejected">
                  <code>{candidate.uri === '' ? candidate.label : candidate.uri}</code>
                  {' '}cannot be registered. {candidate.reason}
                </p>
              )}
          </div>
        ))}
      </div>

      <p className="setup-note">
        Your client is unverified, and it will stay that way. Every person granting consent sees
        an unverified app warning, which is expected here and is not a sign anything is wrong:
        verification exists to lift a hundred user cap that a household instance never reaches.
      </p>

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
              setFailure(cause instanceof Error ? cause.message : 'that did not work')
              setBusy(false)
            })
        }}
      >
        <label className="field">
          <span className="label">Client ID</span>
          <input className="input" value={clientId} autoComplete="off"
            onChange={(e) => setClientId(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">Client secret</span>
          <input className="input" type="password" value={clientSecret} autoComplete="off"
            onChange={(e) => setClientSecret(e.target.value)} />
        </label>

        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Saving' : 'Save and grant consent'}
          </button>
        </div>
      </form>
    </section>
  )
}
