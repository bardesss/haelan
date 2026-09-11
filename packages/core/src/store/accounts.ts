import { asc, eq } from 'drizzle-orm'
import { hash, verify } from '@node-rs/argon2'
import type { DbOrTx } from '../db/open.ts'
import { accounts } from '../db/schema/index.ts'
import { ConfigError } from '../errors.ts'

// OWASP's second recommended argon2id configuration: 19 MiB, two passes, one lane.
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const

const MAX_ATTEMPTS = 10
const LOCK_MS = 15 * 60_000

// The two columns that together are "this account is being guessed at". Named once because three
// callers now write them as a pair, and a fourth that cleared only one of them would hand back an
// account that locks again on its next mistake.
const LOCKOUT_CLEARED = { failedAttempts: 0, lockedUntilMs: null } as const

export interface AccountRow {
  id: string
  personId: string
  username: string
  isAdmin: boolean
  disabledAtMs: number | null
}

/**
 * An account plus the lockout state `AccountRow` deliberately leaves out.
 *
 * Kept separate rather than folded into `AccountRow`, because every other caller of this store
 * answers a browser and has no business knowing how close somebody is to being locked out. Only
 * an operator at the console does.
 */
export interface AccountListRow extends AccountRow {
  lockedUntilMs: number | null
}

export interface CreateAccountInput {
  id: string
  personId: string
  username: string
  password: string
  isAdmin: boolean
  nowMs: number
}

export interface LoginInput { username: string, password: string, nowMs: number }

export type LoginResult =
  | { ok: true, account: AccountRow }
  | { ok: false, reason: 'unknown' | 'bad_password' | 'locked' }

// A function rather than a constant, so the floor and the sentence that explains it stay together
// and a second way into a password cannot quietly enforce a different number.
function requireLongEnough(password: string): void {
  if (password.length < 8) throw new ConfigError('password must be at least 8 characters')
}

// Verifying an unknown username against a real hash costs the same as verifying a known one,
// which is what stops response time from answering "does this account exist".
let decoyHash: string | null = null
async function decoy(): Promise<string> {
  decoyHash ??= await hash('decoy', ARGON2)
  return decoyHash
}

export class AccountStore {
  readonly #db: DbOrTx

  constructor(db: DbOrTx) { this.#db = db }

  count(): number {
    return this.#db.select().from(accounts).all().length
  }

  async create(input: CreateAccountInput): Promise<AccountRow> {
    const username = input.username.trim().toLowerCase()
    if (username === '') throw new ConfigError('username must not be empty')
    if (this.#db.select().from(accounts).where(eq(accounts.username, username)).get()) {
      throw new ConfigError(`username ${username} is already taken`)
    }
    requireLongEnough(input.password)
    const passwordHash = await hash(input.password, ARGON2)
    this.#db.insert(accounts).values({
      id: input.id,
      personId: input.personId,
      username,
      passwordHash,
      isAdmin: input.isAdmin,
      createdAtMs: input.nowMs,
    }).run()
    return { id: input.id, personId: input.personId, username, isAdmin: input.isAdmin, disabledAtMs: null }
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const username = input.username.trim().toLowerCase()
    const row = this.#db.select().from(accounts).where(eq(accounts.username, username)).get()
    if (!row) {
      await verify(await decoy(), input.password).catch(() => false)
      return { ok: false, reason: 'unknown' }
    }
    if (row.lockedUntilMs !== null && row.lockedUntilMs > input.nowMs) {
      return { ok: false, reason: 'locked' }
    }

    const matched = await verify(row.passwordHash, input.password).catch(() => false)
    if (!matched) {
      const failedAttempts = row.failedAttempts + 1
      this.#db.update(accounts).set({
        failedAttempts,
        lockedUntilMs: failedAttempts >= MAX_ATTEMPTS ? input.nowMs + LOCK_MS : row.lockedUntilMs,
      }).where(eq(accounts.id, row.id)).run()
      return { ok: false, reason: 'bad_password' }
    }

    // Checked after the verify rather than instead of it, so a disabled account costs the same
    // time as a live one and the answer is the same one a wrong password gets. Telling the two
    // apart would confirm to anyone trying a username that the account exists, and the admin who
    // disabled it is the one who tells the member - the app has no way to reach them.
    if (row.disabledAtMs !== null) return { ok: false, reason: 'bad_password' }

    this.#db.update(accounts).set(LOCKOUT_CLEARED).where(eq(accounts.id, row.id)).run()
    return { ok: true, account: toRow(row) }
  }

  getById(id: string): AccountRow | null {
    const row = this.#db.select().from(accounts).where(eq(accounts.id, id)).get()
    return row ? toRow(row) : null
  }

  getByPersonId(personId: string): AccountRow | null {
    const row = this.#db.select().from(accounts).where(eq(accounts.personId, personId)).get()
    return row ? toRow(row) : null
  }

  disable(id: string, nowMs: number): void {
    this.#db.update(accounts).set({ disabledAtMs: nowMs }).where(eq(accounts.id, id)).run()
  }

  enable(id: string): void {
    this.#db.update(accounts).set({ disabledAtMs: null }).where(eq(accounts.id, id)).run()
  }

  /**
   * Every account, in username order, for an operator looking at a console.
   *
   * `passwordHash` is not on `AccountListRow` and is not selected here, so the one surface that
   * prints whatever it is handed cannot be handed a hash to print.
   */
  list(): AccountListRow[] {
    return this.#db.select({
      id: accounts.id,
      personId: accounts.personId,
      username: accounts.username,
      isAdmin: accounts.isAdmin,
      disabledAtMs: accounts.disabledAtMs,
      lockedUntilMs: accounts.lockedUntilMs,
    }).from(accounts).orderBy(asc(accounts.username)).all()
  }

  /**
   * Replaces the password, and clears the lockout that a forgotten one usually arrives with.
   *
   * Targeted the way `SettingsStore.putBaseUrl` is, and for the same reason: the caller has a
   * username and a new password and nothing else, so anything this touched beyond the three
   * columns it is named for would be a value it invented. `isAdmin` and `disabledAtMs` in
   * particular survive, because a password reset is not a way to promote or revive an account.
   *
   * No timestamp argument, unlike `putBaseUrl`: `accounts` has no column a password change would
   * stamp, and a parameter this ignored would be a promise the table cannot keep.
   */
  async setPassword(username: string, password: string): Promise<void> {
    const row = this.#require(username)
    requireLongEnough(password)
    const passwordHash = await hash(password, ARGON2)
    this.#db.update(accounts).set({ passwordHash, ...LOCKOUT_CLEARED })
      .where(eq(accounts.id, row.id)).run()
  }

  /**
   * Lets somebody back in who knows their password and ran out of attempts.
   *
   * Separate from `setPassword` rather than a flag on it, because the whole point is the hash it
   * does not touch: an operator clearing a lockout is not being asked to choose a password for
   * somebody who already has one.
   */
  clearLockout(username: string): void {
    const row = this.#require(username)
    this.#db.update(accounts).set(LOCKOUT_CLEARED).where(eq(accounts.id, row.id)).run()
  }

  // Throws rather than answering null, because both callers are a single operator command that
  // has nothing else to do with an account it cannot find.
  #require(username: string): typeof accounts.$inferSelect {
    const normalised = username.trim().toLowerCase()
    const row = this.#db.select().from(accounts).where(eq(accounts.username, normalised)).get()
    if (!row) throw new ConfigError(`no account named ${normalised}`)
    return row
  }
}

function toRow(row: typeof accounts.$inferSelect): AccountRow {
  return {
    id: row.id,
    personId: row.personId,
    username: row.username,
    isAdmin: row.isAdmin,
    disabledAtMs: row.disabledAtMs,
  }
}
