# @haelan/core

The only package that issues SQL or talks to Google. `server`, `mcp`, `cli` and `web` are
adapters over it, which is what makes a dashboard card, a CLI table and an MCP tool answer the
same question identically.

This package currently covers the store (schema, migrations, encryption and the raw archive)
and the API client, which landed in M1b. The sync engine and wizard land in M1c and M1d.

## Opening a database

    import { openDatabase, migrateToLatest } from '@haelan/core'

    const db = openDatabase('/data')
    migrateToLatest(db)

WAL mode is on, so the MCP server, the CLI and a running sync share the file. Foreign keys are
enforced, which is what stops a mistyped person id orphaning rows.

## Tiers

Tier 1 is durable truth and is never regenerated: `people`, `sources`, `oauth_client`,
`credentials`, `notes`, `events`, `overrides`, `raw_payloads`. Tier 2 (`samples`, `sessions`,
`session_segments`) and tier 3 (`daily`) are a cache that `rebuild` regenerates from tier 1.

Three rules the schema exists to enforce:

- **Missing is not zero.** `samples.value` and `daily.value` are nullable, and every `daily` row
  carries `coverage`.
- **Days are local.** A sample is an instant, so it carries one offset beside its millisecond
  timestamp, and day boundaries are computed in the person's timezone. A session is a range, so
  it carries two, `start_offset_minutes` and `end_offset_minutes`, because a sleep session spans
  midnight by definition and a night crossing a daylight saving transition would otherwise
  compute the wrong local wake time from a single offset. Either way, a night spanning midnight
  belongs to the wake date.
- **Merging never happens on write.** Every sample and session keeps its `source_id`.

## Reading the API

Three layers, each ignorant of the next. `TokenProvider` turns a stored refresh token into a
live access token and marks a person revoked when Google returns `invalid_grant`, which pauses
sync for them alone. `HealthClient` builds filters, follows pagination, backs off on 429 and
5xx, and archives every terminal response before anything parses it; a retriable response
during backoff is deliberately not archived, since it is transient infrastructure noise rather
than contract evidence. The mappers turn an archived body into rows.

`HealthClient` and the mappers read one catalogue, `src/api/catalogue.ts`, which declares per
data type what the API calls it and what we call it. `TokenProvider` does not need it: it deals
in credentials, not data types. That module exists because the v4 API is irregular in ways no
amount of naming discipline hides: a single data type wears kebab case in the URL path, snake
case in the filter and camel case in the response, the filterable member differs across five
shapes with nothing documenting which applies, and two types reject `list` entirely in favour of
rollups. Every one of those values was measured against the live API in M0 and is recorded in
`probe/findings/field-map.md`. When one turns out to be wrong, correct it in the catalogue and
nowhere else.

Two parsing traps are handled once, in `src/api/parse.ts`, rather than in each mapper: integer
fields arrive as JSON strings, and proto3 omits zero-valued fields entirely, so a nested time
object can arrive as `{}` and a date missing its day is not a date.

Fixtures are synthetic. Real payloads live in a gitignored directory and never become test data;
`probe/findings/field-map.md` records the shapes without the measurements, which is what makes
`src/testing/payloads.ts` possible.

## Syncing

A job is one person, one data type, one window. `runSync` walks the household, `runJob` walks a
job's windows, and `sync_state` records where each job got to.

**Windows are day aligned in the person's own timezone.** That is not cosmetic. The raw archive
deduplicates on the window start, so an unworn day and an unfetched day stay distinguishable, and
a rolling window with a different start on every run would defeat that and grow the archive
without bound. `dayWindows` handles the 23 and 25 hour days a daylight saving transition produces,
so a household spanning zones syncs each person's real days.

**Every run re-fetches a trailing window** rather than only the range since the cursor, because
devices upload late: last night's sleep can arrive at noon, and a watch left on a charger
backfills days afterwards. Re-fetched payloads deduplicate by body hash and derived rows upsert on
their natural keys, so overlap is cheap.

**Each window's rows commit as one transaction, but the cursor does not move with them.** A crash
mid-window cannot leave that window's rows half written. The job's cursor, `sync_state.highWaterMs`,
advances once, after every window in the job has committed, not per window: `recordSuccess` also
resets the job's consecutive failure count, and `runSync` infers a job's outcome by comparing that
count before and after the job runs, so resetting it after only some windows had committed would
make a job that failed partway through look like a clean success. A crash between two windows
therefore commits those windows' rows but leaves the cursor where the previous run left it, behind
rather than ahead. That lag is deliberately the safe direction: the trailing window re-fetch never
consults the cursor to decide what to fetch, so a lagging cursor costs re-fetching a day already
written, not missing a day that was never fetched.

**A failing window ends its job, and the next run picks that day up again.** A window whose fetch
or write fails records the failure and returns; the job does not carry on to the window after it.
Nothing is lost by that: the trailing re-fetch window covers the failed day again next run, so the
day is retried rather than skipped. Continuing past a window that drifted, which spec section 13
names, is deferred to M1d along with the backfill it matters for, because it needs a decision about
what the high water mark means when a window in the middle of a job failed.

**A body we cannot read holds the cursor back.** Zero points used to mean two opposite things:
a window the person has no data in, which is most windows, and a body whose shape changed under
us. `readEnvelope` in `src/api/envelope.ts` separates them and both sync paths run through it. An
empty object stays readable, because proto3 JSON omits a repeated field that is empty, so that is
what a genuinely quiet window looks like. What marks a rename is a **non-empty list of objects
under a name we do not know**, and each qualifier rules out a false positive: a scalar sibling is
a new field rather than a moved one, a list of strings is an id echo and a data point never is,
and an empty list means the day had nothing to lose, so the rename is caught on the first busy
day instead. A false positive here stalls the cursor silently, which is why the rule is narrow.

An unreadable window records schema drift and, more importantly, withholds the mark: `runJob`
skips `recordSuccess`, `runSync` skips it for a rollup walk, and `runBackfill` stops its backwards
walk rather than marching to the horizon against bodies it cannot read. The backfill needs its own
guard because drift is not a failure, so the consecutive failure counter it otherwise stops on
never moves, and a backfill is one shot. Holding the cursor means the same range is asked for
again next run, so the backlog drains itself once the mapper is fixed. That matters more here than
it would elsewhere: the API retains intraday samples only for a recent window, so a day the cursor
scrolls past is unavailable at that resolution rather than merely late.

**A failure stops one job, not the household.** A revoked person pauses alone and the rest keep
syncing, and a person id with no row is reported back in the run's `unknownPersonIds` rather than
thrown out of the loop. `sync_state` has no separate column for a failure's class; `HaelanError`'s
`[kind]` prefix survives as the first token of `sync_state.last_error`, so a caller can tell a rate
limit from a schema change by reading that prefix rather than the message after it. A throw that
carries no class of its own, from SQLite or zlib, is recorded as `transient`, which is what the
engine does with it anyway.

**A retry the client recovered from is recorded rather than lost.** The client deliberately does
not archive the bodies of a 429 or 5xx it retried past, so `ListResult` carries the attempt count
and the last retried status out instead, and `runJob` writes an episode to `sync_state.last_error`
whenever a window's fetch needed more than one attempt. That column holds one string, so the
episode is written at the point the fetch finished: a real failure recorded later in the same job
replaces it, never the other way round.

**Rate limiting has a seat and no occupant yet.** `probe/findings/scopes.md` measured the real
limit at 300 requests per minute per user, and a trailing week for a five person household is
roughly 720 requests. `JobDeps.limiter` is optional, `runJob` takes one token before each window it
fetches, and `TokenBucket` satisfies it. Nothing sets it today, because choosing the rate is a
settings decision and belongs with the scheduler in M1d.

## Derivation

Tier 3, `daily`, is a cache computed from tier 2. `src/derive` is where that computation lives,
and `src/derive/metrics.ts` is where it starts.

**`METRICS` is a separate catalogue from `DATA_TYPES`, on purpose.** `DATA_TYPES` describes the
API: what Google calls a data type, how to fetch it, what unit the response carries. `METRICS`
describes what a metric means once it is ours: which daily aggregates are meaningful for it (a
sum of heart rate readings is not a number anyone means), how many decimals to show, and whether
a higher reading is better, worse or neither. The two catalogues change on different clocks. A
field map correction to `DATA_TYPES` is measured against the live API; a decision about whether
weight should show its mean or only its last reading belongs to product judgement instead, and
lives in `METRICS`. Sleep and exercise carry no entry here, deliberately: their daily figures come
from sessions and segments, not from a sample rollup, and a test asserts that neither of the two
session types has an entry, so nobody adds one by habit.

**Coverage** is the fraction of the local day's hours, out of 24, that carry at least one sample:
computed by `coverageOf`, stored on every derived `daily` row. It is hours rather than a sample
count or a rate, because a rate would need a declared expected frequency per metric, meaningless
for something episodic like weight. Hours mean the same thing whether the metric is heart rate at
one reading a minute or weight at one reading a week: how much of the day was actually observed.
A **null coverage** means the row was not computed by `rollUpDay` at all, which today means it is
a `provider` row (below); nothing downstream should read a null coverage as zero, or as one. What
a null coverage means for a suppression rule on the dashboard is a decision M2d makes, which is
exactly why it is left null here rather than filled with a fabricated 1.0.

**`daily.source`** takes one of three shapes. A source id names the source that reported it, and
is what `rollUpDay` writes: it derives per source by construction and never merges, so a row it
produces always names exactly the source it came from. The literal `merged` names a row we
computed ourselves by choosing between sources, which needs the per metric priority list that is
M2b's; nothing writes this literal yet. The literal `provider` names a row for a type the API only
answers as a rollup, so we ingested it rather than derived it: `mapRollups` writes these, and
`runDerive` leaves them alone because there is no local recomputation for a number we never saw
the components of. A `provider` row is Google's own reconciliation across sources, which is a
different thing from `merged`: we cannot inspect it against per source data the way we could
verify our own merge, so it is filed under its own literal rather than under `merged`, where it
would make that literal's promise, "this is a merge we can account for", false without saying so.

**A dirty day is queued rather than derived inline.** `DeriveQueue` records which (person, local
date) pairs need recomputing, and `runDerive` is what drains it, replacing a day's derived rows
wholesale in one transaction so a metric whose samples all got excluded loses its row rather than
keeping a stale number. Three things write to the queue: sync, as it commits a window and marks
the days it touched dirty in the same transaction; an override, as it is added or removed; and a
`derivation_version` bump, which is what a rebuild is. Of those three, only sync exists today. The
queue is the mechanism overrides and rebuild will use, not evidence that either is implemented:
nothing applies an override yet, and nothing compares `DERIVATION_VERSION` to what is on disk.

## Heart rate volume and the downsampling decision

M0 measured heart rate arriving every 2 seconds: 13.6M rows per person-year, 95 percent of all
rows. See `probe/findings/volume.md`. The schema provides the shape for the fix: `samples.agg`
lets a minute of heart rate be three rows (`min`, `mean`, `max`) rather than thirty. The ingest
policy that writes at one row per minute per aggregate landed with the API client in M1b, in
`mapWindowSamples`, which downsamples once over a whole fetched window rather than per page, so
a minute split across a page boundary does not collide with itself. The 2-second payload stays
untouched in `raw_payloads`, so this is a resolution choice in a cache, not a loss, and a later
rebuild can widen it without re-fetching.

## Accounts, sessions and the setup step

`AccountStore` hashes with argon2id at OWASP's second recommended configuration, 19 MiB over two
passes. That cost is the security property, so if it makes a test suite unpleasant, lower it
through an injected option in the test rather than in production. Ten failures lock an account
for fifteen minutes, and a success clears the counter so a slow typist is not locked out
tomorrow. A login against an unknown username still runs a real verification against a decoy
hash, so response time does not answer a question the caller was not allowed to ask.

`SessionStore` stores the sha256 of the cookie value and never the value, so a copied database
is a list of expiry times rather than a set of live sessions. Lifetimes are fixed at 30 days and
do not slide: using a session moves `lastSeen` but not `expiresAt`, so a stolen cookie cannot be
kept alive indefinitely by using it.

`setupStep` is derived from the database on every call rather than stored as a counter, because
a resumed setup has to land where the data actually is. A refresh token present without the
completion mark means consent was interrupted, and the step is `consent` rather than `done`.

The auth session table is `auth_sessions`, not `sessions`: `sessions` is a tier 2 table holding
sleep and exercise, and the collision would read as a typo forever after.

## Backfill

`runBackfill` walks backwards a day at a time from the stored cursor, or from today on the first
run, writing the cursor after every window. It takes its day windows from `dayWindows` rather
than stepping 24 hours, so the alignment matches the archive's dedup key on DST days too, and it
only ever takes a window that ends at or before the cursor: a cursor mid-day would otherwise
produce a first window ending in the future and push the high water mark past now.

Horizons are per data type, on the catalogue. See `apps/server/README.md` for the numbers and
the volumes behind them.

## Secrets

`loadOrCreateKey` generates 32 bytes into the data directory on first boot, or reads
`HAELAN_ENCRYPTION_KEY` if you would rather hold the key elsewhere. It protects a copied
database file, not the volume itself. That trade is deliberate and is stated in spec section 15:
deriving the key from a password would be stronger and would stop the instance syncing
unattended after a restart.

The client secret and every refresh token are sealed with AES-256-GCM before they reach a row.
Revocation sets `revoked_at_ms` rather than deleting the token, because the reconnect banner has
to distinguish a revoked person from one who never connected.
