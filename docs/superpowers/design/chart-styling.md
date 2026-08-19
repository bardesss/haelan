# Chart styling specification

**Date:** 2026-08-19
**Status:** Implemented and current as of the D1 final fix round (`Dashboard.tsx`, `Sleep.tsx`)
**Scope:** every chart in `apps/web/src/charts/`, plus the card/legend conventions the two
reference pages establish for anything that carries a chart-adjacent colour.

This document plus `packages/tokens` is what M3 implements the remaining eight pages against. It
records what is actually in code, not aspiration; every value below can be found at the cited
file and line. Where the fixtures produced a result that contradicted an earlier assumption
(see "Naps" under Empty states), the actual behaviour is recorded, not the assumption.

## 1. The one rule everything else follows: resolve tokens at render time

Charts never bake a colour into a stored option object. `apps/web/src/charts/useChart.ts`:

```ts
const render = () => chart.setOption(build(currentChartTokens()), true)
render()

const observer = new MutationObserver(render)
observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
```

`currentChartTokens()` reads `getComputedStyle(document.documentElement)` fresh on every call.
The `MutationObserver` watches `data-theme` on `<html>` and re-runs `render()` on every change, so
a theme switch rebuilds the option object (`setOption(..., true)`, `notMerge: true`) with the new
theme's colours. **This is the line that makes a theme switch re-render every chart series**:
`useChart.ts`'s `observer.observe(...)` call, paired with `render` closing over `build` and
re-invoking `currentChartTokens()` each time it fires.

Every chart's `build` callback takes a `ChartTokens` object as its only source of colour
(`apps/web/src/charts/tokens.ts`) and is wrapped in `useCallback` with a complete dependency
array of the chart's own props, never of token values, so `useChart` is the single place that
decides when a chart needs to redraw for colour and it is the same code path for a prop change
and a theme change.

**Names come from the package, values come from the DOM.** `apps/web/src/charts/tokens.ts`
imports `chartVar`, `semanticVar`, `ChartToken` and `SemanticToken` from `@vitals/tokens` and
declares its mapping as `... as const satisfies Record<string, ChartToken>`. A token renamed in
`packages/tokens/src/chart.ts` is therefore a **compile error in the app**, not a blank string at
first paint; `apps/web/test/chart-tokens.test.ts` additionally asserts that `emitCss()` defines
every custom property the app reads. The same object produces both the property-name list and the
field mapping, so those two cannot drift apart. What the app must *never* import is a resolved
colour: values stay late-bound through `getComputedStyle` or the theme switch would not reach the
charts.

## 1a. Where the shared fragments live

`apps/web/src/charts/base.ts` holds everything that is house style rather than chart-specific:

- `chartBase(t)` returns `axisLabel`, `splitLine`, `axisLine`, `hiddenAxis`, `tooltip`,
  `labelledAxis`, and `grid(inset)` which fills in the constant `right: 12` / `top: 12` /
  `bottom: 24` and takes overrides for what varies.
- `STROKE`, `OPACITY`, `SYMBOL` and `AXIS_FONT_SIZE` name every weight, fill opacity and marker
  size in the chart layer.

A chart states only what makes it that chart. This is not tidiness: the six charts previously
retyped the same four blocks, and the copies had already drifted (one chart's axis labels were a
point larger than the specification claimed they all were). A number that lives inside one
chart's option object is a number the next chart copies slightly wrong.

**Spacing and type scales follow the same rule as colour, by convention rather than by guard.**
`--space-*`, `--radius-*` and `--font-size-*` exist for the same reason the colour tokens do.
Reach for them in any inline `style` or CSS rule; do not type a pixel value that one of them
already names. This is deliberately *not* enforced by a build failure, because charts legitimately
need raw numbers ECharts cannot read a custom property for (grid insets, symbol sizes, stroke
widths), and those live in `base.ts` instead. The guard covers colour only
(`apps/web/test/no-raw-color.test.ts`), and it covers hex, `rgb()`/`hsl()`/`lab()`/`oklch()`/
`color()` and the CSS named colours; `color-mix()` is allowed because it composes tokens rather
than stating a colour.

**Ordinary DOM is different and does not need this.** The Sleep page's stage-total legend
(`apps/web/src/pages/Sleep.tsx`) is plain HTML, not an ECharts option object, so its swatches
reference the custom property directly in `style`: `background: 'var(--chart-stage-deep)'`. CSS
re-evaluates `var()` on its own whenever the custom property changes on an ancestor; no
`MutationObserver` or JS resolution is needed outside a chart option. The rule is: **inside an
ECharts option, resolve the token to a string in JS before handing it to `setOption`; outside
one, reference the custom property directly in CSS or an inline `style`.** Never resolve a token
once in JS and cache the resulting string past the render that produced it (a `useState` seeded
from `currentChartTokens()`, for instance, would defeat the observer).

## 2. Grid and axis treatment

| Chart | `grid` | Notes |
|---|---|---|
| `Sparkline` | `{ left: 0, right: 0, top: 4, bottom: 4 }` | Both axes `show: false`. No grid, no ticks, no labels: the sparkline is a shape, not a chart with a coordinate system a reader is meant to consult. |
| `HeartRateRange` | `{ left: 34, right: 12, top: 18, bottom: 24 }` | Category x (dates), value y (`scale: true` so the axis fits the data rather than forcing a zero baseline). |
| `Hypnogram` | `{ left: 46, right: 12, top: 10, bottom: 24 }` | Value x in minutes, category y (4 stage lanes). `axisLabel.formatter` converts minutes to `Nh`. |
| `SleepSchedule` | `{ left: 40, right: 12, top: 12, bottom: 24 }` | Category x (dates), value y fixed to `[12*60, 36*60]` (noon through noon the next day) so every night's bed/wake pair sits on a stable clock-time axis regardless of how late the night ran, and so the fixture's daytime naps (13:00-16:00) fall inside the domain instead of being clipped below it. The window is still exactly 24 hours; only its start moved, so the bed-to-wake band is no more compressed than before. |
| `ActivityHeatmap` | `{ left: 30, right: 12, top: 10, bottom: 20 }` | Category x, **one entry per calendar week** (five for July 2026); category y, seven weekday names, Monday first. Axis line and ticks hidden on both axes; the heatmap cells carry all the information. |

Grid lines (`splitLine`) and axis lines use `t.grid`; axis labels use `t.axis`, always at
`AXIS_FONT_SIZE` (11) from `base.ts`, which sits one step below the `--font-size-xs` body
minimum and above the `--font-size-micro` step reserved for uppercase labels. No chart draws a
border around its own plot area beyond `splitLine`; the containing `Card` supplies the visual
boundary.

**Gridlines are structure, not a reading aid, and the dark theme is the reason this distinction
matters.** `--chart-grid` measures only 1.04:1 contrast (deltaE 2.54) against `--surface-card` in
the dark theme, which is not enough for a reader to trace a value back to an axis by following the
line. The value is left as-is deliberately: raising it would ripple into every contrast pair
tuned against `t.grid` in `packages/tokens/test/accessibility.test.ts` (the excluded-marker-vs-grid
pair sits at 3.81, barely over its own floor of 3), and none of those pairs were the ones found
wanting. Treat a gridline as a faint division of the plot area that a reader's eye can use to keep
a row straight, not as a mark precise enough to read a value off of; nothing in this system asks a
reader to do that by gridline alone; a chart with a value a reader needs to read exactly should
render it as a label, a tooltip or the accessible table, not rely on grid alignment.

**A calendar axis is derived from dates, never from array positions.** `charts/calendar.ts`
computes each cell's week and weekday from the date itself. The first version of the heatmap used
`i % 7` for the weekday and `Math.floor(i / 7)` for the week, which is day-of-month modulo seven:
2026-07-01 is a Wednesday and rendered in the Monday row, so every label was off by two for the
whole month, and the x axis carried 31 categories for a series that plots 5 columns, squeezing
every cell into the leftmost sixth of the card. Both are invisible without checking a real date
against a real calendar, which is what `apps/web/test/calendar.test.ts` now does.

**Tick density.** Two strategies are in use, chosen by how wide the chart typically renders:

- **Explicit thinning** for a chart that regularly sits in a narrower card: `SleepSchedule`'s
  x-axis sets `axisLabel.interval: 4` (every fifth day labelled) because a full month of daily
  labels collides at the 5-column width the reference pages give it.
  `ActivityHeatmap`'s and `Hypnogram`'s y-axes need no thinning: they only ever have 7 or 4
  categories.
- **Default auto-thinning** for a chart that is usually full-width: `HeartRateRange` sets no
  `interval` and lets ECharts' default `'auto'` behaviour drop labels to avoid overlap. This is
  deliberate, not an oversight: a chart's own card span on a given page determines whether it
  needs an explicit interval, and a component should not assume its own width.

## 3. Series stroke weights

All of these are named constants in `base.ts`, not literals in the option objects.

| Element | Constant | Value | Where |
|---|---|---|---|
| Sparkline line | `STROKE.sparkline` | `1.6` | `Sparkline.tsx`, colour `t.series` |
| HeartRateRange mean line | `STROKE.series` | `1.9` | `HeartRateRange.tsx`, colour `t.series` |
| SleepSchedule night span | `STROKE.nightSpan` | `5`, `lineCap: 'round'` | `SleepSchedule.tsx`, colour from `nightMark` (`t.stageLight` for a real night) |
| HeartRateRange min/max band | `OPACITY.rangeBand` | fill only, `0.22`, colour `t.stageLight` | drawn as a stacked area (min invisible, max-min visible), not a stroke |
| HeartRateRange baseline `markArea` | `OPACITY.baselineBand` | fill only, `0.5`, colour `t.band` | see section 4 |
| Nap marker | `SYMBOL.nap` | `6` | `SleepSchedule.tsx`, colour `t.stageAwake` |
| Excluded reading marker | `SYMBOL.excluded` | `7` | `HeartRateRange.tsx`, colour `t.excluded` |
| No-data marker radius | `SYMBOL.noData` | `3` | `SleepSchedule.tsx` and `ActivityHeatmap.tsx`, colour `t.noData` |
| Event annotation `markLine` | dashed | colour `t.stageAwake` | see section 6 |

The ordering is deliberate: the sparkline is the thinnest line in the system (a glance, not a
measurement); the heart-rate mean line is slightly heavier because it is the thing a reader is
meant to trace across a month; the sleep-schedule span is drawn as a thick rounded bar rather
than a line at all, because its role is closer to a Gantt bar (a night's *span* of time) than a
trend.

## 4. The baseline band

Only `HeartRateRange` currently draws one, via `markArea`:

```ts
markArea: { silent: true, itemStyle: { color: t.band, opacity: 0.5 },
  data: [[{ yAxis: baseline.low }, { yAxis: baseline.high }]] }
```

`t.band` (`--chart-band-baseline`) is a colour distinct from any stage or series colour, so a
baseline band never reads as "this looks like the light-sleep stage colour." The convention for
any future chart with a personal baseline (recovery, resting heart rate, SpO2, per section 10 of
the design spec) is the same: a `markArea` (or equivalent low-opacity fill) behind the series,
using `--chart-band-baseline`, `silent: true` so it never intercepts hover, spanning
`[baseline.low, baseline.high]` on the value axis. It sits behind the series precisely so a
reading resolves as "inside/outside my usual range" at a glance rather than requiring the reader
to consult the axis numbers.

## 5. Tooltip styling

Every tooltip is `chartBase(t).tooltip`, which is:

```ts
tooltip: { backgroundColor: t.tooltipBg, borderColor: t.grid, textStyle: { color: t.muted } }
```

`--chart-tooltip-bg` is its own token rather than a borrowed `--surface-card`: a tooltip is drawn
*over* a card, so painting it the card's own colour leaves only the border to say a panel is
there. It is one step off the card in each theme (`#192937` dark, `#EAF0FB` light), and the
accessibility suite asserts both that it differs from `--surface-card` (deltaE 7.9 dark, 8.03
light) and that `--text-muted` clears 4.5:1 on it (6.10 dark, 7.60 light).

`HeartRateRange` uses `trigger: 'axis'` with a custom `formatter`; `ActivityHeatmap` uses the
default per-item tooltip. `Sparkline`, `Hypnogram` and `SleepSchedule` currently ship no tooltip.

**Why `HeartRateRange` needs a custom formatter, and the pattern to reuse.** The min/max band is
implemented as a stacked area (an invisible `min` series plus a `range` series holding
`max - min`, filled), which is what makes the fill sit in the right place. ECharts' default axis
tooltip would then report each series by its literal configured value, so the `range` series
would display as `range: 34` (the *delta*), not the day's true maximum, an easy value to
mistake for the day's peak. The fix is to ignore series values entirely and look the day up by
`dataIndex` from the same prop the chart was built from:

```ts
// apps/web/src/charts/hrTooltip.ts
export function hrTooltip(days: DayRow[], index: number | undefined): string {
  const day = index === undefined ? undefined : days[index]
  if (!day) return ''
  if (!day.worn) return `${day.date}<br/>not worn`
  if (day.hrMean === null || day.hrMin === null || day.hrMax === null) return `${day.date}<br/>no data`
  return `${day.date}<br/>mean ${day.hrMean} bpm<br/>range ${day.hrMin} to ${day.hrMax} bpm`
}
```

**Any chart built from a stacked series for visual layout (a band, a range, a stacked total)
must write a formatter that reads the source data by index rather than trusting the stacked
series' own values**, and that formatter must handle the "worn but the specific metric is
null" case explicitly rather than letting a null reach the template string as the literal text
`"null"`.

The formatter lives in its own module rather than inside the option object, because it is the
only branching logic in the chart layer and the three branches are exactly the ones a copy would
get wrong. `apps/web/test/hr-tooltip.test.ts` covers all three plus the out-of-range index.
A copied formatter should be copied *with* its test.

## 6. The basis line convention

Every headline number and every chart card states its basis, in a `<p className="basis">` (or
the `StatTile` `basis` prop, which renders through the same CSS class). The convention has three
parts, always present in this order where they apply:

1. **What was aggregated**: `sum`, `mean`, or a plain description (`daily minimum, mean and
   maximum`, `bed and wake time`).
2. **Coverage**: `N of M days` (or `nights`), counted from the fixture, never a literal number
   typed by hand: `${worn.length} of ${july.days.length} days`.
3. **What is missing, named explicitly when non-zero**: `${unworn} days not worn`. A basis line
   never says "27 of 31 days" and stops there; it names what happened to the other four, because
   silence about the gap is what invites the reader to assume full coverage.

The `.basis` CSS class (`app.css`): `font-size: var(--font-size-xs)`, `color: var(--text-muted)`,
`margin-top: var(--space-1)`, `line-height: 1.4`. It is deliberately the same visual weight
everywhere a basis line appears, so a reader learns once that small muted text under a number is
always the coverage statement, never decoration.

**Deltas carry the same discipline plus an arrow, and direction is not the same fact as
judgement.** `apps/web/src/format.ts` exports `trend(values, polarity)`, which compares the mean
of the first half of a run of worn-day values against the second half and returns
`{ text: '↑ 9%', dir: 'up', tone: 'good' }` (arrow and `↓`/`→` for down/flat, flat below a 1%
swing). `dir` is a fact read off the data; `tone` (`'good' | 'bad' | 'neutral'`) is a judgement
about whether that direction is welcome, and the two are kept as separate fields on purpose:

- `polarity: 'higher-is-better'` (steps, sleep duration): `up` is `good`, `down` is `bad`.
- `polarity: 'lower-is-better'` (resting heart rate): `up` is `bad`, `down` is `good`.
- `polarity: 'neutral'` (the default, and what the Dashboard's mean-heart-rate tile uses
  deliberately): every direction reports `tone: 'neutral'`. A rising daily mean heart rate is
  genuinely ambiguous without more context than a month of fixture data provides, and `neutral`
  is the honest answer rather than a guessed verdict.

**A delta states its window too.** `trend()` returns a `basis` field naming what it compared
(`change is the mean of the last 13 readings against the first 13`), and `StatTile` appends it to
the tile's own basis line. A bare "up 4 per cent" on a page whose stated rule is that every
headline number states its basis was the rule's only exception; the comparison window is part of
the number, not a footnote. `Sleep.tsx`'s baseline delta does the same and states its polarity
explicitly (`higher-is-better`) rather than falling through to a neutral default: sleep duration
is not a metric anyone is actually neutral about.

`StatTile`'s `delta` prop renders both: `data-dir` carries the arrow (unstyled by CSS, present as
a semantic hook), `data-tone` carries the colour (`.delta[data-tone]` in `app.css`, mapping
`good` to `--positive`, `bad` to `--negative`, `neutral` to `--text-secondary`), and **`tone`
defaults to `neutral` when a caller omits it**, so a delta nobody has stated a polarity for is
never coloured as if a judgement had been made. This closes a defect the first version of this
task shipped: `StatTile` used to colour every `up` green and every `down` red regardless of the
metric, which put a green rising arrow beside a climbing resting heart rate on the reference
dashboard other pages will be copied from. Fixed at the component (`StatTile.tsx`, `app.css`),
not by dropping deltas from the metrics where the polarity is inverted.

## 7. Empty state wording patterns

`EmptyState` (`title`, `detail`) renders `{title}<br/><small>{detail}</small></p>`. The design
spec names three kinds of empty, and they must never be interchangeable, because they answer
different questions. Two are in use on the reference pages; the third is specified here for M3,
which will hit it as soon as a page offers a range shorter than a metric's own window.

**Template A: verified absence.** The metric is tracked, coverage is full or explicitly stated,
and the checked result is genuinely zero.

```
"No nights with zero recorded sleep in July."
"Checked 27 of 31 nights the device was worn. The remaining 4 nights have no reading at
all, which is a different kind of gap."
```

```
"No nap recorded last night."
"Device was worn on 2026-07-31, so this is a real absence rather than missing data."
```

The detail always names the coverage count and, where relevant, distinguishes the checked-zero
result from the separate no-reading-at-all case, so the two kinds of "nothing" in the same
sentence do not collapse into one.

**Template B: structural absence.** No source provides this data at all; the question of
"how many days did we check" does not apply because there is nothing to check.

```
"No source is providing this data."
"Connect a device that reports heart rate variability to see recovery scores here."
```

Template B never states a coverage count, because stating one would imply the app looked and
found nothing, when in fact it never had the capability to look. This is the one line in the
whole system that is allowed to omit a basis, precisely because there is no basis to state.

**Template C: insufficient data to summarise.** Readings exist, but not enough of them to make
the claim the card would otherwise make. This is the kind that is easiest to get wrong, because
the honest answer is neither "nothing here" nor a number computed off two days and presented as
though it were a month.

```
"Not enough data to summarise this range."
"3 of 31 days have a reading. A monthly mean needs at least 14; the three readings are
plotted below without one."
```

The detail always states **how many readings exist, what the threshold is, and what the card is
doing instead**. It is the only template that names a threshold, because a threshold is exactly
what makes this case different from Template A: A says the answer is genuinely zero, C says the
question cannot be answered yet. A card in state C still plots whatever data it has; suppressing
the points as well would throw away real readings to avoid stating a summary.

**A finding worth recording for M3: do not assume a count is zero without checking the
fixture.** The Dashboard originally planned a month-wide "no naps detected" card, mirroring a
worked example. The July fixture actually records naps on 6 of 31 nights
(`july.schedule[i].naps`), so that claim would have been false. The reference implementation
instead uses `EmptyState` only where the underlying data is genuinely absent (checked and
verifiably zero, or structurally untracked); a metric that has real values, however sparse,
is not an empty state; it is a normal card with an honest basis line, even if the number is
small. Every basis and empty-state string in `Dashboard.tsx` and `Sleep.tsx` is a live
computation over `july`, never a typed-out number, so this class of drift fails at a glance if a
fixture changes and no longer needs re-deriving by hand.

## 8. Excluded point treatment

`HeartRateRange` marks a sensor-flagged reading with a `markPoint`:

```ts
markPoint: { symbolSize: 7, itemStyle: { color: t.excluded },
  data: excluded.flatMap((date) => {
    const day = days.find((d) => d.date === date)
    if (!day || day.hrMean === null) return []
    return [{ name: 'excluded', xAxis: date.slice(8), yAxis: day.hrMean }]
  }) }
```

Two rules, both load-bearing:

- **The marker is anchored at the point's own real value**, never a placeholder coordinate. An
  earlier version of this chart placed excluded markers at a hardcoded `yAxis: 0`; because
  `markPoint` items with explicit coordinates do not participate in axis-extent fitting, that
  placed every marker below the visible range, so an excluded reading looked like no marker at
  all rather than a flagged one. The fix is to look up the day's own value and drop the marker
  entirely (`flatMap` returning `[]`) if no value exists to anchor it to; guessing a position is
  the same class of mistake as guessing whether the reading is excluded.
- **The colour is `--chart-state-excluded`, never a stage colour and never `--negative`.** An
  excluded reading is not "bad data" in the sense of being an alarming value; it is a reading the
  owner or a device has flagged as unreliable, so it gets its own neutral, muted token rather
  than borrowing a colour that would carry a different meaning.

## 9. Gap rendering, per chart type

"Missing is not zero" (design spec, invariant 2) has a different concrete rendering per chart
shape:

| Chart | How a gap renders |
|---|---|
| `Sparkline`, `HeartRateRange` | `connectNulls: false`. A `null` in the data array breaks the line; the gap is a visible discontinuity, never an interpolated bridge across the missing day. |
| `SleepSchedule` | A night with a `null` bed or wake time (`nightMark` in `schedule.ts`) renders as a small circle in `--chart-state-no-data` at a fixed y-position (the axis domain's midpoint), not as a missing bar and not as a zero-length span. A bar that simply is not drawn is indistinguishable from "no column here"; the no-data mark exists specifically so an absent night is visible rather than silently skipped. |
| `ActivityHeatmap` | Unworn days are excluded from the heatmap series *and* plotted as a scatter point in `--chart-state-no-data` at the same cell. An unpainted cell is not an absence marker, it is the absence of a marker. |
| `Hypnogram` | No gap case currently exists in the fixture (one continuous night, every lane accounted for). If a future night has an unrecorded stretch, the pattern to follow is `SleepSchedule`'s: a distinct no-data mark on the affected lane, not a shortened bar that silently omits the missing minutes. |

The common discipline: **a gap is drawn, never omitted and never interpolated across.** A chart
that simply fails to plot a null value (rather than plotting a visible absence marker) has
satisfied the letter of "don't show a fake zero" while still failing the actual requirement,
since a reader cannot distinguish "no data" from "chart still loading" or "off by one."

**This document used to contradict itself here**, describing the heatmap's unpainted cell as an
acceptable rendering in the table above while the paragraph below said that exact behaviour fails
the requirement. The paragraph was right, and the heatmap has been changed to match it rather than
the table being softened: an unworn day now carries a visible dot in the same token
`SleepSchedule` uses, so the two charts answer "why is there nothing here" the same way. The
sequential scale's low end also sits close to the card by design (a near-zero day *should* be a
faint cell), which is precisely why absence cannot be signalled by absence of paint. The
accessibility suite asserts the marker stays separable from every stop of the scale it sits among:
worst case 21.9 dark, 28.9 light, against a floor of 20.

**Line charts are the exception, and only because a break in a line is itself a mark.**
`connectNulls: false` produces a visible discontinuity; nothing further is needed. A *cell* or a
*bar* has no equivalent, because "not drawn" and "not there" look the same.

## 10. Stage colour mapping

`apps/web/src/charts/stage.ts`:

```ts
export function stageColor(stage: Stage, t: ChartTokens): string {
  return { deep: t.stageDeep, light: t.stageLight, rem: t.stageRem, awake: t.stageAwake }[stage]
}
```

| Stage | Token | Dark | Light |
|---|---|---|---|
| Deep | `--chart-stage-deep` | `#3730A3` | `#1E2A78` |
| Light | `--chart-stage-light` | `#4F8FF7` | `#2376E9` |
| REM | `--chart-stage-rem` | `#B3E4FA` | `#B3E4FA` |
| Awake | `--chart-stage-awake` | `#F0A202` | `#B45309` |

Measured worst-case separation across normal vision and all three simulations: 21.8 dark, 27.8
light, against a floor of 18 (and 25 in normal vision, where the worst pair measures 41.3 dark,
35.7 light).

**What these floors are, and are not.** Every separation number in this document, and every floor
in `packages/tokens/test/accessibility.test.ts`, is CIE76 deltaE (`deltaE` in
`packages/tokens/src/color/convert.ts`, plain Euclidean distance in Lab space) measured over colour
run through the Vienot 1999 dichromat matrices (`packages/tokens/src/color/cvd.ts`). Both choices
are defensible and neither is a perceptual measurement: CIE76 overstates differences in saturated
regions relative to CIE2000, and the Vienot matrices are a linear approximation of a dichromat's
vision, not a model of the reduced discrimination that survives along the axis a dichromat still
sees. The floors of 18 and 25 were derived against this exact metric and this exact simulation, so
they are internally consistent and comparable across this palette, but they are not a guarantee
that a real reader perceives "18 units" of separation as any particular felt difference, and they
are not comparable to a deltaE figure computed a different way. A future milestone moving to
CIE2000 would need to re-derive every floor in this document rather than reuse these numbers
against the new metric.

This is the blue depth-ramp plus amber described in the design spec: deeper sleep gets a darker
blue, so the ordering itself carries meaning, and awake is amber specifically so it survives
every common form of colour blindness (it is the one stage that varies along the blue-yellow
axis rather than only in lightness). `packages/tokens/test/accessibility.test.ts` asserts a
minimum perceptual separation between all four stages under normal vision and under
deuteranopia, protanopia and tritanopia simulation; this is a build-time guarantee, not a
design-review one.

**Reused beyond the hypnogram, deliberately:**

- `--chart-stage-light` doubles as `--chart-series` in both themes (they share a value): the
  default line colour for a plain trend chart (`Sparkline`, `HeartRateRange`'s mean line) is the
  same blue as "light sleep." This is intentional, not a collision: it is the one stage a reader
  encounters as "the normal state," so reusing it as the default series colour keeps the palette
  small rather than introducing a fifth blue with no distinct meaning.
- `--chart-stage-awake` (amber) is also used for `HeartRateRange`'s event annotation `markLine`
  and `SleepSchedule`'s nap scatter marker. In both cases the semantic thread is "something
  notable interrupted the baseline pattern," which is the same role amber plays inside the
  hypnogram itself (a period of wakefulness interrupting sleep). A chart that needs an
  "interesting/notable" marker color for something outside the four sleep stages should reach for
  `--chart-stage-awake` rather than introducing a new token, unless the new use case would be
  visually adjacent to an actual awake-stage mark on the same chart (which would make the two
  indistinguishable).

## 11. The no-data token, and why lightness is the only lever left

Absence and exclusion are different concepts (no-data: no reading was ever taken; excluded: a
reading exists and was thrown out), so they must be **separable, not merely different**, and
separable to a reader with any common dichromacy.

The first version of this token failed that, and failed it invisibly: the test asserted
`deltaE(state-no-data, state-excluded)` in normal vision only, while the stage test next to it ran
the same comparison through three simulations. Measured under simulation, the violet swatch it
picked (`#7C5B95` / `#8A749E`) scored 9.3 / 6.1 / 10.0 dark and 16.5 / 13.8 / 13.8 light against
the suite's own floor of 18. Five of six failed. **An assertion that omits the condition the rest
of the suite tests under is worse than no assertion, because it reads as coverage.**

The reason a violet could not work is worth stating, because it constrains every future token:
**under deuteranopia and protanopia the only axes that survive are lightness and blue-yellow.**
Blue is spoken for (stages, series, the sequential scale), amber is spoken for (awake, event
annotations), and neutral grey is spoken for (grid, axis, excluded). There is no third hue
available to a dichromat. A no-data marker therefore has to be separated **by lightness**, and its
hue is free to be whatever reads well in normal vision.

So `--chart-state-no-data` is a muted plum placed by bounded numeric search at the lightness that
maximises its worst-case separation while still clearing contrast against the surfaces it sits on:
`#C1A2BC` (Lab L 70.0) in dark, `#523145` (L 25.0) in light, against `--chart-state-excluded` at
`#647484` (L 48.1) in both. It is lighter than the excluded marker in the dark theme and darker in
the light theme, in each case moving away from the card rather than toward it.

`packages/tokens/test/accessibility.test.ts` asserts, in both themes:

- **Non-text contrast (WCAG 1.4.11) >= 3:1** against `--chart-grid` and `--surface-card`, for both
  state markers. Measured: no-data 7.99 / 7.68 dark, 9.05 / 11.15 light; excluded 3.81 / 3.67
  dark, 3.90 / 4.80 light.
- **Worst-case deltaE >= 20 across normal vision and all three simulations**, against every colour
  that can share a chart with the marker: `state-excluded`, `series`, `series-alt`, all four sleep
  stages, and all five stops of the sequential scale. Measured worst case: **21.9 dark** (against
  `scale-5`) and **22.7 light** (against `state-excluded`), against a floor of 20, which is the
  categorical floor of 18 plus the margin a deliberately-consulted marker earns.

The two markers are also drawn as different shapes (a plain circle versus a `markPoint`), but
shape is a second line of defence, not the first: a chart legend, a swatch or a one-pixel mark
carries colour and nothing else.

## 11a. The sequential scale

`--chart-scale-1` through `--chart-scale-5`, **low value first in both themes**. Any continuous
quantity uses these and nothing else.

| Stop | Dark | Light |
|---|---|---|
| `--chart-scale-1` (lowest) | `#003E5D` | `#B7E4F7` |
| `--chart-scale-2` | `#156588` | `#74BAD8` |
| `--chart-scale-3` | `#3B8FB3` | `#3B8FB3` |
| `--chart-scale-4` | `#74BAD8` | `#156588` |
| `--chart-scale-5` (highest) | `#B7E4F7` | `#003E5D` |

It is **one** five-stop perceptual ramp (`primitives.azure`, evenly spaced at roughly 16 Lab L per
step), read in opposite directions per theme so that "more" always moves *away* from that theme's
own card: brighter on dark, deeper on light. That is why a caption can say "stronger colour is
more steps" and be true in both themes, and why the previous caption ("darker is more steps") was
false in one of them.

The suite asserts the scale is **monotonic in lightness with at least 8 L per step** and that its
ends are at least 40 deltaE apart (measured 64.6, both themes), plus that `scale-1` differs from
`--surface-card` by at least 10 deltaE (21.6 dark, 21.1 light) so a zero-value cell still reads as
a cell.

**Why this token set exists at all.** `ActivityHeatmap` previously built its ramp out of three
categorical tokens, `[band-baseline, stage-light, stage-rem]`. In the light theme those measured
L 84.7, 55.6, 88.0: light, dark, light, so an 18,000-step day and a zero-step day rendered 13.2
deltaE apart, which is to say nearly identically, with the middle of the range darker than both
ends. The root cause was not the chart's choice; it was that the system had no sequential ramp, so
the chart improvised one, and a categorical palette is defined by *not* being ordered.

**The rule for M3: never assemble a continuous scale out of categorical tokens.** If a chart needs
more or fewer than five stops, interpolate between these, or add stops to `primitives.azure` and
extend `SCALE_KEYS`; do not reach sideways into the stage or series colours.

## 11b. Two categorical series

`--chart-series` is the default line colour; `--chart-series-alt` is the second one, for a chart
that plots two things at once. They are separated by lightness (worst case across normal vision
and all three simulations: 25.3 dark, 22.6 light), for the reason given above: there is no third
hue a dichromat can see, and amber is reserved for "something notable happened here."

A chart needing a *third* categorical colour has run out of safe options and should be asked
whether it wants small multiples instead. Do not solve it by adding a green.

## 11c. What the contrast assertions actually cover

The suite loops **every text tier over every surface** and **every non-text token over every
surface**, not one tier against one surface. The reason is that a rail label and a card label are
the same text at the same size, and the reader does not know which surface the designer had in
mind. Measured worst case per tier, across all four surfaces:

| Token | Floor | Dark worst | Light worst |
|---|---|---|---|
| `--text-primary` | 7 | 15.39 | 14.30 |
| `--text-secondary` | 4.5 | 10.31 | 10.03 |
| `--text-muted` | 4.5 | 7.22 | 7.06 |
| `--text-faint` | 4.5 | 4.85 | 4.87 |
| `--accent` | 3 | 5.54 | 3.52 |
| `--focus` | 3 | 12.91 | 3.52 |
| `--positive` | 3 | 8.67 | 4.97 |
| `--negative` | 3 | 6.66 | 4.40 |
| `--chart-axis` on the card | 4.5 (it is text) | 4.85 | 5.99 |
| `--chart-series` vs `--chart-grid` | 3 | 5.76 | 3.52 |

Two of these are worth calling out for M3:

- **`--text-faint` renders real text** (rail group labels, the `EmptyState` detail line), so it
  answers to the 4.5:1 text floor and not the 3:1 non-text one. It previously measured 2.72 to
  3.42 and the neutral ramp has been redistributed around it. Four tiers is the most this palette
  can carry at that floor; a fifth would have to sit inside 4 L of one of these.
- **`--focus` is constrained even though nothing consumes it yet.** M3 will build focus rings
  against it, and a token that gets its first constraint from the milestone that consumes it gets
  constrained to whatever that milestone already shipped.

## 12. Card and grid conventions the pages establish

Not chart-specific, but every chart lives inside these, so M3's eight pages inherit them:

- 12-column grid (`.grid` in `app.css`), each card a `<Card span={n}>` (`grid-column: span n`).
  Below 900px every card collapses to `span 12` (`app.css`'s single media query).
- A card (`.card`) never states a colour of its own beyond `--surface-card` and a
  `--border-subtle` border; every chart inside inherits the page's theme purely through the tokens
  its own `build` callback resolves. `--border-subtle` replaced a
  `color-mix(in srgb, var(--text-primary) 7%, transparent)`, and the delta chip's background
  replaced a second one at 6%: a percentage tuned by eye in one rule is a value the next rule
  guesses differently, which is what a token is for.
- `Card` takes `label` and `basis` props and renders both itself, rather than each page repeating
  the `<span className="label">` / `<p className="basis">` pair. It also publishes the basis
  paragraph's id through `BasisContext`, which is what makes section 13 work.

## 13. Every chart has a name, a description and a table

A chart that renders as a bare `<div>` is a chart only for people who can see it. For a milestone
that enforces colour-blind safety by build failure, having no screen-reader path to the same
numbers is the same requirement dropped at the last step.

`ChartFigure` (`apps/web/src/charts/ChartFigure.tsx`) is the wrapper every chart returns:

```tsx
<figure>
  <div ref={host} role="img" aria-label={label} aria-describedby={describedBy} style={style} />
  <table className="sr-only">…</table>
</figure>
```

Three parts, each with a rule:

1. **An accessible name** (`aria-label`), passed in by the page as the `label` prop. It names the
   metric and the period, in a sentence that stands alone when read out of context: "Steps per day
   through July 2026", not "Steps" and not "chart".
2. **A description**, which is the card's basis line, reached through `BasisContext` rather than
   restated. The sentence that tells a sighted reader what the coverage was is the same sentence a
   screen reader should hear; writing it twice is how the two versions start disagreeing.
3. **A table alternative**, `.sr-only`, carrying the same numbers the chart draws, in reading
   order, with the absence cases spelled out as words (`not worn`, `no reading`, `none`) rather
   than as blanks. A blank cell in a table has the same defect as an unpainted heatmap cell.

`.sr-only` clips rather than using `display: none`, which would take the table out of the
accessibility tree along with the pixels.
