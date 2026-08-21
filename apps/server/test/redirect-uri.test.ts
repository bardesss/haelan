import { describe, it, expect } from 'vitest'
import { loopbackCandidates, candidateFor, redirectUriFor } from '../src/oauth/redirectUri.ts'

describe('redirect URI candidates', () => {
  it('offers both loopback forms, complete and carrying the running port', () => {
    expect(loopbackCandidates(4235).map((c) => c.uri)).toEqual([
      'http://localhost:4235/oauth/callback',
      'http://127.0.0.1:4235/oauth/callback',
    ])
    expect(loopbackCandidates(4235).every((c) => c.registrable)).toBe(true)
  })

  it('uses the port it was given rather than a hard coded 4235', () => {
    expect(loopbackCandidates(9999)[0]?.uri).toBe('http://localhost:9999/oauth/callback')
  })

  it('accepts a Tailscale name and assumes https for a bare hostname', () => {
    expect(candidateFor('box.tail1234.ts.net')).toMatchObject({
      uri: 'https://box.tail1234.ts.net/oauth/callback', registrable: true,
    })
  })

  it('rejects a private IP and quotes the rule, because the console rejects it too', () => {
    const candidate = candidateFor('192.168.178.82')
    expect(candidate.registrable).toBe(false)
    expect(candidate.reason).toContain('Hosts cannot be raw IP addresses')
  })

  it('rejects plain http on a non loopback host', () => {
    const candidate = candidateFor('http://box.example.com')
    expect(candidate.registrable).toBe(false)
    expect(candidate.reason).toContain('must use the HTTPS scheme')
  })

  it('rejects a .local name, which fails the public suffix rule', () => {
    expect(candidateFor('haelan.local').registrable).toBe(false)
  })

  it('accepts loopback over plain http, which is the documented exemption', () => {
    expect(candidateFor('http://localhost:4235').registrable).toBe(true)
    expect(candidateFor('http://127.0.0.1:4235').registrable).toBe(true)
  })

  it('never emits a placeholder, whatever it was handed', () => {
    for (const input of ['192.168.178.82', 'haelan.local', 'box.tail1234.ts.net', '', 'not a url']) {
      expect(candidateFor(input).uri).not.toMatch(/[<>]/)
    }
  })

  it('derives the callback from a stored base URL without doubling the slash', () => {
    expect(redirectUriFor('http://localhost:4235')).toBe('http://localhost:4235/oauth/callback')
    expect(redirectUriFor('http://localhost:4235/')).toBe('http://localhost:4235/oauth/callback')
  })
})
