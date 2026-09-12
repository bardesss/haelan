# @haelan/server

The Fastify app. It is the only package that knows what HTTP is: everything that issues SQL or
talks to Google lives in `@haelan/core`, and this app holds routes, cookies, redirects, the
scheduler and the event stream. One process, one port, one SQLite file.

Default port 4235. Override with `HAELAN_PORT`, the data directory with `HAELAN_DATA_DIR`
(default `/data`), the bind address with `HAELAN_HOST` (default `0.0.0.0`). All three have
working defaults because spec section 15 promises an install with no environment variables and
no edited files; the variables exist for people who disagree.

## Reading data

Setup, auth, sync and one settings control are not the whole API surface any more. The metric
routes spec section 11 describes — daily series, baselines, insights, trend, intraday, sleep
nights, sessions and session detail — plus annotations, sources, data type exclusions, change
tracking and export, are versioned at `/api/v1/p/:personId/...`, guarded by the same session check
everything below is — an `Authorization: Bearer` token or the session cookie, the header winning
when both arrive, so a native client is not a browser session's passenger — and refuse a
`personId` that is not the caller's own with a 403 rather than someone else's data.
`apps/server/src/routes/v1/` is where every one of those routes lives; the table below stays
scoped to setup, auth, sync and settings.

M4a-2 adds a second way to read the same data: the MCP tool surface in
[`TOOLS.md`](../../TOOLS.md), reached over stdio today
(`node --experimental-strip-types apps/server/src/mcp.ts --person <name>`) and, from M4a-3, over
`POST /mcp` as well — both transports read through the same person bound query layer the routes
above do.

## Routes

| Route | Auth | What it does |
|---|---|---|
| `GET /api/health` | none | Liveness. Open during setup, because a container probe has no cookie. |
| `GET /api/setup/state` | none | The step that is due. Open in both directions; the SPA asks on every load. |
| `POST /api/setup/account` | none | Creates the first person and account together, and logs the owner in. |
| `POST /api/setup/instance-url` | session | Stores the base URL and returns the exact redirect URI to register. |
| `GET /api/setup/redirect-uris` | session | Concrete, complete candidates. Never a placeholder. |
| `GET /api/setup/scopes` | session | The six scopes the consent screen declares, for the wizard to list. |
| `POST /api/setup/google-client` | session | Stores the pasted OAuth client, encrypted. |
| `GET /api/setup/last-error` | session | The message from the last failed callback, for the wizard to show. |
| `GET /oauth/start` | session | Redirects to Google with a signed state. |
| `GET /oauth/callback` | none | Exchanges the code, probes access, stores the token, marks setup complete. |
| `POST /api/auth/login` | none | Session cookie, or 401, or 423 once locked. |
| `POST /api/auth/logout` | none | Destroys the session server side. Immediate, not eventual. |
| `GET /api/auth/me` | session | The person this session belongs to. |
| `GET /api/sync/status` | session | Run state and per data type backfill progress, read from `sync_state`. |
| `POST /api/sync/run` | session | 202 and the run continues, or 409 if one is already going. |
| `GET /api/sync/events` | session | Server sent events: the runner's progress, plus a keepalive. |
| `GET /api/settings/backfill-horizon` | session | The current horizon and the three the wizard offers. |
| `PUT /api/settings/backfill-horizon` | session | Sets it, and reopens daily types that already finished. |

## The setup gate points both ways

While setup is unfinished, every API route that is not a setup route answers `409
setup_incomplete` and names the step that is due. Once setup is finished, the setup routes
themselves answer `409 setup_complete`: after the wizard there is nothing left to paste and no
client left to configure.

**Every route after the account step takes a session.** The account step cannot, because it is
what mints the one the others present. `/api/setup/instance-url`, `/api/setup/redirect-uris`,
`/api/setup/scopes` and `/api/setup/last-error` were open until 2026-08-22, while this table
already said they were not; the setup gate bounded that to the setup window, where an
unauthenticated caller on the network could set the base URL consent is later required to match.

The gate governs `/api/` and `/oauth/` only. A document request for `/setup/google` falls
through to the static handler and gets the SPA shell, because that is how the wizard is reached
in the first place and answering it with a JSON 409 would make an unconfigured instance
impossible to configure.

Reconnecting a person whose token was revoked is deliberately not a way back in here.
`markRevoked` and `clearRevoked` exist in core and nothing in M1d calls them; the reconnect
banner is M2's, and it gets an authenticated route rather than reopening the wizard's door.

## The session cookie sets Secure only over https

`httpOnly`, `SameSite=Lax`, `Path=/`, 30 days, and `Secure` only when the request arrived over
https, which behind a reverse proxy means `X-Forwarded-Proto`. A LAN instance on plain http
cannot set `Secure`: a browser would drop the cookie and nobody could log in. So on plain http
the cookie is readable by anyone who can sniff that LAN. Spec section 15 already draws the trust
boundary at the LAN, and this is that trade written down rather than discovered later.

Mutating requests also carry an Origin check against Host. `SameSite=Lax` already blocks a cross
site form POST; the check closes the gap for clients that send Origin without the cookie policy
being what we assumed.

## One process, one mutex

`SyncRunner` refuses to start a second run while one is in flight, rather than queueing: a
queued run would still be going when the next scheduled tick arrived, and the useful answer to
"sync now" during a sync is that one is already going.

`trigger` awaits the run. `tryStart` takes the mutex synchronously and leaves the run going,
which is what `POST /api/sync/run` calls so the browser gets its 202 before a backfill batch
finishes. Both take the same mutex, so the refusal is a real answer rather than a race.

Backfill and the trailing sync share one token bucket, so a backfill cannot starve the nightly
run. `probe/findings/scopes.md` measured 300 requests per minute per user; the bucket refills at
180 with a burst of 10, which is 60 percent of the ceiling. A trailing week for one person is
eighteen types times seven days, roughly 126 requests, so one person's nightly run takes under a
minute and a five person household about four. A backfill batch runs on top of that.

The scheduler reads its interval from `instance_settings.sync_interval_minutes`, default 60, and
the timer is `unref`ed so an idle tick cannot keep the process alive through a shutdown.

## Backfill horizons are per data type

The walk goes backwards from today, a day at a time, writing its cursor after every window, so
an instance killed mid-backfill resumes at the day it was on rather than at today. It stops at
the type's horizon or after `batchDays` windows, whichever comes first.

The horizons differ because the volumes differ by three orders of magnitude. `probe/findings/volume.md`
measured heart rate at 37,370 rows and 23 MB of raw JSON per person-day, about 95 percent of all
rows, while every other type together is under 0.8M rows per person-year.

| Types | Horizon | Why |
|---|---|---|
| `heart-rate` | 60 days | The dense one. Five years of it is not affordable and would not finish. |
| `heart-rate-variability`, `oxygen-saturation` | 365 days | Sampled through the night rather than all day: thousands of rows a night, not tens of thousands. |
| Everything else | 1825 days | The default. Sparse enough that five years costs little. |

No type declares a horizon longer than the default, and a test enforces that: a longer one would
be a claim about Google's retention that nothing in `probe/findings/` measured.

There is no data type picker. Every listable type is enabled. Spec section 17 puts selection in
M5, and asking somebody to choose on first run asks them to decide something they have no basis
for yet.

## Testing

`test/harness.ts` builds a server on a temporary SQLite database with a stubbed Google. It
injects three seams that production leaves alone: a `limiter` (a pass through, so a suite is not
gated on wall clock refill), `backfillBatchDays` (one window per type rather than fourteen), and
the endpoint overrides that point the client and the token provider at the stub.

`test/e2e-setup.test.ts` runs the whole route over a real socket against a real `node:http` stub,
from an empty volume to rows in tier 2, and asserts the second run writes no new ones.

Every payload the stub serves is built by `packages/core/src/testing/payloads.ts`, which invents
every value it emits. Nothing under `probe/samples/` is ever read by a test.
