# Self-hosted Google Health / Fitbit dashboard with an agent surface

**Date:** 2026-08-18
**Status:** Approved design, ready for implementation planning
**Working name:** Vitals (final name is the owner's call; nothing in this design depends on it)

## 1. Context and motivation

Google is retiring the Fitbit Web API in favour of the **Google Health API v4**, with full
cutover in September 2026. The new API uses standard Google OAuth 2.0, collapses 100+ legacy
Fitbit endpoints into roughly 40 data-type bundles, and shares no field paths with the old
schema. Anyone building on Fitbit data is rewriting regardless, which makes this a good moment
to start clean.

Third-party hosted dashboards for this data run into a structural ceiling. A hosted service
authorises many people against one OAuth client, and Google caps clients that have not cleared
verification at **100 users**. Clearing verification can require a paid third-party CASA
security audit, which is out of reach for a free or small project - so these dashboards stall at
a hundred signups regardless of how good they are.

That ceiling is not a defect in any particular product. It is what happens when one hosted
client fans out to many people's accounts. **Self-hosting removes the condition that creates
it:** when an instance's only users are the people who own the OAuth client, there is no
verification to clear and no cap to hit. This is the central architectural argument of the
project, and it carries one binding consequence:

> We must never operate a shared hosted instance. Doing so would inherit the exact constraint
> this design exists to avoid.

The second motivation is the agent surface. Existing tools at best pipe a snapshot of data into
an LLM. We go further with a **Model Context Protocol server over a complete local history**,
which lets an agent investigate long-range questions with real queries instead of guesses.

## 2. Goals

1. A self-hosted dashboard that matches the visual and functional quality of the best hosted
   dashboards for this data: activity, sleep with stages and nap detection, recovery (HRV,
   resting heart rate), SpO2, weight, nutrition, daily notes, activity heatmap,
   period-over-period insights.
2. A complete local mirror of the owner's health history that outlives Google's retention
   windows and survives API changes or loss of access.
3. Context and calibration that a stateless dashboard cannot provide: typed personal events,
   per-person baselines, and user corrections to bad readings.
4. First-class agent access via MCP, plus a scriptable CLI.
5. Household multi-user: a few people, one instance, each with their own data.
6. Open source, self-hosted, no telemetry, no hosted offering.

## 3. Non-goals

- A hosted, multi-tenant SaaS. Explicitly excluded, see section 1.
- Public-internet exposure. The instance binds to localhost or LAN and is reached via reverse
  proxy or Tailscale. We ship no public deployment story.
- Writing data back to Google. Read-only against the Health API in v1.
- Mobile applications, Health Connect ingestion, or Takeout import in v1. Nothing in the data
  model assumes a single provider - samples and sessions already carry a source - so another
  ingestion path would enter through the sync engine's fetch layer without a schema change.
- Sharing or permissions modelling between household members beyond "each account sees its own
  data".

## 4. Decisions already settled

| Decision | Choice |
|---|---|
| Ingestion | Google Health API v4, household's own GCP project |
| Scope | Household: a few people, one instance |
| Stack | TypeScript monorepo, our own API client |
| v1 emphasis | Ingest + store + genuinely good dashboard; MCP and CLI included as thin layers |
| Storage strategy | Local mirror (raw archive + derived tables), not passthrough |
| Database | SQLite (WAL), `better-sqlite3` - rationale and alternatives considered in section 6 |

The passthrough model common to hosted dashboards (fetch per request, persist nothing) was
considered and rejected. It is a coherent privacy stance for a hosted service, but on a
self-hosted box the
rationale dissolves: the owner already is the database. Passthrough would buy a slower
dashboard, exposure to rate limits, no history beyond the API window, no offline use, and
expensive agent queries.

## 5. Architecture

A pnpm workspace producing one Docker image and one SQLite file.

```
core/     Google Health API client, sync engine, store, derivation, query layer
server/   Fastify: JSON API, serves the built SPA, in-process sync scheduler
mcp/      stdio (and optional HTTP) MCP server -> core query layer
cli/      commander -> core query layer
web/      React + Vite + TanStack Query + ECharts
```

`core` is the only package that issues SQL or talks to Google. `server`, `mcp`, `cli` and `web`
are adapters over a single query layer. This is what guarantees that a dashboard insight card, a
CLI table and an MCP tool answer the same question identically.

No message broker, no separate worker process, no external database. The scheduler runs
in-process in `server`.

## 6. Data model

Three tiers, distinguished by whether they are truth or cache.

### Tier 1 - durable truth (backed up, never regenerated)

- `people` - id, display name, timezone.
- `oauth_client` - instance-level client id and secret (encrypted). See section 7.
- `credentials` - per person: encrypted refresh token, granted scopes, expiry, optional
  per-person client override.
- `sources` - per person: external id, display name, device or app type. Drives the source
  filter in the UI.
- `notes` - per person and local date: user-authored daily annotations, free text. User data,
  must survive every rebuild.
- `events` - per person: typed, dated occurrences with an optional value and end date
  (`illness`, `travel`, `alcohol`, `medication`, `injury`, `caffeine`, user-definable types).
  Structured siblings of notes. Free text is only readable by a human; a typed event is an
  analysis variable, which is what makes "how do I sleep after a late flight" answerable at all.
- `overrides` - per person: exclusions and corrections applied to specific samples, sessions or
  day/metric pairs, each with a reason. A glitching strap reporting 210 bpm, or someone else
  wearing the watch, would otherwise poison every baseline permanently. Overrides are **tier 1
  truth, not edits**: the raw payload is never modified, the override is applied during
  derivation, and removing it restores the original value.
- `raw_payloads` - append-only. One row per API response: person, data type, request params,
  window start/end, fetched-at, HTTP status, body, body hash. Deduplicated by hash.

### Tier 2 - normalized, derived from tier 1

- `samples` - person, source, metric, utc_ts, tz_offset, value (nullable), raw_payload_id.
  Long and narrow; backs the intraday heart-rate trace and sample-level SpO2.
- `sessions` - person, source, kind (sleep | exercise), start_ts, end_ts, tz_offset, attrs.
- `session_segments` - session, stage, start, end. Backs the hypnogram.

### Tier 3 - rollups

- `daily` - person, local_date, metric, **aggregate**, source (or `merged`), value, coverage,
  derivation_version.

  The `aggregate` dimension is not optional detail: a heart-rate card shows minimum, mean and
  maximum for the same day, and sleep carries duration, efficiency and per-stage totals. One
  value per metric per day cannot express that. Aggregates are drawn from a fixed set (`min`,
  `mean`, `max`, `last`, `sum`, `count`, `p50`, and stage- or phase-specific totals), and the
  metric catalogue declares which are meaningful for each metric - summing heart rate is
  meaningless, averaging steps across a day is not what anyone means by "steps".

### Sync bookkeeping

- `sync_state` - person, data type, high-water mark, last success, last error.

### Storage engine rationale

The workload is analytics-shaped, so SQLite deserves justification rather than assumption.

**Why SQLite:** the topology decides it. Four processes touch the database - the server writing
during sync, the MCP server (separate process, stdio), the CLI, and rebuilds. SQLite in WAL mode
supports concurrent readers alongside a single writer across processes. DuckDB, despite far
better aggregate performance, takes a single read-write process lock: an MCP query would fail
while a sync was running, or the MCP server would have to proxy through HTTP and lose the direct
SQL that makes `sql_query` worth having. Postgres or Timescale would win on concurrency and
analytic SQL and lose the one file, no daemon, no ops property that a self-hosted tool depends
on most.

**Why the volume is manageable:** roughly 3.2M sample rows per person-year at 1-minute
granularity across six intraday metrics, so five people over five years is on the order of 80M
rows. That is only a problem if scanned. Tier 3 exists so the dashboard reads `daily` - a few
thousand rows per person-year - and sample-level access is confined to a single day or night
(~8 600 rows). The rollup design is what makes a row store the right call.

**Consequences for implementation:**

1. **Raw payload bodies are compressed** (gzip or zstd), or stored on disk with metadata in the
   database. The JSON archive will otherwise dominate file size, likely exceeding all derived
   tables combined.
2. **The schema stays DuckDB-friendly** - integer timestamps, narrow types, no exotic
   collations. DuckDB reads SQLite files directly through `sqlite_scanner`, so if agent SQL over
   sample-level data ever becomes slow, DuckDB can be attached read-only for analytics while
   SQLite remains the system of record. No migration and no format change. This escape hatch is
   nearly free to preserve now and expensive to retrofit later.
3. **Driver:** `better-sqlite3` (synchronous, fast, mature). Node 22's built-in `node:sqlite` is
   the fallback if native builds prove awkward in Docker.

**To verify in M1:** if the API returns intraday data at finer than 1-minute resolution for any
metric, these estimates shift by an order of magnitude and a per-metric downsampling policy
becomes a real decision. Measure against real payloads rather than assuming.

### Invariants

1. **Tiers 2 and 3 are a cache.** A `rebuild` command regenerates them from tier 1. Improving
   nap detection or merge policy costs a rebuild, not a re-fetch of months of history.
2. **Missing is not zero.** The API omits days a device was not worn. Values are nullable and
   every rollup carries `coverage`; a gap and a genuine zero must never render alike.
3. **Days are local; sleep belongs to the wake date.** Every timestamp is stored as a UTC
   instant plus the tz offset in force at that instant. Day boundaries are computed in the
   person's timezone. A night spanning midnight is one session attributed to the morning, so
   "last night" on the 31st means the 30 -> 31 night.
4. **Merging never happens on write.** Every sample and session retains its `source_id`.

## 7. Authentication and credentials

**One GCP project, one OAuth client, per household.** An OAuth client is an application
credential, not a per-person one; multiple people consent to the same client. Each member is
added as a test user under the household project. Per-person projects would buy only quota
isolation, which is irrelevant at household scale, at the cost of one setup wizard per person.

- Client id and secret are stored once at instance level, encrypted with a key supplied via
  environment variable.
- Refresh tokens are stored **per person**, encrypted with the same key.
- A per-person client override exists as an escape hatch for anyone who wants their own project;
  it is not the default path.
- The setup wizard walks the owner through creating the project, enabling the Health API,
  creating the OAuth client and registering `<instance-url>/oauth/callback` as a redirect URI.
- Consent runs as a standard authorization-code flow at `/oauth/callback`.

### Token longevity risk

OAuth clients left in **Testing** publishing status issue refresh tokens that expire after
**7 days**. With a single household client this affects everyone at once. Mitigations, in order
of preference:

1. Publish the client to **production** status. An "unverified app" warning screen is
   inconsequential when the only users are the credential owners. This is precisely where a
   self-hosted instance escapes the 100-user cap without a CASA audit.
2. If the health scopes turn out to be classified **restricted** rather than merely sensitive,
   production status is closed without CASA, and periodic re-consent becomes the price of
   self-hosting. This is survivable: re-consent is a 30-second browser flow.
3. In all cases, detect `invalid_grant` on refresh, pause sync **for that person only**, surface
   a reconnect banner in the dashboard and a non-zero `doctor` exit code.

**No data is lost in any of these cases**, because history already synced lives in the local
archive. Verifying the actual scope classification and token lifetime is the first
implementation task; it shapes the setup documentation.

## 8. Sync engine

Per (person, data type) jobs, with a high-water mark in `sync_state`.

- **Trailing re-fetch window.** Every run re-fetches the last 7 days (configurable) rather than only
  the range since the cursor. Devices upload late: last night's sleep may arrive at noon, and a
  watch left on a charger backfills days afterwards. A pure cursor would permanently miss that
  data. Re-fetched payloads dedupe by body hash, and derived rows upsert on natural keys, so
  overlap is cheap and idempotent.
- **Backfill.** First connect starts a resumable, windowed backwards walk with a token bucket
  and jittered exponential backoff on 429 and 5xx. Progress is visible in the UI.
- **Manual sync.** The dashboard's sync button enqueues an immediate run; progress streams over
  SSE.
- **Quota.** The household shares one project's quota. Backfill is rate-limited so it degrades
  interactive syncs gracefully rather than exhausting quota.
- **Field mapping** between API bundles and our metrics lives in one table-driven module, not
  scattered through the codebase, because the v4 field paths must be verified against the live
  API during implementation.

## 9. Provenance and merge policy

The hardest correctness problem in this domain, and the one developers building on this data
consistently report as the worst. The rule that makes it tractable is invariant 4: never merge
on write. Merging happens at
derivation and query time, from a per-metric source priority list that the user can configure.

- **Sum within a source, choose between sources.** Two devices reporting steps are chosen
  between, never added. Double-counted steps is the classic silent corruption here.
- **Scalar series.** A primary source is selected per time bucket. Gaps may be filled from
  lower-priority sources, with the mix recorded on the rollup. Two devices are never averaged
  into a number no device measured.
- **Sessions.** Two sessions of the same kind are treated as one event when their overlap
  exceeds 50% of the shorter session's duration (configurable). Priority selects the primary;
  the alternate is retained, never deleted.
- **Provenance stays visible.** Charts attribute values to their source in tooltips, and the UI
  carries a source filter on every page.

Because merges are computed rather than stored, changing priority or thresholds is a rebuild,
and any merge decision can be inspected against the untouched per-source data.

## 10. Derivation and analytics

Pure functions over rows, fixture-tested, stamped with `derivation_version`. A version bump
triggers an automatic rebuild on boot.

- **Daily rollups** per metric and aggregate, computed per source and as `merged`, each with
  coverage. The metric catalogue is one module declaring, per metric, its unit, its meaningful
  aggregates, and its display precision - including nutrition (calories, macronutrients, water)
  and weight (value, trend), which otherwise tend to get bolted on inconsistently.
- **Sleep**: stage durations, efficiency, bed and wake times, and nap detection (short sessions
  outside the person's main sleep window; thresholds configurable).
- **Recovery**: resting heart rate, HRV, breathing rate.
- **Personal baselines**: rolling central tendency and dispersion per person and metric (default
  60-day window, excluding overridden values), so a reading can be expressed relative to that
  person rather than in the abstract. "96 bpm" carries no information on its own; "1.4 standard
  deviations above your 60-day baseline" does. Baselines need long history and cheap
  recomputation, which is exactly what tier 1 plus `derivation_version` provides, and they
  upgrade the meaning of every existing chart rather than adding a new one.
- **Insights**: period-over-period deltas against the immediately preceding equal-length period,
  phrased as in "average sleep 7h35 over the last 7 days, against 7h53 in the previous period".
  **Insights are suppressed when coverage is too thin.** A delta computed over three missing
  nights is a fabricated number, and fabricated numbers are worse than a blank card.

## 11. Surfaces

### HTTP API

`GET /api/{person}/{metric}?from&to&granularity&sources`, plus `/api/sync` (SSE),
`/api/notes`, `/api/export`. Deliberately thin; all logic lives in `core`.

### MCP server

The capability that does not exist elsewhere today.

Tools: `list_people`, `query_series`, `get_daily`, `get_sleep`, `get_recovery`, `get_workouts`,
`compare_periods`, `search_notes`, `get_events`, `get_baselines`, and `sql_query` - read-only
SQL against documented views,
with a hard row cap and statement timeout. `sql_query` is the point of the whole surface: it
turns "why has my resting heart rate been climbing since June?" into something an agent can
investigate across years of local history, at zero API cost.

Two rules for this surface:

- **Outputs are token-budgeted.** Default to rollups; downsample dense series (LTTB) rather than
  emitting 86 000 samples into a context window; always return summary statistics alongside any
  series.
- **Writes are opt-in.** `add_note`, `add_event` and `sync_now` exist but are disabled unless
  enabled in configuration.
- **Descriptive, not causal.** An agent with SQL over a hundred metrics and a few dozen event
  types will find correlations that are not real. Tool descriptions instruct that findings be
  reported with effect size and coverage, and phrased as association rather than cause. The
  discipline belongs in the tool contract, where every agent inherits it, rather than in a
  document nobody reads.

**The MCP session is bound to exactly one person.** A stdio server is configured for a person; a
bearer token belongs to a person. Every view the SQL surface can reach is filtered to that
person, so `sql_query` cannot become a path around the account isolation in section 15. The
binding is enforced in the query layer rather than by convention in the tool implementations,
because a tool that forgets a `WHERE` clause must not be able to leak another member's data.

Transport: stdio for local agents; optional bearer-token HTTP for remote ones. The documentation
must state plainly that pointing an LLM at this sends health data to that agent's model
provider. Self-hosting the store does not self-host the model.

### CLI

Binary name `health`. Commands: `sync`, `today`, `sleep --last 30d`, `export --csv/--json`,
`rebuild`, `backup`, and `doctor` (diagnoses auth state, token expiry, sync lag, coverage gaps).
`--json` on every command and deterministic exit codes, so it composes with other tools.

### Dashboard

React + Vite + TanStack Query, with **ECharts** for rendering: it handles dense intraday series
and interactive zoom natively, where lighter React chart libraries degrade on a full-day heart
rate trace.

Pages: Dashboard, Activity, Sleep, Recovery, Health, Weight, Nutrition, Notes.

A single shared control-row component carries range tabs (Day / Week / Month / 3 months / Year),
a prev/next date stepper with calendar picker, the source selector, raw data download, and
manual sync. Every page resolves to the same (person, metric, range, sources) tuple, so this
belongs in one component rather than per page.

Chart set, drawn from what the data supports: intraday heart rate with a min-max band; a daily
min/mean/max heart-rate series for period views; SpO2 with confidence interval and sample count;
sleep duration trend; a bed/wake schedule chart plotting each night as a span, with detected
naps marked on the same axis; the hypnogram as a step chart with per-stage totals; workout
sessions as counts and total duration; activity heatmap; weight trend; KPI cards with
sparklines; and insight cards phrased as a period-over-period delta.

Daily notes and typed events surface as annotations on charts, so an unusual metric carries its
context. Where a baseline exists, charts draw it as a band behind the series, turning an
absolute reading into a relative one at a glance. Overridden points render as excluded rather
than vanishing, with their reason on hover, so corrections stay visible instead of silently
rewriting history.

**UI conventions**, applied across every page rather than decided per card:

- **Every headline number states its basis.** "7 h 25" is followed by "average over 29 nights,
  July"; an SpO2 reading by its confidence interval and sample count; a recovery figure by "last
  recorded value". This is the visual counterpart of the coverage invariant - a number whose
  basis is unstated invites a conclusion the data may not support.
- **Empty states are distinct and explicit.** "No naps detected in this period" is a different
  statement from "device not worn" and from "insufficient data to summarise". Each renders
  differently; none renders as zero or as a blank chart.
- **Cards carry their own controls where the control is card-specific** - a min/max band toggle
  on the heart-rate chart, a source selector on a card whose sources differ from the page
  default - while the page control row holds what applies to the whole page.
- **Dashboard cards deep-link to their detail page** ("view sleep", "view all activity"), so the
  dashboard reads as a set of entry points rather than a terminus.
- The navigation rail is collapsible to an icon strip, since chart pages benefit from the width.
- A resources section links to the documentation, the changelog and the issue tracker. A
  self-hosted tool has no in-app feedback channel and needs none.

Theming via CSS custom properties. Strings are extracted for i18n from the start, shipping
English and Dutch.

## 12. Demo mode

A synthetic data generator producing a plausible year of data: realistic sleep architecture,
weekday and weekend patterns, deliberate gap days, and **deliberately overlapping two-source
data** to exercise the merge policy.

This is infrastructure, not a nicety. The same generator provides the demo instance, the
screenshots, a contributor onramp for anyone without a Fitbit, and the fixtures for the entire
test suite.

## 13. Error handling

Each class has one defined behaviour.

| Class | Behaviour |
|---|---|
| Auth (`invalid_grant`) | Pause sync for that person only; reconnect banner; non-zero `doctor` exit |
| Transient (429, 5xx) | Backoff and retry; surface only after repeated failure |
| Schema drift | Store the raw payload, log, continue. Sync must never crash because Google shipped a new field. The archived payload allows re-derivation once the field is supported |
| Data quality | Suppress the insight or chart; never fabricate a value |

A failed sync never blocks a dashboard read. The user sees the last known data with an explicit
"last synced" state, not an error page.

## 14. Testing strategy

Test-driven throughout.

- **Golden-file unit tests** for every derivation function.
- **Contract tests** for the API client against recorded response fixtures.
- **Property tests for merge and override invariants** - merged steps never exceed the maximum
  reported by any single source; no session is double-counted; rebuild is deterministic and
  idempotent; removing an override restores exactly the pre-override value; baselines ignore
  overridden points. Property
  tests are the right tool here because the failure mode is silently wrong numbers rather than
  crashes.
- **Integration tests** against a temporary SQLite database, including a person-isolation suite:
  no surface - HTTP, MCP tools, `sql_query`, or CLI - can return another person's rows.
- **End-to-end tests** (Playwright) against demo mode.

## 15. Operations and security

- One Docker image, one volume, one SQLite file in WAL mode.
- Drizzle migrations run on boot; a `derivation_version` bump triggers an automatic rebuild.
- `health backup` performs `VACUUM INTO`.
- Household accounts with argon2-hashed passwords and cookie sessions. **Each account sees only
  its own data.** There is no sharing mechanism, no role hierarchy and no admin override in v1 -
  visibility between household members is a consent question, not a configuration default. All
  data is keyed by person already, so opt-in sharing can be added later without a schema change.
- MCP bearer tokens are separate from session credentials, and each is bound to a single person
  (see section 11).
- Binds to localhost or LAN. Reverse proxy or Tailscale for remote access.
- No telemetry of any kind.

## 16. Implementation milestones

This design is larger than one implementation plan. It decomposes into milestones that each
end at something usable, and each gets its own plan.

**M0 - Auth probe (throwaway).** Create the GCP project, enable the Health API, run consent,
call one endpoint, and answer the section 7 question: how are the health scopes classified, and
how long does a refresh token actually live? Everything downstream inherits this answer, and it
costs an afternoon to find out. No production code is kept.

**M1 - Ingest and store.** Monorepo scaffolding, schema and migrations, the API client with its
table-driven field mapping, the sync engine (backfill, trailing window, backoff), and the raw
archive. Done when a real account's history is on disk and re-syncing is idempotent.

M1 comes before the dashboard for a reason beyond dependency order: **sample-level data has a
shelf life.** Intraday series are typically retained by the API only for a recent window, so
every week without ingestion is a week of minute-level history permanently unavailable at that
fidelity, no matter how good the charts are later. Charts can be improved retroactively;
resolution cannot be recovered.

**M2 - Derivation and query layer.** Rollups, sleep and recovery derivation, nap detection,
personal baselines, the override mechanism, the merge policy with its property tests, `rebuild`,
and the demo-mode generator. Done when the same questions can be answered from local data,
correctly, with coverage tracked.

**M3 - Dashboard.** Server, HTTP API, and the eight pages with their chart set, notes and typed
events, baseline bands, override controls, theming and i18n scaffolding. The bulk of v1's
visible work.

**M4 - Agent surfaces.** MCP server (including `sql_query`) and the CLI. Both are thin over M2,
which is why they come after it rather than before.

**M5 - Packaging.** Docker image and compose file, setup wizard, backup, documentation.

M0 must run before M1 is planned in detail. M4 could be pulled ahead of M3 if the agent surface
turns out to be more useful sooner than the charts.

## 17. Risks and verification tasks

1. **Scope classification and token lifetime** (section 7). Verify first; it determines whether
   the household re-consents weekly or effectively never, and it shapes the setup guide.
2. **v4 field paths and data-type bundles.** Not yet verified against the live API. Contained by
   the table-driven mapping module and the raw archive.
3. **Sync lag from device to Google cloud.** Data appears when the device syncs, not when it is
   measured. The trailing re-fetch window addresses this; the window may need tuning against
   real behaviour.
4. **Merge quality against real multi-source data.** The generator exercises the policy, but
   real-world overlap will surface cases the fixtures do not. Because merges are recomputed
   rather than stored, corrections are cheap.
5. **Naming.** The product must not be called "Google Health <something>"; trademark exposure
   for no benefit. Positioning is "works with Google Health and Fitbit".
6. **Intraday resolution and storage sizing.** Sizing assumes 1-minute granularity. Finer
   resolution on any metric shifts volume by an order of magnitude and forces a per-metric
   downsampling decision. Measured in M1 against real payloads; the DuckDB escape hatch in
   section 6 bounds the consequences.

## 18. Deferred

Deliberately out of v1, recorded here because the architecture is chosen so they stay cheap
later rather than requiring rework.

**Non-Google data sources.** Withings, Oura, Strava, continuous glucose monitors, lab results,
or plain manual entry. The merge machinery already handles multiple sources, and combining
vendors is something no vendor's own dashboard can do, since none of them holds the other half
of the data. Deferred because each integration is real work, not because it needs a schema
change - which is why the store must stay provider-agnostic.

**Proactive alert rules.** "Resting heart rate elevated three days running" is a recognised
early-illness signal, and the sync scheduler already runs on a timer. Rules plus a webhook to
ntfy, Home Assistant, email or Telegram. Roughly M5-scale work.

**Home-lab integration.** A Grafana datasource, Home Assistant sensors, and documented read-only
views for anyone pointing DuckDB or a notebook at the file directly. Nearly free once the query
views exist, and expected by the self-hosting audience.

**Also deferred:** Health Connect ingestion, Google Takeout import, write-back to Google, mobile
apps, sharing between household members, additional languages, and any hosted offering.
