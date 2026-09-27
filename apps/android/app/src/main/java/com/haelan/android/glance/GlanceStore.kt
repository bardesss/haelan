package com.haelan.android.glance

import android.content.Context
import androidx.security.crypto.EncryptedFile
import androidx.security.crypto.MasterKey
import org.json.JSONObject
import java.io.File

/**
 * The last glance of today, kept so the screen can draw it the moment it opens and while the
 * instance is out of reach. One record: whose glance it is (server and person), the ETag that lets
 * the next read cost a 304, when it was fetched, and the body exactly as the server sent it.
 *
 * Only today is kept; a past day is read live and never written here.
 *
 * Sign-out has no single place in this app (a 401 during a sync forgets the session from a worker),
 * so the record carries its owner and [load] answers it only to that owner. Anyone else's record is
 * deleted by the read that finds it, as is a record the app cannot use: kept, its ETag would earn a
 * 304 that leaves the screen with nothing to draw.
 */
class GlanceStore(private val storage: Storage) {

    /** Where the record's bytes live: an [EncryptedFile] on a phone, memory in a test. */
    interface Storage {
        /** The bytes, or null when nothing is stored. */
        fun read(): ByteArray?
        fun write(bytes: ByteArray)
        fun delete()
    }

    /** A stored glance, already read, with the body it was read from and what the next read needs. */
    data class Kept(
        val glance: Glance,
        val json: String,
        val etag: String?,
        val fetchedAtMs: Long,
    )

    /**
     * The glance stored for this person on this server, or null. Everything that is not that - no
     * record, another owner's, bytes that will not decrypt or parse - is null, and whatever was
     * there is deleted.
     */
    fun load(server: String, personId: String): Kept? {
        val kept = try {
            val bytes = storage.read() ?: return null
            val record = JSONObject(String(bytes, Charsets.UTF_8))
            if (record.getString("server") != server || record.getString("personId") != personId) {
                null
            } else {
                val json = record.getString("json")
                Kept(
                    glance = GlanceParser.parse(json),
                    json = json,
                    etag = if (record.isNull("etag")) null else record.getString("etag"),
                    fetchedAtMs = record.getLong("fetchedAtMs"),
                )
            }
        } catch (e: Exception) {
            // A missing field, a JSON error, a glance the parser rejects, or a file the key no
            // longer opens: none of them is a glance to draw.
            null
        }
        if (kept == null) delete()
        return kept
    }

    /**
     * Replaces the record. False when the storage refused it (a Keystore that will not produce the
     * key, say): the glance on screen is unaffected and the next open simply starts without one.
     */
    fun save(server: String, personId: String, etag: String?, fetchedAtMs: Long, json: String): Boolean {
        val record = JSONObject()
            .put("server", server)
            .put("personId", personId)
            .put("etag", etag ?: JSONObject.NULL)
            .put("fetchedAtMs", fetchedAtMs)
            .put("json", json)
        return try {
            storage.write(record.toString().toByteArray(Charsets.UTF_8))
            true
        } catch (e: Exception) {
            false
        }
    }

    /** Forgets the glance; signing out calls this. Never throws: there is nothing to do about it. */
    fun delete() {
        runCatching { storage.delete() }
    }

    companion object {
        /** The record's file. noBackupFilesDir: it is health data, and the key would not travel with it anyway. */
        private const val FILE_NAME = "glance.bin"

        /** The store the app uses, encrypted under a Keystore key built as [com.haelan.android.SessionStore] builds its own. */
        fun encrypted(context: Context): GlanceStore = GlanceStore(EncryptedFileStorage(context.applicationContext))
    }

    /**
     * The record in an [EncryptedFile] (AES256-GCM, streaming). No plaintext fallback, unlike the
     * session: a Keystore that fails makes every call here throw, which [load] and [save] already
     * read as "nothing kept", so the glance only loses its instant open.
     */
    private class EncryptedFileStorage(private val context: Context) : Storage {

        private val file get() = File(context.noBackupFilesDir, FILE_NAME)

        private fun encrypted(): EncryptedFile {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            return EncryptedFile.Builder(
                context,
                file,
                masterKey,
                EncryptedFile.FileEncryptionScheme.AES256_GCM_HKDF_4KB,
            ).build()
        }

        override fun read(): ByteArray? {
            if (!file.exists()) return null
            return encrypted().openFileInput().use { it.readBytes() }
        }

        // EncryptedFile refuses to open an existing file for writing, so the old record goes first.
        // A write cut short leaves a file that will not decrypt, which load() deletes.
        override fun write(bytes: ByteArray) {
            file.delete()
            encrypted().openFileOutput().use { it.write(bytes) }
        }

        override fun delete() {
            file.delete()
        }
    }
}
