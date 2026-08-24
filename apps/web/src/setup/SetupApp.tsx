import { useEffect, useState } from 'react'
import { useTranslation } from '../i18n/index.js'
import { useRoute, navigate } from '../router.js'
import { AccountStep } from './AccountStep.js'
import { InstanceUrlStep } from './InstanceUrlStep.js'
import { GoogleStep } from './GoogleStep.js'
import { BackfillStep } from './BackfillStep.js'
import {
  getLastError, getRedirectUris, getScopes, getSetupState, getSyncStatus, putBackfillHorizon,
} from './api.js'
import type { RedirectCandidate, SetupError, SyncStatus } from './api.js'

const STEPS = [
  { step: 'account', path: '/setup/account', titleKey: 'setup.app.steps.account' },
  { step: 'instance-url', path: '/setup/instance-url', titleKey: 'setup.app.steps.address' },
  { step: 'google-client', path: '/setup/google', titleKey: 'setup.app.steps.google' },
  { step: 'consent', path: '/setup/google', titleKey: 'setup.app.steps.consent' },
] as const

const pathForStep = (step: string) =>
  STEPS.find((entry) => entry.step === step)?.path ?? '/setup/backfill'

function Rail({ current }: { current: string }) {
  const { t } = useTranslation()
  const index = STEPS.findIndex((entry) => entry.step === current)
  return (
    <ol className="setup-rail">
      {STEPS.map((entry, position) => (
        <li
          key={entry.titleKey}
          data-state={position === index ? 'current' : position < index || index === -1 ? 'done' : 'todo'}
        >
          {t(entry.titleKey)}
        </li>
      ))}
    </ol>
  )
}

export function SetupApp() {
  const { t } = useTranslation()
  const route = useRoute()
  const [step, setStep] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<RedirectCandidate[]>([])
  const [scopes, setScopes] = useState<string[]>([])
  const [callbackError, setCallbackError] = useState<SetupError | null>(null)
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [horizonFailure, setHorizonFailure] = useState<string | null>(null)

  // The server owns which step is due, so the browser asks rather than remembers. A reload
  // mid wizard, or a callback that landed on the wrong path, both resolve here.
  const refresh = () => {
    void getSetupState().then(({ step: due }) => {
      setStep(due)
      const target = pathForStep(due)
      if (due !== 'done' && !route.startsWith(target)) navigate(target)
    })
  }
  useEffect(refresh, [])

  const onGoogleRoute = route.startsWith('/setup/google')
  useEffect(() => {
    if (!onGoogleRoute) return
    void getRedirectUris(window.location.hostname).then((r) => setCandidates(r.candidates))
    void getScopes().then((r) => setScopes(r.scopes))
    // The callback redirects here with an error code in the query, and the message that goes
    // with it lives on the server. Fetching it is what puts the console fix on screen.
    if (route.includes('error=')) void getLastError().then(setCallbackError)
  }, [onGoogleRoute, route])

  const onBackfill = route.startsWith('/setup/backfill')
  useEffect(() => {
    if (!onBackfill) return
    void getSyncStatus().then(setStatus)
    // EventSource for live progress, with the status route as the fallback: a proxy that
    // buffers the stream would otherwise leave the page frozen at whatever it first drew.
    const stream = new EventSource('/api/sync/events')
    stream.onmessage = (event) => {
      const parsed: unknown = JSON.parse(event.data as string)
      if (typeof parsed === 'object' && parsed !== null && 'running' in parsed) {
        setStatus(parsed as SyncStatus)
      } else {
        void getSyncStatus().then(setStatus)
      }
    }
    const poll = setInterval(() => { void getSyncStatus().then(setStatus) }, 5000)
    return () => { stream.close(); clearInterval(poll) }
  }, [onBackfill])

  return (
    <div className="setup-shell">
      <div className="setup-column">
        <div className="setup-brand">haelan</div>
        <Rail current={step ?? 'account'} />

        {route.startsWith('/setup/instance-url')
          ? <InstanceUrlStep onDone={refresh} />
          : onGoogleRoute
            ? (
              <GoogleStep
                candidates={candidates}
                scopes={scopes}
                error={callbackError}
                onDone={() => { window.location.assign('/oauth/start') }}
              />
            )
            : onBackfill
              ? (status
                ? <BackfillStep
                    status={status}
                    nowMs={Date.now()}
                    failure={horizonFailure}
                    onHorizonChange={(days) => {
                      // Mirrors AccountStep/InstanceUrlStep's clear-then-catch shape: BackfillStep
                      // is presentational, so the failure lives here and is handed down to render,
                      // rather than silently leaving an unhandled rejection and a clicked button
                      // that appears to do nothing.
                      setHorizonFailure(null)
                      putBackfillHorizon(days)
                        .then(() => getSyncStatus().then(setStatus))
                        .catch((cause: unknown) => {
                          setHorizonFailure(cause instanceof Error ? cause.message : 'that did not work')
                        })
                    }}
                  />
                : <p className="empty">{t('setup.app.loadingProgress')}</p>)
              : <AccountStep onDone={refresh} />}
      </div>
    </div>
  )
}
