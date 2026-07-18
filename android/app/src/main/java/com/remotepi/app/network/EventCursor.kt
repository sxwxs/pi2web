package com.remotepi.app.network

enum class SequenceDecision { ACCEPT, DUPLICATE, GAP }

class EventCursor(initial: Long = 0) {
    var value: Long = initial; private set
    @Synchronized fun reset(sequence: Long) { value = sequence }
    @Synchronized fun accept(sequence: Long): SequenceDecision {
        if (sequence <= value) return SequenceDecision.DUPLICATE
        val decision = if (value > 0 && sequence > value + 1) SequenceDecision.GAP else SequenceDecision.ACCEPT
        value = sequence
        return decision
    }
}

object ReconnectPolicy {
    private val seconds = longArrayOf(1, 2, 4, 8, 15, 30)
    fun delaySeconds(attempt: Int): Long = seconds[attempt.coerceIn(0, seconds.lastIndex)]
}
