# M0: Google Health API Auth Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer the three questions that shape every downstream milestone: how Google classifies the health OAuth scopes, how long a refresh token actually survives, and what the v4 payloads really look like.

**Architecture:** A throwaway Node script set, no dependencies, no build step. It runs the OAuth code flow against a real Google Cloud project, calls the data endpoints, archives the raw responses locally, and starts a repeating refresh check that reports over the following week. Nothing here survives into production code. The findings and the sanitised field map do survive.

**Tech Stack:** Node 22 (built-in `fetch`, `node:http`, `node:crypto`), no npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-18-self-hosted-health-dashboard-design.md` (sections 7, 8, 18)

## Global Constraints

- **No em dashes** in prose, code, comments, UI copy or commit messages.
- **Comments are sparse** and record why, never what.
- Node 22 or later.
- **Real health data never gets committed.** `probe/samples/`, `probe/.tokens.json` and `.env.local` are gitignored. Only sanitised field maps and findings go into git.
- This milestone produces **no production code**. Everything under `probe/` is labelled throwaway and is deleted after M1 lands.

## Human-in-the-loop notice

Tasks 1 and 2 require a person at a browser: the Google Cloud Console has no scriptable path for creating an OAuth client or granting consent. Those steps are written as explicit instructions rather than commands, and the agent executing this plan must stop and hand over rather than attempting to automate them.

---

### Task 1: Create the Google Cloud project and record the scope classification

**Files:**
- Create: `probe/README.md`
- Create: `probe/findings/scopes.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing
- Produces: `probe/findings/scopes.md` recording each requested scope and its Google classification (non-sensitive, sensitive, or restricted); `.env.local` holding `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`

- [ ] **Step 1: Extend .gitignore so no credential or health payload can be committed**

```
probe/samples/
probe/.tokens.json
.env.local
```

- [ ] **Step 2: Commit the ignore rules before anything sensitive exists**

```bash
git add .gitignore
git commit -m "chore: ignore probe credentials and sample payloads"
```

- [ ] **Step 3: Human step, create the project and enable the API**

In the Google Cloud Console:
1. Create a new project named `vitals-household`.
2. Open **APIs and Services > Library**, search for the Google Health API, enable it.
3. Open **APIs and Services > OAuth consent screen**, configure it as **External**, publishing status **Testing**.
4. Add your own Google account under **Test users**.

- [ ] **Step 4: Human step, add scopes and record exactly how Google labels each one**

While adding scopes on the consent screen, the console shows a classification column for every scope. Record verbatim what it says for each health scope you add. This single observation decides whether production status is reachable without a CASA audit, so copy the labels rather than paraphrasing them.

Write `probe/findings/scopes.md`:

```markdown
# Scope classification, observed <date>

| Scope | Console label | Notes |
|---|---|---|
| <scope URL> | non-sensitive / sensitive / restricted | |

## Verdict

- Any scope labelled restricted: production status requires CASA. Periodic re-consent
  becomes part of the setup story, see spec section 7 mitigation 2.
- All scopes sensitive or lower: production status is reachable, unverified app warning
  only. Spec section 7 mitigation 1 applies.
```

- [ ] **Step 5: Human step, create the OAuth client**

**APIs and Services > Credentials > Create credentials > OAuth client ID**, type **Web application**, authorised redirect URI `http://localhost:8899/callback`. Copy the client ID and secret into `.env.local`:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

- [ ] **Step 6: Write probe/README.md**

```markdown
# Probe (throwaway)

Answers three questions before M1 starts: scope classification, refresh token lifetime,
and the real shape of v4 payloads. Delete this directory once M1 has landed.

Nothing here is production code. No error handling beyond what makes failures legible.

    node probe/auth.mjs          # one-time consent, writes probe/.tokens.json
    node probe/fetch-types.mjs   # lists data types and scopes
    node probe/fetch-samples.mjs # archives one window per data type
    node probe/refresh-check.mjs # append one refresh result to the token log
```

- [ ] **Step 7: Commit**

```bash
git add probe/README.md probe/findings/scopes.md
git commit -m "docs: record scope classification from the consent screen"
```

---

### Task 2: Run the authorisation code flow and store tokens

**Files:**
- Create: `probe/lib.mjs`
- Create: `probe/auth.mjs`

**Interfaces:**
- Consumes: `.env.local` from Task 1
- Produces: `probe/.tokens.json` containing `{access_token, refresh_token, expires_at, scope, obtained_at}`; `probe/lib.mjs` exporting `loadEnv()`, `loadTokens()`, `saveTokens(t)`, `accessToken()` which refreshes when expired, and `api(path, params)` which returns parsed JSON

- [ ] **Step 1: Write probe/lib.mjs**

```javascript
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

export async function api(path, params = {}) {
  const url = new URL(API_ROOT + path)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url, { headers: { authorization: `Bearer ${await accessToken()}` } })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${url.pathname}: ${text.slice(0, 400)}`)
  return { json: JSON.parse(text), raw: text, url: url.toString() }
}
```

- [ ] **Step 2: Write probe/auth.mjs**

```javascript
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { loadEnv, saveTokens } from './lib.mjs'

const env = loadEnv()
const REDIRECT = 'http://localhost:8899/callback'
const SCOPES = process.argv.slice(2)
if (!SCOPES.length) {
  console.error('usage: node probe/auth.mjs <scope> [<scope> ...]')
  process.exit(1)
}

const state = randomBytes(16).toString('hex')
const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID)
authUrl.searchParams.set('redirect_uri', REDIRECT)
authUrl.searchParams.set('response_type', 'code')
authUrl.searchParams.set('scope', SCOPES.join(' '))
authUrl.searchParams.set('access_type', 'offline')
authUrl.searchParams.set('prompt', 'consent')
authUrl.searchParams.set('state', state)

console.log('\nOpen this URL and grant consent:\n')
console.log(authUrl.toString(), '\n')

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:8899')
  if (url.pathname !== '/callback') return res.end('waiting')
  if (url.searchParams.get('state') !== state) return res.end('state mismatch')

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

  saveTokens({
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    scope: token.scope,
    expires_at: Date.now() + token.expires_in * 1000,
    obtained_at: new Date().toISOString(),
  })

  console.log('tokens saved. refresh_token present:', Boolean(token.refresh_token))
  console.log('granted scopes:', token.scope)
  res.end('Done, close this tab.')
  server.close()
}).listen(8899)
```

- [ ] **Step 3: Run it with the scopes recorded in Task 1**

Run: `node probe/auth.mjs <scope1> <scope2>`
Expected: browser consent completes, console prints `refresh_token present: true`, and `probe/.tokens.json` exists.

If `refresh_token present: false`, the account previously consented. Revoke access at `myaccount.google.com/permissions` and run again. `prompt=consent` should prevent this, but note the behaviour in findings if it occurs.

- [ ] **Step 4: Verify the refresh path works**

Run: `node -e "import('./probe/lib.mjs').then(m => m.refresh()).then(t => console.log('refreshed ok', t.slice(0,12)))"`
Expected: prints `refreshed ok` plus a token prefix. A failure here means the whole sync design needs rethinking, so do not proceed past it.

- [ ] **Step 5: Commit the scripts, never the tokens**

```bash
git status --short   # confirm probe/.tokens.json is NOT listed
git add probe/lib.mjs probe/auth.mjs
git commit -m "feat(probe): oauth code flow and token refresh"
```

---

### Task 3: Discover data types and archive real payloads

**Files:**
- Create: `probe/fetch-types.mjs`
- Create: `probe/fetch-samples.mjs`
- Create: `probe/findings/field-map.md`

**Interfaces:**
- Consumes: `api()`, `accessToken()` from `probe/lib.mjs`
- Produces: `probe/samples/<dataType>.json` (gitignored, real data); `probe/findings/field-map.md` listing field paths and inferred types with no values, safe to commit

- [ ] **Step 1: Write probe/fetch-types.mjs**

```javascript
import { writeFileSync, mkdirSync } from 'node:fs'
import { api } from './lib.mjs'

mkdirSync(new URL('./samples/', import.meta.url), { recursive: true })
const { json, raw } = await api('/dataTypes')
writeFileSync(new URL('./samples/_dataTypes.json', import.meta.url), raw)
for (const t of json.dataTypes ?? json.items ?? []) {
  console.log(t.name ?? t.id, '|', (t.scopes ?? []).join(' '))
}
```

Run it. If the endpoint path is wrong, the thrown error prints the status and body, which is the information needed to correct it. Record the working path in the field map.

- [ ] **Step 2: Write probe/fetch-samples.mjs**

```javascript
import { writeFileSync } from 'node:fs'
import { api } from './lib.mjs'

const TYPES = process.argv.slice(2)
const end = new Date()
const start = new Date(end.getTime() - 7 * 864e5)

for (const type of TYPES) {
  try {
    const { raw, json, url } = await api(`/dataTypes/${type}/data`, {
      startTime: start.toISOString(),
      endTime: end.toISOString(),
    })
    writeFileSync(new URL(`./samples/${type}.json`, import.meta.url), raw)
    const n = (json.data ?? json.points ?? []).length
    console.log(`${type}: ${n} records, ${(raw.length / 1024).toFixed(1)} kB, ${url}`)
  } catch (e) {
    console.log(`${type}: FAILED ${e.message}`)
  }
}
```

- [ ] **Step 3: Fetch a week of every type that matters to the dashboard**

Run: `node probe/fetch-samples.mjs steps heart_rate sleep spo2 hrv weight active_minutes breathing_rate`

Expected: one line per type with a record count and payload size. Failures are data too: record which types are unavailable and why.

- [ ] **Step 4: Write the sanitised field map**

For each archived sample, walk the JSON and record only key paths and value types, never values. Write `probe/findings/field-map.md`:

```markdown
# v4 field map, observed <date>

## steps

    data[].startTime      string, RFC3339
    data[].endTime        string, RFC3339
    data[].value          number
    data[].dataSource.id  string
    data[].dataSource.name string

Records in a 7 day window: <n>. Payload: <k> kB.
Intraday granularity observed: <e.g. 1 minute buckets>.
```

Repeat per type. This file is the input to M1's table-driven mapping module and must contain no health values.

- [ ] **Step 5: Verify nothing sensitive is staged**

Run: `git status --short --untracked-files=all | grep -c "probe/samples"`
Expected: `0`. Any other number means real health data is stageable and the ignore rules from Task 1 are wrong.

- [ ] **Step 6: Commit**

```bash
git add probe/fetch-types.mjs probe/fetch-samples.mjs probe/findings/field-map.md
git commit -m "feat(probe): archive payloads and record the v4 field map"
```

---

### Task 4: Measure resolution and projected storage volume

**Files:**
- Create: `probe/measure.mjs`
- Create: `probe/findings/volume.md`

**Interfaces:**
- Consumes: `probe/samples/*.json` from Task 3
- Produces: `probe/findings/volume.md` with observed sample intervals and projected rows per person-year, resolving spec risk 6

- [ ] **Step 1: Write probe/measure.mjs**

```javascript
import { readdirSync, readFileSync } from 'node:fs'

const dir = new URL('./samples/', import.meta.url)
for (const file of readdirSync(dir).filter((f) => !f.startsWith('_'))) {
  const json = JSON.parse(readFileSync(new URL(file, dir), 'utf8'))
  const rows = json.data ?? json.points ?? []
  if (rows.length < 2) { console.log(`${file}: ${rows.length} rows, no interval`); continue }

  const times = rows.map((r) => Date.parse(r.startTime ?? r.time)).sort((a, b) => a - b)
  const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b)
  const median = gaps[Math.floor(gaps.length / 2)] / 1000
  const perDay = 86400 / median
  console.log(
    `${file}: median interval ${median}s, ~${Math.round(perDay)} rows/day, ` +
    `~${(perDay * 365 / 1e6).toFixed(2)}M rows/person-year`
  )
}
```

- [ ] **Step 2: Run it**

Run: `node probe/measure.mjs`
Expected: one line per type with median interval and projected annual row count.

- [ ] **Step 3: Write probe/findings/volume.md with the observed numbers and the verdict**

```markdown
# Resolution and volume, observed <date>

| Type | Median interval | Rows/day | Rows/person-year |
|---|---|---|---|

Total across intraday types: <n>M rows per person-year.
Five people over five years: <n>M rows.

## Verdict

- At or near 1 minute: spec section 6 sizing holds, no downsampling policy needed.
- Finer than 1 minute on any type: record which, and add a per-metric downsampling
  decision to M1. The DuckDB escape hatch in spec section 6 bounds the consequences.
```

- [ ] **Step 4: Commit**

```bash
git add probe/measure.mjs probe/findings/volume.md
git commit -m "feat(probe): measure intraday resolution and projected volume"
```

---

### Task 5: Start the refresh token lifetime experiment

**Files:**
- Create: `probe/refresh-check.mjs`
- Create: `probe/findings/token-log.jsonl`

**Interfaces:**
- Consumes: `refresh()` from `probe/lib.mjs`
- Produces: `probe/findings/token-log.jsonl`, one JSON line per day recording success or the exact failure

This is the only task whose answer arrives later. It must be started early precisely because it takes eight days to produce a verdict, and M1 should not wait on it.

- [ ] **Step 1: Write probe/refresh-check.mjs**

```javascript
import { appendFileSync } from 'node:fs'
import { loadTokens, refresh } from './lib.mjs'

const log = new URL('./findings/token-log.jsonl', import.meta.url)
const issued = loadTokens().obtained_at
const ageDays = (Date.now() - Date.parse(issued)) / 864e5

let entry
try {
  await refresh()
  entry = { at: new Date().toISOString(), issued, ageDays: +ageDays.toFixed(2), ok: true }
} catch (e) {
  entry = { at: new Date().toISOString(), issued, ageDays: +ageDays.toFixed(2), ok: false, status: e.status, error: e.body?.error }
}
appendFileSync(log, JSON.stringify(entry) + '\n')
console.log(entry)
```

- [ ] **Step 2: Run it once to confirm it logs a success**

Run: `node probe/refresh-check.mjs`
Expected: prints an object with `ok: true` and appends one line to the log.

- [ ] **Step 3: Schedule it daily for the next ten days**

On Windows:

```powershell
schtasks /create /tn "vitals-refresh-check" /tr "node C:\Users\Bartus\Dev\health-wip\probe\refresh-check.mjs" /sc daily /st 09:00
```

- [ ] **Step 4: Commit the script and the log so far**

```bash
git add probe/refresh-check.mjs probe/findings/token-log.jsonl
git commit -m "feat(probe): daily refresh token lifetime check"
```

- [ ] **Step 5: On day 9, read the log and record the verdict**

Append to `probe/findings/token-log.jsonl` a final human note in `probe/findings/scopes.md`:

- Every line `ok: true` past day 7: tokens survive in Testing status. Spec section 7 risk downgrades substantially and the household never re-consents in normal use.
- A line with `ok: false, error: "invalid_grant"` at roughly day 7: the documented Testing status expiry is real. Publishing to production becomes mandatory if the scopes allow it, and if they do not, weekly re-consent goes into the setup guide and the reconnect banner becomes a first-class feature rather than an edge case.

---

### Task 6: Write the findings summary and fold results into the spec

**Files:**
- Create: `probe/findings/README.md`
- Modify: `docs/superpowers/specs/2026-08-18-self-hosted-health-dashboard-design.md` (sections 7 and 18)

**Interfaces:**
- Consumes: all files under `probe/findings/`
- Produces: a decision on publishing status and setup documentation, plus a resolved or re-scoped risk list

- [ ] **Step 1: Write probe/findings/README.md**

```markdown
# M0 findings

**Scope classification:** <verdict from scopes.md>
**Refresh token lifetime:** <verdict from token-log.jsonl>
**Resolution and volume:** <verdict from volume.md>
**Endpoint paths that worked:** <list>
**Types unavailable or erroring:** <list with reasons>

## Consequences for M1

<one line per consequence, each pointing at the spec section it changes>
```

- [ ] **Step 2: Update spec section 7 with the observed classification and lifetime**

Replace the speculative wording in the token longevity subsection with what was measured. Keep the mitigations that still apply and delete the ones the findings rule out.

- [ ] **Step 3: Update spec section 18, resolving risks 1, 2 and 6**

Risks that are now answered become statements of fact in their sections and are removed from the risk list. Risks that survive keep their entry with the new information attached.

- [ ] **Step 4: Commit**

```bash
git add probe/findings/README.md docs/superpowers/specs/2026-08-18-self-hosted-health-dashboard-design.md
git commit -m "docs: fold M0 findings into the spec"
```

- [ ] **Step 5: Confirm M1 can be planned**

M1 detailed planning is unblocked once `probe/findings/README.md` answers scope classification, field paths and volume. The refresh lifetime answer may still be pending on day 9; it changes setup documentation and reconnect UX, not the data model, so M1 does not wait for it.
