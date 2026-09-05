import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'
import { people } from './people.ts'

// One account, one person, enforced by the unique constraint rather than by convention.
// Spec section 15: each account sees only its own data, there is no sharing and no override.
export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().unique().references(() => people.id),
  /** Lower cased at write time, which is what makes the unique index a real one. */
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  // Who may change instance level settings such as the OAuth client. Not a data visibility
  // role: spec section 15 has no admin override over another person's data.
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntilMs: integer('locked_until_ms'),
  createdAtMs: integer('created_at_ms').notNull(),
  // A timestamp rather than a boolean: "when was this account suspended" is the question an admin
  // asks afterwards, and a boolean throws the answer away. Null means active.
  disabledAtMs: integer('disabled_at_ms'),
})

// Not called sessions: that name belongs to sleep and exercise in tier 2.
export const authSessions = sqliteTable('auth_sessions', {
  // The sha256 of the cookie value, never the value. A copied database is then a list of
  // expiry times rather than a set of live sessions.
  idHash: text('id_hash').primaryKey(),
  accountId: text('account_id').notNull().references(() => accounts.id),
  createdAtMs: integer('created_at_ms').notNull(),
  expiresAtMs: integer('expires_at_ms').notNull(),
  lastSeenAtMs: integer('last_seen_at_ms').notNull(),
})

// An invite is a live credential until it is redeemed - it is the thing that creates an account -
// so it is stored the way auth_sessions stores a session: the hash of the token, never the token.
// A copied database is then a list of expiry times rather than a set of usable links.
//
// The person row exists before the invite does, which is the arrangement the parent spec says the
// people/accounts split is for: somebody can exist as a person before anyone can log in as them.
export const invites = sqliteTable('invites', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().references(() => people.id),
  tokenHash: text('token_hash').notNull().unique(),
  createdByAccountId: text('created_by_account_id').notNull().references(() => accounts.id),
  createdAtMs: integer('created_at_ms').notNull(),
  expiresAtMs: integer('expires_at_ms').notNull(),
  // Null until redeemed. Kept rather than deleted so an admin's list can say what happened to an
  // invite, and so a redeemed token cannot be re-redeemed by a row that no longer exists to refuse.
  redeemedAtMs: integer('redeemed_at_ms'),
  revokedAtMs: integer('revoked_at_ms'),
})

export const CONSENT_PATHS = ['localhost', 'tailscale', 'proxy'] as const
export type ConsentPath = (typeof CONSENT_PATHS)[number]

// One row, id 'default'. baseUrl is what the redirect URI is derived from, so it is stored
// rather than read from a request header at consent time: a request arriving through a
// different host must not silently change the URI Google was told about.
export const instanceSettings = sqliteTable('instance_settings', {
  id: text('id').primaryKey(),
  baseUrl: text('base_url').notNull(),
  consentPath: text('consent_path', { enum: CONSENT_PATHS }).notNull(),
  syncIntervalMinutes: integer('sync_interval_minutes').notNull().default(60),
  // The literal below must stay 730: a drizzle default has to be a constant the migration
  // generator can serialise, so it cannot reference DEFAULT_USER_HORIZON_DAYS in catalogue.ts.
  // A test pins the two together so they cannot drift apart.
  backfillHorizonDays: integer('backfill_horizon_days').notNull().default(730),
  // Two sessions of the same kind are one event when their overlap exceeds this fraction of the
  // shorter one. Master design section 9 names 50 percent and calls it configurable; the column
  // exists from the start so the value is never a constant somebody has to go digging for.
  sessionOverlapRatio: real('session_overlap_ratio').notNull().default(0.5),
  // Sleep sessions on one local date join into one night when the gap between them is at most
  // this. A wake long enough for the watch to end a session and start another is ordinary, and
  // reporting only the longer piece would lose the rest of the night every time it happens.
  nightGapMinutes: integer('night_gap_minutes').notNull().default(120),
  setupCompletedAtMs: integer('setup_completed_at_ms'),
  updatedAtMs: integer('updated_at_ms').notNull(),
})
