# Page patterns

Every redesigned page is built from the pieces below. A section that looks like one of these uses the component named here rather than a copy of it. The dashboard and the night page are the reference renderings.

## Page shell

- Root: `<div className="detail-page">` on a detail page, `<div className="dashboard">` on the dashboard.
- Every state (loading, a failed read, nothing to show, a missing record) keeps the header and draws its message in `<div className="grid"><Card span={12}>…</Card></div>`. A missing record is an `EmptyState`, not a retry.

## Header: `PageHeader`, with `DetailNav` or `DayNav`

- `title` says what the page is about: a date through `useHeaderDate` (the short form on a phone), or a name (the workout's type). `line` says when and who, on one line. Names, notes and badges belong in a card: the workout's provider name in its About line, its note in the day block.
- Without a payload the title is the date from the URL, or for a page keyed by id a generic word ("Training" / "Workout").
- `DetailNav` draws ‹ › to the neighbours the payload's `nav` names (never computed), disabled rather than hidden when null, then the way back as a `.button` ("Alle nachten", no arrow glyph). ← and → step through `StepArrows`; `ignoreKeysInside` names the parts of the page with arrow keys of their own.
- `line` is one line at every width: where it runs out (a phone, a long Dutch line at 800) it ends in an ellipsis, the whole line in its `title`.
- Every state keeps the same header: a state without a line yet (loading, a failed read, a missing record) keeps the line's place, empty and `aria-hidden`, so the header is as tall as a loaded page's and the first card sits the same gap (`--space-4`, the header's own margin) below it.
- On a phone (620px and below) the header stays one row, the title ends in an ellipsis, and every control is 44×44.

## Hero: `Card label` and `.dash-lead`

- The value in `.dash-headline`, formatted by `formatFigureValue`.
- The verdict line: `verdictLine`'s words in `.detail-verdict`, coloured by `verdictTone`. Always printed on a detail page; on the dashboard only when the figure is outside its usual, and then under the figure it judges (the steps' line under the steps, not under steps and active minutes). A dashboard figure within its usual prints nothing; its within sentence describes the strip out of sight.
- The strip: `Sparkline` with `height={64}` and `dots`, each day's usual shaded behind it, both band edges labelled (`bandLabels`), each dot coloured by its own day's verdict (`pointStandings` and `pointJudged`), described by the printed verdict's id through `BasisContext` rather than a hidden copy, and each dot opening its own page (`useOpensDay`, worded for a day, a night or a workout). A `.dash-caption` says what the points are, in one wording for one strip: "deze nacht en de zes ervoor" on the night page, "afgelopen nacht …" and "die nacht …" on the dashboard.
- The card is left out when there is no value.
- A workout's strip has one usual, the figure's own, shaded behind every point; each point still carries its own `standing` and `judged` against it, so its dot takes its tone as a night's does. Its caption counts the points it draws ("this workout and the 9 of this type before it", "… the one …"), never a fixed nine, and names the band only when one is drawn.
- Lines under the verdict that are not verdicts (the workout's rank, previous one, best) are `.workout-hero-line`, and say only what compares like with like: no rank beside a thin usual or a `comparison.reason`, and a rank that beat every one says "all" ("Faster than all of your last 20"). A best that measures something else than the hero names what it is, in the hero line and the compared table alike: under an average pace, "fastest kilometre" / "fastest km"; under an elapsed time, "longest".

## Figure rows: `FigureRow` inside `FigureRows`

- Each row: a `.label`, the value (its unit set smaller), a bar or a strip, then the verdict line.
- Pass both `judged` and `standing`. Draw a strip where the trend is the point, the bar otherwise. A thin usual draws no bar and says so.
- A row without a value is left out; a card without rows is left out.
- `FigureRows` sets one column per row, up to four (`max={3}` where the card gives the rows three quarters, `side` inside a `SideCard`); below 900px every grid of two or more is two across. A lone row across a full card takes a third of it (half below 900px, all of it on a phone), never the whole width.
- Text under a value that is not a verdict passes `band={null}`.

## Verdict words and colour

- Words come from `verdictLine` on a detail page and `usualLine` on the dashboard, which share their catalogue keys. The dashboard may drop the range where a verdict sits inline beside other figures (`usualShort`), but keeps the words.
- Dutch says "gebruikelijk(e)", never "gewoon" or "normaal". A clock time is later or earlier than its usual, a pace slower or faster; neither is above or below.
- Colour is `verdictTone(judged, standing)`: better in `--positive`, worse in `--negative`, outside the usual on a figure judged neither way (`is-out`) in `--negative`, inside the usual plain. Only the verdict words take the tone; the value they judge stays plain, on a hero, a `FigureRow` and a dashboard mini alike. A strip's dots and a bar's mark take the same tone. The steps pace line keeps its own ahead-only green, since a pace is not a judgement.
- A strip's accessible table words each day's verdict with `standingShort`, the verdict line's own words without the range (`directionWords` is the one table of later/earlier and slower/faster both read), so the table and the printed line cannot disagree.
- The server judges (`standing` and `judged` on every figure and every strip day); the web only words and colours what it sent.

## Values

- One formatter per unit, and three duration forms, each on purpose:
  - "6h 36m" in English, "6u 36m" in Dutch (a signed one "-0h 23m" / "-0u 23m") for a span that runs to hours: time asleep, the stages, time in bed, a balance. `formatDuration` and `formatSignedDuration` take the language for the hour unit.
  - "12 min" for a figure that is only ever a few minutes (time to fall asleep, active minutes, bedtime variability) and for a workout's length in a session row ("34 min").
  - A stopwatch "28:04", "1:05:05" for time into or across a workout (elapsed, moving time, pauses, splits), the way the watch that recorded it reads.
- A value never wraps inside itself: `formatFigureValue` joins its parts with no-break spaces.
- A range is `formatFigureRange`'s: a spaced dash, the unit once after the second number ("60 – 65 bpm", "±20 – 35 min"); a duration or clock time keeps both ends whole.
- A difference is `formatFigureDifference`'s, taken between the two values as printed so a row adds up (5.20 km beside 5.00 km is +0.20). A pace difference reads "12 s/km" everywhere, the hero's previous line, the table and the split alike; a stopwatch difference reads as a stopwatch ("+1:40").

## Cards

- A detail card is `Card span={12} label=…`; its label renders as an `h2` styled as `.label`. A dashboard card is `DashCard` (a title, a muted subtitle, a `.card-link`).
- A side section (the day before a night; a workout's day of, afterwards and running form) is a `SideCard` whose caption names the relation ("{date}, de dag van deze training"), its rows in `FigureRows side`.
- A way onward inside a card is a `.card-link` worded "Bekijk …" / "View …", never an arrow glyph.
- A table never scrolls sideways on a phone: it drops the columns the rest of the page already says (the workout's usual and best), and its caption and footnote drop their words about those columns with them (`.workout-compared-wide`). A caption or footnote names only columns that are there.
- A table's last row draws no rule under any cell, its row header included.
- A time hero (moving or elapsed time) leads the compared table with its own row.
- Legends use `.detail-legend`, captions `.dash-caption`; a basis that describes one chart is a caption under it, so a card's first line is always its label. A key's colour is its series' chart token (`--chart-stage-*`, `--chart-zone-*`), never one borrowed from another chart.
- A strip has no show-numbers control, on a detail page (the hero's and a `FigureRow`'s) as on the dashboard: it passes `tableToggle={false}` and keeps its table for a screen reader. A detail page's other charts keep theirs.

## The day block

`DayLogBlock` (mood, chips, note, and a note written on the page's own record passed as `note`), then steps and active minutes as `FigureRow`s, then `TodayWorkouts` labelled "Trainingen" / "Workouts", which draws nothing on a day without one (no "none" row). The block is left out with no log, no note, neither figure and no workout.

## Overview pages (Sleep, Activity)

- The header is `PageHeader` with the page's name as `title` and the period and source as `line` ("1 – 30 sep 2026 · Alle bronnen", from `periodLine` in pages/period/), then the existing `ControlRow` with no trend note. The Day tab is not a period: Sleep opens that date's night page, Activity the dashboard on that day.
- The hero's label says what its figure is an average of: "Tijd in slaap, gemiddeld per nacht" / "Time asleep, average per night". The point panel and the night page keep the figure's plain name.
- Every figure is the period's average (per night, per day, or per week for active minutes) against the **usual for a period of that length**, from the earlier periods of the same length: a week against the last 12 weeks, a month against the last 12 months, 3 months against the 4 before it, a year against the year before (its quarters). The server sends it as `usual` with its `window`. The window is named once, in the hero's verdict, after the range with a plain space and no " · " ("binnen je gebruikelijke bereik 6u 40m – 7u 35m voor een maand, afgelopen 12 maanden" / "… for a month, last 12 months"; "… voor een jaar, uit 2025" / "… for a year, from 2025"): `periodVerdictLine(…, { window: true })`. Every other figure's verdict is the verdict and its range alone. A thin usual (`thin-usual`), a running period with fewer than three days (`too-few-days`) or a period with no days (`no-data`) prints the reason (`reason`), never a verdict.
- A total (distance, floors, climb, calories) prints the period total as the value and the per-day average in the line under it; the verdict judges the average, so a running period is compared fairly.
- A per-week figure (`per: 'week'`, active minutes) prints its value and its usual per week, and its weekly points per week. Its daily points are each day's own minutes against that day's own usual, so a day's dot and its panel read that day, never seven times it.
- Day counts sit beside every average, from the server's `counts`: "24 van 30 nachten gebruikelijk · 3 korter · 3 langer" / "24 of 30 nights usual · 3 shorter · 3 longer", in the verdict catalogue's words for the figure (later/earlier for a clock time). They count what the card's points are: nights, days, or mornings ("25 van 30 ochtenden gebruikelijk", the mornings after a night); a card whose rows have no points of their own ("Meer over de slaap") drops the noun ("26 van 30 gebruikelijk"). Only days with a value count. The line is left out when no day is judged (`within + above + below === 0`): the recovery index's days carry no usual of their own, so it prints its average and verdict without one.
- What stood out goes under the counts, a line each (`standoutLines`): the high point (`high`: "je langste: **7u 44m** op vr 25 sep ✦", the weekday in the date), the change against the previous period (`previous`: "**+0u 23m** tegenover augustus"), and with the comparison on, against the same period a year earlier (`yearEarlier`), as a third line. The value each line turns on is bold (`emphasise`, rendered by `EmphasisedText`); nothing else goes on those lines.
- A good day (`judged === 'better'` on the hero figure) is marked quietly: a ring on its dot, ✦ after it in text and lists. A good week on the weekly strip (3 months and Year) gets the same ring. No other good-day mark exists.
- Strips shade each day's own usual; the verdict above uses the period's. On 3 months and Year the strip draws one point per week (`weekly`), each against the usual for a week.
- Under the hero's strip its caption says what the points are, by the range ("elke nacht deze maand", "elke week, als gemiddelde"; the period from `thisPeriod`), and on the right what a tap does ("tik op een nacht voor de cijfers", PeriodHero's `hint`). A phone draws Sparkline's own tap control instead, so the hint is hidden there.
- A card of strips (the four figures, the mornings) ends with one caption for all its rows: "elk lijntje: elke nacht deze maand · band = je gebruikelijke bereik" (on 3 months and Year, "elke week, het gemiddelde van haar nachten"). A chart's caption says what a mark is, by the range: "fasen per nacht deze maand · gemiddeld per nacht in de legenda", "naar bed en wakker, elke nacht deze maand".
- On 3 months and Year only the hero keeps its days (`daily`); every other figure is sent with its weekly points alone and draws those.
- A figure in `more` is sent with no daily or weekly points on any range: the page draws it as a bar with its day counts, never a strip.
- Tapping a strip point opens a small panel first (that day's key figures, "Bekijk nacht" / "Bekijk dag", "Uitsluiten of een notitie toevoegen"), and the page from there: the day-metric exclude and annotate stay reachable.
- The panel reads the payload's own points; there is no separate day read. A day point shows that day's figures from the figures' `daily` and links to the day. A week point shows that week's values from `weekly` and has no link.
- A list (nights, workouts) opens with a caption ("de nieuwste eerst · de stip is de verdict van die nacht") and shows the 7 most recent and a button naming what it shows, "Toon alle 30 nachten" / "Show all 30 nights" (ExpandableList's `showAll`). A night's row reads date · time asleep · dot · "23:06 – 06:57" (a spaced dash), then ✦ on a good night, "✦ je langste" on the one that is the period's high. Expanded, it takes its own full-width row and flows into columns (grouped by month on 3 months and Year); the card beside it widens with it so no hole opens.
- Workout type counts are scaled to the period's length before they are compared with the usual, so a week's count is not read against a month's.
- Sections the archive has no data for are left out by the server (`days === 0`); the page draws what it is sent.
- The sleep schedule opens with two sentences, the variability against its usual ("Naar bed varieerde ±34 min deze maand · je gebruikelijke ±20 – 40 min", `variedLine`, the night page's wording) in place of a figure row, and the weekend against the weekdays with its amounts bold. Its chart draws weekend nights (Saturday and Sunday mornings, the server's rule) in `--chart-stage-rem`, the lighter step of the weekdays' `--chart-stage-light`, and dots a bedtime the server judged outside its usual in `--negative`; the legend keys only what is drawn.
- The balance names its zero line and the nights it adds up: "ten opzichte van je gebruikelijke 7u 08m, over 30 nachten" (the hero's `days`).

## Terms (nl / en)

Tijd in slaap / Time asleep · Tijd in slaap, gemiddeld per nacht / Time asleep, average per night (an overview's hero) · Naar bed / Bedtime · Wakker geworden / Wake time · Efficiëntie / Efficiency · Stappen / Steps · Actieve minuten / Active minutes · Trainingen / Workouts · Rusthartslag / Resting heart rate · gebruikelijk / usual · Uitsluiten of een notitie toevoegen / Exclude or add a note (`common.annotate`) · Gebruikelijk voor een maand / Usual for a month · Nachten / Nights · Toon alle / Show all · Doordeweeks / Weekdays · Weekend / Weekend.

The heart-rate zones: Licht / Light · Matig / Moderate · Intensief / Vigorous · Piek / Peak; the time in the top two is "intensief of piek" / "vigorous or peak".

A term holds everywhere it appears: a table's column ("Naar bed", "Wakker geworden"), a chart's marker ("Bedtime 00:08"), a sentence ("Naar bed varieerde …"). i18n-parity.test.ts pins bed and wake.

## Breakpoints

- 900px: every card spans the full row, figure rows go two across, side cards stack.
- 620px: the phone header, 44px targets.

## Type scale

Hero 48 · dashboard card lead 34 · row figure 24 · inline mini 17.
