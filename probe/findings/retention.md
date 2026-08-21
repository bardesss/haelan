# Intraday retention, measured 2026-08-21

The open question this answers: **how far back does the API actually serve intraday data?**

It mattered because the design's argument for building ingestion before the dashboard rests on
it — "every week without ingestion is a week of minute-level history permanently unavailable at
that resolution" — and because the backfill caps intraday types at 90 days for reasons of disk
cost. Whether that cap forgoes data Google would still have served was unknown, and unlike most
open questions this one gets worse while it waits.

M0 measured intraday *density* in `volume.md` and never *depth*. This is the depth.

## Method

One request per probe against the live account, heart rate for a single day window at increasing
age, reads only — no archiving, no cursor movement. Every empty answer was paired with a
**control**: `daily-resting-heart-rate` for the same day, derived from the same wear. Without the
control an empty intraday answer is unreadable, because "Google no longer serves it" and "this
person had no device yet" look identical.

## Result

| days back | date | heart rate, intraday | daily resting HR, control |
|---|---|---|---|
| 30 | 2026-07-21 | full page | present |
| 90 | 2026-05-22 | full page | present |
| 150 | 2026-03-23 | full page | present |
| 180 | 2026-02-21 | full page | present |
| 205 | 2026-01-27 | full page | present |
| 209 | 2026-01-23 | full page | none |
| 210 | 2026-01-22 | **none** | none |
| 240, 300, 365, 545, 730 | | none | none |

**Intraday and the control stop on the same day.** That is the account's own history beginning on
2026-01-23, not a retention cliff. The API served full-resolution heart rate across the entire
209 days this account has existed.

Resolution does not degrade with age either. One hour, sized to sit inside a single page so the
count is real density rather than a page cap:

| age of the hour | points returned |
|---|---|
| 3 days | page full |
| 30 days | page full |
| 90 days | page full |
| 150 days | page full |
| 200 days | page full |

An hour 200 days old comes back as densely as an hour from this week. Nothing is being thinned.

## What this establishes, and what it does not

**Establishes:** retention is at least 209 days, and there is no observable degradation within it.
The 90-day intraday cap currently forgoes **119 days of minute-level history that the API is
willing to serve today.**

**Does not establish:** the retention limit itself. The account is younger than the window, so the
measurement bottoms out on the account rather than on Google. Retention could be 210 days or
unlimited; this cannot tell. It also measures heart rate only. The other intraday types
(`active-energy-burned`, `distance`, `steps`, `active-minutes`, `active-zone-minutes`) are assumed
to behave the same and were not probed.

**Consequently the design's premise is unproven rather than confirmed.** Nothing observed here
ages out. The claim that minute-level history becomes permanently unavailable may still be true
beyond 209 days, but no evidence in this repository supports it, and the sequencing argument that
put M1 before the dashboard rests on it.

## The decision this hands back

Raising the intraday cap from 90 days to cover the full available history costs roughly 0.26 GB
per person instead of 0.60 GB, extrapolating from the measured 468 bytes per sample row. That is
the whole trade: about a third of a gigabyte per person against 119 days of minute-level history
that exists right now and might not later.

Re-running this is one throwaway script: open the instance, take an access token, request one day
of `heart-rate` and one of `daily-resting-heart-rate` at each depth, and read the pair. The script
itself was deleted per `probe/`'s own rule that `scripts/` is disposable and `findings/` is not.
