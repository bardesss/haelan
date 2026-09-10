import type { FastifyReply } from 'fastify'
import { ConfigError, TransientError } from '@haelan/core'

// The shape, everywhere. There used to be a second one - every route outside /api/v1 answered
// { error: 'a string' }, sometimes with a sibling field beside it - and the cost was not the
// duplication but the silence: a client narrowing on error.kind read undefined off the string and
// fell through without saying anything. M5e-1 migrated the last of them and deleted what had grown
// to bridge the two, which was an injectable refusal in the session guard, a path-prefix branch in
// the setup gate, and a second HTTP client in the web app.
//
// `{ error: { ... } }` and nothing else. A sibling field beside `error` is how the old shape came
// back the first time; flat-surface-auth.test.ts asserts exactly these three keys on every route
// outside /api/v1, which is what stops a new route written from an old example reintroducing it.
export type ErrorKind = 'unauthorized' | 'forbidden' | 'not_found' | 'setup_incomplete' | 'config' | 'transient' | 'internal'

export interface ApiErrorBody {
  error: {
    kind: ErrorKind
    /**
     * The specific reason within the kind, for a client that wants to branch on more than the
     * status. Real on the statuses requirePerson answers: `no_session`, `no_such_person` and
     * `not_your_person` each say something `kind` does not.
     *
     * A placeholder on anything a core call threw, where it is a copy of `kind` and carries no
     * information at all. ConfigError has no code of its own to derive one from, and inventing a
     * taxonomy at this boundary would only produce codes that mean whatever the message happened
     * to say that week. Documented rather than quietly left as it was, so a client reads the
     * message on a 400 and does not build a branch on a value that will change the day core
     * grows real codes.
     */
    code: string
    message: string
  }
}

const STATUS_BY_KIND: Record<ErrorKind, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  setup_incomplete: 409,
  config: 400,
  transient: 503,
  internal: 500,
}

export function statusFor(kind: ErrorKind): number {
  return STATUS_BY_KIND[kind]
}

export function errorBody(kind: ErrorKind, code: string, message: string): ApiErrorBody {
  return { error: { kind, code, message } }
}

/**
 * Maps whatever a core call threw to a response. ConfigError names the real problem, so its
 * message is the useful thing to show a caller. TransientError means retrying can work, which is
 * exactly what an unrecognised throw does not mean: that case is a bug in us, kept under its own
 * 'internal' kind rather than folded into 'transient', because a caller that trusts kind for
 * retry logic would otherwise hammer a deterministic failure forever. Echoing its message risks a
 * query, a path or a row leaking into a response, so it goes to the log and the caller gets a
 * bare 500.
 *
 * `detail`, not `message`: HaelanError's constructor tags the message with its own kind for the
 * log, and the body already carries that kind in a field, so echoing `message` here read back to
 * a caller as "[config] metric is required" next to kind: "config". Nothing about what is logged
 * changes; the 500 branch below still hands the whole error, tag included, to console.error.
 *
 * The `code` passed on both branches is a copy of the kind. See ApiErrorBody for why it is a
 * placeholder here and real on the statuses requirePerson answers.
 */
export function sendCoreError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ConfigError) {
    return reply.code(statusFor('config')).send(errorBody('config', 'config', error.detail))
  }
  if (error instanceof TransientError) {
    return reply.code(statusFor('transient')).send(errorBody('transient', 'transient', error.detail))
  }
  console.error(error)
  return reply.code(statusFor('internal')).send(errorBody('internal', 'internal_error', 'something went wrong'))
}
