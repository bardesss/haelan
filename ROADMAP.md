# Roadmap

Where haelan has got to, and why it got there in that order.

Lifted out of the README before the first release: thirty rows of milestone letters are this
project's own bookkeeping rather than something a reader needs in the first two screens. The
reasoning below the table is a different matter. Specs and plans live under `docs/`, which is not
tracked, so this file is the only place any of it exists.

## The milestones

| Milestone | What it delivers | Status |
|---|---|---|
| **D1** Visual direction | Design tokens, chart styling, the app shell and two reference pages | Done, [#10](https://github.com/bardesss/haelan/pull/10) |
| **M0** Auth probe | Scopes, token lifetime and real v4 payload shapes; throwaway code, lasting findings | Done, [#11](https://github.com/bardesss/haelan/pull/11) |
| **M1a** Store and credentials | The three-tier SQLite schema, encrypted credentials and the compressed raw archive | Done, [#12](https://github.com/bardesss/haelan/pull/12) |
| **M1b** API client and mapping | The v4 client, the data type catalogue and the payload mappers | Done, [#14](https://github.com/bardesss/haelan/pull/14) |
| **M1c** Sync engine | Day aligned windows, per person jobs, sync state and a token bucket | Done, [#19](https://github.com/bardesss/haelan/pull/19) |
| **M1d** Wizard and accounts | The Fastify server, argon2 accounts and the guided setup flow | Done, [#21](https://github.com/bardesss/haelan/pull/21) |
| **M2a** Catalogue and rollups | The metric catalogue, per source `daily` rows with coverage, and the derive queue | Done, [#38](https://github.com/bardesss/haelan/pull/38) |
| **M2b** Priority and merge | Per metric source priority, `merged` rows chosen per local hour, overrides applied at derivation | Done, [#45](https://github.com/bardesss/haelan/pull/45) |
| **M2c** Sleep derivation | Nights assembled across split sessions, naps, stage durations and efficiency | Done, [#50](https://github.com/bardesss/haelan/pull/50) |
| **M2d** Baselines and query layer | Rolling baselines with a thin flag, and the person bound query layer M3 and M4 read through | Done, [#51](https://github.com/bardesss/haelan/pull/51) |
| **M2e** Rebuild | Atomic per person rebuild of tiers 2 and 3 from the archive, triggered by a version bump | Done, [#55](https://github.com/bardesss/haelan/pull/55) |
| **M3** Dashboard | Eight pages, the full chart set, notes and typed events, baseline bands, override controls, i18n | Done |
| **M3a** Web foundations | Routing, sign in, person binding, English and Dutch across every page, TanStack Query | Done, [#64](https://github.com/bardesss/haelan/pull/64) |
| **M3b-1** Core read stack | Units, sample counts and workout durations, and the query layer with its shared downsampler | Done, [#65](https://github.com/bardesss/haelan/pull/65) |
| **M3b-2** HTTP surface | Bearer auth, the response envelope, weak ETags, export, and the person isolation suite | Done, [#67](https://github.com/bardesss/haelan/pull/67) |
| **M3d-1** Page spine and Dashboard | The shared control row and the data hooks, with the Dashboard off fixtures as their first consumer | Done, [#68](https://github.com/bardesss/haelan/pull/68) |
| **M3d-2** Activity, Sleep and Recovery | The three remaining M3d pages, on the control row and hooks M3d-1 built | Done, [#71](https://github.com/bardesss/haelan/pull/71) |
| **M3c** Annotations and corrections | Override, note and event CRUD, re-derive enqueued in the same transaction, and the chart click panel | Done, [#76](https://github.com/bardesss/haelan/pull/76) |
| **M3e-1** Health, Weight and Notes | SpO2, weight and body fat, and the Notes page, the first surface that can delete an annotation | Done, [#81](https://github.com/bardesss/haelan/pull/81) |
| **M3e-2** Insight cards and the shell | Period over period cards, each withheld with its own reason when the data is thin, and the Dutch sweep | Done, [#82](https://github.com/bardesss/haelan/pull/82) |
| **M3f** The consumers M3 never built | The intraday chart, the activity list, naps and the weight trend, and two sleep defects an audit found | Done, [#85](https://github.com/bardesss/haelan/pull/85), [#86](https://github.com/bardesss/haelan/pull/86), [#87](https://github.com/bardesss/haelan/pull/87) |
| **M3 second pass** Corrections a second audit found | The tier 2 readers learn about a person's corrections, and Correct finally gets its home on the intraday chart | Done, [#93](https://github.com/bardesss/haelan/pull/93) |
| **M4** Agent surfaces | MCP server including `sql_query`, and the CLI. Both thin over M2 | Not started |
| **M5a** Source naming | A person scoped name for each source, so a 32 character hex id can read "My watch" | Done, [#91](https://github.com/bardesss/haelan/pull/91) |
| **M5b** People | Invites stored as a hash, a member who chooses their own password, the first `is_admin` guard, and suspension | Done, [#94](https://github.com/bardesss/haelan/pull/94) |
| **M5f** Wizard polish | The connect card `/oauth/start` had been reachable from nowhere, and per person data type exclusions | Done, [#95](https://github.com/bardesss/haelan/pull/95), [#96](https://github.com/bardesss/haelan/pull/96) |
| **M5c** Packaging | The image that runs the TypeScript it was tested as, booted twice over one volume on both architectures | Done, [#104](https://github.com/bardesss/haelan/pull/104) |
| **M5d-D** Cheaper sync tests | A test's data types bounded the way its depth already was, after the catalogue took every sprint test from twenty types to forty-two | Done, [#106](https://github.com/bardesss/haelan/pull/106) |
| **The catalogue catches up** | Twenty-two data types the app fetched nothing for, measured off the API's own envelope rather than its release notes; food is recorded unfetchable because a Food carries no clock | Done, [#101](https://github.com/bardesss/haelan/pull/101) |
| **M5d-A** Narrow sample keys | The five identifiers every one of 1.6 million sample rows wrote out in full become integer references; measured 632 MB down to 247 MB | Done, [#108](https://github.com/bardesss/haelan/pull/108) |
| **M5d-B/C** Reclaiming and backup | The 595 MB a rebuild frees and never hands back, reclaimed once a boot, and a daily compacted copy that is integrity-checked and row-counted before it is called a backup | Done, [#112](https://github.com/bardesss/haelan/pull/112) |
| **M5e-1** One error shape | Every route answers the same error envelope, and the injectable responder, the gate's path branch and the second HTTP client that existed to bridge two shapes are gone | Done, [#115](https://github.com/bardesss/haelan/pull/115) |
| **M5e-2** Seed and rehearsal | A deterministic demo data generator, the upgrade path rehearsed end to end from an old schema through rebuild, reclaim, backup and restore, and the script that seeds a directory for anyone to boot an instance against | Done, [#116](https://github.com/bardesss/haelan/pull/116) |
| **M5e-3** Documentation and screenshots | Three screenshots off the seeded demo data, and the README a stranger meets first: the features that shipped and not the ones that did not, one deploy block, and a configuration reference written for people who disagree with the defaults | In review |
| **M5** Packaging | Cut into six units, a, b, c, d, e and f as listed here, with M5d itself cut into four strands - D cheaper tests, A narrow keys, then B reclaiming the space a rebuild frees but never returns and C backup and restore, which shipped together because a vacuum and a backup are one SQLite operation writing to two places - and M5e itself cut into three: M5e-1 the envelope, M5e-2 the seeded demo data and the automated upgrade rehearsal, M5e-3 the documentation and screenshots - and the catalogue work and the image both landing before the v1.0.0 tag | In progress |

## Why the order is not alphabetical

**M3d comes before M3c**, out of milestone letter order: section 6's creation flow is a click on a
plotted point, and the pages that plot real points are M3d's, so building the annotation panel
first would mean targeting fixture points that correspond to no row an override could name.

M1a through M1d are a decomposition of the spec's single M1, not phases the spec names: store,
client, sync and wizard each produce working, testable software on their own. **M1 itself is
done**: the design calls it done when a real account's history is on disk, re-syncing is
idempotent, and the whole route from empty database to syncing data ran through the browser. That
run happened on 2026-08-21 and is recorded, including what it broke, in
`probe/findings/console-steps.md`. Two things that run did not settle are listed there rather than
here, because an unanswered question belongs next to its evidence. **M2 is cut the same way**,
into the units its derivation design names: M2a is the first
of them and each has its own row above, and **M2e** is the last. **M3 is cut the same way**,
with M3b-1 and a second plan covering the HTTP surface. D1 and M0 through
M5 are the only phases the design defines. M1 comes before the dashboard deliberately: intraday samples have a shelf
life, since the API only retains them for a recent window, so every week without ingestion is a
week of minute-level history permanently unavailable at that resolution. Charts can be improved
retroactively; resolution cannot be recovered.

**M5 comes before M4**, also out of letter order, and for two reasons rather than convenience.
M4's `sql_query` is the widest read surface this project will have, and person isolation is so far
proven against a database holding one person: M5 brings member management, which is where a second
person first exists to prove it against. And M5 carries backup and the upgrade path while
`DERIVATION_VERSION` and `MAPPING_VERSION` still move often enough to force rebuilds. M4 adds a
surface; M5 retires a risk that is already live.

**Within M5, M5f runs before M5c, M5d and M5e**, also out of letter order: M5c is the unit that
packages the image, and landing the wizard and connect polish first means the first published
artifact already carries it rather than the image going out once and the polish arriving in a
rebuild.

## The rule that keeps this true

**Every milestone pull request updates this table**, in the same pull request rather than
afterwards. Everything else leaves it alone: a dependency bump or a documentation fix has no row
to touch. A roadmap that is only accurate on the day it was written is worse than none, because it
still looks authoritative.

That rule had one gap, which this line closes: a milestone's own pull request records the status
it has **on the day it is opened**, and "in review" stops being true the moment it merges. Nothing
was then allowed to correct it, since the next milestone's pull request has no business touching
another row. **A pull request may correct a status this table gets wrong**, and only that. M1d
carried "In review" for a day after [#21](https://github.com/bardesss/haelan/pull/21) merged
because of it.
