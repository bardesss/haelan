# Probe findings

Everything below is M0, run 2026-08-19, except `rollup-methods.md`, which is M2p, run
2026-08-22, and which corrects two things this file said.

## M0

Probe run 2026-08-19 against project `haelan-genesis`, one real account, Fitbit as the only
connected source.

**Scope classification:** Five of the six read scopes are **restricted**, `settings.readonly`
is merely sensitive. Restricted governs verification, which lifts the 100 user cap. It does
not govern publishing.

**Publishing status:** **In production, unverified, accepted.** No security review was
demanded. The only warning concerns branding, which controls whether the app name and logo
appear on the consent screen rather than whether the app may run. The 7 day refresh token
expiry that testing status imposes therefore never applies to this instance.

**Refresh token lifetime:** Refresh succeeds. The daily check is logged in `token-log.jsonl`
and is confirmation rather than discovery, since production status removes the documented
expiry. It ran from 2026-08-19 to 2026-08-21 and the scheduled task was deleted on 2026-08-22,
by which point it was authenticating with a client secret Google had stopped accepting. That log is machine local and gitignored: it is one line per run of a
scheduled task on whoever registered it, so committing it would mean a working tree that goes
dirty every morning to record an answer this file already states.

**Resolution and volume:** Heart rate samples every **2 seconds**, not the assumed minute:
37,370 rows and 23 MB of raw JSON per person-day, which is 95 percent of all rows. Every other
type together is under 0.8M rows per person-year. See `volume.md`.

**Endpoint paths that worked:**

    GET /v4/users/me/profile
    GET /v4/users/me/pairedDevices
    GET /v4/users/me/dataTypes/{kebab-type}/dataPoints?filter=&pageSize=&pageToken=

**Types unavailable or erroring:** `total-calories` and `floors` reject `list` entirely and
answer `:rollUp` and `:dailyRollUp` instead (`floors` also `reconcile`). M0 measured only that
those endpoints exist; M2p measured what they take and return on 2026-08-22, in
`rollup-methods.md`. `nutrition-log` is empty for this account in every window probed.
`hydration-log` holds 33 points, all from 2017.

## Consequences for M1

- **Section 7, publishing.** The setup wizard must walk the owner to In production and say
  plainly that an unverified app warning is expected. Skipping that step silently buys a 7 day
  token, and the failure surfaces a week later as a household-wide sync stop.
- **Section 7, mitigations.** Mitigation 1 applies. Mitigation 2, periodic re-consent, is dead.
  Mitigation 3, `invalid_grant` detection and a reconnect banner, survives as the response to a
  genuine revocation.
- **Section 8, sync engine.** The filter member differs per data type across five shapes and
  none of it is documented. It belongs in the same table that drives field mapping, because a
  wrong member is a 400 rather than a silent empty result, which is the good failure mode.
- **Section 8, sessions.** Sleep filters on `interval.end_time`, so a nightly window is defined
  by when a night **ends**. A window defined on bed time silently drops the night that crosses
  it.
- **Section 8, civil time.** Exercise and the logs filter only on `civil_start_time`, which
  carries no zone. A window expressed in UTC means something different for these types.
- **Section 6, volume.** Heart rate needs a per-metric downsampling decision in M1, and the raw
  archive needs compression or a retention policy. See `volume.md`.
- **Section 6, parsing.** Integers arrive as JSON **strings** (`beatsPerMinute`,
  `minutesAsleep`), and proto3 omits zero-valued fields entirely, so `civilStartTime.time` can
  be `{}`. The mapper must treat absent as zero rather than as missing data.
- **Section 15, redirect URIs.** No LAN hostname or private IP is registrable. Consent
  completes only at localhost, over Tailscale, or behind a real certificate. See
  `console-steps.md`.
- **Section 11, nutrition.** This household logs no food and last logged water in 2017. The
  Nutrition page needs a genuine empty state, not a chart with no series.

## Still open

- **Billing.** Whether the console demands a billing account to enable the API, and whether any
  quota page shows a per request cost. Spec risk 6. Not yet observed.

## M6-0, all-time eligibility, 2026-09-15

`probe/scripts/all-time-eligibility.mjs`. Whether a day the reader excluded, or a day whose
coverage is thin, can hold an all-time record or move an Eddington number.

**The write-up is deliberately not in this directory.** It reports day counts and an Eddington
integer off one household's archive, and this repository is public. What the units downstream
needed from it is in `ROADMAP.md` instead, stated structurally: coverage never decides a record,
no eligibility rule moves an Eddington number, the rule the milestone actually needed was tier
selection rather than eligibility, and an all-time figure has to name the window it covers.
