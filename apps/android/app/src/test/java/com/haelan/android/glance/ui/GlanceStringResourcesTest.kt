package com.haelan.android.glance.ui

import com.haelan.android.R
import com.haelan.android.glance.format.DUTCH_TEXT
import com.haelan.android.glance.format.ENGLISH_TEXT
import org.junit.Assert.assertEquals
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/**
 * The glance's words on a phone are the web's words. GlanceText holds the English and Dutch
 * sentences checked against the web's i18n files; this holds the two resource files to that text,
 * key for key, and the lookup map to the resources, so neither can drift from what was verified.
 */
class GlanceStringResourcesTest {

    /** The module's res directory, found as NoRawColorTest finds it; not finding it is a failure. */
    private val res: File = generateSequence(File("").absoluteFile) { it.parentFile }
        .map { File(it, "src/main/res") }
        .firstOrNull { it.isDirectory }
        ?: error("src/main/res was not found above ${File("").absolutePath}")

    /** Every `<string>` in [file], its text as `getString` returns it. */
    private fun strings(file: File): Map<String, String> {
        val document = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
        val nodes = document.getElementsByTagName("string")
        return (0 until nodes.length).map { nodes.item(it) as Element }.associate { it.getAttribute("name") to unescape(it.textContent) }
    }

    @Test
    fun `every English sentence is in values, word for word`() {
        assertMatches(ENGLISH_TEXT, strings(File(res, "values/strings.xml")))
    }

    @Test
    fun `every Dutch sentence is in values-nl, word for word`() {
        assertMatches(DUTCH_TEXT, strings(File(res, "values-nl/strings.xml")))
    }

    private fun assertMatches(expected: Map<String, String>, actual: Map<String, String>) {
        val wrong = expected.filter { (key, text) -> actual[key] != text }.map { (key, text) -> "$key: expected <$text>, found <${actual[key]}>" }
        assertEquals(emptyList<String>(), wrong)
    }

    @Test
    fun `every sentence has its resource in the lookup, and the resource of its own name`() {
        val wrong = ENGLISH_TEXT.keys.filter { key ->
            val id = runCatching { R.string::class.java.getField(key).getInt(null) }.getOrNull()
            id == null || GLANCE_STRING_IDS[key] != id
        }
        assertEquals(emptyList<String>(), wrong)
    }

    @Test
    fun `the unescaping reads what Android reads`() {
        assertEquals("Today's activities", unescape("Today\\'s activities"))
        assertEquals("a \"b\" \\ c", unescape("a \\\"b\\\" \\\\ c"))
        assertEquals("@home", unescape("\\@home"))
    }

    private companion object {
        /** Android's string-resource escapes: a backslash before a quote, a backslash, an at or a question mark. */
        fun unescape(raw: String): String {
            val out = StringBuilder()
            var i = 0
            while (i < raw.length) {
                val c = raw[i]
                if (c == '\\' && i + 1 < raw.length) {
                    out.append(
                        when (val next = raw[i + 1]) {
                            'n' -> '\n'
                            't' -> '\t'
                            else -> next
                        },
                    )
                    i += 2
                } else {
                    out.append(c)
                    i++
                }
            }
            return out.toString()
        }
    }
}
