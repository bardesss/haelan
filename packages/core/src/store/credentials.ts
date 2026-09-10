import { and, eq, isNull } from 'drizzle-orm'
import type { DbOrTx } from '../db/open.ts'
import { oauthClient, credentials } from '../db/schema/index.ts'
import { seal, unseal } from '../crypto/secretBox.ts'
import { ConfigError, CredentialsUnreadableError } from '../errors.ts'

const CLIENT_ROW_ID = 'default'

export interface ClientCredentials { clientId: string, clientSecret: string }
export interface StoredRefreshToken { refreshToken: string, scopes: string[], revokedAtMs: number | null }

export class CredentialStore {
  readonly #db: DbOrTx
  readonly #key: Buffer

  constructor(db: DbOrTx, key: Buffer) {
    this.#db = db
    this.#key = key
  }

  putClient(input: ClientCredentials & { nowMs: number }): void {
    this.#db.insert(oauthClient).values({
      id: CLIENT_ROW_ID,
      clientId: input.clientId,
      clientSecretEncrypted: seal(this.#key, input.clientSecret),
      updatedAtMs: input.nowMs,
    }).onConflictDoUpdate({
      target: oauthClient.id,
      set: {
        clientId: input.clientId,
        clientSecretEncrypted: seal(this.#key, input.clientSecret),
        updatedAtMs: input.nowMs,
      },
    }).run()
  }

  getClient(): ClientCredentials | null {
    const row = this.#db.select().from(oauthClient).where(eq(oauthClient.id, CLIENT_ROW_ID)).get()
    if (!row) return null
    return { clientId: row.clientId, clientSecret: unseal(this.#key, row.clientSecretEncrypted) }
  }

  putRefreshToken(input: { personId: string, refreshToken: string, scopes: string[], nowMs: number }): void {
    const encrypted = seal(this.#key, input.refreshToken)
    const scopes = input.scopes.join(' ')
    this.#db.insert(credentials).values({
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

  // Throws CredentialsUnreadableError rather than letting unseal's own error escape: a caller
  // catching that has to know it means "the wrong key", not "the wrong shape" or "the wrong
  // tag" - the two things AES-GCM's own failure actually reports. Every caller of this method
  // wants the same distinction TokenProvider.accessTokenFor wants, so it is made once, here,
  // rather than by every caller re-deriving it from a decipher exception.
  getRefreshToken(personId: string): StoredRefreshToken | null {
    const row = this.#db.select().from(credentials).where(eq(credentials.personId, personId)).get()
    if (!row) return null
    let refreshToken: string
    try {
      refreshToken = unseal(this.#key, row.refreshTokenEncrypted)
    } catch (error) {
      throw new CredentialsUnreadableError(personId, { cause: error })
    }
    return {
      refreshToken,
      scopes: row.grantedScopes === '' ? [] : row.grantedScopes.split(' '),
      revokedAtMs: row.revokedAtMs ?? null,
    }
  }

  putClientOverride(input: { personId: string, clientId: string, clientSecret: string }): void {
    const result = this.#db.update(credentials).set({
      clientIdOverride: input.clientId,
      clientSecretOverrideEncrypted: seal(this.#key, input.clientSecret),
    }).where(eq(credentials.personId, input.personId)).run()
    // An UPDATE against a missing row matches nothing and returns void, which would bury the
    // failure. RawArchive.put checks changes for the same reason.
    if (result.changes === 0) {
      throw new ConfigError(`no credentials row for person ${input.personId}; connect the person before setting a client override`)
    }
  }

  // Refresh has to use the client the token was issued against. Reading the household client
  // for a person who configured their own project fails as invalid_client, for exactly the
  // person who took the trouble to set it up. Spec section 7 calls the override an escape
  // hatch, so it has to be on the path everything takes.
  getClientFor(personId: string): ClientCredentials {
    const row = this.#db.select().from(credentials).where(eq(credentials.personId, personId)).get()
    if (row?.clientIdOverride && row.clientSecretOverrideEncrypted) {
      return {
        clientId: row.clientIdOverride,
        clientSecret: unseal(this.#key, row.clientSecretOverrideEncrypted),
      }
    }
    const household = this.getClient()
    if (!household) throw new ConfigError(`no OAuth client configured for person ${personId}`)
    return household
  }

  // The token is kept rather than deleted: the reconnect banner needs to distinguish "this
  // person revoked access" from "this person was never connected". Spec section 13.
  markRevoked(personId: string, nowMs: number): void {
    this.#db.update(credentials).set({ revokedAtMs: nowMs })
      .where(eq(credentials.personId, personId)).run()
  }

  clearRevoked(personId: string): void {
    this.#db.update(credentials).set({ revokedAtMs: null })
      .where(eq(credentials.personId, personId)).run()
  }

  listConnectedPeople(): string[] {
    return this.#db.select({ personId: credentials.personId }).from(credentials)
      .where(isNull(credentials.revokedAtMs)).all().map((r) => r.personId)
  }

  // Deliberately not listConnectedPeople's predicate (row exists, never revoked) plus a decrypt
  // attempt bolted on: this is the one place that decides what "connected" means for a single
  // person, and #readable below is the single place that decides whether the key can still open
  // what putRefreshToken wrote. Anything that wants to know "does this person have a usable
  // connection right now" - the session payload included - calls this.
  //
  // listConnectedPeople stays cheap and decrypt-free on purpose: it drives the scheduler's own
  // eligibility check on every run, and a row whose key has gone bad is still worth one attempt
  // - the failure surfaces through getRefreshToken instead, at the point that actually needs the
  // plaintext, rather than by decrypting every household's tokens once an hour just to ask.
  isConnected(personId: string): boolean {
    const row = this.#db.select().from(credentials).where(eq(credentials.personId, personId)).get()
    if (!row || row.revokedAtMs !== null) return false
    return this.#readable(row.refreshTokenEncrypted)
  }

  // The state this codebase had no name for until backups existed: a row that is neither absent
  // nor revoked, whose token instance.key simply cannot open. Reported separately from
  // isConnected rather than folded into a wider status - the person's own comment on `connected`
  // in apps/web/src/auth/session.ts is right that one action (reconsent) covers both this and
  // "never connected", but an operator asking why a member who was clearly connected yesterday
  // now shows the connect button again deserves the real answer, not just the same boolean.
  isCredentialsUnreadable(personId: string): boolean {
    const row = this.#db.select().from(credentials).where(eq(credentials.personId, personId)).get()
    if (!row || row.revokedAtMs !== null) return false
    return !this.#readable(row.refreshTokenEncrypted)
  }

  #readable(encrypted: string): boolean {
    try {
      unseal(this.#key, encrypted)
      return true
    } catch {
      return false
    }
  }
}
