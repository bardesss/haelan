// Spec section 13 gives each failure class one defined behaviour. A caller that has to match on
// message text to find the class will eventually treat a schema change as a rate limit.
export type ErrorKind = 'auth' | 'transient' | 'schema_drift' | 'data_quality' | 'config'

export class HaelanError extends Error {
  // Declared and assigned rather than written as a constructor parameter property. Node's
  // type stripping is strip-only and rejects parameter properties outright, so the shorthand
  // would compile here and fail to boot the server. See apps/server/test/boot.test.ts.
  readonly kind: ErrorKind

  /**
   * The message without the `[kind]` tag `message` carries.
   *
   * The tag exists for a log line, where nothing else states the class. A response body states it
   * in a field of its own, so echoing `message` there put the class in twice and a caller read
   * `"[config] metric is required"` next to `kind: "config"`. Kept as a field rather than stripped
   * back off with a regex at the boundary, so there is one place the two forms are decided.
   */
  readonly detail: string

  constructor(kind: ErrorKind, message: string, options?: { cause?: unknown }) {
    super(`[${kind}] ${message}`, options)
    this.kind = kind
    this.detail = message
    this.name = new.target.name
  }
}

export class AuthError extends HaelanError {
  constructor(message: string, options?: { cause?: unknown }) { super('auth', message, options) }
}

export class TransientError extends HaelanError {
  constructor(message: string, options?: { cause?: unknown }) { super('transient', message, options) }
}

export class SchemaDriftError extends HaelanError {
  constructor(message: string, options?: { cause?: unknown }) { super('schema_drift', message, options) }
}

export class DataQualityError extends HaelanError {
  constructor(message: string, options?: { cause?: unknown }) { super('data_quality', message, options) }
}

export class ConfigError extends HaelanError {
  constructor(message: string, options?: { cause?: unknown }) { super('config', message, options) }
}

// Distinct from RevokedError (api/tokens.ts): nobody revoked anything, and the row on disk is
// exactly what putRefreshToken wrote. instance.key just cannot open it - the shape a backup
// restored onto a different machine takes, since a backup deliberately carries no key of its
// own. From this process's point of view the person is neither connected nor never-connected,
// so it gets a kind of its own rather than folding into either.
//
// `personId` is null for the household OAuth client secret, which the same key seals and which
// therefore goes unreadable in exactly the same breath as every token. It belongs to the
// household rather than to a person, so there is nobody to name; it is not a second error class
// because it is not a second condition - one key stopped opening what it sealed, and a caller
// that has learned to treat this class as "the key cannot open this" would gain nothing from
// having to learn a second name for the same sentence.
export class CredentialsUnreadableError extends AuthError {
  readonly personId: string | null

  constructor(personId: string | null, options?: { cause?: unknown }) {
    super(personId === null
      ? 'the household OAuth client secret cannot be decrypted'
      : `refresh token for person ${personId} cannot be decrypted`, options)
    this.personId = personId
  }
}

// A 4xx that is not 429 means the request was wrong, which retrying cannot fix. Treating it as
// schema drift is what puts the archived payload in front of a human instead of in a retry loop.
export function classifyHttp(status: number): 'transient' | 'schema_drift' {
  return status === 429 || status >= 500 ? 'transient' : 'schema_drift'
}
