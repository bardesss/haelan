/**
 * The raw session id a request carried in its Authorization header, or null.
 *
 * A bearer token here is a session id, not a second kind of credential: SessionStore.resolve does
 * not care which transport carried it, so one store means one revocation path rather than two
 * that have to be kept in agreement.
 */
export function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null
  const space = header.indexOf(' ')
  if (space === -1) return null
  if (header.slice(0, space).toLowerCase() !== 'bearer') return null
  const token = header.slice(space + 1).trim()
  return token === '' ? null : token
}
