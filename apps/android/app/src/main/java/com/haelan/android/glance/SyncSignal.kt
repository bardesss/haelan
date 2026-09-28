package com.haelan.android.glance

import android.content.SharedPreferences
import com.haelan.android.SyncStatus
import com.haelan.android.SyncTypes

/**
 * A finished sync, heard from the preferences both sync paths already write. The button's run
 * (SyncRun) and the background worker each record a type's last finished run under
 * [SyncStatus.lastKey] in SessionStore.prefs, so a change to one of those keys is a type that has
 * just reached the instance, whichever path sent it; nothing in the app observes the sync jobs
 * themselves, and this needs nothing that does.
 *
 * SharedPreferences holds its listeners weakly, so the listener is a field here and this object is
 * held for as long as it should hear anything: a lambda handed straight to register would be
 * collected and go quiet with no error. [onSync] runs on whichever thread wrote the preference
 * (EncryptedSharedPreferences calls back on the writer's thread, the worker's included), once per
 * type, so the caller moves it to the main thread and folds a run's burst into one refresh.
 */
class SyncSignal(private val prefs: SharedPreferences, private val onSync: () -> Unit) : AutoCloseable {

    private val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (isSyncKey(key)) onSync()
    }

    /** Starts listening; [close] stops. */
    fun start() = prefs.registerOnSharedPreferenceChangeListener(listener)

    override fun close() = prefs.unregisterOnSharedPreferenceChangeListener(listener)

    companion object {
        /** Every key a finished run writes its instant under, one per sync toggle. */
        private val SYNC_KEYS: Set<String> = SyncTypes.ALL.map { SyncStatus.lastKey(it.key) }.toSet()

        /**
         * Whether a changed [key] is a type's last finished run. Only those: the empty flag written
         * beside it, a toggle, the session, or a null key (a `clear()` on newer Android) are not a
         * sync finishing.
         */
        fun isSyncKey(key: String?): Boolean = key in SYNC_KEYS
    }
}
