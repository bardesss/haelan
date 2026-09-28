package com.haelan.android.glance

/**
 * Every glance repository that is open in the process, so a sign-out can close them all before it
 * deletes the stored glance. A list rather than one slot: two glance screens can exist for a moment
 * (a relaunch before the old one is destroyed), and a slot overwritten by the second and cleared by
 * whichever is destroyed first would leave the other running, its read in flight free to write the
 * glance back after the delete.
 *
 * Plain Kotlin, no Android: whatever owns a repository registers it when it builds one and closes
 * it through [close]; today that is GlanceActivity, and a ViewModel's onCleared would do the same.
 * Synchronised, since the sign-out closes from the IO thread while screens open on the main one.
 */
class GlanceRegistry {

    private val open = mutableListOf<AutoCloseable>()

    /** Registers [repository] as open and hands it back, for `val repo = registry.register(...)`. */
    fun <T : AutoCloseable> register(repository: T): T {
        synchronized(open) { open += repository }
        return repository
    }

    /** Closes [repository] and forgets it; closing one already closed by [closeAll] is harmless. */
    fun close(repository: AutoCloseable) {
        synchronized(open) { open.remove(repository) }
        repository.close()
    }

    /** Closes every repository still open, oldest first, and forgets them all. */
    fun closeAll() {
        val all = synchronized(open) { open.toList().also { open.clear() } }
        all.forEach { it.close() }
    }

    /** How many are open; for tests. */
    internal val size: Int get() = synchronized(open) { open.size }

    companion object {
        /** The process's registry: the glance screens register here and the sign-out closes it. */
        val app = GlanceRegistry()
    }
}

/**
 * **The sign-out's glance step: close every repository, then delete the stored glance.** A blocking
 * today read cannot be interrupted, so one in flight at sign-out can still answer 200 afterwards;
 * a closed repository never writes that answer (GlanceRepository's KDoc), and its close takes the
 * lock its disk write holds, so once [GlanceRegistry.closeAll] returns no write is still under way.
 * Deleting after it is what makes the delete final. Runs off the main thread: the delete is disk.
 */
fun forgetGlances(registry: GlanceRegistry, deleteStore: () -> Unit) {
    registry.closeAll()
    deleteStore()
}
