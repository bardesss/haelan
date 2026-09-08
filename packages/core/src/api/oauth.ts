import { AuthError, ConfigError, TransientError, classifyHttp } from '../errors.ts'
import type { ClientCredentials } from '../store/credentials.ts'

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
export const API_ROOT = 'https://health.googleapis.com/v4'

// Every scope this instance asks a household member to grant. Declaring the full set once is what
// keeps a later data type from needing a second console visit.
//
// `googlehealth.nutrition.readonly` is here on the strength of two measurements that outrank the
// discovery document. It appears on the console's own Data Access page, classified Restricted with
// a Google-authored description - "See your Google Health nutrition data" - recorded in
// probe/findings/scopes.md on 2026-08-19; and hydration-log returned 33 real data points under a
// token granted from a list naming it (probe/findings/field-map.md).
//
// It is absent from `auth.oauth2.scopes` in the v4 discovery document. That block is therefore
// incomplete, and an argument of the form "the registry does not name it, so it does not exist" is
// unsound. This comment exists because that argument was made, acted on, and briefly removed this
// scope - which would have cost every new connection its hydration history.
//
// ecg and irn are new here, for the data types this branch adds. Anyone who connected earlier
// holds a token granted against the old list, so those two answer with a permission error until
// they reconnect; runJob records that per data type and the rest of their sync continues.
export const SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.nutrition.readonly',
  'https://www.googleapis.com/auth/googlehealth.ecg.readonly',
  'https://www.googleapis.com/auth/googlehealth.irn.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.profile.readonly',
  'https://www.googleapis.com/auth/googlehealth.settings.readonly',
] as const

export interface ConsentUrlInput {
  clientId: string
  redirectUri: string
  state: string
  authEndpoint?: string
}

export function buildConsentUrl(input: ConsentUrlInput): string {
  const url = new URL(input.authEndpoint ?? AUTH_ENDPOINT)
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SCOPES.join(' '))
  // offline plus consent is what returns a refresh token. Without prompt=consent, an account
  // that has granted before gets an access token only, and the instance can never sync.
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('include_granted_scopes', 'true')
  url.searchParams.set('state', input.state)
  return url.toString()
}

export interface ExchangeDeps {
  fetch: typeof globalThis.fetch
  now: () => number
  tokenEndpoint?: string
}

export interface ExchangeInput {
  code: string
  redirectUri: string
  client: ClientCredentials
  deps: ExchangeDeps
}

export interface ExchangeResult {
  refreshToken: string
  accessToken: string
  expiresInSeconds: number
  scopes: string[]
}

export async function exchangeAuthorizationCode(input: ExchangeInput): Promise<ExchangeResult> {
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.client.clientId,
    client_secret: input.client.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
  })

  const response = await input.deps.fetch(input.deps.tokenEndpoint ?? TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const text = await response.text()

  if (!response.ok) throw exchangeError(response.status, text)

  const parsed = JSON.parse(text) as {
    refresh_token?: string, access_token?: string, expires_in?: number, scope?: string
  }
  if (typeof parsed.refresh_token !== 'string' || parsed.refresh_token === '') {
    // Google omits it when the account granted before and prompt=consent did not reach it.
    // Accepting the access token would leave an instance that syncs once and then stops.
    throw new ConfigError('Google returned no refresh token. Revoke the app under your Google account permissions and grant consent again.')
  }
  return {
    refreshToken: parsed.refresh_token,
    accessToken: parsed.access_token ?? '',
    expiresInSeconds: parsed.expires_in ?? 0,
    scopes: parsed.scope === undefined || parsed.scope === '' ? [] : parsed.scope.split(' '),
  }
}

// Every branch names the console fix, because the whole point of validating here is that the
// owner is still in front of the console when the answer arrives.
function exchangeError(status: number, text: string): Error {
  const code = errorCode(text)
  if (code === 'invalid_client') {
    return new ConfigError('invalid_client: the client ID or the secret does not match the OAuth client in the console. Re-copy both from Credentials.')
  }
  if (code === 'redirect_uri_mismatch') {
    return new ConfigError('redirect_uri_mismatch: the redirect URI this instance sent is not registered on the OAuth client. Add it verbatim under Authorised redirect URIs.')
  }
  if (code === 'invalid_grant') {
    return new AuthError('invalid_grant: the authorization code was already used or has expired. Start the connect step again.')
  }
  return classifyHttp(status) === 'transient'
    ? new TransientError(`token endpoint returned ${status}`)
    : new ConfigError(`token endpoint returned ${status}${code === null ? '' : `, ${code}`}`)
}

function errorCode(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { error?: unknown }
    return typeof parsed.error === 'string' ? parsed.error : null
  } catch {
    return null
  }
}

export interface ProbeInput {
  accessToken: string
  deps: { fetch: typeof globalThis.fetch, apiRoot?: string }
}

// One real call with the token just issued. It is the only thing that proves the API is enabled
// on the project and that the scopes were actually granted, which no amount of form validation
// can establish beforehand.
export async function probeAccess(input: ProbeInput): Promise<void> {
  const response = await input.deps.fetch(`${input.deps.apiRoot ?? API_ROOT}/users/me/profile`, {
    headers: { authorization: `Bearer ${input.accessToken}` },
  })
  if (response.ok) return

  const text = await response.text()
  if (response.status === 403) {
    if (text.includes('SERVICE_DISABLED') || text.includes('has not been used in project')) {
      throw new ConfigError('The Google Health API is not enabled on this project. Enable it under APIs and services, then try again.')
    }
    if (text.toLowerCase().includes('scopes')) {
      throw new ConfigError('Consent did not grant the scopes haelan needs. Grant every requested permission on the consent screen.')
    }
  }
  throw classifyHttp(response.status) === 'transient'
    ? new TransientError(`profile probe returned ${response.status}`)
    : new ConfigError(`profile probe returned ${response.status}`)
}
