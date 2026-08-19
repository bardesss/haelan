import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { loadEnv, saveTokens } from './lib.mjs'

const env = loadEnv()
const REDIRECT = 'http://localhost:8899/callback'

// The six read scopes the shipped v1 pages need. Derived per data type from
// developers.google.com/health/data-types: heart rate and weight are health metrics, not
// activity, which is not obvious from the page names.
const DEFAULT_SCOPES = [
  'activity_and_fitness',
  'sleep',
  'health_metrics_and_measurements',
  'nutrition',
  'profile',
  'settings',
].map((s) => `https://www.googleapis.com/auth/googlehealth.${s}.readonly`)

const SCOPES = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_SCOPES

const state = randomBytes(16).toString('hex')
const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID)
authUrl.searchParams.set('redirect_uri', REDIRECT)
authUrl.searchParams.set('response_type', 'code')
authUrl.searchParams.set('scope', SCOPES.join(' '))
authUrl.searchParams.set('access_type', 'offline')
authUrl.searchParams.set('prompt', 'consent')
authUrl.searchParams.set('state', state)

console.log('\nrequesting scopes:')
for (const s of SCOPES) console.log('  ' + s)
console.log('\nOpen this URL and grant consent:\n')
console.log(authUrl.toString(), '\n')

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8899')
  if (url.pathname !== '/callback') return res.end('waiting')
  if (url.searchParams.get('state') !== state) return res.end('state mismatch')

  const denied = url.searchParams.get('error')
  if (denied) {
    console.log('consent denied:', denied, url.searchParams.get('error_description') ?? '')
    res.end('Consent denied, see the terminal.')
    return server.close()
  }

  const token = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: url.searchParams.get('code'),
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    }),
  }).then((r) => r.json())

  if (!token.access_token) {
    console.log('token exchange failed:', token)
    res.end('Token exchange failed, see the terminal.')
    return server.close()
  }

  saveTokens({
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    scope: token.scope,
    expires_at: Date.now() + token.expires_in * 1000,
    obtained_at: new Date().toISOString(),
  })

  console.log('tokens saved. refresh_token present:', Boolean(token.refresh_token))
  console.log('granted scopes:', token.scope)
  const requested = new Set(SCOPES)
  const granted = new Set((token.scope ?? '').split(' '))
  const missing = [...requested].filter((s) => !granted.has(s))
  if (missing.length) console.log('NOT granted:', missing.join(' '))
  res.end('Done, close this tab.')
  server.close()
}).listen(8899)
