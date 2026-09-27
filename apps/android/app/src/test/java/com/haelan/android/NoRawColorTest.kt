package com.haelan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The palette has one definition, in `packages/tokens`, and no
 * resource or Kotlin source in this app states a colour of its own. The counterpart of the web's
 * `apps/web/test/no-raw-color.test.ts`, including the part that makes the guard honest: a check
 * that only knows about one spelling of a colour advertises more than it does.
 */
class NoRawColorTest {

    /**
     * Walks up from the working directory to find `module`, the module root that both source
     * trees hang off. A test that looked in the wrong place and found nothing would pass while
     * checking nothing, which is the failure this refuses: not finding the directory is an
     * error, not an empty result.
     */
    private fun moduleDir(marker: String): File =
        generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, marker) }
            .firstOrNull { it.isDirectory }
            ?: error("$marker was not found above ${File("").absolutePath}")

    private val res: File = moduleDir("src/main/res")
    private val javaSrc: File = moduleDir("src/main/java")

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
    fun `no Kotlin source states a colour of its own`() {
        val offenders = javaSrc.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .filter { rawColorMatchIn(it.readText()) }
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

    /**
     * The positive control for the Kotlin scan: a temp `.kt` file containing a raw colour
     * construction is written under `javaSrc` and must be caught, so a scanner that silently
     * matched nothing (wrong extension filter, wrong regex, wrong directory) fails loudly here
     * instead of passing the test above by finding no files at all.
     */
    @Test
    fun `the Kotlin scan catches a raw colour construction`() {
        val probe = File(javaSrc, "NoRawColorProbe_${System.nanoTime()}.kt")
        try {
            probe.writeText(
                """
                package com.haelan.android.probe
                import androidx.compose.ui.graphics.Color
                val probe = Color(0xFF112233)
                """.trimIndent(),
            )
            assertTrue(
                "the scan did not flag a raw Color(0x...) construction",
                rawColorMatchIn(probe.readText()),
            )
        } finally {
            probe.delete()
        }
    }

    private fun rawColorMatchIn(text: String): Boolean =
        HEX.containsMatchIn(text) || KOTLIN_COLOR_CALL.containsMatchIn(text)

    private companion object {
        val HEX = Regex("#[0-9a-fA-F]{3,8}\\b")

        // `Color(0x...)`, `Color.rgb(`, `Color.argb(` and `parseColor(` are the ways Kotlin
        // states a colour without a hex literal in a string; a hex literal inside a string (as in
        // `Color.parseColor("#4F8FF7")`) is still caught by HEX above.
        val KOTLIN_COLOR_CALL = Regex("""Color\(0x|Color\.rgb\(|Color\.argb\(|parseColor\(""")
    }
}
