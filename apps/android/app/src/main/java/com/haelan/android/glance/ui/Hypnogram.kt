package com.haelan.android.glance.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import com.haelan.android.glance.GlanceNightSegment
import com.haelan.android.glance.geometry.HypnoStage
import com.haelan.android.glance.geometry.HypnogramLayout
import com.haelan.android.glance.geometry.hypnogramLayout

/**
 * The night card's compact hypnogram, drawn from [hypnogramLayout]: a block per staged stretch on
 * its stage's row, awake at the top and deep at the bottom, then the one faint line of totals. The
 * totals line is also the chart's description, as the web's stage totals are its accessible text:
 * the blocks carry nothing a reader of the totals does not already have, bar their order.
 */
@Composable
internal fun Hypnogram(segments: List<GlanceNightSegment>, startMs: Long, text: CardText, modifier: Modifier = Modifier) {
    val colors = LocalGlanceColors.current
    // The totals do not depend on the width the blocks are laid across.
    val totals = remember(segments, startMs) { hypnogramLayout(segments, startMs, 1f).totals }
    val totalsLine = text.words.stageTotalsLine(totals)
    Column(modifier.clearAndSetSemantics { contentDescription = totalsLine }, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Canvas(Modifier.fillMaxWidth().height(96.dp)) {
            val layout = hypnogramLayout(segments, startMs, size.width)
            val rowHeight = size.height / HypnogramLayout.ROWS
            val blockHeight = rowHeight * HypnogramLayout.BLOCK_SHARE
            layout.blocks.forEach { block ->
                val color = when (block.stage) {
                    HypnoStage.AWAKE -> colors.stageAwake
                    HypnoStage.REM -> colors.stageRem
                    HypnoStage.LIGHT -> colors.stageLight
                    HypnoStage.DEEP -> colors.stageDeep
                }
                drawRect(
                    color = color,
                    topLeft = Offset(block.left, block.stage.row * rowHeight + (rowHeight - blockHeight) / 2),
                    size = Size(block.right - block.left, blockHeight),
                )
            }
        }
        Text(totalsLine, style = MaterialTheme.typography.bodySmall, color = colors.textMuted)
    }
}
