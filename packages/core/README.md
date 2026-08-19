# @haelan/core

The only package that issues SQL or talks to Google. `server`, `mcp`, `cli` and `web` are
adapters over it, which is what makes a dashboard card, a CLI table and an MCP tool answer the
same question identically.

This package currently covers the store: schema, migrations, encryption and the raw archive.
The API client, sync engine and wizard land in M1b, M1c and M1d.

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

## Heart rate is stored per minute

M0 measured heart rate arriving every 2 seconds: 13.6M rows per person-year, 95 percent of all
rows. `samples` holds one row per minute per aggregate, so a minute of heart rate is three rows
(`min`, `mean`, `max`) rather than thirty. The 2-second payload stays untouched in
`raw_payloads`, so this is a resolution choice in a cache, not a loss. See
`probe/findings/volume.md`.

## Secrets

`loadOrCreateKey` generates 32 bytes into the data directory on first boot, or reads
`HAELAN_ENCRYPTION_KEY` if you would rather hold the key elsewhere. It protects a copied
database file, not the volume itself. That trade is deliberate and is stated in spec section 15:
deriving the key from a password would be stronger and would stop the instance syncing
unattended after a restart.

The client secret and every refresh token are sealed with AES-256-GCM before they reach a row.
Revocation sets `revoked_at_ms` rather than deleting the token, because the reconnect banner has
to distinguish a revoked person from one who never connected.
