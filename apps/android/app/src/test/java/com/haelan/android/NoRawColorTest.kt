package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The palette has one definition, in `packages/tokens`, and no
 * resource in this app states a colour of its own. The counterpart of the web's
 * `apps/web/test/no-raw-color.test.ts`, including the part that makes the guard honest: a check
 * that only knows about one spelling of a colour advertises more than it does.
 */
class NoRawColorTest {

    /**
     * `src/main/res`, found by walking up from the working directory rather than assumed. A test
     * that looked in the wrong place and found nothing would pass while checking nothing, which is
     * the failure this refuses: not finding the directory is an error, not an empty result.
     */
    private val res: File = generateSequence(File("").absoluteFile) { it.parentFile }
        .map { File(it, "src/main/res") }
        .firstOrNull { it.isDirectory }
        ?: error("src/main/res was not found above ${File("").absolutePath}")

    @Test
    fun `no resource states a colour of its own`() {
        val offenders = res.walkTopDown()
            .filter { it.isFile }
            .filter { HEX.containsMatchIn(it.readText()) }
            .map { it.name }
            .toList()

        assertEquals(emptyList<String>(), offenders)
    }

    @Test
    fun `the guard catches what it claims to catch`() {
        assertTrue(HEX.containsMatchIn("android:textColor=\"#4F8FF7\""))
        assertTrue(HEX.containsMatchIn("android:fillColor=\"#fff\""))
        assertFalse(HEX.containsMatchIn("android:textColor=\"@color/text_primary\""))
        assertFalse(HEX.containsMatchIn("app:boxStrokeColor=\"?attr/colorPrimary\""))
    }

    private companion object {
        val HEX = Regex("#[0-9a-fA-F]{3,8}\\b")
    }
}
