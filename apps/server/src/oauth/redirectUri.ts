export const CALLBACK_PATH = '/oauth/callback'

export interface RedirectCandidate {
  uri: string
  label: string
  registrable: boolean
  /** Google's rule, quoted, when the value cannot be registered. */
  reason?: string
}

// Quoted from developers.google.com/identity/protocols/oauth2/web-server and confirmed against
// the live console in probe/findings/console-steps.md rather than recalled.
const RULE_SCHEME = 'Redirect URIs must use the HTTPS scheme, not plain HTTP. Localhost URIs (including localhost IP address URIs) are exempt from this rule.'
const RULE_IP = 'Hosts cannot be raw IP addresses. Localhost IP addresses are exempted from this rule.'
const RULE_TLD = 'Host TLDs (Top Level Domains) must belong to the public suffix list.'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

export function loopbackCandidates(port: number): RedirectCandidate[] {
  return [
    { uri: `http://localhost:${port}${CALLBACK_PATH}`, label: 'This machine', registrable: true },
    { uri: `http://127.0.0.1:${port}${CALLBACK_PATH}`, label: 'This machine, literal loopback', registrable: true },
  ]
}

export function candidateFor(hostOrUrl: string): RedirectCandidate {
  const trimmed = hostOrUrl.trim()
  const label = 'Reverse proxy or Tailscale'
  if (trimmed === '') return { uri: '', label, registrable: false, reason: 'Enter a hostname.' }

  // A bare hostname is read as https, because https is the only thing Google will register for
  // a non loopback host. Guessing http would produce a value the console refuses.
  const hasScheme = /^https?:\/\//i.test(trimmed)
  const parsed = safeUrl(hasScheme ? trimmed : `https://${trimmed}`)
  if (!parsed) return { uri: '', label, registrable: false, reason: 'That is not a hostname a URL can be built from.' }

  const host = parsed.hostname
  const isLoopback = LOOPBACK.has(host)
  const uri = `${parsed.protocol}//${parsed.host}${CALLBACK_PATH}`

  if (isLoopback) return { uri, label: 'This machine', registrable: true }
  if (IPV4.test(host)) return { uri, label, registrable: false, reason: RULE_IP }
  if (parsed.protocol !== 'https:') return { uri, label, registrable: false, reason: RULE_SCHEME }
  // The real public suffix list is not shipped here, so this is a shape check and Google stays
  // the authority. It exists to catch .local and bare labels before consent, not to reproduce
  // the list.
  if (host.endsWith('.local') || !/\.[a-z]{2,}$/i.test(host)) {
    return { uri, label, registrable: false, reason: RULE_TLD }
  }
  return { uri, label, registrable: true }
}

export function redirectUriFor(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${CALLBACK_PATH}`
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}
