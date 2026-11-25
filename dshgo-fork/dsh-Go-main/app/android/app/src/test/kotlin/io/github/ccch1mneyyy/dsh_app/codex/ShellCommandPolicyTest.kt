package io.github.ccch1mneyyy.dsh_app.codex

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShellCommandPolicyTest {
    @Test fun acceptsOneDocumentedCommandWithoutAShell() {
        assertEquals(listOf("pm", "list", "packages"), ShellCommandPolicy.parse("pm list packages"))
        assertEquals(listOf("getprop", "ro.build.version.release"), ShellCommandPolicy.parse("getprop ro.build.version.release"))
        assertEquals("'pm' 'list' 'packages'", ShellCommandPolicy.suCommand(listOf("pm", "list", "packages")))
    }

    @Test fun rejectsShellCompositionAndArbitraryFamilies() {
        val denied = listOf(
            "pm list packages | head", "pm list packages;id", "pm list packages && id",
            "pm list packages > /sdcard/x", "echo `id`", "pm list $(id)",
            "sh -c id", "id", "pm list \"packages\"", "pm list packages\nid",
        )
        for (command in denied) {
            val error = runCatching { ShellCommandPolicy.parse(command) }.exceptionOrNull()
            assertTrue("must reject $command", error is DeviceError)
            assertEquals("args/invalid", (error as DeviceError).code)
        }
    }

    @Test fun rootRequiresActualUidZeroSuccess() {
        assertTrue(ShellCommandPolicy.isRootIdentity(0, "uid=0(root) gid=0(root)"))
        assertFalse(ShellCommandPolicy.isRootIdentity(1, "uid=0(root)"))
        assertFalse(ShellCommandPolicy.isRootIdentity(0, "uid=2000(shell)"))
        assertFalse(ShellCommandPolicy.isRootIdentity(0, ""))
    }

    @Test fun outputIsBoundedAndReportsTruncation() {
        val capture = BoundedCapture(4)
        capture.readFrom("abcdefgh".byteInputStream())
        assertEquals("abcd", capture.text())
        assertTrue(capture.truncated)
    }
}
