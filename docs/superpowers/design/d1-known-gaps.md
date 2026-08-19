# D1 known gaps

Findings that survived the final review's fix wave. Each was adjudicated rather than fixed,
because the process allows one fix wave and these arrived after it. They are recorded here so
M3 inherits them as known work rather than rediscovering them.

Six gaps were fixed in a follow-up pass (commit noted below); the remaining section records
deliberate deferrals that are still open and out of scope for that pass.

## Fixed

1. **Nap markers could never render.** `apps/web/src/fixtures/july.ts` generates naps between
   780 and 960 minutes (13:00 to 16:00); `SleepSchedule.tsx`'s y axis was fixed to `[1080,
   2520]` (18:00 through 18:00 the next day), clipping every one. Fixed by shifting the domain
   to `[720, 2160]` (noon through noon the next day) rather than widening it: the window was
   already a full 24 hours, so the naps only needed it moved six hours earlier, which costs no
   compression of the bed-to-wake band the chart exists to show. `NO_DATA_Y` moved with it, from
   `40*60` to `35*60`, to stay clear of the new wake-time cluster and inside the new axis max.
   `apps/web/test/schedule-marks.test.ts` gained a dedicated "every plotted value falls inside
   the axis domain" suite (bed, wake and nap, each checked against `[AXIS_MIN, AXIS_MAX]`), plus
   naps added to the existing no-data-marker-clearance check. `chart-styling.md` section 2's
   `SleepSchedule` row updated to match.

2. **Dark theme gridlines' contrast disclosure was wrong, not the colour.** `--chart-grid` still
   measures 1.04:1 (deltaE 2.54) against `--surface-card` in the dark theme, left alone because
   raising it would ripple into contrast pairs already tuned close to their floor (excluded vs
   grid sits at 3.81, floor 3). Fixed by amending `chart-styling.md` section 2 to describe
   gridlines as structure a reader's eye can use to keep a row straight, not a mark precise
   enough to read a value off of, and by updating the matching comment in
   `apps/web/src/charts/base.ts` to the same effect.

3. **`Sleep.tsx` hand-typed four chart token names.** Fixed: `STAGE_VAR: Record<Stage, string>`
   (raw `--chart-stage-*` strings) replaced with `STAGE_TOKEN: Record<Stage, ChartToken>` plus
   `chartVar()` from `@vitals/tokens` at the point of use. A rename in
   `packages/tokens/src/chart.ts` is now a compile error at `Sleep.tsx`, not a silent broken
   swatch; the four token names were already covered by `apps/web/test/chart-tokens.test.ts`'s
   `emitCss()` loop via `apps/web/src/charts/tokens.ts`'s own `CHART_SOURCES` entries, so no new
   test was needed for stylesheet coverage.

4. **`ActivityHeatmap` re-initialised its chart on every render.** Fixed: `calendarLayout(...)`
   moved into a `useMemo` keyed on `days`, so `cells` (and the `build` callback that depends on
   it) keeps a stable identity across renders that do not change the underlying data.

5. **The accessibility suite's thresholds read as perceptually calibrated when they are not.**
   Fixed by documentation only, per the ruling that the metric and floors are M3's decision, not
   this pass's: `chart-styling.md` section 10 gained a "What these floors are, and are not"
   paragraph, stating plainly that every separation number is CIE76 deltaE over Vienot
   1999-simulated colour, that both choices are defensible but not perceptually calibrated, and
   that the floors of 18 and 25 are internally consistent within this palette and this metric
   rather than a perceptual guarantee or a figure portable to a different metric.

6. **Transcription error in `chart-styling.md` section 5.** "deltaE 7.9 dark, 9.1 light" for
   tooltip background against card corrected to "7.9 dark, 8.03 light" (independently
   recomputed from the actual token values). 9.11 remains, correctly, the light theme's grid
   against card figure one row above.

## Deferred by earlier ruling, still open

- **i18n**: spec section 11 requires strings extracted from the start, shipping English and
  Dutch. Both reference pages hardcode every string inline. Deferred deliberately, on the
  grounds that extraction is a feature rather than a papercut, but it gets more expensive with
  every page M3 adds. It belongs first in the M3 plan.
- **Elevation primitives**: no consumer in D1, so adding them would have meant inventing a
  vocabulary with nothing to validate it.
- **Spacing, radius and type scales are unguarded**: the colour guard has no counterpart for
  geometry, and components do use raw pixel values in places. Documented as a convention
  rather than enforced, because a pixel-literal guard would fire on legitimate one-off geometry.
- **Card-level controls and dashboard deep links**: spec section 11 names both. Neither is
  demonstrated on the reference pages, so M3 has no pattern to copy.
- **The third empty state**: the spec names three kinds (nothing detected, device not worn,
  insufficient data to summarise). The pages demonstrate two.
