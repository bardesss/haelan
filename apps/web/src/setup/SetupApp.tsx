import { useEffect, useState } from 'react'
import { useTranslation } from '../i18n/index.js'
import { useRoute, navigate } from '../router.js'
import { AccountStep } from './AccountStep.js'
import { InstanceUrlStep } from './InstanceUrlStep.js'
import { GoogleStep } from './GoogleStep.js'
import { BackfillStep } from './BackfillStep.js'
import { DataTypeStep } from './DataTypeStep.js'
import { SignIn } from '../auth/SignIn.js'
import { BrandMark } from '../components/BrandMark.js'
import {
  getLastError, getRedirectUris, getScopes, getSetupState, getSyncStatus, putBackfillHorizon,
} from './api.js'
import type { RedirectCandidate, SetupError, SyncStatus } from './api.js'
import { ApiError } from '../api/client.js'

const STEPS = [
  { step: 'account', path: '/setup/account', titleKey: 'setup.app.steps.account' },
  { step: 'instance-url', path: '/setup/instance-url', titleKey: 'setup.app.steps.address' },
  { step: 'google-client', path: '/setup/google', titleKey: 'setup.app.steps.google' },
  { step: 'consent', path: '/setup/google', titleKey: 'setup.app.steps.consent' },
] as const

const pathForStep = (step: string) =>
  STEPS.find((entry) => entry.step === step)?.path ?? '/setup/backfill'

// Reload survival for dataTypesDone (see the state below): sessionStorage rather than a plain
// module variable, because a reload discards the module the same way it discards React state, and
// rather than localStorage, because this is scoped to the setup session that is still open, not a
// fact worth remembering into a future one where the wizard runs again for a different household
// member's own browser profile.
const DATA_TYPES_DONE_KEY = 'haelan.setup.dataTypesDone'

function readDataTypesDone(): boolean {
  if (typeof sessionStorage === 'undefined') return false
  return sessionStorage.getItem(DATA_TYPES_DONE_KEY) === 'true'
}

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
  // Not one of setupStep's values (see DataTypeStep.tsx's own doc comment for why): the server
  // has nothing to say about whether this screen has been shown, so the browser tracks it here,
  // the same way it already tracks candidates and scopes for the Google screen above. Written
  // through to sessionStorage, not left as bare useState: a reload mid-backfill used to re-run the
  // getSetupState() effect below, land back on /setup/backfill with dataTypesDone reset to false,
  // and re-show DataTypeStep over a backfill that was already running -- harmless to click Continue
  // on again, but a lie about where the wizard actually was.
  const [dataTypesDone, setDataTypesDoneState] = useState(readDataTypesDone)
  const setDataTypesDone = (done: boolean): void => {
    setDataTypesDoneState(done)
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(DATA_TYPES_DONE_KEY, String(done))
  }

  // Every step but the first needs a session, and the first one mints one as it goes - so a
  // wizard walked in one sitting never sees this. Something else has to have brought the reader
  // to an unfinished wizard: a reload after the cookie expired, another browser, or a database
  // restored without its instance.key, which cannot decrypt the Google client and so puts a
  // finished instance back on this very step with nobody signed in. A 401 there is not a red
  // line under a form, it is the sign-in screen; the server leaves /api/auth/login open during
  // setup for exactly this (apps/server/src/routes/setupGate.ts).
  const [needsSignIn, setNeedsSignIn] = useState(false)
  const orSignIn = (cause: unknown): void => {
    if (cause instanceof ApiError && cause.status === 401) {
      setNeedsSignIn(true)
      return
    }
    // Anything else is not this handler's to eat. Rethrowing leaves it exactly the rejection it
    // was before this catch existed, rather than turning a 500 into a screen that quietly shows
    // an empty list and never says why.
    throw cause
  }

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
    if (!onGoogleRoute || needsSignIn) return
    void getRedirectUris(window.location.hostname).then((r) => setCandidates(r.candidates)).catch(orSignIn)
    void getScopes().then((r) => setScopes(r.scopes)).catch(orSignIn)
    // The callback redirects here with an error code in the query, and the message that goes
    // with it lives on the server. Fetching it is what puts the console fix on screen.
    if (route.includes('error=')) void getLastError().then(setCallbackError).catch(orSignIn)
  }, [onGoogleRoute, route, needsSignIn])

  const onBackfill = route.startsWith('/setup/backfill')
  // Gated on dataTypesDone as well as the route: fetching progress and opening the live stream
  // is preparation for BackfillStep specifically, and starting it while DataTypeStep is still on
  // screen would mean tearing an open EventSource down again the moment Continue is clicked,
  // for no reader-visible benefit.
  const showBackfill = onBackfill && dataTypesDone
  useEffect(() => {
    if (!showBackfill) return
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
  }, [showBackfill])

  // On its own, the way Shell renders it, rather than inside the wizard's column: the rail is a
  // claim about progress through steps this reader cannot take a single one of until they are
  // signed in. The step may also have moved while nobody was, which is exactly what a restore
  // does, so signing in asks the server where it is now rather than resuming this screen.
  if (needsSignIn) {
    return <SignIn onSignedIn={() => { setNeedsSignIn(false); refresh() }} />
  }

  return (
    <div className="setup-shell">
      <div className="setup-column">
        <div className="setup-brand"><BrandMark />Hælan</div>
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
              ? (!dataTypesDone
                ? <DataTypeStep onDone={() => setDataTypesDone(true)} />
                : status
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
                            setHorizonFailure(cause instanceof Error ? cause.message : t('setup.genericError'))
                          })
                      }}
                    />
                  : <p className="empty">{t('setup.app.loadingProgress')}</p>)
              : <AccountStep onDone={refresh} />}
      </div>
    </div>
  )
}
