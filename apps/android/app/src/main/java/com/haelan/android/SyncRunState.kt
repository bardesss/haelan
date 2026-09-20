package com.haelan.android

/**
 * The state of the button's sync, in a place a screen can attach to and leave again.
 *
 * The screen that starts a run is not the screen that has to finish it: rotating the phone
 * destroys and recreates the activity, and the system destroys it too when it reclaims memory
 * while somebody checks another app. A run cancelled on the way out is not a pause. What landed
 * has already moved the instance's cursor for that type, and the rest of its window sits behind
 * that cursor, where the next run only reads back to the overlap. So the run and this state
 * outlive the screen, and a screen created afterwards paints what it finds.
 *
 * What lives here is the part a JVM test can hold: which types a run carries, what each row shows,
 * and how those move. The scope, Health Connect and the POSTs are [SyncRun].
 */
class SyncRunState {

    /** What the box at the end of one type's row shows. */
    enum class Mark {
        IDLE, RUNNING, SENT, EMPTY, FAILED;

        /**
         * Whether this mark is an answer the run left, as opposed to a type on its way to one.
         * It is what a card's bar counts as done, so a run still going and a type not reached yet
         * both stay out of the count.
         */
        val answered: Boolean get() = this == SENT || this == EMPTY || this == FAILED
    }

    /**
     * The run as a screen draws it. [sending] is the set of types this run carries, which is what
     * each card's bar counts against, and [marks] holds the types the run has answered for: a key
     * that is not in it has not been reached yet.
     */
    data class Status(
        val running: Boolean = false,
        val sending: Set<String> = emptySet(),
        val marks: Map<String, Mark> = emptyMap(),
        /**
         * Why a type failed, for the types that did, in the reader's own language.
         *
         * The mark alone said only that something went wrong, and the screen drew a red dot for
         * it. A dot cannot be read: diagnosing a type that would not send meant reading the app's
         * own logcat, which nobody has on the phone in their hand, so the answer the app already
         * had went to a log line instead of to the person it concerned.
         */
        val reasons: Map<String, String> = emptyMap(),
    )

    /**
     * The screen drawing this state, which is at most one: an activity attaches in onCreate and
     * detaches in onDestroy. [paint] is level-triggered and is the whole of the drawing contract;
     * the other two are one-shot answers, because a screen that arrives late cannot act on a
     * session that expired while it was gone.
     */
    interface Screen {
        fun paint(status: Status)

        /** The session is over: the run stopped, and the screen that is up has to leave. */
        fun sessionExpired()

        /** The run itself threw, which is not one type's failure and belongs to no row. */
        fun runFailed(error: Throwable)
    }

    private var screen: Screen? = null
    private var status = Status()

    /** What a screen attaching now would paint. */
    fun status(): Status = status

    /**
     * The screen to draw with. What it gets first is the state as it stands, which is the whole
     * point: a screen created by a rotation paints the run that is still going instead of a screen
     * whose button looks idle and whose rows look untouched.
     */
    fun attach(screen: Screen) {
        this.screen = screen
        screen.paint(status)
    }

    /** The screen going away, which is not the run going away: nothing here cancels anything. */
    fun detach(screen: Screen) {
        if (this.screen === screen) this.screen = null
    }

    /**
     * Opens a run for [sending], or refuses while one is already going: a second tap is not
     * a second upload of the same window, and the marks below are what both would be writing to.
     */
    fun begin(sending: Set<String>): Boolean {
        if (status.running) return false
        status = Status(running = true, sending = sending, marks = emptyMap())
        publish()
        return true
    }

    /** One type's own answer, as the engine reports it. */
    fun mark(key: String, mark: Mark, reason: String? = null) {
        // A reason replaces whatever the last run left, and its absence clears it: a type that
        // failed and then succeeded must not keep explaining a failure that is over.
        val reasons = if (reason == null) status.reasons - key else status.reasons + (key to reason)
        status = status.copy(marks = status.marks + (key to mark), reasons = reasons)
        publish()
    }

    /** The session is over. A screen that is up is told; one that is gone is not invented. */
    fun expired() {
        screen?.sessionExpired()
    }

    /** The run threw. Told once, to whoever is up. */
    fun failed(error: Throwable) {
        screen?.runFailed(error)
    }

    /**
     * The run is over, whichever way it ended: finished, refused, expired, or cancelled by the
     * framework as the process goes. A spinning row belongs to a run that is no longer going, so
     * it goes back to neutral; a type the run never reached was never marked at all.
     */
    fun finish() {
        status = status.copy(
            running = false,
            marks = status.marks.mapValues { (_, mark) -> if (mark == Mark.RUNNING) Mark.IDLE else mark },
        )
        publish()
    }

    private fun publish() {
        screen?.paint(status)
    }
}
