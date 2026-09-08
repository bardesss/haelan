import { describe, it, expect } from 'vitest'
import { buildConsentUrl, exchangeAuthorizationCode, probeAccess, SCOPES } from '../src/api/oauth.ts'
import { AuthError, ConfigError, TransientError } from '../src/errors.ts'

// Distinctive, so the leak test below asserts the value never reaches an error rather
// than asserting the word "secret" never appears in English prose.
const client = { clientId: 'id.apps.googleusercontent.com', clientSecret: 'GOCSPX-never-in-a-message' }
const redirectUri = 'http://localhost:4235/oauth/callback'

const respond = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof globalThis.fetch

describe('buildConsentUrl', () => {
  it('asks for offline access and forces the consent screen, which is what returns a refresh token', () => {
    const url = new URL(buildConsentUrl({ clientId: client.clientId, redirectUri, state: 'st' }))
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('state')).toBe('st')
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri)
  })

  it('requests exactly the scopes the catalogue is built on', () => {
    const url = new URL(buildConsentUrl({ clientId: client.clientId, redirectUri, state: 'st' }))
    expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual([...SCOPES].sort())
    // Seven since ecg and irn joined and the nutrition one, which Google never defined, left.
    // catalogue-scopes.test.ts is what pins which seven; this only pins that the URL carries them.
    expect(SCOPES).toHaveLength(7)
  })
})

describe('exchangeAuthorizationCode', () => {
  it('returns the refresh token and the granted scopes', async () => {
    const result = await exchangeAuthorizationCode({
      code: 'c', redirectUri, client,
      deps: {
        now: () => 0,
        fetch: respond(200, {
          refresh_token: 'r', access_token: 'a', expires_in: 3599, scope: 'one two',
        }),
      },
    })
    expect(result).toEqual({ refreshToken: 'r', accessToken: 'a', expiresInSeconds: 3599, scopes: ['one', 'two'] })
  })

  it('calls a stubbed endpoint when one is supplied, which is how tests avoid Google', async () => {
    let seen = ''
    await exchangeAuthorizationCode({
      code: 'c', redirectUri, client,
      deps: {
        now: () => 0,
        tokenEndpoint: 'http://127.0.0.1:1/token',
        fetch: (async (url: string | URL) => {
          seen = String(url)
          return new Response(JSON.stringify({ refresh_token: 'r', access_token: 'a', expires_in: 1, scope: '' }), { status: 200 })
        }) as unknown as typeof globalThis.fetch,
      },
    })
    expect(seen).toBe('http://127.0.0.1:1/token')
  })

  it('treats a response with no refresh token as a config failure, not a success', async () => {
    // Google omits it when the account already granted consent and prompt=consent was dropped.
    // Storing nothing and reporting nothing would leave an instance that can never sync.
    await expect(exchangeAuthorizationCode({
      code: 'c', redirectUri, client,
      deps: { now: () => 0, fetch: respond(200, { access_token: 'a', expires_in: 1, scope: '' }) },
    })).rejects.toBeInstanceOf(ConfigError)
  })

  it('names a wrong secret rather than reporting a generic 401', async () => {
    const error = await exchangeAuthorizationCode({
      code: 'c', redirectUri, client,
      deps: { now: () => 0, fetch: respond(401, { error: 'invalid_client' }) },
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConfigError)
    expect(String(error)).toContain('invalid_client')
  })

  it('names a redirect URI mismatch, which is the failure M0 predicted', async () => {
    const error = await exchangeAuthorizationCode({
      code: 'c', redirectUri, client,
      deps: { now: () => 0, fetch: respond(400, { error: 'redirect_uri_mismatch' }) },
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConfigError)
    expect(String(error)).toContain('redirect_uri_mismatch')
  })

  it('classifies an expired or reused code as an auth failure', async () => {
    await expect(exchangeAuthorizationCode({
      code: 'c', redirectUri, client,
      deps: { now: () => 0, fetch: respond(400, { error: 'invalid_grant' }) },
    })).rejects.toBeInstanceOf(AuthError)
  })

  it('classifies a 503 as transient, so the wizard offers a retry rather than a diagnosis', async () => {
    await expect(exchangeAuthorizationCode({
      code: 'c', redirectUri, client,
      deps: { now: () => 0, fetch: respond(503, { error: 'backendError' }) },
    })).rejects.toBeInstanceOf(TransientError)
  })

  it('never puts the client secret in the error it throws', async () => {
    const error = await exchangeAuthorizationCode({
      code: 'c', redirectUri, client,
      deps: { now: () => 0, fetch: respond(401, { error: 'invalid_client' }) },
    }).catch((e: unknown) => e)
    expect(String(error)).not.toContain(client.clientSecret)
  })

  it('never echoes the request body back, whatever the endpoint answered', async () => {
    // The commonest way a secret escapes is an error that quotes what was sent. This fails the
    // moment exchangeError starts interpolating the form body into its message.
    const error = await exchangeAuthorizationCode({
      code: 'c', redirectUri, client,
      deps: { now: () => 0, fetch: respond(418, { error: 'teapot' }) },
    }).catch((e: unknown) => e)
    expect(String(error)).not.toContain(client.clientSecret)
    expect(String(error)).toContain('418')
  })
})

describe('probeAccess', () => {
  it('passes when the profile call succeeds', async () => {
    await expect(probeAccess({
      accessToken: 'a', deps: { fetch: respond(200, { displayName: 'Bartus' }) },
    })).resolves.toBeUndefined()
  })

  it('says the API is not enabled when that is what the 403 means', async () => {
    const error = await probeAccess({
      accessToken: 'a',
      deps: {
        fetch: respond(403, {
          error: { status: 'PERMISSION_DENIED', message: 'Health API has not been used in project 1 before or it is disabled', details: [{ reason: 'SERVICE_DISABLED' }] },
        }),
      },
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConfigError)
    expect(String(error)).toContain('not enabled')
  })

  it('reports a missing scope grant as a config failure the owner can act on', async () => {
    const error = await probeAccess({
      accessToken: 'a',
      deps: { fetch: respond(403, { error: { status: 'PERMISSION_DENIED', message: 'Request had insufficient authentication scopes.' } }) },
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConfigError)
    expect(String(error)).toContain('scopes')
  })
})
