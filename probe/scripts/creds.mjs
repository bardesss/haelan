// M2p, throwaway. The credentials moved into the instance database during M1d, and the copy in
// .env.local is stale: same client id, a client secret Google now rejects with invalid_client.
// Probes that still read the env file are authenticating as a client that no longer exists.
import { openHaelan } from '../../packages/core/src/instance.ts'
import { credentials as credentialsTable } from '../../packages/core/src/db/schema/index.ts'

const DATA_DIR = process.env.HAELAN_DATA_DIR ?? './.local-data'

export function instanceCredentials() {
  const inst = openHaelan(DATA_DIR)
  try {
    const client = inst.credentials.getClient()
    if (!client) throw new Error(`no oauth client in ${DATA_DIR}: run the wizard`)
    const row = inst.db.select().from(credentialsTable).all().find((r) => r.revokedAtMs === null)
    if (!row) throw new Error(`no live credential in ${DATA_DIR}`)
    const stored = inst.credentials.getRefreshToken(row.personId)
    return { ...client, personId: row.personId, refreshToken: stored.refreshToken, scopes: stored.scopes }
  } finally {
    inst.close()
  }
}

let cached = null

// Read only on purpose. Google does not rotate a refresh token on use for this client type, and
// writing a new one back from a throwaway script is how an instance loses its grant. Cached for
// the process because a probe issuing a dozen calls should not mint a dozen access tokens.
export async function accessToken() {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
  const c = instanceCredentials()
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`refresh failed ${res.status}: ${JSON.stringify(body)}`)
  cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 }
  return cached.token
}
