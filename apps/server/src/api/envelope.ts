import type { FastifyReply } from 'fastify'
import { ConfigError, TransientError } from '@haelan/core'

// Second style, /api/v1 only. Every older route answers { error: 'a string' }, occasionally with
// a sibling field, and the setup wizard's own client reads that flat shape; migrating it is a
// later milestone's job, not this one's.
export type ErrorKind = 'unauthorized' | 'forbidden' | 'not_found' | 'setup_incomplete' | 'config' | 'transient'

export interface ApiErrorBody {
  error: { kind: ErrorKind, code: string, message: string }
}

const STATUS_BY_KIND: Record<ErrorKind, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  setup_incomplete: 409,
  config: 400,
  transient: 503,
}

export function statusFor(kind: ErrorKind): number {
  return STATUS_BY_KIND[kind]
}

export function errorBody(kind: ErrorKind, code: string, message: string): ApiErrorBody {
  return { error: { kind, code, message } }
}

/**
 * Maps whatever a core call threw to a response. ConfigError names the real problem, so its
 * message is the useful thing to show a caller. TransientError means retrying can work. Anything
 * else is a bug in us: echoing its message risks a query, a path or a row leaking into a
 * response, so it goes to the log and the caller gets a bare 500.
 */
export function sendCoreError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ConfigError) {
    return reply.code(statusFor('config')).send(errorBody('config', 'config', error.message))
  }
  if (error instanceof TransientError) {
    return reply.code(statusFor('transient')).send(errorBody('transient', 'transient', error.message))
  }
  console.error(error)
  return reply.code(500).send(errorBody('transient', 'internal_error', 'something went wrong'))
}
