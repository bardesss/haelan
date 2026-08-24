# @haelan/core

The only package that issues SQL or talks to Google. `server`, `mcp`, `cli` and `web` are
adapters over it, which is what makes a dashboard card, a CLI table and an MCP tool answer the
same question identically.

This package covers the store (schema, migrations, encryption and the raw archive), the API
client and mapping, the sync engine, the derivation layer that turns tier 2 into tier 3, the
person bound query layer, and the rebuild that regenerates both derived tiers from the archive.
Each has its own section below. The wizard is not here: it is a server and browser concern, and
lives in `apps/server` and `apps/web`.

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

- **Missing is not zero.** `samples.value` and `daily.value` are nullable, and a `daily` row
  carries `coverage` wherever there is a basis to measure it. Null coverage is itself that rule
  applied to the column: a provider reconciled rollup has no samples underneath it to count, and
  a fabricated 1.0 would read as a fully observed day. See the derivation section below.
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
computed ourselves by choosing between sources: `mergeDay` writes it, per metric, per local hour,
picking the winning source from the priority list and recording which sources it drew on in
`source_mix`. The literal `provider` names a row for a type the API only answers as a rollup, so
we ingested it rather than derived it: `mapRollups` writes these, and
`runDerive` leaves them alone because there is no local recomputation for a number we never saw
the components of. A `provider` row is Google's own reconciliation across sources, which is a
different thing from `merged`: we cannot inspect it against per source data the way we could
verify our own merge, so it is filed under its own literal rather than under `merged`, where it
would make that literal's promise, "this is a merge we can account for", false without saying so.

**A dirty day is queued rather than derived inline.** `DeriveQueue` records which (person, local
date) pairs need recomputing, and `runDerive` is what drains it, replacing a day's derived rows
wholesale in one transaction so a metric whose samples all got excluded loses its row rather than
keeping a stale number. Four things write to the queue. Sync marks the days a window touched dirty
in the same transaction that commits it. An override marks its own day as it is added or removed,
through `OverrideStore.put` and `.remove`. A priority list write marks every day the person has
data for, through `SourcePriorityStore.put` and `.clear`, because changing priority is a rebuild.
The fourth is a `derivation_version` bump, which is what a rebuild itself is: `rebuild/versions.ts`
compares both version constants against each person's stamp at boot, and the rebuild section below
describes what happens when either has moved.

**Priority** is the per person, per metric ranking that decides which source wins where more than
one reported the same metric. `SourcePriorityStore` keeps it in `source_priority`, one row per
person, metric and rank; the metric `*` is the person's default. A metric's own list is a complete
statement for that metric, not an amendment to the default, because the two lists' indices are not
comparable. Where nothing is configured, the fallback order is `device`, then `app`, then
`manual`, ties broken by source id rather than `created_at_ms`, chosen because a source id
survives M2e's rebuild unchanged and a creation timestamp does not. Changing a list marks every
day the person has data for, because section 9 says changing priority is a rebuild.

**Overrides** are applied at derivation and never on write, which is what makes removing one
restore the original exactly rather than repair it. Sample scope excludes or corrects a reading at
one instant, across every aggregate of that minute, because the person corrected a reading rather
than one of its three summaries. Session scope excludes a session; a session correction is
refused rather than applied, because a night derives eleven figures and one number cannot say
which of them it means, and setting `sleep_asleep_minutes` alone would leave the stage totals no
longer summing to it. Day metric scope excludes only: a corrected day figure has no source and
nothing per source to be inspected against, and `OverrideStore.put` rejects a correcting day
metric override rather than storing something no derivation would apply. `OverrideStore.remove`
takes `{personId, id, nowMs}`, not a bare id: a review found that an id alone let one person delete
another person's override, since an id is not a secret, and the fix scopes removal to the caller's
own person as well as the id.

**Session grouping** is `groupSessions`, pure and stores nothing: two sessions of the same kind
join by single linkage over a configurable overlap ratio that defaults to a half, so one stretch
of sleep stays one event however many devices cut it into pieces. Priority picks the primary from
the group, and every alternate is kept rather than discarded, since section 9's merges are
computed rather than stored and the untouched `sessions` rows are already what "retained" means.

**Sleep** is derived by `deriveSleepDay`, in `src/derive/sleep.ts`, and three different things
merge it, which is worth keeping apart because confusing them is how a night goes missing:
`groupSessions` merges one event recorded across sources, `assembleNights` merges one night
recorded across sessions, and `shortAwakenings`, carried in a session's own `attrs`, is the
provider's model of brief wakes inside one session that nothing here touches. Pieces separated by
at most `night_gap_minutes`, default 120, are one night, which is what stops an early wake being
reported as a night plus a nap rather than the single night it was. `mainSleep` chooses between
groups and never within one, so a piece that joined the night by gap is part of it whatever its
own flag says. A nap needs no rule of its own: it is simply a session that did not join, which is
why there is one threshold rather than two. The six stage figures, deep, light, REM, asleep, awake
and efficiency, are summed from the segments we stored; bedtime, waketime and time in bed come
from the sessions' own start and end times instead, and the nap figures come from counting and
summing the sessions that did not join. Either way nothing here reads the provider's own summary,
so a figure can be inspected against the rows underneath it and so an override on a session moves
it. `sleep_bedtime_minutes` and `sleep_waketime_minutes` are minutes from the local midnight of
the row's own date, negative before it, one signed scale rather than a time plus a column saying
which day. A night whose segments never arrived, or whose segments all carry a stage value we do
not recognise, writes its times and its in-bed span but none of the six stage figures, because a
zero there would claim the person lay awake all night when the truth is we do not know. Where the
source says of every session on a day that it is not the main sleep, the day gets no night at all
and every session is a nap: a session the provider told us was not the night must not become one.
A null flag is the provider declining to say, which is a different thing, and there the longest
group is still taken as the night.

Two limitations M2c does not address, written down rather than fixed. Night assembly cannot cross
the local date boundary: `sessions.local_date` is the date a session ended in, and a day's sleep is
queried by that column, so two pieces of one night falling either side of midnight are assembled as
two separate nights on two separate days. A wake from 23:40 to 00:10 is the case. And changing
`night_gap_minutes` or `session_overlap_ratio` requeues nothing, so only the days a later sync
happens to re-fetch are recomputed under the new value; a year of backfilled nights keeps its old
grouping until a full rebuild.

## Rebuild

Tiers 2 and 3 are a cache. `runRebuild`, in `src/rebuild/runRebuild.ts`, regenerates them from the
archived payloads in tier 1, one person at a time, each inside a single transaction: nobody ever
reads a person whose samples and daily rows disagree, and the rest of the household keeps reading
throughout while one member's rebuild runs.

Two constants decide when it happens. `DERIVATION_VERSION`, currently 4, says what the numbers
computed from tier 2 mean. `MAPPING_VERSION`, currently 2 and in `src/api/version.ts`, says what a
payload turns into, including how `describe()` decides a source's identity, which
`DERIVATION_VERSION` cannot express because a mapping change alters tier 2 itself. Either one
moving, in either direction, triggers a rebuild on the next boot. Both are stamped on each `people`
row as the rebuild finishes with them, which is what lets an interrupted run resume at the next
unstamped person rather than starting over.

M3b is why both moved at once rather than one at a time. It gathered four changes to what a day's
figures contain: spo2 and hrv gained a count aggregate, heart rate gained one too, fed by a fourth
per-minute row the downsampler now emits, and workout counts and durations started being derived
from exercise sessions nothing had consumed before. The count aggregates and the workout rollups
both change what a `daily` row set holds, so `DERIVATION_VERSION` moved from 3 to 4; the new
per-minute row changes what the mapping layer writes into tier 2, so `MAPPING_VERSION` moved from
1 to 2. Bumping both together, deliberately, in one task, is what lets a single rebuild on the next
boot carry all four changes at once instead of a person rebuilding once per bump.

Sources are re-resolved rather than reused. A source id is derived from the person and the
identity `describe()` produces, so an identity the current code still produces comes back under
the same id, and one it no longer produces is dropped along with the priority rankings that named
it. That is the point of the milestone: an instance whose `sources` rows predate a change to
`describe()` comes out of a rebuild carrying the identity the current code would produce.

`replayPerson`, in `src/rebuild/replay.ts`, maps each fetch episode of a window separately rather
than the window as a whole. That detail is load bearing. The sync re-fetches a trailing window on
every run by design, so several archived rows commonly share one window's bounds without being
pages of the same fetch, and mapping them together would run per minute downsampling across a
stale reading and the reading that later corrected it, blending two things the original sync
always kept apart.

Re-resolving identity moves things that point at it. Sample override keys name a source, and
session ids embed one, so `retargetOverrides`, in `src/rebuild/retarget.ts`, moves each key onto
the regenerated row where exactly one candidate exists and reports the rest. An override that
could go two places is left where it is and named in the boot log, because a correction silently
applied to the wrong reading is worse than one an operator is told about.

The boot trigger itself lives outside this package, in `apps/server/src/rebuild.ts`.
`rebuildIfNeeded` runs after `listen`, so an upgrade never turns into a refused connection, and
`runBootSequence` starts the sync runner only once the rebuild has succeeded, so nothing writes
rows the replay would delete without replaying. It yields between people so the server keeps
answering while better-sqlite3 holds the thread for whichever one it is currently on.

A failure that stops the boot sequence structurally does not start the sync runner at all. One
person's rebuild failing does, because a household should not stop ingesting over one broken
archive: the runner starts and quarantines that person until a later boot rebuilds them. The
quarantine covers both halves of what a run does, fetching and draining the derive queue, since
deriving their queued days would write tier 3 at the current version over tier 2 an older mapper
built, which is the mixing the version stamp exists to prevent.

A rebuild never touches sync state. High water marks, backfill cursors, notes and events all
survive it untouched, and so do the overrides themselves beyond moving their keys. Tier 1 exists
so that improving derivation costs a rebuild rather than months of API calls, and a rebuild that
reset a cursor would undo exactly that.

## Querying

`src/query` is the surface `server`, `mcp` and `cli` read the store through. It sits above tier 3
and computes nothing that is not already a `daily` row, except the statistics baselines and
insights need on top of one.

**The person binding is structural.** `PersonQuery` takes a person id at construction and every
method reads through it. There is no unbound variant and no optional person parameter, because
section 11 requires the binding to live in the query layer rather than in the callers: a tool that
forgets a `WHERE` clause must not be able to leak another member's data. `person-query-isolation.test.ts`
is what keeps that true as methods are added.

**Three questions, not ten.** The MCP surface names ten tools, but most are readings of the same
three answers: a series over a range, a baseline to judge a reading against, and a period against
the one before it. Today's numbers are a series whose range is one day, and a sleep page is a
series over the `sleep_*` metrics.

**The authoritative row by default, per source on request.** With no source named, a series reads
the `merged` row for a day and falls back to the `provider` row where no merged one exists, because
both mean what happened that day and differ only in who reconciled it, which is what `daily.source`'s
own column comment says. The fallback is per row rather than per series, so a single stray merged
row cannot hide an entire provider series. `total_calories` and `floors` are why it exists: Google
reconciles them itself and there is no sample underneath either for a merge to work from, so each is
written only as a `provider` row. Naming a source reads that device instead, and naming `merged`
still means only the rows we merged ourselves, which is what keeps a merge inspectable against the
rows underneath it. `DailyPoint` carries `source`, so a caller can always see which it got.

**Baselines are computed, not stored.** Sixty rows is a cheap query, a stored baseline can
disagree with the rows it came from, and changing the window takes effect everywhere at once.
Overridden days need no handling here: an override applies at derivation, so an excluded day has
no row and a corrected one already carries its new value.

**A baseline never contains the reading it judges.** The window ends the day before the date asked
about, because a reading included in its own baseline pulls the centre toward itself and biases
its own z score toward zero, worst when history is shortest.

**A thin baseline is reported, not hidden.** It carries the number of contributing days and a
`thin` flag, so a dashboard band and an agent's effect size inherit the same judgement instead of
each inventing a threshold. Thin means either of two things: too few days for a spread to stand on,
capped at the window so a legitimate seven day trend is not thin by construction, or too small a
fraction of the window asked for. The fraction is the one insights use, imported rather than
copied, because a person who wore their device 20 of 60 days must not get a confident band directly
above a blank insight card built from the same rows.

**A baseline drops the days it cannot trust.** Where coverage is a quality signal for the metric, a
day below the same minimum insights use is left out rather than averaged in. Sixty mornings-only
days at 0.2 coverage are sixty systematic undercounts, and left in they build a centre against which
the first properly worn day scores a large positive z: a wear artefact reported as a health signal.

**Coverage is a quality signal only where a metric is continuously sampled.** It is the fraction of
the day's hours carrying a sample, which is comparable within a metric and meaningless across them:
a `resting_heart_rate` arrives once a day, so a perfect one reads 1/24. `coverageIsMeaningful` asks
the catalogue, and only an `intraday` tier says yes. A metric no data type declares, which is every
`sleep_*` metric, says no. Without this the single cross-metric threshold blanked the whole Recovery
page, the whole Weight page, and the metric behind the product's own flagship example question.

**A query that cannot be answered throws rather than returning nothing.** Dates must be padded ISO
and a range must run forwards, the metric must be one the catalogue declares, and the aggregate must
be one that metric lists. Each of those otherwise returns an empty series indistinguishable from
"this person has no data", which in M4 becomes an agent stating a false thing about somebody's
health record with total confidence. The failures are `ConfigError` and name the offending value.

**Suppression has two gates, and a suppressed insight is blank.** Days present first, because a
missing day has no row and therefore no coverage, so completeness is a failure the coverage gate
structurally cannot see. Then how well observed the present days were. A null coverage counts as
present and fine, since null means there was never a basis to measure hours: treating it as zero
would blank every sleep and provider insight in the product. When either gate fails the numbers
come back null with a reason, deliberately unlike a thin baseline, because a thin baseline is a
weaker true statement while a suppressed insight is the fabricated number the design calls worse
than a blank card. A refusal still carries its evidence: both day counts, both mean coverages and
both resolved date ranges come back either way, because they are what explain it, and because a
caller that had to re-derive "the period before this one" would grow its own copy of the day
arithmetic to do it.

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
