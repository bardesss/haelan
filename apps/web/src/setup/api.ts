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

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  const parsed: unknown = text === '' ? {} : JSON.parse(text)
  if (!response.ok) {
    // The server's messages name the console fix, so the message is the useful thing to
    // surface. A status code would send the reader looking for it.
    const message = typeof (parsed as { error?: unknown }).error === 'string'
      ? (parsed as { error: string }).error
      : `request failed with ${response.status}`
    throw new Error(message)
  }
  return parsed as T
}

export const getSetupState = () => send<{ step: string }>('GET', '/api/setup/state')
export const getLastError = () => send<SetupError>('GET', '/api/setup/last-error')
export const getSyncStatus = () => send<SyncStatus>('GET', '/api/sync/status')
export const getRedirectUris = (host: string) =>
  send<{ candidates: RedirectCandidate[] }>('GET', `/api/setup/redirect-uris?host=${encodeURIComponent(host)}`)

// Fetched rather than hard coded in this bundle, so the list on screen is the list the server
// will actually request at consent.
export const getScopes = () => send<{ scopes: string[] }>('GET', '/api/setup/scopes')

export const createAccount = (body: {
  username: string, password: string, displayName: string, timezone: string
}) => send<{ personId: string, step: string }>('POST', '/api/setup/account', body)

export const putInstanceUrl = (body: { baseUrl: string, consentPath: string }) =>
  send<{ step: string, redirectUri: string }>('POST', '/api/setup/instance-url', body)

export const putGoogleClient = (body: { clientId: string, clientSecret: string }) =>
  send<{ step: string }>('POST', '/api/setup/google-client', body)

// Under /api/settings/, not /api/setup/: the backfill screen is the step after setup is
// 'done', and the setup gate answers every /api/setup/* path with 409 once it is.
export const putBackfillHorizon = (days: number) =>
  send<{ backfillHorizonDays: number }>('PUT', '/api/settings/backfill-horizon', { days })
