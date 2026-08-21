import { useState } from 'react'
import { putInstanceUrl } from './api.js'

// The three ways a browser reaches this instance, from probe/findings/console-steps.md. A LAN
// IP is deliberately not among them, and the note below says so rather than letting somebody
// discover it from a console error.
const PATHS = [
  {
    id: 'localhost',
    title: 'This machine',
    detail: 'You open haelan in a browser on the machine it runs on. Google exempts loopback from its HTTPS rule, so this works with no certificate.',
  },
  {
    id: 'tailscale',
    title: 'Tailscale',
    detail: 'Your tailnet name, which is a real hostname with a real certificate. Reachable from your phone without exposing anything to the internet.',
  },
  {
    id: 'proxy',
    title: 'Reverse proxy',
    detail: 'A hostname you own, terminating HTTPS in front of haelan. You already have the certificate.',
  },
] as const

const originOr = (fallback: string) =>
  typeof window === 'undefined' ? fallback : window.location.origin

export function InstanceUrlStep({ onDone }: { onDone: () => void }) {
  const [baseUrl, setBaseUrl] = useState(originOr('http://localhost:4235'))
  const [consentPath, setConsentPath] = useState<string>('localhost')
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <section className="setup-step">
      <h1>How you reach this instance</h1>
      <p>
        Google has to be told the exact address it sends you back to after you grant consent,
        and it has to match what your browser actually used. Pick how you reach haelan.
      </p>

      {failure && <p className="form-error" role="alert">{failure}</p>}

      <form
        onSubmit={(event) => {
          event.preventDefault()
          setBusy(true)
          setFailure(null)
          putInstanceUrl({ baseUrl, consentPath })
            .then(onDone)
            .catch((cause: unknown) => {
              setFailure(cause instanceof Error ? cause.message : 'that did not work')
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
              <span className="choice-title">{path.title}</span>
              <span className="choice-detail">{path.detail}</span>
            </span>
          </label>
        ))}

        <label className="field">
          <span className="label">Address</span>
          <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <span className="field-hint">
            Google refuses a raw IP address as a redirect target, so a LAN address like the one
            your router hands out is not an option here, whatever it says in your browser bar.
            Loopback and real hostnames are.
          </span>
        </label>

        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Saving' : 'Continue'}
          </button>
        </div>
      </form>
    </section>
  )
}
