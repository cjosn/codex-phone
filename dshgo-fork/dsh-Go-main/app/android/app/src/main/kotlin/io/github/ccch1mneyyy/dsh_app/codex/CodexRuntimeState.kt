package io.github.ccch1mneyyy.dsh_app.codex

/** Pure state rules shared with JVM tests; process and file I/O stay in CodexRuntime. */
internal object CodexRuntimeState {
    fun restoredPhase(installed: Boolean, bridgeAlive: Boolean): String = when {
        bridgeAlive -> "running"
        installed -> "installed"
        else -> "notInstalled"
    }

    /** Log lines are fetched explicitly; streaming them with every state change rebuilds the whole page. */
    fun eventSnapshot(status: Map<String, Any?>): Map<String, Any?> = status - "logs"

    fun isPersistedTokenUsable(token: String?): Boolean = token?.matches(Regex("[A-Za-z0-9_-]{32,}")) == true

    /** Closing stdout/stderr during process retirement is normal, not an uncaught thread failure. */
    fun shouldReportLogStreamFailure(requestedStop: Boolean, ownsProcess: Boolean, processAlive: Boolean): Boolean =
        !requestedStop && ownsProcess && processAlive
}
