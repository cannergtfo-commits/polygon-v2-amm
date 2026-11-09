package net.blazarforce.wallet

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import kotlin.math.max
import kotlin.math.min

@Composable
fun CandleChart(candles: List<Candle>, modifier: Modifier = Modifier) {
    Canvas(modifier.fillMaxWidth().height(220.dp)) {
        if (candles.isEmpty()) return@Canvas
        val low = candles.minOf { it.low }
        val high = candles.maxOf { it.high }
        val span = (high - low).takeIf { it > 0 } ?: 1e-9
        val slot = size.width / candles.size
        candles.forEachIndexed { index, candle ->
            val x = index * slot + slot / 2f
            fun y(value: Double) = size.height - ((value - low) / span * size.height).toFloat()
            val up = candle.close >= candle.open
            val color = if (up) Color(0xFF3EFFB1) else Color(0xFFFF5D7A)
            drawLine(color, Offset(x, y(candle.high)), Offset(x, y(candle.low)), 2f)
            val top = min(y(candle.open), y(candle.close))
            val bottom = max(y(candle.open), y(candle.close))
            drawRect(color, Offset(x - slot * 0.28f, top), Size(slot * 0.56f, (bottom - top).coerceAtLeast(1f)))
        }
    }
}
