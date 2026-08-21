import { eq } from 'drizzle-orm'
import { hash, verify } from '@node-rs/argon2'
import type { DbOrTx } from '../db/open.ts'
import { accounts } from '../db/schema/index.ts'
import { ConfigError } from '../errors.ts'

// OWASP's second recommended argon2id configuration: 19 MiB, two passes, one lane.
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const

const MAX_ATTEMPTS = 10
const LOCK_MS = 15 * 60_000

export interface AccountRow {
  id: string
  personId: string
  username: string
  isAdmin: boolean
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
    if (input.password.length < 8) throw new ConfigError('password must be at least 8 characters')
    const passwordHash = await hash(input.password, ARGON2)
    this.#db.insert(accounts).values({
      id: input.id,
      personId: input.personId,
      username,
      passwordHash,
      isAdmin: input.isAdmin,
      createdAtMs: input.nowMs,
    }).run()
    return { id: input.id, personId: input.personId, username, isAdmin: input.isAdmin }
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

    this.#db.update(accounts).set({ failedAttempts: 0, lockedUntilMs: null })
      .where(eq(accounts.id, row.id)).run()
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
}

function toRow(row: typeof accounts.$inferSelect): AccountRow {
  return { id: row.id, personId: row.personId, username: row.username, isAdmin: row.isAdmin }
}
