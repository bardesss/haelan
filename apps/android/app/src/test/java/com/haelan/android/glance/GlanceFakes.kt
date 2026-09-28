package com.haelan.android.glance

import com.haelan.android.glance.GlanceClient.GlanceRead
import kotlinx.coroutines.CoroutineDispatcher
import kotlin.coroutines.CoroutineContext

/** A fixture under `glance/`, written by the server's own fixture test (see GlanceParserTest). */
internal fun glanceFixture(name: String): String =
    checkNotNull(GlanceStoreTest::class.java.getResourceAsStream("/glance/$name")) {
        "glance/$name is not on the test classpath"
    }.bufferedReader().readText()

/** The store's bytes in memory: what the EncryptedFile holds on a phone. */
internal class MemoryStorage : GlanceStore.Storage {
    var bytes: ByteArray? = null
    var failWrites = false

    override fun read(): ByteArray? = bytes

    override fun write(bytes: ByteArray) {
        if (failWrites) throw IllegalStateException("no key")
        this.bytes = bytes
    }

    override fun delete() {
        bytes = null
    }
}

/**
 * The instance, answer by answer. Each read takes the next queued answer for its route; [onToday]
 * and [onDay] run at the moment of the call, which is how a test sees what was on screen then.
 */
internal class FakeReads : GlanceReads {
    val todayAnswers = ArrayDeque<GlanceRead>()
    val dayAnswers = mutableMapOf<String, ArrayDeque<GlanceRead>>()
    val etagsSent = mutableListOf<String?>()
    val daysAsked = mutableListOf<String>()
    var onToday: () -> Unit = {}
    var onDay: (String) -> Unit = {}

    fun answerDay(localDate: String, read: GlanceRead) {
        dayAnswers.getOrPut(localDate) { ArrayDeque() }.addLast(read)
    }

    override fun today(etag: String?): GlanceRead {
        etagsSent += etag
        onToday()
        return todayAnswers.removeFirstOrNull() ?: error("no answer queued for today")
    }

    override fun day(localDate: String): GlanceRead {
        daysAsked += localDate
        onDay(localDate)
        return dayAnswers[localDate]?.removeFirstOrNull() ?: error("no answer queued for $localDate")
    }
}

/** A dispatcher that runs nothing until told to, and in the order the test picks. */
internal class QueueDispatcher : CoroutineDispatcher() {
    val tasks = ArrayDeque<Runnable>()

    override fun dispatch(context: CoroutineContext, block: Runnable) {
        tasks.addLast(block)
    }

    fun runLast() = tasks.removeLast().run()

    fun runFirst() = tasks.removeFirst().run()
}
