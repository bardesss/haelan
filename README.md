# haelan

A self-hosted dashboard and local mirror for your own health data, built on the Google Health API
v4. One household, one instance, no telemetry, no hosted offering.

The reason it is self-hosted is structural rather than ideological. Google caps an unverified
OAuth client at 100 users, and clearing verification for health scopes needs a paid third-party
security assessment. A hosted dashboard therefore stalls at a hundred signups no matter how good
it is. An instance whose only users are the people who own its OAuth client never meets that cap.
The direct cost is that every household brings its own Google Cloud project; the direct benefit is
that no ceiling exists.

## Roadmap

| Milestone | What it delivers | Status |
|---|---|---|
| **D1** Visual direction | Design tokens, chart styling spec, Dashboard and Sleep reference pages, app shell | Done, [#10](https://github.com/bardesss/haelan/pull/10) |
| **M0** Auth probe | Scope classification, token lifetime, real v4 payload shapes. Throwaway code, lasting findings | Done, [#11](https://github.com/bardesss/haelan/pull/11) |
| **M1a** Store and credentials | Three-tier SQLite schema, migrations, instance key, encrypted credentials, compressed raw archive | Done, [#12](https://github.com/bardesss/haelan/pull/12) |
| **M1b** API client and mapping | v4 client, the data type catalogue, payload parsers, sample and session mappers | In review, [#14](https://github.com/bardesss/haelan/pull/14) |
| **M1c** Sync engine | Day aligned windows, per person jobs, sync state, token bucket, transactional writes | Planned |
| **M1d** Wizard and accounts | Fastify server, argon2 accounts, sessions, the guided setup flow and backfill progress | Not started |
| **M2** Derivation and query layer | Rollups, sleep and recovery derivation, nap detection, baselines, merge policy, rebuild, demo mode | Not started |
| **M3** Dashboard | Eight pages, the full chart set, notes and typed events, baseline bands, override controls, i18n | Not started |
| **M4** Agent surfaces | MCP server including `sql_query`, and the CLI. Both thin over M2 | Not started |
| **M5** Packaging | Docker image, compose file, backup, upgrade path, documentation, wizard polish | Not started |

M1 is split into four plans because store, client, sync and wizard each produce working, testable
software on their own. M1 comes before the dashboard deliberately: intraday samples have a shelf
life, since the API only retains them for a recent window, so every week without ingestion is a
week of minute-level history permanently unavailable at that resolution. Charts can be improved
retroactively; resolution cannot be recovered.

**Every pull request updates this table.** A roadmap that is only accurate on the day it was
written is worse than none, because it still looks authoritative.

## Layout

```
packages/core     the only package that issues SQL or talks to Google
packages/tokens   design tokens, emitted to CSS custom properties
apps/web          React and Vite dashboard, fixtures only until M3
probe/            M0 throwaway scripts, deleted once M1 lands
```

`packages/core/README.md` documents the store and the API client. `apps/web/README.md` documents
the reference pages.

Specs and plans live under `docs/superpowers/` and are deliberately not tracked: they are working
documents for whoever is building, not part of what ships.

## Development

```
pnpm install
pnpm test
pnpm typecheck
pnpm dev
```

Node 22.13 or later. The suite runs against temporary SQLite databases and needs no credentials.

## Conventions

- No em dashes anywhere: prose, documentation, UI copy, code comments, commit messages.
- Comments are sparse and record why, not what.
- Every change reaches `master` through a pull request, and nothing is ever force pushed.
- Real health data never gets committed. Archived payloads stay gitignored, and every test fixture
  is synthetic.
