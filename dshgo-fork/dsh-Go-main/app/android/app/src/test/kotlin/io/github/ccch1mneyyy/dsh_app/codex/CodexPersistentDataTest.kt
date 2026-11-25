package io.github.ccch1mneyyy.dsh_app.codex

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CodexPersistentDataTest {
    @Test
    fun upgradeMovesExistingHomeAndWorkspaceOutsideRootfs() {
        val base = java.nio.file.Files.createTempDirectory("codex-home-migration").toFile()
        try {
            val root = File(base, "rootfs")
            val legacyHome = File(root, "root/.codex").apply { mkdirs() }
            val legacyWorkspace = File(root, "root/workspace").apply { mkdirs() }
            File(legacyHome, "sessions/old.jsonl").apply { parentFile.mkdirs(); writeText("history") }
            File(legacyWorkspace, "project.txt").writeText("kept")
            val home = File(base, "home")
            val workspace = File(base, "workspace")

            CodexPersistentData.migrate(root, home, workspace)

            assertEquals("history", File(home, "sessions/old.jsonl").readText())
            assertEquals("kept", File(workspace, "project.txt").readText())
            assertFalse(legacyHome.exists())
            assertFalse(legacyWorkspace.exists())
        } finally {
            base.deleteRecursively()
        }
    }

    @Test
    fun existingPersistentDataIsNeverOverwrittenByAnotherRootfs() {
        val base = java.nio.file.Files.createTempDirectory("codex-home-existing").toFile()
        try {
            val root = File(base, "rootfs")
            val home = File(base, "home").apply { mkdirs() }
            val workspace = File(base, "workspace").apply { mkdirs() }
            File(home, "config.toml").writeText("current")
            File(root, "root/.codex").apply { mkdirs() }.resolve("config.toml").writeText("old")

            CodexPersistentData.migrate(root, home, workspace)

            assertEquals("current", File(home, "config.toml").readText())
            assertTrue(File(root, "root/.codex/config.toml").isFile)
        } finally {
            base.deleteRecursively()
        }
    }
}
