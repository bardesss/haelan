// Small numbers as English words, for the prose on the README and the landing page.
//
// Both surfaces count things out loud - "Eight pages", "Thirteen typed tools", "All four are the
// demo data" - and a sentence is where a count goes stale most quietly: nothing about adding a
// ninth page makes anybody reread a paragraph written when there were eight. The guards in
// scripts/test/cross-surface.test.ts derive the number from the code that defines it and then look
// for the word here, which is the only reason this table exists.

const WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty',
]

/**
 * `numberWord(8)` is "eight". Throws past the end of the table rather than falling back to the
 * digits: a guard that silently started comparing against "21" would pass against prose that
 * still said "twenty", which is the failure it exists to catch.
 */
export function numberWord(n) {
  const word = WORDS[n]
  if (word === undefined) throw new Error(`no word for ${n}; extend WORDS in scripts/number-words.mjs`)
  return word
}

/** "A", "A and B", "A, B and C" - the serial comma left out, as the prose on both surfaces does. */
export function joinWords(parts) {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}
