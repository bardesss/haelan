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

## Heart rate volume and the downsampling decision

M0 measured heart rate arriving every 2 seconds: 13.6M rows per person-year, 95 percent of all
rows. See `probe/findings/volume.md`. The schema provides the shape for the fix: `samples.agg`
lets a minute of heart rate be three rows (`min`, `mean`, `max`) rather than thirty. The ingest
policy that writes at one row per minute per aggregate landed with the API client in M1b, in
`mapWindowSamples`, which downsamples once over a whole fetched window rather than per page, so
a minute split across a page boundary does not collide with itself. The 2-second payload stays
untouched in `raw_payloads`, so this is a resolution choice in a cache, not a loss, and a later
rebuild can widen it without re-fetching.

## Secrets

`loadOrCreateKey` generates 32 bytes into the data directory on first boot, or reads
`HAELAN_ENCRYPTION_KEY` if you would rather hold the key elsewhere. It protects a copied
database file, not the volume itself. That trade is deliberate and is stated in spec section 15:
deriving the key from a password would be stronger and would stop the instance syncing
unattended after a restart.

The client secret and every refresh token are sealed with AES-256-GCM before they reach a row.
Revocation sets `revoked_at_ms` rather than deleting the token, because the reconnect banner has
to distinguish a revoked person from one who never connected.
