import Foundation

/// How to start `claude-profiler live`, in order of preference.
public enum CollectorCommand: Equatable, Sendable {
    /// `CPROF_LIVE` from the environment, run through `/bin/sh` — for
    /// development, e.g. `CPROF_LIVE="node ../dist/live/main.js"`.
    case override(String)
    /// The single executable `scripts/bundle.sh` puts in the app bundle.
    case bundled(URL)
    /// A globally installed `claude-profiler`, found through the user's
    /// interactive login shell: an app launched from Finder does not inherit
    /// the PATH nvm, fnm or Homebrew set up in `.zshrc`.
    case loginShell

    public static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        bundle: Bundle = .main
    ) -> CollectorCommand {
        if let command = environment["CPROF_LIVE"], !command.isEmpty { return .override(command) }
        if let url = bundle.url(forResource: "cprof-live", withExtension: nil) { return .bundled(url) }
        return .loginShell
    }

    var executable: URL {
        switch self {
        case .override: URL(fileURLWithPath: "/bin/sh")
        case .bundled(let url): url
        case .loginShell: URL(fileURLWithPath: "/bin/zsh")
        }
    }

    func arguments(once: Bool = false) -> [String] {
        let flag = once ? " --once" : ""
        switch self {
        case .override(let command): return ["-c", "exec \(command)\(flag)"]
        case .bundled: return once ? ["--once"] : []
        case .loginShell: return ["-l", "-i", "-c", "exec claude-profiler live\(flag)"]
        }
    }

    public var description: String {
        switch self {
        case .override(let command): command
        case .bundled(let url): url.path
        case .loginShell: "claude-profiler live (login shell)"
        }
    }
}

/// Runs the collector as a child process and hands every decoded message to
/// `onMessage` on the main queue. The collector exits when its stdin closes,
/// so it never outlives this app, even after a crash.
public final class CollectorProcess {
    public var onMessage: ((LiveMessage) -> Void)?
    /// Exit status and the tail of stderr, for a "collector failed" message.
    public var onExit: ((Int32, String) -> Void)?

    private let command: CollectorCommand
    private var process: Process?
    private var stdin: FileHandle?
    private var buffer = LineBuffer()
    private var stderrTail = ""

    public init(command: CollectorCommand) {
        self.command = command
    }

    /// Runs the collector for a single snapshot and waits for it.
    public static func collectOnce(command: CollectorCommand) throws -> LiveMessage? {
        let process = Process()
        process.executableURL = command.executable
        process.arguments = command.arguments(once: true)
        let stdout = Pipe()
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = stdout.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        var buffer = LineBuffer()
        return buffer.append(data + Data("\n".utf8)).lazy.compactMap(LiveMessage.decode).first
    }

    public var isRunning: Bool { process?.isRunning ?? false }

    public func start() throws {
        let process = Process()
        process.executableURL = command.executable
        process.arguments = command.arguments()

        let stdout = Pipe()
        let stderr = Pipe()
        let stdin = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        process.standardInput = stdin

        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            DispatchQueue.main.async { self?.receive(chunk) }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let text = String(decoding: handle.availableData, as: UTF8.self)
            DispatchQueue.main.async {
                guard let self else { return }
                self.stderrTail = String((self.stderrTail + text).suffix(2_000))
            }
        }
        process.terminationHandler = { [weak self] finished in
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                guard let self else { return }
                self.onExit?(finished.terminationStatus, self.stderrTail)
            }
        }

        try process.run()
        self.process = process
        self.stdin = stdin.fileHandleForWriting
        buffer = LineBuffer()
        stderrTail = ""
    }

    public func stop() {
        try? stdin?.close()
        process?.terminate()
        process = nil
        stdin = nil
    }

    /// Polling interval; the collector clamps it to 250 ms … 60 s.
    public func setRate(milliseconds: Int) {
        send(#"{"cmd":"rate","ms":\#(milliseconds)}"#)
    }

    public func refresh() {
        send(#"{"cmd":"refresh"}"#)
    }

    private func send(_ line: String) {
        guard let stdin, isRunning else { return }
        try? stdin.write(contentsOf: Data((line + "\n").utf8))
    }

    private func receive(_ chunk: Data) {
        guard !chunk.isEmpty else { return }
        for line in buffer.append(chunk) {
            if let message = LiveMessage.decode(line) { onMessage?(message) }
        }
    }
}
