package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/**
 * What a refused upload costs, now that a chunk is bounded by time as well as bytes and a refusal
 * is asked again before the type gives up.
 *
 * This is the case behind the PR comment on SyncEngine.uploadType ("I think uploadType can lose
 * data permanently"). Nothing here is Android: points are instants and byte costs, because org.json
 * is a stub in a JVM unit test ("Method put in org.json.JSONObject not mocked") and would have
 * measured a fabricated string anyway - the same reason IngestChunkSizeTest measures bytes rather
 * than building points.
 *
 * THE CUT IS THE PRODUCTION ONE. Every boundary below comes from [SyncEngine.chunkEnds] and the
 * flush from [SyncEngine.flushEnd], so the ceiling this file is about is the ceiling the app
 * applies. The model is the loop around it:
 * buffer per identity, cut when a ceiling is reached, the first permanent refusal ending the type
 * with every other buffer unsent, each identity's remainder flushed at the end. That loop cannot be
 * reached from a JVM test because uploadType reads Health Connect, and it is the part to watch if
 * this file ever stops matching the engine.
 *
 * WHAT BOUNDS THE LOSS, in one line: a refusal costs what it leaves unposted, and the next sync
 * only re-reads from the instance's cursor minus SyncCursors.OVERLAP_MS. So the loss is bounded by
 * the reach of one chunk, which is what MAX_CHUNK_SPAN_MS caps at half the overlap - and a refusal
 * that a retry could have answered never becomes a loss at all.
 *
 * The assertions count what travelled and what did not, never how many chunks a fixture happens to
 * produce: chunk counts are a property of the ceilings and of how a provider paginates, and a test
 * that types one in measures its own arithmetic. IngestChunkSizeTest pins the cut policy itself.
 */
class UploadCursorHoleTest {

    /** SyncEngine.MAX_CHUNK_BYTES, repeated because that constant is private to the engine. */
    private val budget = 512 * 1024

    /** SyncEngine.MAX_CHUNK_SPAN_MS, whose value is the point of the whole file. */
    private val spanCap = SyncEngine.MAX_CHUNK_SPAN_MS

    private val hourMs = 60L * 60L * 1000L
    private val minuteMs = 60L * 1000L

    // ---- The two sides, as little of each as the case needs ----

    /** One mapped point: the identity its record carried, the byte cost it adds, and its instant. */
    private data class Point(val identity: String, val bytes: Int, val atMs: Long)

    /** One readRecords answer: the points it held, in the order the provider returned them. */
    private class Page(val points: List<Point>)

    private class Upload(private val budget: Int, private val spanCap: Long) {

        /**
         * The post refused, as its position in this run's sequence of posts, counting from zero.
         * A refused post is attempted up to [retryLimit] extra times; past that it is permanent and
         * ends the type, which is what uploadType's single early return does to the chunks cut
         * beside the refused one and to every buffer still holding points.
         */
        var refuseFromPost: Int = Int.MAX_VALUE

        /**
         * The attempt at which the refusal stops being answered, or [Int.MAX_VALUE] for a refusal
         * no attempt is ever answered from - an instance that is gone rather than busy.
         *
         * Two is the ordinary refusal postWithRetry exists for: the first attempt is refused and the
         * second one lands, so nothing is lost and the type carries on.
         */
        var refusalsAnswered: Int = Int.MAX_VALUE

        /** How many attempts a post gets before the type gives up. SyncEngine.POST_ATTEMPTS. */
        var retryBudget: Int = SyncEngine.POST_ATTEMPTS

        /** What landed, by identity: the points the instance archived and can answer for. */
        val landed = mutableMapOf<String, MutableList<Point>>()

        /** Every point the pages carried, by identity and in the order they were read. */
        private val read = mutableMapOf<String, MutableList<Point>>()

        /** Every post this run would have made, in order, so a test can name one to refuse. */
        val posts = mutableListOf<Pair<String, List<Point>>>()

        /** How many times each refused post was attempted, so a case can prove the retry happened. */
        val attemptsByPost = mutableMapOf<Int, Int>()

        /** The identity whose post ended the type, or null when this run posted everything. */
        var refusedAt: String? = null
            private set

        private var postIndex = 0

        fun run(pages: List<Page>) {
            for (page in pages) {
                for (point in page.points) read.getOrPut(point.identity) { mutableListOf() } += point
            }
            val buffers = mutableMapOf<String, MutableList<Point>>()
            for (page in pages) {
                // Cut before any post, exactly like uploadType: a refusal inside this loop also
                // abandons the chunks beside the refused one that had already been cut.
                val ready = mutableListOf<Pair<String, List<Point>>>()
                for ((identity, points) in page.points.groupBy { it.identity }) {
                    val buffer = buffers.getOrPut(identity) { mutableListOf() }
                    buffer += points
                    while (true) {
                        val chunk = readyChunk(buffer) ?: break
                        ready += identity to chunk
                    }
                }
                for ((identity, chunk) in ready) {
                    if (!post(identity, chunk)) return
                }
            }
            val tail = mutableListOf<Pair<String, List<Point>>>()
            for ((identity, buffer) in buffers) {
                if (buffer.isNotEmpty()) tail += chunks(buffer).map { identity to it }
            }
            for ((identity, chunk) in tail) {
                if (!post(identity, chunk)) return
            }
        }

        /** The first chunk this buffer holds, cut by the production ceilings, or null if it is one. */
        private fun readyChunk(buffer: MutableList<Point>): List<Point>? {
            val end = SyncEngine.flushEnd(ends(buffer)) ?: return null
            val ready = buffer.subList(0, end).toList()
            buffer.subList(0, end).clear()
            return ready
        }

        /** Whatever the buffer still holds once the read is over: the tail, cut to the same ceilings. */
        private fun chunks(buffer: List<Point>): List<List<Point>> {
            var from = 0
            return ends(buffer).map { end -> buffer.subList(from, end).toList().also { from = end } }
        }

        private fun ends(points: List<Point>): List<Int> =
            SyncEngine.chunkEnds(
                points.map { it.bytes + 1 },
                budget,
                points.map { it.atMs },
                spanCap,
                // The count ceiling, which the route counts and the other two cannot express.
                SyncEngine.MAX_CHUNK_POINTS,
            )

        /**
         * One post, asked again while the answer is the refusal and the budget has attempts left -
         * the shape of postWithRetry, which is what decides whether this is a cost or a loss.
         *
         * The position in the sequence and the attempt number are two different numbers, and having
         * one variable for both is what a first version of this file got wrong. The position
         * advances once per post however many times it is asked; the attempt advances once per ask,
         * and only the attempt against the budget decides whether the post ever happens.
         */
        private fun post(identity: String, chunk: List<Point>): Boolean {
            if (postIndex < refuseFromPost) {
                postIndex++
                posts += identity to chunk
                landed.getOrPut(identity) { mutableListOf() } += chunk
                return true
            }
            // The refused post, asked one attempt at a time the way postWithRetry asks it: the
            // budget bounds the asking, and a refusal every attempt answers is already a refusal
            // that got through. Only a post that exhausts the budget ends the type.
            var attempts = 0
            while (attempts < retryBudget) {
                attempts++
                if (attempts >= refusalsAnswered) {
                    attemptsByPost[postIndex] = attempts
                    postIndex++
                    posts += identity to chunk
                    landed.getOrPut(identity) { mutableListOf() } += chunk
                    return true
                }
            }
            attemptsByPost[postIndex] = attempts
            refusedAt = identity
            return false
        }

        /**
         * Everything the refusal abandoned, by identity and in the order it was read: every point
         * the pages carried, minus the ones that landed.
         *
         * Derived rather than recorded, because the thing itself has no home once uploadType
         * returns - the buffers live on the stack of a call that is over.
         */
        fun unposted(): Map<String, List<Point>> =
            read.mapValues { (identity, points) ->
                val delivered = landed[identity].orEmpty()
                points.filterNot { point -> point in delivered }
            }
    }

    /** companion.ts: each source's own cursor is the newest window end that landed for it. */
    private fun cursorFor(landed: List<Point>): Long =
        if (landed.isEmpty()) 0L else landed.maxOf { it.atMs } + 1L

    /**
     * The instance's answer, read the way the phone reads it. Not a model of the instance: this is
     * the app's own production rule, SyncCursors.cursorEndsFor taking the minimum across a type's
     * sources and SyncEngine.syncAll calling SyncCursors.startFor on it. [landedBySource] is every
     * identity's own landed points -- one source that lags pulls the whole type's next start back
     * to it, which is the fix for the two source hole below.
     */
    private fun retryStartFor(landedBySource: Map<String, List<Point>>): Instant {
        val cursor = landedBySource.values.minOf { cursorFor(it) }
        // end is effectively unbounded here, so startFor never answers null for a real
        // (past) cursor; the type never needs the null path this deep into history.
        return SyncCursors.startFor(cursor, Instant.ofEpochMilli(0), Instant.ofEpochMilli(Long.MAX_VALUE))
            ?: error("a cursor this far in the past cannot be ahead of an unbounded end")
    }

    private fun points(count: Int, identity: String, bytes: Int, fromMs: Long, stepMs: Long): List<Point> =
        List(count) { Point(identity, bytes, fromMs + it * stepMs) }

    /** The sync as it would run with nothing refused, so a case can name the post it refuses. */
    private fun shapeOf(pages: List<Page>): Upload = Upload(budget, spanCap).also { it.run(pages) }

    /**
     * The watch-and-phone fixture: a watch that writes 300 KiB a page and flushes its way through
     * them, and a phone that writes readings across the same window at its own, much slower rate.
     * That asymmetry is the whole case - the cursor is per data type, so the watch's progress is
     * what the phone's readings are measured against.
     *
     * The phone's readings are spread over the pages at [readingsStepMs], not one per page: how the
     * provider paginates is a detail, and how fast the source writes is the thing under test.
     */
    private fun twoSources(readings: Int, readingsStepMs: Long): Pair<List<Page>, List<Point>> {
        // A page the watch always has to flush: 200 points of 3,000 bytes is 600 KiB against a
        // 512 KiB budget, so the watch reaches the byte ceiling inside every page rather than
        // across several. That is what puts watch posts between the phone's readings instead of
        // one watch post at the end.
        val watchPointBytes = 3_000
        val watchPointsPerPage = 200
        val pageSpanMs = 2 * 24 * hourMs
        val watchStepMs = pageSpanMs / watchPointsPerPage
        val windowMs = (readings - 1) * readingsStepMs
        // Enough pages to hold the window, so the number of watch posts is a property of the
        // fixture rather than of a page count typed in.
        val pages = (windowMs / pageSpanMs).toInt() + 1

        val phone = points(readings, "phone", 100, 0L, readingsStepMs)
        val all = mutableListOf<Page>()
        for (page in 0 until pages) {
            val fromMs = page * pageSpanMs
            val toMs = if (page == pages - 1) Long.MAX_VALUE else (page + 1) * pageSpanMs
            val watch = points(watchPointsPerPage, "watch", watchPointBytes, fromMs, watchStepMs)
            all += Page(watch + phone.filter { it.atMs in fromMs until toMs })
        }
        check(all.sumOf { it.points.size } == pages * watchPointsPerPage + readings) {
            "a reading was spread over no page: the window is wider than the pages ($pages)"
        }
        return all to phone
    }

    /** Every point of one identity that this run posted, which is what the instance holds. */
    private fun postedOf(upload: Upload, identity: String): List<Point> =
        upload.posts.filter { it.first == identity }.flatMap { it.second }

    // ---- 1. A refusal that a retry answers costs nothing ----

    /**
     * The phone's readings are too sparse to fill a byte-bounded buffer, so before the span ceiling
     * its whole window travelled as one post - and one refusal took all of it. The refusal here is
     * answered on the second attempt, which is the ordinary case the retry exists for: a network
     * that moved under a background sync says nothing about the request.
     */
    @Test
    fun `a refusal the retry answers loses nothing`() {
        val (pages, phoneWindow) = twoSources(readings = 13, readingsStepMs = 12 * hourMs)

        val shape = shapeOf(pages)
        assertNull("the shape run refuses nothing", shape.refusedAt)
        assertEquals("the phone's readings all travel", phoneWindow, postedOf(shape, "phone"))

        val upload = Upload(budget, spanCap)
        upload.refuseFromPost = shape.posts.lastIndex
        // The first attempt is refused and the second one is answered, which is the ordinary
        // refusal a background sync meets: a network that moved, not an instance that is gone.
        upload.refusalsAnswered = 2
        upload.run(pages)

        assertNull("the refused post was asked again and answered", upload.refusedAt)
        assertEquals("so the phone's whole window landed", phoneWindow, upload.landed["phone"].orEmpty())
        assertEquals(
            "and nothing is left unposted",
            emptyList<Point>(),
            upload.unposted().values.flatten(),
        )
        assertEquals(
            "the retry is what did it: the post took a second attempt",
            2,
            upload.attemptsByPost[shape.posts.lastIndex],
        )
    }

    // ---- 2. A refusal that survives the retries costs one chunk, not a window ----

    /**
     * The same sync with a refusal no retry can answer - the instance is gone, not busy. The type
     * ends at that post, so the phone's window is what it is: the loss is real, and the question
     * this case answers is how big it can be.
     *
     * Before the span ceiling the phone's whole window was one post, so a permanent refusal put
     * twenty days behind a cursor the watch had already pushed to the end. Now the loss is the
     * chunk that did not go, and a chunk is capped at half the day of overlap.
     */
    @Test
    fun `a refusal that survives the retries costs one chunk, not the whole window`() {
        val (pages, phoneWindow) = twoSources(readings = 40, readingsStepMs = 12 * hourMs)

        val shape = shapeOf(pages)
        assertTrue(
            "the window is more than one post now, which is what the ceiling bought",
            shape.posts.count { it.first == "phone" } > 1,
        )
        assertEquals("and the phone's readings still all travel", phoneWindow, postedOf(shape, "phone"))

        val upload = Upload(budget, spanCap)
        upload.refuseFromPost = shape.posts.lastIndex
        // The instance is gone, not busy: no attempt is ever answered.
        upload.refusalsAnswered = Int.MAX_VALUE
        upload.run(pages)

        assertEquals("the type gave up at the refused post", "phone", upload.refusedAt)
        assertEquals(
            "after spending the whole attempt budget on it",
            SyncEngine.POST_ATTEMPTS,
            upload.attemptsByPost[shape.posts.lastIndex],
        )

        val unposted = upload.unposted()["phone"].orEmpty()
        val retryStartMs = retryStartFor(upload.landed).toEpochMilli()
        val skipped = unposted.filter { it.atMs < retryStartMs }

        println(
            "permanent refusal: phone window 0..${phoneWindow.last().atMs}ms, "
            + "${unposted.size} of ${phoneWindow.size} readings unposted spanning "
            + "${(unposted.last().atMs - unposted.first().atMs) / hourMs}h, retry starts at "
            + "${retryStartMs}ms, ${skipped.size} skipped for good",
        )

        assertTrue("something was lost", unposted.isNotEmpty())
        assertTrue("but not the window: most of it reached the instance", unposted.size < phoneWindow.size / 2)
        assertTrue(
            "and what was lost is narrower than the day of overlap",
            unposted.last().atMs - unposted.first().atMs < SyncCursors.OVERLAP_MS,
        )
        assertEquals("so the next sync reads all of it again", emptyList<Point>(), skipped)
    }

    // ---- 3. Within one identity, a refusal costs nothing at all ----

    /**
     * One identity whose buffer is cut into several chunks, with one of them refused. What saves it
     * is that chunks of one identity are consecutive in time: the cursor lands where the last chunk
     * that travelled ended, so the day of overlap reaches back from it into the chunk that did not,
     * and the next sync asks for all of it again.
     *
     * This is the property the two-source case does not have, and it is why the fixture matters:
     * two identities move at different depths and the cursor is shared, one does not.
     */
    @Test
    fun `a refused chunk comes back whole within one identity`() {
        val watch = points(8, "watch", 100, 0L, 12 * hourMs)

        val shape = shapeOf(listOf(Page(watch)))
        assertTrue("the buffer is cut rather than posted whole", shape.posts.size > 1)
        assertEquals("and every reading travels", watch, postedOf(shape, "watch"))

        val upload = Upload(budget, spanCap)
        upload.refuseFromPost = 1
        upload.refusalsAnswered = Int.MAX_VALUE
        upload.run(listOf(Page(watch)))

        val landed = upload.landed["watch"].orEmpty()
        val abandoned = upload.unposted()["watch"].orEmpty()
        val retryStartMs = retryStartFor(upload.landed).toEpochMilli()
        val skipped = abandoned.filter { it.atMs < retryStartMs }

        println(
            "one identity, refused chunk 2 of ${shape.posts.size}: ${landed.size} readings landed, "
            + "${abandoned.size} unposted from ${abandoned.firstOrNull()?.atMs}ms, retry starts at "
            + "${retryStartMs}ms, ${skipped.size} outside the retry window",
        )

        assertTrue("the refusal really did cost something", abandoned.isNotEmpty())
        assertTrue("and it is a suffix of the window, not a hole in it", abandoned.first().atMs > landed.last().atMs)
        assertEquals("so the retry window reaches all of it", emptyList<Point>(), skipped)
    }

    // ---- 4. The property the two fixes exist to hold ----

    /**
     * The invariant, stated as a property rather than as a behaviour: whatever a sync fails to post
     * has to be old enough that the next sync still asks for it, or the data is gone.
     *
     * The fixture is the one that broke before: two sources, one of them writing too little to fill
     * a byte-bounded buffer. It is asserted against a refusal no retry answers, because that is the
     * refusal the ceiling has to hold against on its own.
     */
    @Test
    fun `what a sync fails to post stays inside the window the next sync re-reads`() {
        val (pages, _) = twoSources(readings = 40, readingsStepMs = 12 * hourMs)

        val shape = shapeOf(pages)
        val upload = Upload(budget, spanCap)
        upload.refuseFromPost = shape.posts.lastIndex
        upload.refusalsAnswered = Int.MAX_VALUE
        upload.run(pages)

        val unposted = upload.unposted()["phone"].orEmpty()
        val retryStartMs = retryStartFor(upload.landed).toEpochMilli()
        val skipped = unposted.filter { it.atMs < retryStartMs }

        assertFalse(
            "${skipped.size} of the ${unposted.size} readings that never travelled are behind the "
            + "retry window, which starts at ${retryStartMs}ms; the oldest is "
            + "${(retryStartMs - unposted.first().atMs) / hourMs}h before it and is never read again",
            skipped.isNotEmpty(),
        )
    }

    // A 72 hour spaced case belongs to the cross source minimum, not to this file: retryStartFor
    // above models "the minimum across sources" in the test's own Kotlin and never calls
    // SyncCursors.cursorEndsFor, so no fixture built on top of it -- at 12 hours, 72 hours, or any
    // other spacing -- can tell .min() from .max() in the production code. Tuning the reading
    // count only found a spacing where this file's own arithmetic happened to agree with the fix;
    // it proved nothing about the fix itself, which is what going red only for an even reading
    // count turned out to mean. SyncCursorsTest's
    // "a laggard's own late reading still falls inside the delta keyed on the minimum, not the
    // maximum" builds the two-sources-diverge-by-more-than-the-overlap case directly against
    // cursorEndsFor and startFor, which is the guard on this defect.

    // ---- 5. The case the app has always handled, kept as a floor ----

    /**
     * A buffer that flushes on every page, with a point past both ceilings on its own: what landed
     * is a prefix in time and the buffer is never deeper than the page it was just filled from.
     * No ceiling should turn this into a re-read of a window the instance already has.
     */
    @Test
    fun `a refusal with every buffer flushing stays inside the overlap`() {
        val pageMs = 10 * minuteMs
        val pages = List(4) { page -> Page(points(1, "watch", 307_000, page * pageMs, minuteMs)) }
        val everything = pages.flatMap { it.points }

        val shape = shapeOf(pages)
        assertEquals("one post per page", 4, shape.posts.size)

        val nothing = Upload(budget, spanCap)
        nothing.refuseFromPost = 0
        // The first post is refused and never answered, so the type ends there and no cursor exists.
        nothing.refusalsAnswered = Int.MAX_VALUE
        nothing.run(pages)
        assertEquals(
            "no cursor is how the app reads a type it has never sent",
            0L,
            cursorFor(nothing.landed["watch"].orEmpty()),
        )
        assertEquals("so every point is still to send", everything, nothing.unposted()["watch"].orEmpty())

        val second = Upload(budget, spanCap)
        second.refuseFromPost = 1
        second.refusalsAnswered = Int.MAX_VALUE
        second.run(pages)

        val landed = second.landed["watch"].orEmpty()
        val unposted = second.unposted()["watch"].orEmpty()
        val retryStartMs = retryStartFor(second.landed).toEpochMilli()

        assertEquals("one page landed", 1, landed.size)
        assertEquals("three points are still to send", 3, unposted.size)
        assertTrue(
            "the gap is ${unposted.first().atMs - landed.last().atMs}ms, inside the "
            + "${SyncCursors.OVERLAP_MS}ms the app re-reads",
            unposted.first().atMs - landed.last().atMs < SyncCursors.OVERLAP_MS,
        )
        assertEquals(
            "and the retry window reaches every unposted point",
            emptyList<Point>(),
            unposted.filter { it.atMs < retryStartMs },
        )
    }
}











