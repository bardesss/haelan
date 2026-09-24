// @vitest-environment happy-dom
//
// happy-dom, because scrollToHashTarget reads window.location and the document, neither of which
// router.test.ts's node environment has.
import { describe, it, expect, afterEach } from 'vitest'
import { scrollToHashTarget } from '../src/router.js'

describe('scrollToHashTarget', () => {
  const before = window.location.pathname + window.location.search + window.location.hash
  afterEach(() => {
    window.history.replaceState(null, '', before)
    document.body.replaceChildren()
  })

  it('scrolls the element the fragment names into view', () => {
    const target = document.createElement('section')
    target.id = 'sources'
    let scrolled = false
    target.scrollIntoView = () => { scrolled = true }
    document.body.appendChild(target)
    window.history.replaceState(null, '', '/account#sources')
    scrollToHashTarget()
    expect(scrolled).toBe(true)
  })

  // A fragment is whatever the address bar holds, and decodeURIComponent throws URIError on a
  // malformed escape. The Account page calls this on mount, so a throw here would take the page
  // down for a typo in a URL.
  it('does nothing, rather than throwing, for a malformed fragment', () => {
    window.history.replaceState(null, '', '/account#%E0')
    expect(() => scrollToHashTarget()).not.toThrow()
  })
})
