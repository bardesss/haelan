package com.haelan.android

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Everything the app remembers - server address, username, session and toggles - lives
 * here, encrypted with a Keystore key (AES256-SIV for names, AES256-GCM
 * for values). The password is never persisted: it stays only in the text
 * field and in the login POST.
 *
 * The first launch after the upgrade migrates the values once from the legacy
 * plaintext file and then clears it. If the Keystore is unavailable, it falls
 * back to the plaintext file and reports it (insecureFallback): a warning is
 * better than an app that does not start.
 */
object SessionStore {

    private const val FILE_SECURE = "haelan_secure"
    private const val FILE_PLAIN = "haelan"
    private const val KEY_SERVER = "server_url"
    private const val KEY_USERNAME = "username"
    private const val KEY_PERSON_ID = "person_id"
    private const val KEY_COOKIE = "cookie"

    data class Session(val server: String, val personId: String, val cookie: String, val username: String)

    @Volatile
    private var cached: SharedPreferences? = null

    var insecureFallback = false
        private set

    fun prefs(context: Context): SharedPreferences {
        cached?.let { return it }
        val appCtx = context.applicationContext
        val secure = try {
            val masterKey = MasterKey.Builder(appCtx)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            EncryptedSharedPreferences.create(
                appCtx,
                FILE_SECURE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        } catch (e: Exception) {
            null
        }
        val resolved = if (secure != null) {
            migrateLegacy(appCtx, secure)
            insecureFallback = false
            secure
        } else {
            insecureFallback = true
            appCtx.getSharedPreferences(FILE_PLAIN, Context.MODE_PRIVATE)
        }
        cached = resolved
        return resolved
    }

    private fun migrateLegacy(appCtx: Context, secure: SharedPreferences) {
        val plain = appCtx.getSharedPreferences(FILE_PLAIN, Context.MODE_PRIVATE)
        if (plain.all.isEmpty()) return
        secure.edit().apply {
            for ((key, value) in plain.all) {
                when (value) {
                    is String -> putString(key, value)
                    is Boolean -> putBoolean(key, value)
                    is Int -> putInt(key, value)
                    is Long -> putLong(key, value)
                    is Float -> putFloat(key, value)
                    is Set<*> -> @Suppress("UNCHECKED_CAST") putStringSet(key, value as Set<String>)
                }
            }
        }.apply()
        plain.edit().clear().apply()
    }

    fun saveSession(prefs: SharedPreferences, server: String, username: String, personId: String, cookie: String) {
        prefs.edit()
            .putString(KEY_SERVER, server)
            .putString(KEY_USERNAME, username)
            .putString(KEY_PERSON_ID, personId)
            .putString(KEY_COOKIE, cookie)
            .apply()
    }

    fun loadSession(prefs: SharedPreferences): Session? {
        val server = prefs.getString(KEY_SERVER, null)
        val personId = prefs.getString(KEY_PERSON_ID, null)
        val cookie = prefs.getString(KEY_COOKIE, null)
        val username = prefs.getString(KEY_USERNAME, null)
        if (server.isNullOrEmpty() || personId.isNullOrEmpty()
            || cookie.isNullOrEmpty() || username.isNullOrEmpty()
        ) return null
        return Session(server, personId, cookie, username)
    }

    fun serverAndUsername(prefs: SharedPreferences): Pair<String, String> =
        (prefs.getString(KEY_SERVER, "") ?: "") to (prefs.getString(KEY_USERNAME, "") ?: "")

    /** Forgets the session, keeps server address and username to prefill login. */
    fun clearSession(prefs: SharedPreferences) {
        prefs.edit().remove(KEY_PERSON_ID).remove(KEY_COOKIE).apply()
    }
}
