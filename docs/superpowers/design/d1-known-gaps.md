# D1 known gaps

Findings that survived the final review's fix wave. Each was adjudicated rather than fixed,
because the process allows one fix wave and these arrived after it. They are recorded here so
M3 inherits them as known work rather than rediscovering them.

Ordered by what should be fixed first.

## 1. Nap markers can never render

`apps/web/src/fixtures/july.ts` generates naps between 780 and 960 minutes (13:00 to 16:00).
`apps/web/src/charts/SleepSchedule.tsx` fixes the y axis to `[1080, 2520]`. All six nap values
in the fixture fall below the axis minimum, so ECharts clips every one of them.

Both reference pages state "dot marks a nap" in their basis lines, and the styling
specification documents a `SYMBOL.nap`. The chart cannot satisfy either claim.

This is pre-existing, untouched by the fix wave, and missed by every earlier review including
the per-task one. It is first on this list because it is the only item where the shipped
artefact makes a statement that is false.

Fix: either extend the axis domain to include daytime, or plot naps on a separate lane. Then
extend `apps/web/test/schedule-marks.test.ts`, whose placement assertions currently cover only
bed and wake values, so the same gap cannot reopen.

## 2. Dark theme gridlines are effectively invisible

`--chart-grid` measures 1.04:1 against `--surface-card` in the dark theme, a colour difference
of 2.54. The fix wave deliberately left the value alone: it is outside every finding, it was
not made worse by the renumbering, and moving it would ripple through the contrast figures the
wave had just tuned. That reasoning holds.

What does not hold is the disclosure. `chart-styling.md` section 2 still tells M3 that gridlines
"say where a value sits", which they cannot do at this contrast. Either raise the value and
retune the affected pairs, or amend the document to describe gridlines as decorative structure
rather than a reading aid.

## 3. Sleep.tsx hand-types four chart token names

`apps/web/src/pages/Sleep.tsx` declares `'--chart-stage-deep' | '-light' | '-rem' | '-awake'`
as plain strings. `chartVar()` exists for exactly this and is not used there, and nothing
asserts those four names appear in the emitted stylesheet.

This is the same defect class as the final review's C3, at a third of the size: rename a stage
token and this page breaks at runtime with a green suite. C3's fix removed the twelve-name
duplicate and left this four-name one.

## 4. ActivityHeatmap re-initialises its chart on every render

`calendarLayout(...)` runs in the component body, so `cells` has a new identity each render.
It is in the `useCallback` dependency list, which makes `build` unstable, and `useChart`'s
effect keys on `build`, so every re-render disposes and recreates the ECharts instance along
with its MutationObserver and resize listener.

No user-visible impact today, because the reference pages render once and never update. It
becomes real the moment M3 adds a date picker or a source filter to a page carrying a heatmap.
A `useMemo` on the layout closes it.

## 5. The accessibility suite's thresholds are a house metric

The suite measures separation with CIE76 over Vienot-simulated colour. Both choices are
defensible and neither is perceptually calibrated: CIE76 overstates differences in saturated
regions, and neither model captures a dichromat's reduced discrimination along the axis that
survives. The floors of 18 and 25 are therefore internally consistent and comparable across
this palette, but they are not perceptual guarantees, and the styling document currently
implies otherwise.

The suite is still worth what it costs: it has twice caught real collapses that no reviewer
noticed. The gap is in what it claims, not in what it does. M3 should either move to CIE2000
with re-derived floors, or state plainly in the document that the numbers are relative.

## 6. One transcription error in the styling specification

`chart-styling.md` section 5 gives tooltip background against card as "deltaE 7.9 dark, 9.1
light". The light figure is 8.03; 9.11 is the light theme's grid against card, one row above.
Every other number in that document was independently reproduced and is correct.

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
