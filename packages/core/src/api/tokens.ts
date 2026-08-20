import type { CredentialStore } from '../store/credentials.ts'

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const EXPIRY_MARGIN_MS = 60_000

export class RevokedError extends Error {
  constructor(readonly personId: string) {
    super(`refresh token for person ${personId} is no longer valid`)
    this.name = 'RevokedError'
  }
}

export interface TokenProviderDeps {
  fetch: typeof globalThis.fetch
  now: () => number
}

interface CachedToken { accessToken: string, expiresAtMs: number }

function parseErrorBody(body: string): { error?: string } | null {
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === 'object' && parsed !== null ? parsed as { error?: string } : null
  } catch {
    return null
  }
}

export class TokenProvider {
  private readonly cache = new Map<string, CachedToken>()

  constructor(
    private readonly credentials: CredentialStore,
    private readonly deps: TokenProviderDeps = { fetch: globalThis.fetch, now: Date.now },
  ) {}

  async accessTokenFor(personId: string): Promise<string> {
    // The stored credential is the source of truth and is read before the cache on every
    // call: a revocation from another path (admin disconnect, another process, a future
    // wizard flow) must stop this instance from handing out data now, not once the cached
    // token happens to expire.
    const stored = this.credentials.getRefreshToken(personId)
    if (!stored) throw new Error(`person ${personId} is not connected`)
    if (stored.revokedAtMs !== null) {
      this.cache.delete(personId)
      throw new RevokedError(personId)
    }

    const cached = this.cache.get(personId)
    if (cached && cached.expiresAtMs > this.deps.now() + EXPIRY_MARGIN_MS) return cached.accessToken

    const client = this.credentials.getClientFor(personId)
    const res = await this.deps.fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: stored.refreshToken,
        grant_type: 'refresh_token',
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      // Only invalid_grant means the person must reconsent. A 5xx means Google is having a bad
      // day, and marking them revoked for that would send the household to the consent screen
      // for no reason. Parsed strictly on the error field, not matched as a substring of the
      // whole body: an unrelated error whose description happens to mention the phrase must
      // not revoke. Ambiguous bodies (unparsable, or no error field) also must not revoke,
      // since wrongly revoking costs a household member their connection while wrongly not
      // revoking only costs a retry.
      const parsed = parseErrorBody(body)
      if (parsed?.error === 'invalid_grant') {
        this.credentials.markRevoked(personId, this.deps.now())
        this.cache.delete(personId)
        throw new RevokedError(personId)
      }
      throw new Error(`token refresh failed ${res.status}: ${body.slice(0, 200)}`)
    }

    const json: unknown = await res.json()
    if (
      typeof json !== 'object' || json === null
      || !('access_token' in json) || typeof json.access_token !== 'string' || json.access_token === ''
      || !('expires_in' in json) || typeof json.expires_in !== 'number' || !Number.isFinite(json.expires_in)
    ) {
      throw new Error('token response was malformed')
    }

    this.cache.set(personId, {
      accessToken: json.access_token,
      expiresAtMs: this.deps.now() + json.expires_in * 1000,
    })
    return json.access_token
  }
}
