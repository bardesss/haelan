import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { people } from './people.ts'

// One row, id 'default'. The client is instance level because one OAuth client serves the
// whole household. Spec section 7.
export const oauthClient = sqliteTable('oauth_client', {
  id: text('id').primaryKey(),
  clientId: text('client_id').notNull(),
  clientSecretEncrypted: text('client_secret_encrypted').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
})

export const credentials = sqliteTable('credentials', {
  personId: text('person_id').primaryKey().references(() => people.id),
  refreshTokenEncrypted: text('refresh_token_encrypted').notNull(),
  grantedScopes: text('granted_scopes').notNull(),
  // Set when a refresh returns invalid_grant. Sync pauses for this person alone and the
  // dashboard shows a reconnect banner. Spec section 13.
  revokedAtMs: integer('revoked_at_ms'),
  obtainedAtMs: integer('obtained_at_ms').notNull(),
  clientIdOverride: text('client_id_override'),
  clientSecretOverrideEncrypted: text('client_secret_override_encrypted'),
})
