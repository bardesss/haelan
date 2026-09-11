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
 * 2: M3b's downsampler emits a fourth row per minute carrying that minute's reading tally, so a
 *    person's tier 2 built under 1 has no count rows for heart rate and cannot roll one up.
 * 3: the catalogue caught up with the API - twenty-two data types the app fetched nothing for,
 *    across six shapes. Tier 2 built under 2 has no rows at all for any of them, and the archive
 *    it would be re-derived from does hold their payloads for whatever window was already
 *    fetched, so the bump is what turns that archived history into rows rather than leaving only
 *    the types' future visible.
 * 4: M5d-A rekeys `samples` onto integers. The five identifiers the table used to write out in
 *    full on every row - a person id, a source id, a metric name, an aggregate name and a raw
 *    payload id - are now integer refs. Four of them are refs into the tables that own them; the
 *    fifth, the aggregate, is not, since it comes from the fixed `SAMPLE_AGG_REFS` map and has no
 *    owning table to reference. Tier 2's shape is different in every row it holds. Migration 0016
 *    drops the old table rather than translating 1.6 million
 *    rows inside a migration transaction, which means a person stamped 3 has no samples at all
 *    rather than samples in the older shape, and this bump is the whole of what refills them from
 *    the archive on the first boot after the upgrade.
 * 5: M8a widens a session's `attrs` from seven keys to fourteen. Laps, automatic splits, pause and
 *    resume events, moving time, the workout's own name, its notes and its GPS flag were all in
 *    the Exercise payload and none of them reached tier 2, so a session row built under 4 cannot
 *    answer a detail page at all. The archive holds every payload they are re-mapped from, which
 *    is what makes this a bump rather than a re-fetch: history becomes detailed, not only future
 *    workouts. Sessions are a rounding error against `samples`, so the disk cost is not
 *    measurable next to the rebuild the bump triggers.
 */
export const MAPPING_VERSION = 5
