import { describe, it, expect } from 'vitest'
import { isExemptInlineLink } from '../layout-shared.mjs'

/**
 * `isExemptInlineLink` is the only part of the layout harnesses' hit-area sweep (`smallTargets`
 * in layout-shared.mjs) that can be exercised without a browser: it is deliberately a pure
 * function of already-extracted facts (`isAnchor`, `inlineDisplay`, `siblingText`) rather than of
 * the DOM, precisely so a regression like this one can be pinned in a fast test instead of only in
 * a Playwright run.
 *
 * The predicate this file guards against is the one that shipped first and was found too loose in
 * review: "the enclosing element carries any non-empty text besides the link" - which a breadcrumb
 * separator or a list marker satisfies without reading as a sentence in any sense WCAG 2.5.8's
 * inline exception means. `oldPredicate` below is that version, kept here only as the reference
 * point the regression test compares against - it is not used by the shipped harness.
 */
function oldPredicate({ isAnchor, inlineDisplay, siblingText }: { isAnchor: boolean, inlineDisplay: boolean, siblingText: string }) {
  if (!isAnchor || !inlineDisplay) return false
  return siblingText.trim().length > 0
}

describe('isExemptInlineLink', () => {
  it('exempts a real sentence, the shape GoogleStep.tsx actually has', () => {
    // GoogleStep.tsx's <li>: step1Before ("Open") + the link + step1After ("and create a
    // project, or pick an existing one."), joined the way the sweep joins sibling text nodes.
    const facts = { isAnchor: true, inlineDisplay: true, siblingText: 'Open  and create a project, or pick an existing one.' }
    expect(isExemptInlineLink(facts)).toBe(true)
  })

  it('does NOT exempt a breadcrumb separator - the case this fix was for', () => {
    // <span>› <a href="/x">Settings</a></span>: a real, discrete tap target next to a single
    // punctuation glyph, not prose constrained by line-height.
    const facts = { isAnchor: true, inlineDisplay: true, siblingText: '›' }

    // Proof this is a regression test and not a tautology: the predicate this repo shipped first
    // would have let this exact shape through.
    expect(oldPredicate(facts)).toBe(true)

    expect(isExemptInlineLink(facts)).toBe(false)
  })

  it('does NOT exempt a bare list marker either - the reviewer\'s second example', () => {
    // <li>* <a href="/y">this field</a></li>
    const facts = { isAnchor: true, inlineDisplay: true, siblingText: '*' }
    expect(oldPredicate(facts)).toBe(true)
    expect(isExemptInlineLink(facts)).toBe(false)
  })

  it('still requires an <a>', () => {
    expect(isExemptInlineLink({ isAnchor: false, inlineDisplay: true, siblingText: 'a whole sentence here' })).toBe(false)
  })

  it('still requires inline display', () => {
    expect(isExemptInlineLink({ isAnchor: true, inlineDisplay: false, siblingText: 'a whole sentence here' })).toBe(false)
  })

  it('does not exempt a link with no surrounding text at all', () => {
    expect(isExemptInlineLink({ isAnchor: true, inlineDisplay: true, siblingText: '' })).toBe(false)
  })

  it('does not exempt a single surrounding word', () => {
    // One word either side of the link is not yet a sentence.
    expect(isExemptInlineLink({ isAnchor: true, inlineDisplay: true, siblingText: 'Details' })).toBe(false)
  })
})
