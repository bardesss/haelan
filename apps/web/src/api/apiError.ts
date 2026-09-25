export type ApiErrorKind =
  | 'unauthorized' | 'forbidden' | 'not_found' | 'setup_incomplete'
  | 'config' | 'transient' | 'internal' | 'unreachable'

// Its own module, separate from client.ts, so the demo transport (apps/web/src/demo/client.ts)
// can throw and be caught as the identical class every real caller uses - instanceof and .kind
// both depend on that - without importing client.ts itself, which is exactly the specifier the
// demo build's Vite plugin redirects to the demo module in the first place.
export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status: number | null
  // The parsed response body for a request that reached the instance and came back an error,
  // undefined for a thrown fetch or a body that would not parse. Most callers never look at this
  // (kind and status already answer "what kind of failure"); it exists for the rare body whose
  // *shape*, not just its envelope, the caller needs - the glance route's 404 `{ nearest }` (M9c)
  // is the first one, since that body carries no `error` envelope for apiSend to unpack at all.
  readonly body: unknown

  // Declared and assigned rather than written as constructor parameter properties: Node's type
  // stripping is strip-only and rejects parameter properties, the same reason HaelanError in
  // packages/core/src/errors.ts is written this way.
  constructor(kind: ApiErrorKind, status: number | null, message: string, body?: unknown) {
    super(message)
    this.kind = kind
    this.status = status
    this.body = body
    this.name = 'ApiError'
  }
}
