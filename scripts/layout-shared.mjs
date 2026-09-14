// What both layout harnesses agree on: the viewports they measure at, and the one sweep that
// decides whether a control is big enough for a finger.
//
// Extracted rather than copied. layout-check.mjs drives the built demo - nine routes, recorded
// fixtures, no server - and layout-check-boot.mjs boots a real instance against a temporary
// directory to reach the wizard and the sign-in screen, which the demo cannot render by
// construction. Different subjects and different lifecycles, but the same two assertions, and two
// drifting copies of a hit-area rule is worse than one imperfect rule: the moment the checkbox
// substitution below is widened, or 44 becomes some other number, it has to change in one place
// or the second harness quietly keeps measuring by the old rule.

// The phone this milestone is named for.
export const PHONE = { width: 375, height: 812 }
// One pixel above the breakpoint: the rail is back, so the content column is at its narrowest of
// any width in the app, and this is where the band that scrolled sideways for the whole of M7a
// begins. Every page measured 703px there - 186px of rail, 20px of .main padding, and a 497px
// control row that would not wrap - against a 621px viewport.
export const BAND = { width: 621, height: 900 }
// The rest of that band. The upper end is 702 and not 719: a page needs 703px, so 703 up was
// always clean and a check pinned at 719 would have passed against the broken stylesheet. Widths,
// not viewports - the height never mattered to this.
export const BAND_WIDTHS = [660, 700, 702, 719]
// A landscape phone, and the size at which the rail was measured holding 712px of content in a
// 380px column with sign-out 437px below the fold.
export const SHORT = { width: 900, height: 380 }

// A tablet rotating portrait to landscape: the one gesture that crosses the breakpoint upward
// without a reload and without a second resize behind it.
export const ROTATE_FROM = { width: 600, height: 960 }
export const ROTATE_TO = { width: 960, height: 600 }

// How long a page is given to settle after a viewport change before it is measured. This is not a
// fix waiting out a race - that fix is in useChart, which observes its own container instead of
// the window - it is a harness leaving room for a relayout the browser has already been asked for.
// The overflow this guards was still there after two seconds, so a wait this side of that is
// measuring a settled page rather than a lucky one.
export const SETTLE_MS = 500

// A finger needs about 44px in its smaller dimension - the figure both major mobile platforms
// publish, and close to the measured width of an adult fingertip. Below the breakpoint only:
// above it a mouse is precise, so shrinking desktop density to suit a phone would be solving a
// problem no reader there has.
export const TOUCH_MIN = 44

/**
 * Every interactive control inside `root` (the whole document when it is null) whose smaller
 * dimension is under `TOUCH_MIN`, as `{ tag, cls, where, w, h }`.
 *
 * `where` is the nearest class-carrying ancestor, self included, and it is there because `cls`
 * alone is frequently empty: the controls this sweep catches tend to be bare elements styled
 * through a descendant selector (`.setup-horizon li button`, `.choice input`), so a report that
 * named only the tag and its own class said `input. 13x13` and left whoever has to fix it
 * guessing which input.
 *
 * The zero-rect filter below is load bearing and stays: a control that is display:none, or that
 * lives in a closed <dialog>, has no box to measure and reporting it as "0x0, below 44px" would
 * be a lie about a control nobody can reach. What it also did, silently, was exclude the whole of
 * the phone's navigation - the rail lives inside a closed `dialog.rail-dialog` on a phone, so all
 * 12 `.rail-item` links and sign-out had a zero rect on every route and were dropped before
 * measurement. Thirteen controls, none of them measured, while the check reported every route
 * clean. The answer is not to drop the filter - it would then flag every genuinely hidden control
 * in the app - but for the caller to run the sweep a second time with the drawer actually open,
 * which is the only state in which those thirteen have a box at all.
 *
 * `root` is what scopes that second pass to the drawer: the page behind it is still laid out and
 * still measurable, and re-reporting it would double every failure the first pass already names.
 */
export const smallTargets = (page, root) => page.evaluate(({ min, root }) => {
  const scope = root === null ? document : document.querySelector(root)
  if (scope === null) return [{ tag: 'missing', cls: root, w: 0, h: 0 }]
  const interactive = 'a[href], button, input, select, textarea, [role="button"]'
  return [...scope.querySelectorAll(interactive)]
    .filter((el) => !el.closest('.sr-only') && el.getBoundingClientRect().width > 0)
    .map((el) => {
      // A checkbox's own box stays small by design (DataTypePicker.tsx wraps each one in a
      // <label> that also carries its name) - the label is what a reader actually taps, so
      // that is what gets measured here instead of the input alone.
      const target = el.matches('input[type="checkbox"]') ? (el.closest('label') ?? el) : el
      const r = target.getBoundingClientRect()
      const owner = el.closest('[class]')
      return {
        tag: el.tagName.toLowerCase(),
        cls: String(el.className).slice(0, 30),
        where: owner === null ? '' : String(owner.className).split(/\s+/)[0],
        w: Math.round(r.width),
        h: Math.round(r.height),
      }
    })
    .filter((t) => Math.min(t.w, t.h) < min)
}, { min: TOUCH_MIN, root: root ?? null })

export const describeTargets = (targets) =>
  targets.slice(0, 5).map((t) => `${t.where === '' ? '' : `.${t.where} `}${t.tag}.${t.cls} ${t.w}x${t.h}`).join(', ')
