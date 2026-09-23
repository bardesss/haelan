// The one list of screenshots, read by everything that shows them: the landing page's gallery and
// lightboxes (scripts/build-site.mjs), and the README's screenshot block
// (scripts/sync-readme-screenshots.mjs). Adding a shot here puts it on both surfaces; there is no
// second place to remember.
//
// It is a module rather than a JSON file so it can carry this comment and the ones below. Nothing
// in it is read at build time from the images themselves - a caption is a sentence somebody wrote,
// not something a PNG knows.

/**
 * @typedef {object} Screenshot
 * @property {string} file       Name inside assets/screenshots, published at screenshots/<file>.
 * @property {string} title      The caption, and the name the lightbox is announced under.
 * @property {string} alt        What the image says to somebody who cannot see it. Never empty:
 *                               each shot is a link to its own full-size view, and a link whose
 *                               only content is an image with no alt text is unusable by a screen
 *                               reader, which is why these did not need alt text before and do now.
 * @property {'hero' | 'gallery'} role  Where it sits on the landing page. Exactly one is the hero.
 * @property {'inline' | 'link'} readme Shown full width in the README, or named in the line of
 *                               links beneath. The README is read on a phone as often as not, and
 *                               four full-width screenshots before the first paragraph of prose is
 *                               a wall to scroll past rather than a look at the thing.
 */

/** @type {readonly Screenshot[]} */
export const SCREENSHOTS = [
  {
    file: 'dashboard.png',
    title: 'Dashboard',
    alt: 'The Hælan dashboard in three columns: last night with its sleep stages, recovery today with resting heart rate and heart rate variability, and today so far with steps, heart rate and active minutes, each against your own usual.',
    role: 'hero',
    readme: 'inline',
  },
  {
    file: 'activity.png',
    title: 'Activity',
    alt: 'The Activity page: a year heatmap of daily movement above a list of workouts, each with its distance, duration and average heart rate.',
    role: 'gallery',
    readme: 'inline',
  },
  {
    file: 'sleep.png',
    title: 'Sleep',
    alt: 'The Sleep page: nightly duration broken into stages, with the naps outside each night and a month of sleep timing.',
    role: 'gallery',
    readme: 'link',
  },
  {
    file: 'recovery.png',
    title: 'Recovery',
    alt: 'The Recovery page: a recovery index against your own last sixty days, with the four measures that moved it, beside resting heart rate, heart rate variability and respiratory rate against their own baselines, and the daily heart rate range beneath them.',
    role: 'gallery',
    readme: 'link',
  },
]

/**
 * The single hero, thrown rather than defaulted: a manifest with two heroes (or none) would
 * otherwise publish a page with two hero images stacked, or one with the hero slot empty, and the
 * mistake would be visible only to whoever opened the site.
 */
export function heroShot() {
  const heroes = SCREENSHOTS.filter((shot) => shot.role === 'hero')
  if (heroes.length !== 1) throw new Error(`expected exactly one hero screenshot, found ${heroes.length}`)
  return heroes[0]
}

/** The rest, in manifest order, which is the order they appear in the gallery. */
export function galleryShots() {
  return SCREENSHOTS.filter((shot) => shot.role === 'gallery')
}
