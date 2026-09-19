package com.haelan.android

import java.net.URI
import java.net.URISyntaxException

/**
 * The instance address as a person types it, turned into the one form the app posts to.
 *
 * A phone cannot guess: somebody types `192.168.1.10:4235`, somebody pastes `http://nas:4235/`,
 * and both mean the same instance. Getting it wrong used to surface as a network error that said
 * nothing, so the repair happens once, before the address is saved, and no screen builds a URL
 * out of what was typed (A-18).
 */
object InstanceAddress {

    // A scheme, not a colon: `nas:4235` has one of those and is an address, `http://nas` has the
    // other and is one too.
    private val SCHEME = Regex("^[a-zA-Z][a-zA-Z0-9+.\\-]*://")

    /** The address in its one form, or null when what was typed cannot be one. */
    fun normalize(typed: String): String? {
        val trimmed = typed.trim()
        if (trimmed.isEmpty()) return null
        // A home instance is reached over http, so an address with no scheme means http rather
        // than a guess at https: the one that fails is the one that fails on a typo.
        val candidate = if (SCHEME.containsMatchIn(trimmed)) trimmed else "http://$trimmed"
        val uri = try {
            URI(candidate)
        } catch (e: URISyntaxException) {
            return null
        }
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return null
        if (uri.host.isNullOrEmpty()) return null
        // Credentials, a query or a fragment would ride along in every request or be dropped
        // silently. Refusing the address beats picking a half of it.
        if (uri.userInfo != null || uri.query != null || uri.fragment != null) return null
        return candidate.trimEnd('/')
    }
}
