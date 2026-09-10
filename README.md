# haelan

**A self-hosted dashboard and local mirror for your own health data, built on the Google Health
API v4.** One household, one instance, no telemetry, no hosted offering.

[![CI](https://github.com/bardesss/haelan/actions/workflows/ci.yml/badge.svg)](https://github.com/bardesss/haelan/actions/workflows/ci.yml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)

> **Not installable yet.** haelan is under active development and there is no release. The
> sections below describe what v1 is being built to do; the roadmap tells you what actually
> exists today. Nothing here is a promise about a date.

The reason it is self-hosted is structural rather than ideological. Google caps an unverified
OAuth client at 100 users, and clearing verification for health scopes needs a paid third-party
security assessment. A hosted dashboard therefore stalls at a hundred signups no matter how good
it is. An instance whose only users are the people who own its OAuth client never meets that cap.
The direct cost is that every household brings its own Google Cloud project; the direct benefit is
that no ceiling exists.

![The Dashboard](assets/screenshots/dashboard.png)

![Sleep](assets/screenshots/sleep.png)

<sub>Dashboard, Sleep, and [Recovery](assets/screenshots/recovery.png). All three are the demo data
`scripts/seed-demo.mjs` generates, not anybody's real health history.</sub>

## What it does

### 📦 A complete local mirror

Your whole history in one SQLite file, kept past Google's retention windows and surviving you
losing access to the API. Intraday samples in particular have a shelf life at the source, so a
mirror is the only place minute-level history stays available at that resolution.

### 📊 Eight pages of it

Dashboard, Activity, Sleep, Recovery, Health, Weight, Nutrition and Notes: sleep with stages and
nap detection, resting heart rate and HRV, SpO2 with its confidence interval, an activity heatmap
and a workout list, an intraday chart, a weight trend, and period-over-period insight cards that
withhold themselves, each with its own reason, when the data behind them is thin. English and
Dutch throughout. Nutrition is the one page with nothing on it: this household has never logged
food, and the API's Food type carries no timestamp to file a meal under, so the page says so
rather than inventing a data model to have something to draw.

### 📐 Personal baselines

A reading is shown against your own 60 day baseline, because "96 bpm" carries no information on
its own and "1.4 standard deviations above your baseline" does. A baseline computed from too few
days is flagged as thin rather than quietly presented as one.

### 📝 Context a stateless dashboard cannot have

Daily notes and typed events (illness, travel, alcohol, medication, injury, and any other kind you
name) become analysis variables, so "how do I sleep after a late flight" is answerable rather than
guessable.

### ✂️ Corrections that do not rewrite history

A glitching strap reporting 210 bpm is excluded by an override applied at derivation time; the
raw payload is never modified, and removing the override restores the original value exactly.

### 👥 Household multi-user

A few people, one instance, each seeing only their own data. An admin invites a member, the member
chooses their own password, and each person connects their own Google account and picks which data
types get fetched for them.

## Deploy

[`compose.yaml`](compose.yaml) at the repository root is eight lines of YAML and carries no
environment variables at all. It needs no editing, because every value the server reads already
has a working default.

```
docker compose up -d
```

Then open `http://localhost:4235`. The database is empty, so the setup wizard runs. It asks for
four things in order: an admin account, the address this instance is reached at, a Google OAuth
client, and consent. After that it asks which data types to fetch and how far back to backfill.

### The one manual step

Somebody has to create a Google Cloud project and an OAuth client once, in the console. Google
exposes no API for that, and the credentials must belong to whoever owns the data, which is
precisely what keeps an instance out of the verification ceiling described above. The setup wizard
makes that step guided, validated and copy-paste driven. It cannot make it disappear, and any
documentation claiming otherwise would be lying.

The wizard walks you through it and prints the exact values to paste. What you do in the console,
in the order it asks:

1. Open [console.cloud.google.com](https://console.cloud.google.com) and create a project, or pick
   an existing one.
2. Under **APIs and services**, enable the **Google Health API**.
3. Configure the OAuth consent screen and declare the eleven read-only scopes the wizard lists,
   including the data types you do not want today: declaring is once, granting is per person, and
   a scope you skip now means a second visit later.
4. Set publishing status to **In production**. Leaving it in Testing gives every refresh token a
   seven day life, and the household's sync stops a week after setup with no obvious cause.
5. Create an OAuth client of type **Web application** and register every redirect URI the wizard
   shows, in one pass. An unused URI costs nothing; a missing one costs a return trip.
6. Copy the client ID and secret into the wizard.

Your client stays unverified, so everyone granting consent sees an unverified app warning. That is
expected here and is not a sign anything is wrong: verification exists to lift a hundred user cap
a household instance never reaches.

### Two things worth knowing before you rely on this

- **Consent needs an HTTPS or loopback address.** Google's OAuth console refuses a raw IP as a
  redirect target and requires HTTPS for anything that isn't localhost, so a browser on the same
  machine the instance runs on works out of the box. Reaching consent from another device on the
  LAN needs either Tailscale, whose `ts.net` names carry a real certificate, or a reverse proxy
  holding a certificate for a domain you own. Recorded from a real walk through the console at
  [`probe/findings/console-steps.md`](probe/findings/console-steps.md).
- **Leave room for a second copy of the database in free disk.** The daily backup and the
  boot-time reclaim each write a whole new file before anything old is replaced or freed, so each
  needs room for another copy of what the database holds, with a margin. Neither runs when it
  cannot: both read free space first and decline, visibly, rather than filling the disk.

## Configuration

There is nothing to configure. Every variable below has a working default, and they exist for
people who disagree rather than for people installing.

| Variable | Default | What it is for |
|---|---|---|
| `HAELAN_DATA_DIR` | `/data` | Where the database, the key and the backups live |
| `HAELAN_PORT` | `4235` | The port the server listens on |
| `HAELAN_HOST` | `0.0.0.0` | The address it binds to |
| `HAELAN_BACKUP_KEEP` | `7` | How many backups to keep; `0` turns backups off |
| `HAELAN_BACKUP_INTERVAL_HOURS` | `24` | How often one is taken |
| `HAELAN_ENCRYPTION_KEY` | generated | Holding the key yourself instead of in a file beside the database |

### What is in the data directory

`haelan.sqlite` is the database: the archived payloads, everything derived from them, and every
note, event and override. `instance.key` is the 44 byte file that decrypts the stored Google
credentials, and it is deliberately **not** in a backup, so keep a copy of it somewhere separate.
`backups/` holds the compacted daily copies.

## Try it without a Google account

`scripts/seed-demo.mjs` writes a year of generated data into an empty directory and leaves the
setup wizard already finished, so an instance boots straight to a populated dashboard.

```
pnpm install
pnpm build
node --experimental-strip-types scripts/seed-demo.mjs ./demo-data
HAELAN_DATA_DIR=./demo-data pnpm start
```

Sign in as `demo` with the password `haelan-demo`. That password is printed by the script and
written down here on purpose: it is correct for a throwaway directory and wrong for anything else,
and the script refuses to run against a directory that already holds a database. The data comes
from a fixed seed, which is why the screenshots above can be regenerated identically.

## Backups, and restoring one

An instance takes a compacted copy of its database once a day into `backups/` inside the data
directory, keeps the newest seven, and does it while the app is running. `HAELAN_BACKUP_KEEP` and
`HAELAN_BACKUP_INTERVAL_HOURS` change that; `HAELAN_BACKUP_KEEP=0` turns it off for an operator who
backs the volume up by other means. Settings shows when the last one was taken and can take one now.

A file appears in `backups/` only after it has been written, opened, integrity-checked and
row-counted against the live database. A copy that fails any of those keeps a `.part` extension,
which nothing restores, nothing counts, and no schedule accepts - so a failed backup is visible as
a symptom and can never be mistaken for a good one. The most recent failure is kept until a later
backup succeeds, so there is always something to look at.

**A backup does not contain `instance.key`.** That file, beside the database, encrypts the stored
Google credentials, and a backup that carried it would itself be a credential - and backups are
exactly the files people copy to a NAS, a cloud folder, or a support thread. Keep a copy of the key
somewhere separate. It is 44 bytes.

To restore, with the container stopped:

1. move the chosen file from `backups/` over `haelan.sqlite`
2. **delete any `haelan.sqlite-wal` and `haelan.sqlite-shm` beside it.** They belong to the database
   you just replaced, and SQLite applying a stale write-ahead log to a restored file is the one way
   this procedure corrupts the thing it is repairing
3. leave `instance.key` where it is - it is not in the backup and is not replaced
4. start the container

Restoring onto a machine that still has its original `instance.key` needs nothing further.

Restoring onto one that does not is supported, and it costs exactly what that key was holding: the
household's Google client secret and every person's stored refresh token. The health data is
intact. The instance writes itself a fresh `instance.key` on that first boot and comes up asking
for the Google client again, because a client secret nobody can decrypt is a client that has to be
set up again. Sign in, paste the client ID and secret back in from your Google Cloud console -
which is where they still are - and then connect each person once, the way setup did the first
time.

Nothing is deleted along the way, so the old key is worth keeping even after you have given up on
it. Put it back - container stopped, over the key the instance generated - and every row that was
sealed under it opens again.

But only those rows, and that is the catch worth reading twice. Anything you re-entered or
re-consented in the meantime was sealed under the *new* key, and restoring the old one takes it
straight back off you: the Google client if you pasted it in again, and every person who
reconnected. So putting the original key back is worth doing **before** you repair anything, and a
poor trade afterwards - by then the repair is the thing that works, and the old key undoes it.

Worth doing once, on a copy, before you need it: the procedure is four steps and the day you first
run it should not be the day it matters.

## Upgrading

**Upgrading past M5d-A costs one rebuild.** Migration 0016 drops `samples` rather than translating
it, so the first boot after this release rebuilds tier 2 from the archive; measured at 11 minutes
36 seconds on 1.6 million rows over 741 days. The dashboard is reachable while that runs, and its
intraday charts are empty for the duration, which is not distinguishable from a day with no data.
The database file does not shrink: live content falls from 632.4 MB to 246.8 MB measured like for
like, but SQLite keeps the freed pages on its freelist - about 595 MB - and returns them to the
operating system only on a `VACUUM`. **M5d-B/C now runs one**, once per boot, when more than a
fifth of the file and more than 64 MiB of it are dead and the disk can hold a second copy while it
works. Measured on the author's database, upgrading from the pre-M5d schema: **21 seconds, and 645
MB handed back**, taking the file from 891 MB to 247 MB. The app stalls for those 21 seconds rather
than stopping, and it happens once - the boots after it find too little dead space to bother.

## Roadmap

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

**M3d comes before M3c in this table**, out of milestone letter order: section 6's creation flow is a click on a plotted point, and the pages that plot real points are M3d's, so building the annotation panel first would mean targeting fixture points that correspond to no row an override could name.

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

## The name

*Haelan* is Old English **hǣlan**, "to heal, to cure, to make whole". It shares a root with
**hāl**, "whole, sound, hale", and it is the word English later turned into *health* by way of
**hǣlþ**, literally the state of being whole.

That is the right idea for this project. A dashboard that shows you today's numbers is reporting
on a fragment. The point of keeping a complete local history, with your own notes and events
beside it, is to see the whole rather than the reading.

The name also stays deliberately clear of the API it reads. Calling this "Google Health
something" would borrow a trademark for no benefit; the positioning is that haelan works with the
Google Health API, not that it is part of it.

## Non-goals

- A hosted, multi-tenant service. Running one would inherit the exact cap this design exists to
  avoid.
- Public internet exposure. The instance binds to localhost or a LAN and is reached through a
  reverse proxy or Tailscale. There is no public deployment story.
- Writing data back to Google. Read only in v1.

## Layout

```
packages/core     the only package that issues SQL or talks to Google
packages/tokens   design tokens, emitted to CSS custom properties
apps/server       Fastify: routes, cookies, the scheduler, the setup wizard's API
apps/web          React and Vite: the dashboard and the setup wizard
scripts/          the demo seed, the enum drift check and the image boot check
assets/           the screenshots above
probe/            M0 throwaway scripts and the findings three plans still cite
```

`probe/` was going to be deleted once M1 landed, and that is now due. It is staying anyway, and
the promise was the wrong one: `probe/scripts/` is throwaway and `probe/findings/` is not.
Three plans cite the findings, the wizard's console copy is derived from them, and the redirect
URI rules quote them directly. Deleting the measurements to keep a tidying promise would leave
the code asserting things with no recorded source. The scripts go when something needs the
space; the findings stay.

`packages/core/README.md` documents the store and the API client, `apps/server/README.md` the
HTTP surface, and `apps/web/README.md` the dashboard and the wizard.

Specs and plans live under `docs/superpowers/` and are deliberately not tracked: they are working
documents for whoever is building, not part of what ships.

## Development

```
pnpm install
pnpm test
pnpm typecheck
git config core.hooksPath .githooks
```

That last line is once per clone. It enables `.githooks/commit-msg`, which refuses a commit
message carrying a Claude Code session link. CI checks the same rule on every push and pull
request, so the hook is fast feedback rather than the guarantee, and forgetting it costs a red
build instead of a bad commit reaching `master`.

Two processes in development, in separate terminals. Vite serves the app and proxies `/api` and
`/oauth` to Fastify, so the browser sees one origin and the session cookie behaves exactly as it
does in production behind one port.

```
pnpm dev:server      Fastify on 4235
pnpm dev             Vite, proxying to it
```

For the single port arrangement production uses, build the bundle first and run the server
alone: it serves `apps/web/dist` when that directory exists.

```
pnpm build
HAELAN_DATA_DIR=./.local-data pnpm start
```

`pnpm start` runs from the repository root, so a relative `HAELAN_DATA_DIR` is relative to the
root too. The server prints the resolved absolute path at boot, so there is never a question
about which database an instance opened.

Node 22.13 or later. The suite runs against temporary SQLite databases and needs no credentials:
every payload it reads is synthetic, and the one test that speaks HTTP speaks it to a stub on
localhost.

## Conventions

- No em dashes anywhere: prose, documentation, UI copy, code comments, commit messages.
- No agent session links in commit messages or pull request bodies. `Co-Authored-By` trailers
  are attribution and are welcome; a session URL is meaningless to everyone but the account that
  created it. Enforced by `.githooks/commit-msg` and by CI.
- Comments are sparse and record why, not what.
- Every change reaches `master` through a pull request, and nothing is ever force pushed. That
  rule has exactly one exception, on 2026-08-22, recorded here rather than quietly: `master` was
  rewritten once to strip agent session links from 22 commit messages, before the repository was
  public and while nothing else had cloned it. Content was untouched, verified by the rewritten
  tree being byte-identical to the original and by the commit count and every `Co-Authored-By`
  line surviving. The merge references on pull requests #30 through #38 point at commits that
  rewrite left unreachable. There is no second exception.
- Real health data never gets committed. Archived payloads stay gitignored, and every test fixture
  is synthetic.

## License

AGPL-3.0-only. Full text in [`LICENSE`](LICENSE). If you fork haelan and run a modified version as
a network service, the AGPL requires you to publish your changes to the people using that service.

## Contributing

Not open to contributions yet; the interfaces are still moving weekly. Issues describing what you
would want from a self-hosted health dashboard are welcome once the repository is public.
