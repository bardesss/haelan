import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core'
import { people } from './people.ts'

// One account, one person, enforced by the unique constraint rather than by convention.
// Spec section 15: each account sees only its own data, and there is no sharing. The one
// exception, added when accounts gained self-management, is named rather than general: an admin
// may reset another member's password, because an instance with no mail server has no other way
// back in. It reaches no row of theirs - the isolation suites still prove an admin cannot query
// another person's data - so it is a recovery door, not a role hierarchy.
export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().unique().references(() => people.id),
  /** Lower cased at write time, which is what makes the unique index a real one. */
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  // Who may change instance level settings such as the OAuth client, and who may reset another
  // member's password when they are locked out of it. Not a data visibility role: spec section 15
  // gives no admin a way to read another person's rows, and the password reset does not become
  // one, since it hands back an account rather than what is inside it.
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntilMs: integer('locked_until_ms'),
  createdAtMs: integer('created_at_ms').notNull(),
  // A timestamp rather than a boolean: "when was this account suspended" is the question an admin
  // asks afterwards, and a boolean throws the answer away. Null means active.
  disabledAtMs: integer('disabled_at_ms'),
  // When this account last signed in, for the members list. Null until it signs in once, which is
  // every account that existed before this column did.
  //
  // Here rather than derived from auth_sessions.lastSeenAtMs, which looks like the same answer and
  // is not: sessions expire and are swept, so that value goes blank exactly for the dormant member
  // it would be consulted about. A deliberate decision rather than a side effect of a screen - it
  // is the first thing this app records about when a person uses it, and it is visible to the
  // household's admin. Nothing else reads it, no behaviour turns on it, and it is one timestamp
  // rather than a history: "when did they last sign in", not "when have they ever signed in".
  lastLoginAtMs: integer('last_login_at_ms'),
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
  // How many completed backups the folder keeps, and how long between them. Nullable with no
  // default, unlike every other column above, and that is what makes the one-time seed from the
  // old HAELAN_BACKUP_KEEP / HAELAN_BACKUP_INTERVAL_HOURS variables possible: null means nobody
  // has chosen yet, so an instance that was already running with backups switched off can be
  // handed its own value once rather than silently starting to keep seven. A default here would
  // erase that distinction the moment the migration ran. Reads resolve null through
  // DEFAULT_BACKUP_KEEP / DEFAULT_BACKUP_INTERVAL_HOURS in store/settings.ts.
  backupKeep: integer('backup_keep'),
  backupIntervalHours: integer('backup_interval_hours'),
  setupCompletedAtMs: integer('setup_completed_at_ms'),
  // Whether this instance may ask GitHub whether a newer release exists. Off by default, and the
  // default is the point: everything else this program does stays inside the household, and a
  // check that contacted a third party without being asked would quietly end that property for
  // every instance that upgraded into it. An admin turns it on knowing what it sends, which is a
  // request for one public release tag and nothing about this instance beyond the fact that it
  // asked. See apps/server/src/updates.ts for what goes over the wire.
  updateCheckEnabled: integer('update_check_enabled', { mode: 'boolean' }).notNull().default(false),
  // Whether a workout's route card may fetch map tiles from a third party to draw a basemap under
  // the trace. Off by default, for a sharper reason than updateCheckEnabled above: a route's first
  // and last point is usually this household's own address, and a tile request is what tells the
  // map provider where that is. See apps/web/src/pages/activity/WorkoutRoute.tsx for what a tile
  // request sends and what stays local when this is off.
  routeBasemapEnabled: integer('route_basemap_enabled', { mode: 'boolean' }).notNull().default(false),
  // True when the wizard was finished through the companion app instead of Google OAuth.
  // The step derivation reads it to skip the client and consent steps, and it stays readable
  // afterwards so the dashboard can say where this instance's data comes from.
  companionMode: integer('companion_mode', { mode: 'boolean' }).notNull().default(false),
  updatedAtMs: integer('updated_at_ms').notNull(),
})

/**
 * The credential a remote agent presents at `POST /mcp`, stored the way auth_sessions and invites
 * store theirs: the sha256 of the value, never the value. A copied database is a list of expiry
 * times rather than a set of working keys.
 *
 * SHA-256 rather than the argon2 accounts.password_hash uses, and that is the right algorithm here
 * rather than a shortcut. Argon2's cost - OWASP's 19 MiB and two passes - exists to make guessing
 * a *low-entropy* secret expensive, and a 32-byte random token has no entropy to guess. Paying it
 * on every request would buy nothing. A password is chosen by a human; this is not.
 *
 * There is no capability column. Read-only is the only kind of token that exists, and a flag
 * nobody can set is a flag that cannot be set wrong later. Writes, if they are ever wanted, arrive
 * with their own migration.
 */
export const mcpTokens = sqliteTable('mcp_tokens', {
  id: text('id').primaryKey(),
  // An account, never a person. The person comes from accounts.person_id, which is notNull and
  // unique, so a forged or edited token cannot be made to point at a different household member.
  accountId: text('account_id').notNull().references(() => accounts.id),
  // Required, unlike anything else on this table. A token you cannot identify is a token you will
  // not revoke, and the whole value of the list on the Profile card is that each row says which
  // machine it is.
  label: text('label').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAtMs: integer('created_at_ms').notNull(),
  // Mandatory, unlike a session's, and chosen from 30 / 90 / 365 days at creation. A credential
  // for a machine outlives every visit to the screen that could have retired it.
  expiresAtMs: integer('expires_at_ms').notNull(),
  // What makes a leaked token visible rather than theoretical. Null until the first call.
  lastUsedAtMs: integer('last_used_at_ms'),
  // A stamp rather than a delete, so mcp_calls rows still name something after a revocation - and
  // so the one place an attack shows up does not erase itself when the attack is stopped.
  revokedAtMs: integer('revoked_at_ms'),
})

export const MCP_CALL_OUTCOMES = ['ok', 'error', 'refused'] as const
export type McpCallOutcome = (typeof MCP_CALL_OUTCOMES)[number]

/**
 * When, which token, which tool, how much came back, how long it took, and how it ended.
 *
 * **There is no column for argument values, and there never is to be one.** Not a filter and not
 * an allow-list: the table structurally cannot record that somebody searched their notes for a
 * word they would not say aloud. A durable log of search terms is a new privacy surface in a
 * health application, and this log's purpose does not need one - a token used at four in the
 * morning, or one that returned forty thousand rows in a minute, is visible from the shape alone.
 *
 * `token_id` is notNull, which is also the rule for what gets written: a presented secret that
 * matches no row at all writes nothing. That keeps an anonymous caller from growing this table by
 * guessing, on a surface that is deliberately not rate limited yet, and costs nothing the log was
 * for - a leaked token is a known row, which is the case worth seeing.
 *
 * stdio calls are absent by construction. That entry opens the database through `openReadOnly`,
 * which cannot write a row; opening it read-write to log would trade a guarantee for an audit
 * trail that protects nothing, since reaching stdio requires `docker exec` and a process with that
 * already holds the volume, the database and the encryption key.
 */
export const mcpCalls = sqliteTable('mcp_calls', {
  id: text('id').primaryKey(),
  tokenId: text('token_id').notNull().references(() => mcpTokens.id),
  atMs: integer('at_ms').notNull(),
  // Null on a refusal: the guard turns a call away before any tool name is known.
  tool: text('tool'),
  // Spelled row_count rather than rows: ROWS is a window-frame keyword in SQLite and the name is
  // not worth the question.
  rowCount: integer('row_count'),
  durationMs: integer('duration_ms'),
  outcome: text('outcome', { enum: MCP_CALL_OUTCOMES }).notNull(),
}, (t) => [
  // What the Profile card reads: this account's tokens, newest call first.
  index('mcp_calls_token_at').on(t.tokenId, t.atMs),
  // What the prune reads.
  index('mcp_calls_at').on(t.atMs),
])
