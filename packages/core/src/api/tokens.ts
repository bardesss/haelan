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

export class TokenProvider {
  private readonly cache = new Map<string, CachedToken>()

  constructor(
    private readonly credentials: CredentialStore,
    private readonly deps: TokenProviderDeps = { fetch: globalThis.fetch, now: Date.now },
  ) {}

  async accessTokenFor(personId: string): Promise<string> {
    const cached = this.cache.get(personId)
    if (cached && cached.expiresAtMs > this.deps.now() + EXPIRY_MARGIN_MS) return cached.accessToken

    const stored = this.credentials.getRefreshToken(personId)
    if (!stored) throw new Error(`person ${personId} is not connected`)
    // Checked before the network call rather than after: a revoked person must cost nothing,
    // because sync pauses for them alone while everyone else keeps running. Spec section 13.
    if (stored.revokedAtMs !== null) throw new RevokedError(personId)

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
      // for no reason.
      if (body.includes('invalid_grant')) {
        this.credentials.markRevoked(personId, this.deps.now())
        throw new RevokedError(personId)
      }
      throw new Error(`token refresh failed ${res.status}: ${body.slice(0, 200)}`)
    }

    const json = await res.json() as { access_token: string, expires_in: number }
    this.cache.set(personId, {
      accessToken: json.access_token,
      expiresAtMs: this.deps.now() + json.expires_in * 1000,
    })
    return json.access_token
  }
}
