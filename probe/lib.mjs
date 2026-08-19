import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const TOKENS = new URL('./.tokens.json', import.meta.url)
const API_ROOT = 'https://health.googleapis.com/v4'

export function loadEnv() {
  const text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  const env = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return env
}

export function loadTokens() {
  if (!existsSync(TOKENS)) throw new Error('run: node probe/auth.mjs')
  return JSON.parse(readFileSync(TOKENS, 'utf8'))
}

export function saveTokens(t) {
  writeFileSync(TOKENS, JSON.stringify(t, null, 2))
}

export async function refresh() {
  const env = loadEnv()
  const t = loadTokens()
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: t.refresh_token,
      grant_type: 'refresh_token',
    }),
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(`refresh failed ${res.status}: ${JSON.stringify(body)}`)
    err.status = res.status
    err.body = body
    throw err
  }
  saveTokens({ ...t, access_token: body.access_token, expires_at: Date.now() + body.expires_in * 1000 })
  return body.access_token
}

export async function accessToken() {
  const t = loadTokens()
  if (t.expires_at && t.expires_at > Date.now() + 60_000) return t.access_token
  return refresh()
}

// Rollup methods are POST with a JSON body, so method and body are parameters rather than
// assumed GET.
export async function api(path, params = {}, { method = 'GET', body } = {}) {
  const url = new URL(API_ROOT + path)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const init = { method, headers: { authorization: `Bearer ${await accessToken()}` } }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await fetch(url, init)
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${url.pathname}: ${text.slice(0, 400)}`)
  return { json: text ? JSON.parse(text) : {}, raw: text, url: url.toString() }
}
