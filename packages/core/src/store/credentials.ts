import { eq, isNull } from 'drizzle-orm'
import type { Database } from '../db/open.ts'
import { oauthClient, credentials } from '../db/schema/index.ts'
import { seal, unseal } from '../crypto/secretBox.ts'

const CLIENT_ROW_ID = 'default'

export interface ClientCredentials { clientId: string, clientSecret: string }
export interface StoredRefreshToken { refreshToken: string, scopes: string[], revokedAtMs: number | null }

export class CredentialStore {
  constructor(private readonly db: Database, private readonly key: Buffer) {}

  putClient(input: ClientCredentials & { nowMs: number }): void {
    this.db.insert(oauthClient).values({
      id: CLIENT_ROW_ID,
      clientId: input.clientId,
      clientSecretEncrypted: seal(this.key, input.clientSecret),
      updatedAtMs: input.nowMs,
    }).onConflictDoUpdate({
      target: oauthClient.id,
      set: {
        clientId: input.clientId,
        clientSecretEncrypted: seal(this.key, input.clientSecret),
        updatedAtMs: input.nowMs,
      },
    }).run()
  }

  getClient(): ClientCredentials | null {
    const row = this.db.select().from(oauthClient).where(eq(oauthClient.id, CLIENT_ROW_ID)).get()
    if (!row) return null
    return { clientId: row.clientId, clientSecret: unseal(this.key, row.clientSecretEncrypted) }
  }

  putRefreshToken(input: { personId: string, refreshToken: string, scopes: string[], nowMs: number }): void {
    const encrypted = seal(this.key, input.refreshToken)
    const scopes = input.scopes.join(' ')
    this.db.insert(credentials).values({
      personId: input.personId,
      refreshTokenEncrypted: encrypted,
      grantedScopes: scopes,
      obtainedAtMs: input.nowMs,
      revokedAtMs: null,
    }).onConflictDoUpdate({
      target: credentials.personId,
      set: { refreshTokenEncrypted: encrypted, grantedScopes: scopes, obtainedAtMs: input.nowMs, revokedAtMs: null },
    }).run()
  }

  getRefreshToken(personId: string): StoredRefreshToken | null {
    const row = this.db.select().from(credentials).where(eq(credentials.personId, personId)).get()
    if (!row) return null
    return {
      refreshToken: unseal(this.key, row.refreshTokenEncrypted),
      scopes: row.grantedScopes === '' ? [] : row.grantedScopes.split(' '),
      revokedAtMs: row.revokedAtMs ?? null,
    }
  }

  putClientOverride(input: { personId: string, clientId: string, clientSecret: string }): void {
    this.db.update(credentials).set({
      clientIdOverride: input.clientId,
      clientSecretOverrideEncrypted: seal(this.key, input.clientSecret),
    }).where(eq(credentials.personId, input.personId)).run()
  }

  // Refresh has to use the client the token was issued against. Reading the household client
  // for a person who configured their own project fails as invalid_client, for exactly the
  // person who took the trouble to set it up. Spec section 7 calls the override an escape
  // hatch, so it has to be on the path everything takes.
  getClientFor(personId: string): ClientCredentials {
    const row = this.db.select().from(credentials).where(eq(credentials.personId, personId)).get()
    if (row?.clientIdOverride && row.clientSecretOverrideEncrypted) {
      return {
        clientId: row.clientIdOverride,
        clientSecret: unseal(this.key, row.clientSecretOverrideEncrypted),
      }
    }
    const household = this.getClient()
    if (!household) throw new Error(`no OAuth client configured for person ${personId}`)
    return household
  }

  // The token is kept rather than deleted: the reconnect banner needs to distinguish "this
  // person revoked access" from "this person was never connected". Spec section 13.
  markRevoked(personId: string, nowMs: number): void {
    this.db.update(credentials).set({ revokedAtMs: nowMs })
      .where(eq(credentials.personId, personId)).run()
  }

  clearRevoked(personId: string): void {
    this.db.update(credentials).set({ revokedAtMs: null })
      .where(eq(credentials.personId, personId)).run()
  }

  listConnectedPeople(): string[] {
    return this.db.select({ personId: credentials.personId }).from(credentials)
      .where(isNull(credentials.revokedAtMs)).all().map((r) => r.personId)
  }
}
