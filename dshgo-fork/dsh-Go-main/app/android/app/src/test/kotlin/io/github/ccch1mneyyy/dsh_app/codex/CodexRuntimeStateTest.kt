package io.github.ccch1mneyyy.dsh_app.codex

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class CodexRuntimeStateTest {
    @Test fun persistedBridgeRequiresAnOwnedLiveProcess() {
        assertEquals("running", CodexRuntimeState.restoredPhase(installed = true, bridgeAlive = true))
        assertEquals("installed", CodexRuntimeState.restoredPhase(installed = true, bridgeAlive = false))
        assertEquals("notInstalled", CodexRuntimeState.restoredPhase(installed = false, bridgeAlive = false))
    }

    @Test fun runtimeEventsDoNotCarryTheLogRing() {
        val status = mapOf<String, Any?>(
            "phase" to "running",
            "token" to "synthetic-token",
            "logs" to listOf("one", "two"),
        )
        val event = CodexRuntimeState.eventSnapshot(status)
        assertEquals("running", event["phase"])
        assertFalse(event.containsKey("logs"))
        assertEquals(listOf("one", "two"), status["logs"])
    }

    @Test fun onlyCompleteGeneratedTokensAreReused() {
        assertEquals(true, CodexRuntimeState.isPersistedTokenUsable("a".repeat(43)))
        assertFalse(CodexRuntimeState.isPersistedTokenUsable("truncated"))
        assertFalse(CodexRuntimeState.isPersistedTokenUsable("invalid!".repeat(8)))
        assertFalse(CodexRuntimeState.isPersistedTokenUsable(null))
    }

    @Test fun expectedLogStreamCloseDoesNotEscapePumpThread() {
        assertFalse(CodexRuntimeState.shouldReportLogStreamFailure(requestedStop = true, ownsProcess = true, processAlive = false))
        assertFalse(CodexRuntimeState.shouldReportLogStreamFailure(requestedStop = false, ownsProcess = false, processAlive = false))
        assertFalse(CodexRuntimeState.shouldReportLogStreamFailure(requestedStop = false, ownsProcess = true, processAlive = false))
        assertEquals(true, CodexRuntimeState.shouldReportLogStreamFailure(requestedStop = false, ownsProcess = true, processAlive = true))
    }
}
