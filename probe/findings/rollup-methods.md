# Rollup methods, observed 2026-08-22

Measured by `probe/scripts/rollup-shapes.mjs` against the live account, 19 requests. Raw
responses are in `probe/samples/rollup/` and are gitignored like every other sample. Following
`field-map.md`, this file records request and response shapes, paths and types, and never a
measurement: where a number was needed to make a point, it is a difference or a count of
windows rather than a value the account reported.

Answers the question M2 was blocked on: `total-calories` and `floors` reject `list`, and
`field-map.md` left their filter member, payload key and value path columns empty because no
request or response had ever been observed. Both are now observed.

## The methods are `:rollUp` and `:dailyRollUp`, with a capital U

`field-map.md` records them as `rollup, dailyRollup` because that is how the API spells them in
the error message it returns when `list` is refused. The method names themselves are camel case
with a capital U:

    POST /v4/users/me/dataTypes/{dataType}/dataPoints:rollUp
    POST /v4/users/me/dataTypes/{dataType}/dataPoints:dailyRollUp

The public discovery document at `https://health.googleapis.com/$discovery/rest?version=v4`
carries both, with full request and response schemas, and needs no credentials to read. Every
shape below was read there first and then confirmed against the account.

## Request shapes

`rollUp` groups by physical time and takes an absolute interval plus a window duration:

```json
{ "range": { "startTime": "2026-08-15T00:00:00Z", "endTime": "2026-08-22T00:00:00Z" },
  "windowSize": "86400s" }
```

`dailyRollUp` groups by civil time and takes a civil interval, with `windowSizeDays` defaulting
to 1:

```json
{ "range": { "start": { "date": { "year": 2026, "month": 8, "day": 15 } },
             "end":   { "date": { "year": 2026, "month": 8, "day": 22 } } } }
```

Neither takes a `filter` string. The filter grammar that every `list` call needs does not apply
here, which is why the filter member column for these two types was never fillable: they have
none.

## Response shapes and value paths

Both answer `rollupDataPoints`, newest window first. A physical point carries `startTime` and
`endTime`; a civil point carries `civilStartTime` and `civilEndTime`, each a `{ date, time }`
where `time` is present but empty for a whole-day window.

| Type | Payload key | Value path | JSON type | Unit |
|---|---|---|---|---|
| `total-calories` | `totalCalories` | `totalCalories.kcalSum` | number | kcal |
| `floors` | `floors` | `floors.countSum` | **string** | count |

`floors.countSum` is an int64, and Google serialises int64 as a JSON string. Parsing it as a
number without a cast is the kind of defect that only shows up above 2^53, which is never, so it
would instead show up as a string landing in a `real` column.

## Days with no data are omitted, not returned as zero

`floors` over a 90 day range returned 86 windows. The four missing days are absent from the
array rather than present with a null or a zero. Spec invariant 2 therefore holds by
construction here: coverage for these two types has to be derived from which windows came back,
because there is no per-window count to divide by.

## Neither method paginates

Both requests accept a `pageToken`, and `RollUpDataPointsResponse` even declares a
`nextPageToken`, but no response in 19 requests carried one, and `pageSize` does not do what it
looks like it does:

- `dailyRollUp` over 14 days with `pageSize: 5` is a 400: *"page_size (5) is too small. Must be
  at least 14 to cover the requested range with a window_size_days of 1."*
- `rollUp` over 90 days with `pageSize: 5` returned all 86 windows and no token.

So `pageSize` is a floor the request must clear, not a page size, and the range cap below is the
only lever a backfill has. A rollup walk steps by range; it never pages.

## Range caps are per type and machine readable

| Type | Max range | Reason returned |
|---|---|---|
| `total-calories` | 14 days | `INVALID_ROLLUP_QUERY_DURATION`, `metadata.maxDurationDays: "14"` |
| `floors` | 90 days | `INVALID_ROLLUP_QUERY_DURATION`, `metadata.maxDurationDays: "90"` |

The discovery document names the same 14 day group: `calories-in-heart-rate-zone`, `heart-rate`,
`active-minutes` and `total-calories`. Everything else is 90. A 90 day request for `floors`
succeeded exactly at the cap, so the bound is inclusive.

The error carries `maxDurationDays` in its metadata, so a client that guesses wrong can read the
right answer out of the rejection rather than failing.

## Physical and civil rollups disagree, and civil is the one we want

The same seven days, `total-calories`, both methods. Values are the account's own, so only the
disagreement between the two is recorded here, per this directory's rule that a finding carries
shapes and never a measurement:

| Day | `rollUp` against `dailyRollUp` |
|---|---|
| 2026-08-21, the trailing day | +7.9% |
| 2026-08-20 | 0.0% |
| 2026-08-19 | -0.4% |
| 2026-08-18 | +0.6% |
| 2026-08-17 | -0.1% |
| 2026-08-16 | +0.1% |
| 2026-08-15 | -1.3% |

The account is in Europe/Amsterdam, UTC+2 in August, so a UTC anchored 24 hour window is the
local day shifted two hours. Mid-history the shift mostly cancels; at the trailing edge it does
not, because the last UTC window reaches two hours into a day the civil one has not started.
Total calories includes basal expenditure, so two hours of it is not a rounding error.

Spec invariant 3 already says days are local. This is the measurement behind it: **`dailyRollUp`
is the only correct source for a `daily` row**, and `rollUp` is for sub-day windows only.

## Sub-day windows work

`total-calories` with `windowSize: "3600s"` over one day returned 24 hourly windows. An intraday
total-calories trace is therefore possible, at the cost of a walk capped at 14 days per request.
Not needed for v1, recorded so nobody re-probes it.

## Rollups do not generalise to every type

| Type | `dailyRollUp` | Note |
|---|---|---|
| `total-calories` | yes | no `list` |
| `floors` | yes | no `list` |
| `steps` | yes | also lists |
| `heart-rate` | yes | also lists |
| `daily-resting-heart-rate` | **no** | `UNSUPPORTED_DATA_TYPE_ACTION`, allows `list, reconcile` |
| `sleep` | **no** | allows `list, get, reconcile, create, update, batchDelete` |

So the catalogue's `listSupported: boolean` is not enough to describe the surface: a type has a
set of supported actions, and `list` and `rollUp` are neither opposites nor a partition. The
rejection names the allowed set in `metadata.allowed_actions`, which is how this table was built.

Types that support both are deliberately left on `list`. Rollups cannot be split by source (see
below) and sample level data can, so switching a type we can list to its rollup would trade
provenance for nothing.

## Rollups are server side merged, and `dataSourceFamily` does not undo it

Both methods are documented as rolling up "reconciled data points from all data sources,
excluding those data points that are identified as recorded by wearables in intervals when they
were not actually worn". There is no per source rollup. The only lever is `dataSourceFamily`,
which takes three values: `all-sources`, `google-wearables`, `google-sources`.

All three returned identical `kcalSum` for all seven days on this account. That is one account,
one type, one week, so it bounds the lever rather than disproving it, but nothing here suggests
the families can recover a per source split.

**Consequence for spec section 9.** `total-calories` and `floors` arrive already merged, by
somebody else's policy, with the per source data that policy was applied to unavailable. Every
other metric's `merged` row is computed from per source rows we hold and can be inspected
against them. These two cannot be. Recording them as `source = 'merged'` would make the promise
that any merge decision is inspectable false for exactly two metrics, silently. They need a
source value that says where the merge happened.

## Retention: no cliff at 180 days, for either type

A seven day window 180 to 187 days back returned data for all seven days for both types, and the
90 day `floors` walk was continuous apart from the four genuinely missing days. `retention.md`
measured the same absence of a cliff for heart rate within the 209 days the account has existed.

This still bottoms out on the account rather than on Google: an account 209 days old cannot
distinguish "Google keeps it" from "nothing has aged out yet". The urgency of ingesting these
two is correspondingly low, which is what section 17 already assumed.

## Operational finding: `.env.local` is stale and the daily refresh check is broken

The probe first failed with `invalid_client`. The cause is not the grant: `.env.local` and the
instance database hold the **same client id and different client secrets**, and Google rejects
the one in the env file. The secret was rotated in the console at some point after M0, and the
M1d wizard wrote the new one into the instance while the env file kept the old.

Everything that still reads `.env.local` has been authenticating as a client that no longer
exists. That includes `probe/refresh-check.mjs`, which the scheduled task `haelan-refresh-check`
runs daily at 09:00 and which writes `findings/token-log.jsonl`. The log has no entry after
2026-08-21, and the task's last run on 2026-08-22 at 09:21 exited `-2147020576`, so the token
longevity measurement has stopped. Nothing downstream depends on it continuing, since section
7's six month question was already answered, but the log should not be read as evidence of
anything after 2026-08-21.

`probe/scripts/creds.mjs` reads the client and the refresh token out of the instance database
instead, which is where they now live. It never writes a rotated token back: a throwaway script
that refreshes a token the instance owns is how an instance loses its grant.
