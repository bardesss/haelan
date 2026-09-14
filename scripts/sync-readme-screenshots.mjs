// Writes the README's screenshot block from scripts/screenshots.mjs, the same list the landing
// page's gallery and lightboxes are built from.
//
// Usage: pnpm readme:screenshots
//
// Do not hand edit the block between the markers in README.md: scripts/test/screenshots.test.ts
// regenerates it and fails when it disagrees with what is checked in. Change the manifest, run the
// script, commit the result - the same arrangement TOOLS.md and `pnpm docs:tools` already use.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SCREENSHOTS } from './screenshots.mjs'
import { joinWords, numberWord } from './number-words.mjs'

const START = '<!-- screenshots:start -->'
const END = '<!-- screenshots:end -->'

// What the rest of README.md wraps at. A generated block that runs to one 300 character line turns
// every future edit near it into an unreadable diff, so this one wraps like its neighbours.
const WIDTH = 100

/**
 * Greedy wrap at spaces. Safe for the markdown here because a link - `[Sleep](assets/…png)` - has
 * no space inside it and so is never split across lines, which markdown would not survive. A word
 * longer than the width goes over it rather than being broken.
 */
function wrap(sentence) {
  const lines = ['']
  for (const word of sentence.split(' ')) {
    const line = lines.at(-1)
    if (line === '') lines[lines.length - 1] = word
    else if (line.length + 1 + word.length <= WIDTH) lines[lines.length - 1] = `${line} ${word}`
    else lines.push(word)
  }
  return lines.join('\n')
}

/**
 * The block itself, without its markers, ending in the newline that separates it from the closing
 * marker.
 *
 * The markdown alt text is the manifest's full sentence rather than the caption it used to be.
 * GitHub renders alt text to whoever cannot see the image, and "The Dashboard" told them only that
 * a dashboard exists.
 */
export function readmeScreenshots() {
  const inline = SCREENSHOTS.filter((shot) => shot.readme === 'inline')
  const linked = SCREENSHOTS.filter((shot) => shot.readme === 'link')

  const images = inline.map((shot) => `![${shot.alt}](assets/screenshots/${shot.file})`).join('\n\n')

  // Four full-width screenshots stacked before the first paragraph is a wall to scroll past on a
  // phone, so the rest are named in a line of links instead - said here rather than left for a
  // reader to infer from the manifest's `readme` field.
  const above = `${joinWords(inline.map((shot) => shot.title))} above`
  const rest = linked.length > 0
    ? `; ${joinWords(linked.map((shot) => `[${shot.title}](assets/screenshots/${shot.file})`))} as well`
    : ''
  const all = `All ${numberWord(SCREENSHOTS.length)} are the demo data \`scripts/seed-demo.mjs\` generates, not anybody's real health history.`

  return `${images}\n\n${wrap(`<sub>${above}${rest}. ${all}</sub>`)}\n`
}

/** Replaces the marked block in `readme` in place, leaving every other byte alone. */
export function render(readme) {
  const start = readme.indexOf(START)
  const end = readme.indexOf(END)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README.md has no ${START} / ${END} block to write into`)
  }
  return readme.slice(0, start + START.length) + '\n' + readmeScreenshots() + readme.slice(end)
}

// Run directly (pnpm readme:screenshots), not imported by a test.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = fileURLToPath(new URL('../README.md', import.meta.url))
  const before = readFileSync(path, 'utf8')
  const after = render(before)
  writeFileSync(path, after)
  console.log(after === before ? 'README.md screenshot block was already current' : 'rewrote the README.md screenshot block')
}
