package com.haelan.android

import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Keeps a screen's own content out from under the status and navigation bars.
 *
 * targetSdk is 35, and from Android 15 the system draws every app edge to edge whether it asked
 * to or not. A layout that was written before that gets its first line painted underneath the
 * clock: on a Pixel the account row and the sign out button sat behind the status bar, unreadable
 * and half untappable.
 *
 * The insets are ADDED to whatever padding the layout already declares rather than replacing it,
 * which is the difference between this and `fitsSystemWindows`. That attribute writes padding
 * directly onto the view and silently discards the 16dp the layout asked for, so the content ends
 * up against the screen edge on the sides while the top is fixed.
 *
 * The base padding is read once, on the first call, because the listener can fire again on a
 * rotation or a keyboard and reading the already-padded values would add the inset a second time.
 *
 * [top] and [bottom] say which of the two edges this view owns. A screen with a top bar splits
 * them: the bar takes the status bar's inset, so its colour runs up under the clock, and the
 * scrolling page under it takes the navigation bar's.
 */
fun View.padForSystemBars(top: Boolean = true, bottom: Boolean = true) {
    val baseTop = paddingTop
    val baseBottom = paddingBottom
    val baseLeft = paddingLeft
    val baseRight = paddingRight
    ViewCompat.setOnApplyWindowInsetsListener(this) { view, insets ->
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
        view.setPadding(
            baseLeft + bars.left,
            baseTop + if (top) bars.top else 0,
            baseRight + bars.right,
            baseBottom + if (bottom) bars.bottom else 0,
        )
        insets
    }
    ViewCompat.requestApplyInsets(this)
}
