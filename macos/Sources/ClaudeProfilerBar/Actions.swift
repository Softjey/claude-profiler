import AppKit
import ProfilerBarCore

enum Actions {
    /// Opens the full terminal profiler for a session. A `.command` file makes
    /// Terminal run it without asking for Automation permission, and the
    /// interactive login shell finds `claude-profiler` wherever nvm put it.
    static func openInProfiler(_ session: LiveSession) {
        let script = """
        #!/bin/zsh -il
        clear
        if command -v claude-profiler >/dev/null 2>&1; then
          claude-profiler \(session.id)
        else
          npx --yes claude-profiler \(session.id)
        fi
        """
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("cprof-\(session.id.prefix(8)).command")
        do {
            try script.write(to: url, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
            NSWorkspace.shared.open(url)
        } catch {
            NSSound.beep()
        }
    }

    static func revealTranscript(_ session: LiveSession) {
        guard let path = session.transcriptPath else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}
