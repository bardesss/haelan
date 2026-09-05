export type ApiErrorKind =
  | 'unauthorized' | 'forbidden' | 'not_found' | 'setup_incomplete'
  | 'config' | 'transient' | 'internal' | 'unreachable'

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status: number | null

  // Declared and assigned rather than written as constructor parameter properties: Node's type
  // stripping is strip-only and rejects parameter properties, the same reason HaelanError in
  // packages/core/src/errors.ts is written this way.
  constructor(kind: ApiErrorKind, status: number | null, message: string) {
    super(message)
    this.kind = kind
    this.status = status
    this.name = 'ApiError'
  }
}

const KIND_BY_STATUS: Record<number, ApiErrorKind> = {
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'setup_incomplete',
}

// The kinds a body can actually declare. 'unreachable' is deliberately absent: it is what a
// thrown fetch becomes, below, and never a status the instance itself answered with, so a body
// spelling it would not be believed.
const KNOWN_KINDS = new Set<ApiErrorKind>([
  'unauthorized', 'forbidden', 'not_found', 'setup_incomplete', 'config', 'transient', 'internal',
])

interface ErrorBody { error?: { kind?: string, code?: string, message?: string } }

export async function apiSend<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    // A thrown fetch is the network, never a status. Collapsing this into the status handling
    // below would report an unreachable instance as an expired session and sign the reader out.
    throw new ApiError('unreachable', null, 'the instance did not answer')
  }

  let parsed: unknown
  try {
    const text = await response.text()
    // Empty body becomes empty object for both success and error paths, since 204 has no body to read.
    parsed = text === '' ? {} : JSON.parse(text)
  } catch {
    // The instance answered (response received) but could not parse the body. This happens when
    // a reverse proxy returns HTML for a 502 or other error.
    if (response.ok) {
      throw new ApiError('transient', response.status, 'failed to read response body')
    }
    const kind = KIND_BY_STATUS[response.status] ?? (response.status >= 500 ? 'transient' : 'config')
    throw new ApiError(kind, response.status, `request failed with ${response.status}`)
  }

  if (response.ok) return parsed as T

  const named = (parsed as ErrorBody).error
  // The envelope's own kind first. The status map cannot tell a deterministic 500 from a
  // transient one, which is exactly the distinction envelope.ts introduced 'internal' to carry,
  // and the retry predicate in queryClient.tsx is the caller it was introduced for. Only a kind
  // this client recognises is trusted; an older route or a proxy answering on its behalf can send
  // anything in that field, and falling back to the status map is exactly what happened before
  // this field was read at all.
  const declared = typeof named?.kind === 'string' && KNOWN_KINDS.has(named.kind as ApiErrorKind)
    ? named.kind as ApiErrorKind
    : null
  const kind = declared ?? KIND_BY_STATUS[response.status] ?? (response.status >= 500 ? 'transient' : 'config')
  throw new ApiError(kind, response.status, named?.message ?? named?.code ?? `request failed with ${response.status}`)
}

export function apiGet<T>(path: string): Promise<T> {
  return apiSend<T>('GET', path)
}
