# Resolution and volume, observed 2026-08-19

Median gaps are measured across archived payloads. Rows per day are counted from one fully
paginated 24 hour window rather than scaled from a partial one, because the API caps a page
well below the 10,000 requested and a truncated window understates every dense type.

| Type | Median gap | Rows/day | Rows/person-year |
|---|---|---|---|
| heart-rate | 2 s | 37,370 | 13.64M |
| active-energy-burned | 1 min | 869 | 0.32M |
| distance | 1 min | 371 | 0.14M |
| oxygen-saturation | 1 min | 207 | 0.08M |
| active-minutes | 1 min | 198 | 0.07M |
| steps | 2 min | 189 | 0.07M |
| heart-rate-variability | 5 min | 72 | 0.03M |
| active-zone-minutes | 1 min | 48 | 0.02M |
| daily-* (4 types) | 1 day | 4 | negligible |
| sleep | 1 per night | 1 | negligible |
| weight, body-fat | days apart | sparse | negligible |

Total across intraday types: **14.35M rows per person-year**.
Five people over five years: **around 358M rows**.

Raw JSON, uncompressed, from the same paginated day: 24.9 MB per person per day, so roughly
**9.1 GB per person-year**, or **227 GB** for five people over five years.

## Verdict

The plan's threshold was one minute, and heart rate is thirty times finer than that. Both
consequences it named now apply.

**1. A per-metric downsampling decision belongs in M1, not later.** Heart rate alone is 95
percent of all rows. Every other type together is under 0.8M rows per person-year, which the
spec section 6 sizing handles comfortably. This is not a general volume problem, it is one
metric, which makes it tractable: a stored one-minute aggregate plus retention of raw samples
for a recent window would cut the row count by a factor of thirty while changing nothing a
chart can actually render. No dashboard draws 37,370 points across a day; the intraday trace
is downsampled for display regardless.

**2. The raw archive needs a compression or retention policy.** 227 GB of append-only JSON is
the larger number and the easier one to fix, since this payload compresses well and is read
only during rebuilds. Storing it compressed, or storing only what a rebuild genuinely needs,
keeps spec section 6's raw_payloads invariant intact at a fraction of the footprint.

Neither finding threatens the SQLite choice at household scale once heart rate is handled.
The DuckDB escape hatch in spec section 6 stays where it is, unused but now with a measured
number attached to the condition that would trigger it.

## Sizing caveat

One person, one day, one device. A second device, or a person wearing the watch during more
exercise, moves heart rate further. The measured figure is a floor, not a ceiling.
