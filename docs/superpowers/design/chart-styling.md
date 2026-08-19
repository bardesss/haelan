# Chart styling specification

**Date:** 2026-08-19
**Status:** Implemented and current as of D1 Task 10 (`Dashboard.tsx`, `Sleep.tsx`)
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
| `SleepSchedule` | `{ left: 40, right: 12, top: 12, bottom: 24 }` | Category x (dates), value y fixed to `[18*60, 42*60]` (18:00 through 18:00 two days later) so every night's bed/wake pair sits on a stable clock-time axis regardless of how late the night ran. |
| `ActivityHeatmap` | `{ left: 30, right: 12, top: 10, bottom: 20 }` | Category x (week index), category y (weekday initials). Axis line and ticks hidden on both axes; the heatmap cells carry all the information. |

Grid lines (`splitLine`) and axis lines use `t.grid`; axis labels use `t.axis`, always at
`fontSize: 9`. No chart draws a border around its own plot area beyond `splitLine`; the
containing `Card` supplies the visual boundary.

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

| Element | Width | Where |
|---|---|---|
| Sparkline line | `1.6` | `Sparkline.tsx`, colour `t.series` |
| HeartRateRange mean line | `1.9` | `HeartRateRange.tsx`, colour `t.series` |
| SleepSchedule night span | `5`, `lineCap: 'round'` | `SleepSchedule.tsx`, colour from `nightMark` (`t.stageLight` for a real night) |
| HeartRateRange min/max band | fill only, `opacity: 0.22`, colour `t.stageLight` | drawn as a stacked area (min invisible, max-min visible), not a stroke |
| HeartRateRange baseline `markArea` | fill only, `opacity: 0.5`, colour `t.band` | see section 4 |
| Event annotation `markLine` | dashed, colour `t.stageAwake` | see section 6 |

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

Every tooltip shares the same three properties, read from tokens:

```ts
tooltip: { backgroundColor: t.surface, borderColor: t.grid, textStyle: { color: t.muted } }
```

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
formatter: (params) => {
  const first = Array.isArray(params) ? params[0] : params
  const day = first ? days[first.dataIndex] : undefined
  if (!day) return ''
  if (!day.worn) return `${day.date}<br/>not worn`
  if (day.hrMean === null || day.hrMin === null || day.hrMax === null) return `${day.date}<br/>no data`
  return `${day.date}<br/>mean ${day.hrMean} bpm<br/>range ${day.hrMin}–${day.hrMax} bpm`
}
```

**Any chart built from a stacked series for visual layout (a band, a range, a stacked total)
must write a formatter that reads the source data by index rather than trusting the stacked
series' own values**, and that formatter must handle the "worn but the specific metric is
null" case explicitly rather than letting a null reach the template string as the literal text
`"null"`.

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

**Deltas carry the same discipline plus an arrow.** `apps/web/src/format.ts` exports `trend()`,
which compares the mean of the first half of a run of worn-day values against the second half and
returns `{ text: '↑ 9%', dir: 'up' }` (or `↓`/`→` for down/flat, flat below a 1% swing). The arrow
is part of the string, not a separate icon, so `StatTile`'s `delta` prop needs nothing extra to
carry it: colour (via `.delta[data-dir]`, mapping `up` to `--positive` and `down` to `--negative`)
and the arrow glyph both encode direction, so the reading survives colour blindness or a
greyscale printout. **Known caveat, not fixed by this task**: `StatTile` colours every `up` delta
positive and every `down` delta negative regardless of what the metric is. That is correct for
steps and sleep duration; it is backwards for resting heart rate, where a rising trend is not
good news. Nothing in the current component makes that distinction. A metric where "up" is bad
should either omit the delta or (a change for M3) extend `StatTile` with a per-tile
"higher is better" flag rather than always trusting `dir`.

## 7. Empty state wording patterns

`EmptyState` (`title`, `detail`) renders `{title}<br/><small>{detail}</small></p>`. Two distinct
templates are in use, and they must never be interchangeable, because they answer different
questions:

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
| `ActivityHeatmap` | Unworn days carry `steps: null`; ECharts' `heatmap` series skips a `null` cell outright rather than colouring it at the low end of the `visualMap` scale, so an unworn day reads as an empty cell, not a "zero steps" cell. |
| `Hypnogram` | No gap case currently exists in the fixture (one continuous night, every lane accounted for). If a future night has an unrecorded stretch, the pattern to follow is `SleepSchedule`'s: a distinct no-data mark on the affected lane, not a shortened bar that silently omits the missing minutes. |

The common discipline: **a gap is drawn, never omitted and never interpolated across.** A chart
that simply fails to plot a null value (rather than plotting a visible absence marker) has
satisfied the letter of "don't show a fake zero" while still failing the actual requirement,
since a reader cannot distinguish "no data" from "chart still loading" or "off by one."

## 10. Stage colour mapping

`apps/web/src/charts/stage.ts`:

```ts
export function stageColor(stage: Stage, t: ChartTokens): string {
  return { deep: t.stageDeep, light: t.stageLight, rem: t.stageRem, awake: t.stageAwake }[stage]
}
```

| Stage | Token | Dark | Light |
|---|---|---|---|
| Deep | `--chart-stage-deep` | `#3730A3` | `#312E81` |
| Light | `--chart-stage-light` | `#4F8FF7` | `#3B82F6` |
| REM | `--chart-stage-rem` | `#B3E4FA` | `#ADE5FD` |
| Awake | `--chart-stage-awake` | `#F0A202` | `#B45309` |

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

## 11. Known limitation to verify before M3 relies on it

`--chart-state-no-data` and `--chart-grid` currently resolve to the same value in both themes
(`#0E1520` dark, `#E3E8EF` light; see `packages/tokens`' semantic mapping). `SleepSchedule`'s
no-data marker is therefore the same colour as the chart's own gridlines, which weakens "a gap is
drawn, never omitted" from section 9: the mark is present, but may read as low-contrast against
the grid it sits among rather than as a clearly distinct state. This is a token-package decision
(D1 Tasks 2 to 5), out of scope for this task to change, but worth resolving before M3 leans on
`--chart-state-no-data` reading as visually distinct from `--chart-grid` on a denser chart.

## 12. Card and grid conventions the pages establish

Not chart-specific, but every chart lives inside these, so M3's eight pages inherit them:

- 12-column grid (`.grid` in `app.css`), each card a `<Card span={n}>` (`grid-column: span n`).
  Below 900px every card collapses to `span 12` (`app.css`'s single media query).
- A card (`.card`) never states a colour of its own beyond `--surface-card` and a
  `color-mix(in srgb, var(--text-primary) 7%, transparent)` border; every chart inside inherits
  the page's theme purely through the tokens its own `build` callback resolves.
- A card's structural label (`<span className="label">`) is the eyebrow above every chart card
  that is not a `StatTile`; it names the chart, and the `.basis` paragraph beneath it states
  coverage, per section 6.
