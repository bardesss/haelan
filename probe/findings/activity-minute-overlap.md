# Activity minutes: do the two families count the same clock minutes?

Measured by `probe/scripts/activity-minute-overlap.mjs` on 2026-09-13, from the M0 archive in
`probe/samples/`, the same payloads `field-map.md` was generated from. Following that file and
`rollup-methods.md`, this one records shapes, counts and relationships and never a health
measurement: every number below is a count of points, a count of clock minutes, a percentage or
a ratio. No daily series and no device name appears here, and the archive stays gitignored.

Answers the question issue #143 is blocked on. Its reporter proposed one chart stacking
`active_minutes_light`, `active_minutes_moderate` and `active_minutes_vigorous` with
`active_zone_minutes_peak` on top, and a summed total above it. A stack claims its parts add up.

**They do not.** The two families count the same clock minutes, and the two series the chart
would stack against each other are the most overlapping pair in the sample. Measurement below.

## What was measured

| Type | Points | Interval length | Distinct start instants | Repeated starts |
|---|---|---|---|---|
| `active-minutes` | 1114 | 1 minute, all of them | 1114 | 0 |
| `active-zone-minutes` | 334 | 1 minute, all of them | 334 | 0 |

Both types emit one point per clock minute on the same grid: all 1448 intervals across the two
files are exactly one minute long and start on a whole minute, none off-grid, none repeated. So
"the same clock minute" is an exact key match on `interval.startTime` rather than an interval
intersection test, and there are no partial overlaps to argue about.

Both files come from one account, one person and one device — `FITBIT` platform for every
point, `DERIVED` for all 1114 active-minutes points and `PASSIVELY_MEASURED` for all 334
zone-minute points. The two families are produced by different paths at the source.

### The comparison window

`field-map.md` records `active-minutes` as having hit the page cap, and it had: the archived
file is a single page holding the *tail* of the seven day window and nothing before its first
point. Comparing the families outside the range both cover would read that truncation as a real
absence, so every overlap figure below is computed inside

    2026-08-13T15:02:00Z .. 2026-08-19T15:10:00Z     six days and twenty hours

which holds all 1114 active-minutes points and 245 of the 334 zone-minute points. The 89
excluded points all fall on the window's first UTC day, before the active-minutes page begins.
No excluded point sits inside the window.

## 1. Can one minute be counted in both families? Yes — always, in this sample

Of the 245 zone minutes inside the window, **245 are also an active-minutes minute: 100 percent,
with no exceptions.** Over these six days the zone-minute set is a strict subset of the
active-minute set. The converse does not hold — 245 of 1114 active minutes, 22 percent, also
carry a heart rate zone.

Cross tabulated, one distinct clock minute per cell:

|  | FAT_BURN | CARDIO | PEAK |
|---|---|---|---|
| **LIGHT** | 89 | 2 | 0 |
| **MODERATE** | 53 | 0 | 0 |
| **VIGOROUS** | 42 | 15 | 44 |

Every non-zero cell is a minute that a chart stacking the row label against the column label
counts twice. The specific pair issue #143 proposes to stack — vigorous minutes, peak minutes
above them — is the largest cell in the table: **44 minutes are both, and every peak minute in
the window is also a vigorous minute, 44 of 44.** There is no minute anywhere in the window
that is peak and not vigorous.

The two bands the chart would draw side by side are, in this data, one band drawn twice.

## 2. Are light, moderate and vigorous mutually exclusive of each other? Yes

The payload permits `activeMinutesByActivityLevel[]` to carry LIGHT, MODERATE and VIGOROUS
entries at once, unlike AZM's single zone per point, and that is what made this worth measuring.
It never does:

- **All 1114 points carry exactly one entry.** None carries two or three.
- **Every entry's `activeMinutes` value is `1`**, so every point's entries sum to 1.
- The only level sets observed are therefore LIGHT (932 points), MODERATE (76), VIGOROUS (106).

One point, one clock minute, one level. Within this family the three are a genuine partition:
light + moderate + vigorous counts each active clock minute exactly once. A stacked chart over
just these three is honest, and its total is a real number of minutes.

## 3. Does summing a family's three members give a meaningful daily total?

**For `active_minutes_*`: yes**, and it means "minutes active". Per the partition above, and
comfortably inside the clock — the busiest civil day in the window used under a sixth of its
1440 minutes, so nothing here strains against the day.

**For `active_zone_minutes_*`: no, not in minutes.** The value is not always 1, and which value
it takes is decided entirely by the zone, with no exception in either direction across all 334
points:

| Zone | `activeZoneMinutes` value | Points |
|---|---|---|
| FAT_BURN | always 1 | 213 |
| CARDIO | always 2 | 41 |
| PEAK | always 2 | 80 |

One clock minute in the cardio or peak zone is worth two active zone minutes. This is a score,
not a duration. The two diverge sharply: on the hardest civil day in the window the zone score
is 1.85 times the number of zone minutes of clock time it describes.

So summing `active_zone_minutes_fat_burn + _cardio + _peak` yields a number whose unit is not
minutes, even though `metrics.ts` declares all three as `unit: 'minutes'`. Whether haelan should
sum the raw values (a score) or count the points (clock minutes) is a product decision, but they
are different numbers and only one belongs on an axis labelled minutes.

### What the proposed total would print

Over the whole window, the proposed stack would print a total **7.9 percent larger** than the
number of distinct clock minutes its segments describe. That average is mild only because most
days in the window had no peak minutes at all and the error was zero on them. All 44 peak
minutes fall on a single civil day, and on that day the proposed total is **43.8 percent larger
than the distinct clock minutes underneath it** — the chart draws 44 minutes as a band beside
the vigorous band that wholly contains them, and doubles them again on the way into the total.

The error is therefore invisible on a rest day and largest precisely on the day a reader would
open the chart to understand.

## What this does not establish

- **One account, one person, one device, six days and twenty hours.** Fitbit only, `DERIVED`
  and `PASSIVELY_MEASURED` respectively. Nothing here says how Health Connect, a manually
  logged workout or a non-Fitbit platform fills these two types. `field-map.md` already records
  that other types in this same account arrive from `HEALTH_CONNECT` under different
  conventions, so a second platform is a real possibility rather than a hypothetical.
- **"Always" means "with no exception in this sample."** 245 of 245 is a strong result for a
  subset relationship, but it is six days of one wrist, not a documented contract. Neither the
  v4 reference nor the discovery document states any relationship between the two types, which
  is why this had to be measured at all.
- **One level per point is likewise measured, not promised.** The repeated field still permits
  three entries, so a mapper assuming one would be assuming something the schema does not
  enforce. `mapSamples.ts` reading the array is correct; only the chart may lean on the
  partition, and only as far as this measurement reaches.
- **All 44 peak minutes fall on one civil day**, so "every peak minute is vigorous" rests on a
  single session rather than 44 independent occasions. The FAT_BURN and CARDIO rows of the
  cross tabulation are spread across the window and are better sampled than the PEAK column.
- **The doubling of CARDIO and PEAK was observed, not explained.** 334 points is enough to
  establish the rule holds here; it is not a source that says the rule is intentional or stable.
- **Wear time and total active time were not brought in**, because neither family needed them:
  within a family the minutes are distinct and daily totals sit far below the clock, so no
  clock violation was available to find. The overlap question was settled by exact minute keys,
  which is a stronger test than any budget comparison would have been.
- **The 89 excluded zone-minute points were not tested for overlap**, because the active-minutes
  sample is silent about those minutes. They are not evidence of non-overlap and were not
  counted as such.
- **Nothing was measured about how haelan's own rollup treats either family.** This is a finding
  about the payloads, not about `rollup.ts`.

## Consequence for issue #143

The chart as proposed cannot be drawn honestly, and the reason is worth giving the reporter
plainly: the two families are not two slices of a day, they are two descriptions of the same
minutes. The three `active_minutes_*` members do partition a day's active minutes and may be
stacked among themselves with a real total. `active_zone_minutes_peak` may not go on top of
them — in this sample it is a strict subset of the vigorous band it would sit beside, and its
values are a doubled score rather than minutes, so the printed total would be wrong twice over.

Showing the zone family alongside the activity levels needs its own axis, its own chart, or an
explicit statement that it re-describes minutes already drawn.
