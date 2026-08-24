export type ApiErrorKind =
  | 'unauthorized' | 'forbidden' | 'not_found' | 'setup_incomplete'
  | 'config' | 'transient' | 'unreachable'

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

  const text = await response.text()
  const parsed: unknown = text === '' ? {} : JSON.parse(text)

  if (response.ok) return parsed as T

  const named = (parsed as ErrorBody).error
  const kind = KIND_BY_STATUS[response.status] ?? (response.status >= 500 ? 'transient' : 'config')
  throw new ApiError(kind, response.status, named?.message ?? named?.code ?? `request failed with ${response.status}`)
}

export function apiGet<T>(path: string): Promise<T> {
  return apiSend<T>('GET', path)
}
