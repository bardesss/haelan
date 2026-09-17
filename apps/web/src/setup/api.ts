import { apiGet, apiSend } from '../api/client.js'

export interface RedirectCandidate {
  uri: string
  labelKey: string
  registrable: boolean
  reason?: string
}

export interface SetupError { code: string, message: string }

export interface BackfillSummary {
  dataType: string
  complete: boolean
  cursorMs: number | null
  horizonDays: number
}

export interface SyncStatus {
  /** Whose snapshot this is. See RunnerStatus.personId on the server for why it is here. */
  personId: string
  running: boolean
  reason: string | null
  startedAtMs: number | null
  lastFinishedAtMs: number | null
  userHorizonDays: number
  backfill: BackfillSummary[]
}

export const getSetupState = () => apiGet<{ step: string, companionMode: boolean }>('/api/setup/state')
export const getLastError = () => apiGet<SetupError>('/api/setup/last-error')
export const getSyncStatus = () => apiGet<SyncStatus>('/api/sync/status')
export const getRedirectUris = (host: string) =>
  apiGet<{ candidates: RedirectCandidate[] }>(`/api/setup/redirect-uris?host=${encodeURIComponent(host)}`)

// Fetched rather than hard coded in this bundle, so the list on screen is the list the server
// will actually request at consent.
export const getScopes = () => apiGet<{ scopes: string[] }>('/api/setup/scopes')

export const createAccount = (body: {
  username: string, password: string, displayName: string, timezone: string
}) => apiSend<{ personId: string, step: string }>('POST', '/api/setup/account', body)

export const putInstanceUrl = (body: { baseUrl: string, consentPath: string }) =>
  apiSend<{ step: string, redirectUri: string }>('POST', '/api/setup/instance-url', body)

export const putGoogleClient = (body: { clientId: string, clientSecret: string }) =>
  apiSend<{ step: string }>('POST', '/api/setup/google-client', body)

// No body: finishing without Google is a choice rather than a value, and the server reads
// the step it is on rather than anything the browser claims.
export const postCompanionSetup = () =>
  apiSend<{ step: string }>('POST', '/api/setup/companion', {})

// Under /api/settings/, not /api/setup/: the backfill screen is the step after setup is
// 'done', and the setup gate answers every /api/setup/* path with 409 once it is.
export const putBackfillHorizon = (days: number) =>
  apiSend<{ backfillHorizonDays: number }>('PUT', '/api/settings/backfill-horizon', { days })
