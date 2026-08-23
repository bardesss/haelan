/**
 * What the mapping layer turns a payload into: which fields become samples, how a session is
 * shaped, and above all how `describe()` in store/sources.ts decides a source's identity.
 *
 * Separate from DERIVATION_VERSION because the two answer different questions. A derivation
 * bump says the numbers computed from tier 2 changed. A mapping bump says tier 2 itself
 * changed, so re-deriving from the rows on disk would faithfully recompute the wrong thing.
 * Either one triggers a rebuild; keeping them apart is what lets a bump say which layer moved.
 *
 * 1: M2e, the first version recorded. describe() widened during M1 to take an application
 *    package name and the manual recording flag into a source's identity, and the sources rows
 *    written before that widening are the reason this milestone exists.
 */
export const MAPPING_VERSION = 1
