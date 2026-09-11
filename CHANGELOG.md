# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versioning
follows [Semantic Versioning](https://semver.org/). See the Contributing section of
[README.md](README.md) for who writes an entry and when.

## [Unreleased]

## [1.0.0] - 2026-09-11

First release. A self-hosted dashboard and local mirror for your own health data, built on the
Google Health API v4, for one household running one instance.

### Added

- A complete local mirror of the account's Google Health history in one SQLite file: the
  compressed raw archive, everything derived from it, and every note, event and override,
  surviving Google's retention windows and kept at minute-level resolution for intraday samples
  that the API itself does not retain.
- Eight dashboard pages: Dashboard, Activity, Sleep, Recovery, Health, Weight, Nutrition and
  Notes. Sleep is derived with stage durations, nap detection and efficiency computed from our
  own segments rather than passed through from the source; Activity carries a heatmap, a workout
  list and an intraday chart; Health covers resting heart rate, HRV and SpO2 with its confidence
  interval; Weight tracks a trend; Nutrition explains, rather than fakes, that the household has
  never logged food and the API's `Food` type carries no timestamp to file a meal under. English
  and Dutch throughout.
- Personal baselines: a reading is shown against the person's own rolling 60 day baseline, and a
  baseline built from too few days is flagged as thin rather than presented as settled.
- Period-over-period insight cards that withhold themselves, each with its own stated reason,
  when the data behind them is too thin to say anything.
- Daily notes and typed events (illness, travel, alcohol, medication, injury, and any other kind
  a person names), so a change in a metric can be checked against what else was going on that day.
- Corrections applied at derivation time rather than by rewriting history: an override excludes a
  bad reading (a glitching strap reporting 210 bpm) from what gets derived, and the raw archived
  payload is never modified, so removing the override restores the original value exactly.
- Household multi-user support: an admin invites a member, the member chooses their own password,
  and each person connects their own Google account and picks which data types get fetched for
  them, seeing only their own data.
- A guided setup wizard that walks through creating a Google Cloud project and OAuth client,
  prints the exact values to paste, and asks which data types to fetch and how far back to
  backfill.
- A daily backup: a compacted copy of the database, integrity-checked and row-counted before it
  is called a backup, with a configurable number kept.
- An automatic upgrade path: a schema migration that changes how data is derived rebuilds the
  affected person's rows from the raw archive rather than leaving old and new derivations side by
  side, and a boot-time reclaim hands freed database pages back to the filesystem once enough of
  them accumulate.
- A demo data seed (`scripts/seed-demo.mjs`) that writes a year of generated history into an
  empty data directory and leaves the setup wizard already finished, for trying the dashboard
  without a Google account.
- A Docker image built for both `linux/amd64` and `linux/arm64`, booted on both architectures
  before every publish, deployable with an eight-line `compose.yaml` that needs no editing.

### Security

- Stored Google credentials are encrypted at rest under a key kept outside the database and
  deliberately excluded from backups, so a backup copied off the machine never carries the
  credentials needed to decrypt itself.
