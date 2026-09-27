package com.haelan.android.glance.geometry

import com.haelan.android.glance.GlanceNightSegment

// The Last night card's compact hypnogram, as the web's Hypnogram draws it with `compact`
// (apps/web/src/charts/Hypnogram.tsx, fed by NightCard.tsx's hypnogramSegments): stage blocks on
// four rows, x on clock time from bedtime, and one line of stage totals under them.

/** A drawn stage and its row, counted from the top: awake highest, deep lowest. */
enum class HypnoStage(val row: Int) { AWAKE(0), REM(1), LIGHT(2), DEEP(3) }

/** One stage's block, from [left] to [right] across the width it was laid out in. */
data class HypnoBlock(val stage: HypnoStage, val left: Float, val right: Float)

/** A stage's minutes over the night, for the totals line. */
data class StageTotal(val stage: HypnoStage, val minutes: Long)

data class HypnogramLayout(
    val blocks: List<HypnoBlock>,
    /** Deep, light, REM, awake, each only when the night has it; empty for a night never staged. */
    val totals: List<StageTotal>,
) {
    companion object {
        /** How many rows the blocks sit on. */
        const val ROWS = 4

        /** How much of its row a block fills in the compact form. */
        const val BLOCK_SHARE = 0.75f
    }
}

private const val MINUTE_MS = 60_000.0

// The night drawn when it has no staged segment to end on, the web's own 480 minute fallback.
private const val EMPTY_SPAN_MS = 480 * 60_000L

/**
 * The four staged stages by the server's word, or null for anything else. ASLEEP and RESTLESS, the
 * classic unstaged pair, are dropped rather than drawn as light, leaving a gap: a device reporting a
 * value nobody staged is not a stage to guess (apps/web/src/data/nights.ts's stageOf).
 */
fun hypnoStageOf(raw: String): HypnoStage? = when (raw) {
    "DEEP" -> HypnoStage.DEEP
    "LIGHT" -> HypnoStage.LIGHT
    "REM" -> HypnoStage.REM
    "AWAKE" -> HypnoStage.AWAKE
    else -> null
}

/**
 * The night's blocks across [width], x zero at bedtime ([startMs], the night's own start) and the
 * right edge where the last staged segment ends, so a night whose first segment begins after bedtime
 * opens on a gap. The totals are summed in milliseconds and rounded once per stage, never per
 * segment: rounding each boundary and summing invents minutes on the provider's 30 second grid
 * (Hypnogram.tsx's stageTotals, and derive/sleep.ts before it).
 */
fun hypnogramLayout(segments: List<GlanceNightSegment>, startMs: Long, width: Float): HypnogramLayout {
    val staged = segments.mapNotNull { segment -> hypnoStageOf(segment.stage)?.let { it to segment } }
    val spanMs = (staged.lastOrNull()?.second?.endMs?.minus(startMs) ?: EMPTY_SPAN_MS).toFloat()
    val blocks = staged.map { (stage, segment) ->
        HypnoBlock(stage, (segment.startMs - startMs) / spanMs * width, (segment.endMs - startMs) / spanMs * width)
    }
    val msByStage = staged.groupBy({ it.first }, { it.second.endMs - it.second.startMs }).mapValues { it.value.sum() }
    val totals = TOTALS_ORDER.mapNotNull { stage ->
        msByStage[stage]?.let { StageTotal(stage, Math.round(it / MINUTE_MS)) }
    }
    return HypnogramLayout(blocks, totals)
}

// The totals' reading order, deep to awake, not the rows' drawing order.
private val TOTALS_ORDER = listOf(HypnoStage.DEEP, HypnoStage.LIGHT, HypnoStage.REM, HypnoStage.AWAKE)
