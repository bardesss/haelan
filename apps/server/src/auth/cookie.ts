import type { FastifyReply, FastifyRequest } from 'fastify'
import { SESSION_TTL_MS } from '@haelan/core'

export const SESSION_COOKIE = 'haelan_session'

// A reverse proxy terminates TLS and forwards plain http, so its header is the only honest
// answer to "did the browser use https". request.protocol reports this hop, not that one.
export function isHttps(request: FastifyRequest): boolean {
  const forwarded = request.headers['x-forwarded-proto']
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (typeof first === 'string' && first !== '') return first.split(',')[0]?.trim() === 'https'
  return request.protocol === 'https'
}

export function setSessionCookie(request: FastifyRequest, reply: FastifyReply, rawId: string): void {
  reply.setCookie(SESSION_COOKIE, rawId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    // Only over https. A LAN instance on plain http cannot set this, which means the cookie is
    // readable by anyone who can sniff that LAN. Spec section 15 accepts the LAN as the trust
    // boundary, and this is that trade stated where the code makes it.
    secure: isHttps(request),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' })
}
