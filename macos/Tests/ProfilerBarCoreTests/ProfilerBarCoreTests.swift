import Foundation
import Testing
@testable import ProfilerBarCore

private let snapshotLine = #"""
{"v":1,"type":"snapshot","at":1789853284750,"hooksInstalled":true,
 "today":{"tokens":157,"sessions":2,"costUsd":0.5},
 "sessions":[
  {"id":"live-1","title":"Fix the thing","cwd":"/Users/me/app","source":"vscode","state":"waiting",
   "pid":100,"startedAt":1,"lastActivityAt":2,"model":"claude-opus-5",
   "tokens":{"input":5,"output":60,"cacheRead":85,"cacheCreate":0},"tokensToday":150,
   "contextTokens":90,"costUsd":null,"subagents":1,"cpuPct":15,"rssMb":300,
   "activity":{"kind":"permission","tool":"Bash","since":3},"burn":[0,100,50],
   "transcriptPath":"/x.jsonl","somethingNew":true},
  {"id":"done-1","title":null,"cwd":null,"source":"jetbrains","state":"hibernating",
   "pid":null,"startedAt":null,"lastActivityAt":null,"model":null,
   "tokens":{"input":0,"output":7,"cacheRead":0,"cacheCreate":0},"tokensToday":7,
   "contextTokens":null,"costUsd":0.5,"subagents":0,"cpuPct":null,"rssMb":null,
   "activity":null,"burn":[],"transcriptPath":null}
 ]}
"""#.replacingOccurrences(of: "\n", with: "")

@Test func decodesASnapshotAndToleratesUnknownValues() throws {
    let message = try #require(LiveMessage.decode(Data(snapshotLine.utf8)))
    guard case .snapshot(let snapshot) = message else {
        Issue.record("expected a snapshot")
        return
    }
    #expect(snapshot.today.tokens == 157)
    #expect(snapshot.waitingCount == 1)
    #expect(snapshot.liveCount == 1)

    let live = snapshot.sessions[0]
    #expect(live.source == .vscode)
    #expect(live.activity == LiveActivity(kind: .permission, tool: "Bash", since: 3))
    #expect(live.tokens.total == 150)
    #expect(live.displayTitle == "Fix the thing")

    let done = snapshot.sessions[1]
    #expect(done.source == .other)
    #expect(done.state == .unknown)
    #expect(done.displayTitle == "done-1")
}

@Test func decodesErrorsAndIgnoresNoise() {
    #expect(LiveMessage.decode(Data(#"{"v":1,"type":"error","at":1,"message":"boom"}"#.utf8)) == .error("boom"))
    #expect(LiveMessage.decode(Data("Welcome to zsh".utf8)) == nil)
    #expect(LiveMessage.decode(Data(#"{"v":2,"type":"snapshot"}"#.utf8)) == nil)
}

@Test func lineBufferHoldsPartialLines() {
    var buffer = LineBuffer()
    #expect(buffer.append(Data("a\nb".utf8)) == [Data("a".utf8)])
    #expect(buffer.append(Data("c\n\nd".utf8)) == [Data("bc".utf8)])
    #expect(buffer.append(Data("\n".utf8)) == [Data("d".utf8)])
}

@Test func formatsTokens() {
    #expect(Format.tokens(950) == "950")
    #expect(Format.tokens(4_321) == "4.3k")
    #expect(Format.tokens(88_295) == "88k")
    #expect(Format.tokens(1_576_617) == "1.6M")
    #expect(Format.tokens(49_013_786) == "49M")
}

@Test func formatsDurations() {
    #expect(Format.duration(seconds: 42) == "42s")
    #expect(Format.duration(seconds: 185) == "3m")
    #expect(Format.duration(seconds: 3_900) == "1h 5m")
    #expect(Format.duration(seconds: 7_200) == "2h")
    #expect(Format.duration(seconds: 140_520) == "1d 15h")
    #expect(Format.duration(seconds: 172_800) == "2d")
}

@Test func formatsMillisecondsBytesAndPercent() {
    #expect(Format.ms(240) == "240ms")
    #expect(Format.ms(3_542) == "3.5s")
    #expect(Format.ms(12_345) == "12s")
    #expect(Format.ms(75_000) == "1m 15s")
    #expect(Format.ms(80_000) == "1m 20s")
    #expect(Format.ms(3_661_000) == "1h 1m")
    #expect(Format.ms(3_900_000) == "1h 5m")
    #expect(Format.ms(7_200_000) == "2h")
    #expect(Format.ms(42_000) == "42s")
    #expect(Format.ms(120_000) == "2m")
    #expect(Format.bytes(820) == "820 B")
    #expect(Format.bytes(819_043) == "800 KiB")
    #expect(Format.bytes(5_400_000) == "5.1 MiB")
    #expect(Format.bytes(nil) == "—")
    #expect(Format.rate(0.2) == "0.2")
    #expect(Format.rate(9.4) == "9.4")
    #expect(Format.rate(118.34) == "118")
    #expect(Format.rate(nil) == "—")
    #expect(Format.percent(ratio: 0.424) == "42%")
    #expect(Format.percent(ratio: 0.0042) == "0.4%")
    #expect(Format.percent(ratio: 0.0197) == "2.0%")
    #expect(Format.percent(ratio: 0) == "0.0%")
}

/// The twin of `formatUsd` in src/tui/format.test.ts.
@Test func formatsMoney() {
    #expect(Format.usd(85.194) == "$85.19")
    #expect(Format.usd(0) == "$0.00")
    #expect(Format.usd(0.0042) == "$0.0042")
    #expect(Format.usd(nil) == "—")
}

/// The twin of `formatDateTime` / `formatClock`, in the machine's own zone —
/// the same instant is built locally so the assertion holds in any TZ.
@Test func formatsTimestampsInLocalTime() {
    var components = DateComponents()
    components.year = 2026
    components.month = 1
    components.day = 2
    components.hour = 21
    components.minute = 16
    components.second = 5
    let date = try! #require(Calendar.current.date(from: components))
    let iso = ISO8601DateFormatter.parser.string(from: date)

    #expect(Format.dateTime(iso) == "2026-01-02 21:16")
    #expect(Format.clock(iso) == "21:16:05")
    #expect(Format.dateTime(nil) == "—")
    #expect(Format.clock("not a timestamp") == "—")
    // A timestamp without milliseconds still parses.
    #expect(Format.clock(ISO8601DateFormatter.plainParser.string(from: date)) == "21:16:05")
}

@Test func formatsModels() {
    #expect(Format.model("claude-opus-5") == "Opus 5")
    #expect(Format.model("claude-sonnet-4-5-20250929") == "Sonnet 4.5")
    #expect(Format.model("claude-opus-5[1m]") == "Opus 5")
    #expect(Format.model("claude-haiku-4-5-20251001") == "Haiku 4.5")
}

@Test func resolvesTheCollectorCommand() {
    #expect(CollectorCommand.resolve(environment: ["CPROF_LIVE": "node x.js"]) == .override("node x.js"))
    #expect(CollectorCommand.resolve(environment: [:]) == .loginShell)
}

/// Smoke test against a profile from a real session, the Swift side of
/// `test/corpus.test.ts`: point `CPROF_PROFILE_JSON` at the output of
/// `claude-profiler <session> --json --out <path>`. Skipped when unset, as
/// in CI.
@Test func decodesARealProfileArtifact() throws {
    guard let path = ProcessInfo.processInfo.environment["CPROF_PROFILE_JSON"], !path.isEmpty else { return }
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    let profile = try JSONDecoder().decode(Profile.self, from: data)
    #expect(profile.schemaVersion == "0.2")
    #expect(profile.timeline.spanMs > 0)
    #expect(!profile.session.sessionId.isEmpty)
    // Written on every artifact, so a nil here means the field was renamed or
    // dropped on the TypeScript side and this app stopped seeing it.
    #expect(profile.diagnostics != nil)

    // The sections the app renders from `hooks`. They are optional because a
    // session may carry none, but if the artifact has them they must decode —
    // silently reading as nil is how the Hooks tab lost six panels before.
    if let hooks = profile.hooks {
        #expect(hooks.sidecarVersion != nil)
        if let subagents = hooks.subagents {
            #expect(subagents.allSatisfy { !$0.subagentId.isEmpty })
        }
        if let instructions = hooks.instructions {
            #expect(instructions.totalLoads >= instructions.files.count)
        }
    }

    // Every request carries the detail pane's fields.
    for request in profile.modelBreakdown.requests.prefix(10) {
        #expect(!request.key.isEmpty)
        #expect(request.totalMs >= 0)
    }
}

@Test func releaseOnlyMatchesTheSessionThatOwnsThePid() {
    let registry = Data(#"{"pid":42,"sessionId":"abc","startedAt":1792330904333}"#.utf8)
    let start = Date(timeIntervalSince1970: 1_792_330_904.1)
    #expect(SessionRelease.registryMatches(registry, sessionId: "abc", processStart: start))
    #expect(!SessionRelease.registryMatches(registry, sessionId: "other", processStart: start))
    // A recycled pid: the process started long after the registry entry.
    #expect(!SessionRelease.registryMatches(registry, sessionId: "abc", processStart: start.addingTimeInterval(3_600)))
    #expect(!SessionRelease.registryMatches(Data(#"{"sessionId":"abc"}"#.utf8), sessionId: "abc", processStart: start))
    #expect(!SessionRelease.registryMatches(Data("not json".utf8), sessionId: "abc", processStart: start))
}

@Test func readsTheStartTimeOfARunningProcess() throws {
    let start = try #require(SessionRelease.processStart(pid: getpid()))
    #expect(start <= Date())
    #expect(Date().timeIntervalSince(start) < 3_600)
}

@Test func locatesAChatByItsFrontEndAndHostApp() {
    let code = ChatLocation.Host(pid: 10, bundleId: "com.microsoft.VSCode", bundlePath: "/Applications/Visual Studio Code.app")
    let terminal = ChatLocation.Host(pid: 20, bundleId: "com.apple.Terminal", bundlePath: "/System/Applications/Utilities/Terminal.app")
    let ghostty = ChatLocation.Host(pid: 30, bundleId: "com.mitchellh.ghostty", bundlePath: "/Applications/Ghostty.app")

    #expect(ChatLocation.resolve(source: .desktop, sessionId: "s", cwd: "/p", host: nil, tty: nil) == .desktop(sessionId: "s"))
    #expect(ChatLocation.resolve(source: .vscode, sessionId: "s", cwd: "/p", host: code, tty: nil)
        == .editor(appPath: code.bundlePath, scheme: "vscode", folder: "/p", sessionId: "s"))
    // A CLI session in the editor's own terminal goes to the editor window.
    #expect(ChatLocation.resolve(source: .cli, sessionId: "s", cwd: "/p", host: code, tty: "/dev/ttys001")
        == .editor(appPath: code.bundlePath, scheme: "vscode", folder: "/p", sessionId: "s"))
    #expect(ChatLocation.resolve(source: .cli, sessionId: "s", cwd: "/p", host: terminal, tty: "/dev/ttys001")
        == .terminalTab(bundleId: "com.apple.Terminal", tty: "/dev/ttys001"))
    #expect(ChatLocation.resolve(source: .cli, sessionId: "s", cwd: "/p", host: ghostty, tty: "/dev/ttys001") == .app(pid: 30))
    #expect(ChatLocation.resolve(source: .cli, sessionId: "s", cwd: "/p", host: nil, tty: nil)
        == .resumeInTerminal(sessionId: "s", cwd: "/p"))
    #expect(ChatLocation.resolve(source: .sdk, sessionId: "s", cwd: nil, host: nil, tty: nil) == nil)
}

@Test func buildsTheDeepLinks() {
    #expect(ChatLocation.editorURL(scheme: "cursor", sessionId: "abc")?.absoluteString == "cursor://anthropic.claude-code/open?session=abc")
    #expect(ChatLocation.desktopURL(sessionId: "abc")?.absoluteString == "claude://code/continue?session=abc")
    #expect(ChatLocation.selectTabScript(bundleId: "com.apple.Terminal", tty: "/dev/ttys001")?.contains(#"tty of t is "/dev/ttys001""#) == true)
    #expect(ChatLocation.selectTabScript(bundleId: "com.mitchellh.ghostty", tty: "/dev/ttys001") == nil)
}

@Test func walksTheProcessTree() {
    let me = getpid()
    let chain = ChatLocation.ancestry(of: me)
    #expect(chain.first == me)
    #expect(chain.count >= 2)
    #expect(ChatLocation.parent(of: me) == getppid())
}

private func liveSnapshot(_ sessionJSONs: [String]) throws -> LiveSnapshot {
    let line = #"{"v":1,"type":"snapshot","at":1,"hooksInstalled":true,"today":{"tokens":0,"sessions":0,"costUsd":null},"sessions":["#
        + sessionJSONs.joined(separator: ",") + "]}"
    guard case .snapshot(let snapshot) = try #require(LiveMessage.decode(Data(line.utf8))) else {
        throw CocoaError(.coderReadCorrupt)
    }
    return snapshot
}

private func sessionJSON(
    id: String = "s",
    state: String = "idle",
    source: String = "cli",
    pid: Int = 100,
    cpu: Double? = 0.3,
    rss: Int? = 800
) -> String {
    let cpu = cpu.map { "\($0)" } ?? "null"
    let rss = rss.map { "\($0)" } ?? "null"
    return #"{"id":"\#(id)","title":null,"cwd":null,"source":"\#(source)","state":"\#(state)","pid":\#(pid),"#
        + #""startedAt":1,"lastActivityAt":1,"model":null,"tokens":{"input":0,"output":0,"cacheRead":0,"cacheCreate":0},"#
        + #""tokensToday":0,"contextTokens":null,"costUsd":null,"subagents":0,"cpuPct":\#(cpu),"rssMb":\#(rss),"#
        + #""activity":null,"burn":[],"transcriptPath":null}"#
}

private let hourPolicy = AutoReleaser.Policy(minimumIdleDuration: 3_600, minimumRssMb: 500, scope: .cli)
private let releaseStart = Date(timeIntervalSince1970: 1_000_000)

/// Feeds `snapshot` every `step` seconds from `from` up to, not including, `to`.
private func feed(
    _ releaser: inout AutoReleaser,
    _ snapshot: LiveSnapshot,
    from: TimeInterval,
    to: TimeInterval,
    step: TimeInterval = 5,
    watched: Set<String> = []
) -> [String] {
    var released: [String] = []
    for offset in stride(from: from, to: to, by: step) {
        released += releaser.sessionsToRelease(
            in: snapshot, policy: hourPolicy, watched: watched, now: releaseStart.addingTimeInterval(offset)
        ).map(\.id)
    }
    return released
}

@Test func autoReleaserReleasesASessionOnceItHasBeenIdleLongEnough() throws {
    var releaser = AutoReleaser()
    let idle = try liveSnapshot([sessionJSON()])

    #expect(releaser.sessionsToRelease(in: idle, policy: hourPolicy, now: releaseStart).isEmpty)
    #expect(releaser.sessionsToRelease(in: idle, policy: hourPolicy, now: releaseStart.addingTimeInterval(3_599)).isEmpty)
    #expect(releaser.sessionsToRelease(in: idle, policy: hourPolicy, now: releaseStart.addingTimeInterval(3_600)).map(\.id) == ["s"])
    // Handed out once: a release that failed is not retried every snapshot.
    #expect(releaser.sessionsToRelease(in: idle, policy: hourPolicy, now: releaseStart.addingTimeInterval(4_000)).isEmpty)
}

@Test func autoReleaserRestartsTheIdleClockWhenTheSessionWorks() throws {
    var releaser = AutoReleaser()
    let idle = try liveSnapshot([sessionJSON()])

    _ = releaser.sessionsToRelease(in: idle, policy: hourPolicy, now: releaseStart)
    _ = releaser.sessionsToRelease(in: try liveSnapshot([sessionJSON(state: "busy")]), policy: hourPolicy, now: releaseStart.addingTimeInterval(1_800))
    #expect(releaser.sessionsToRelease(in: idle, policy: hourPolicy, now: releaseStart.addingTimeInterval(1_805)).isEmpty)
    #expect(releaser.sessionsToRelease(in: idle, policy: hourPolicy, now: releaseStart.addingTimeInterval(5_404)).isEmpty)
    #expect(releaser.sessionsToRelease(in: idle, policy: hourPolicy, now: releaseStart.addingTimeInterval(5_405)).map(\.id) == ["s"])
}

@Test func autoReleaserKeepsASessionUnderLoadEvenThroughItsDips() throws {
    var releaser = AutoReleaser()
    let building = try liveSnapshot([sessionJSON(cpu: 60)])
    let waitingOnDisk = try liveSnapshot([sessionJSON(cpu: 1)])

    // A build that waits on disk every other sample still averages well over the threshold.
    var released: [String] = []
    for offset in stride(from: 0.0, to: 7_200, by: 10) {
        released += feed(&releaser, building, from: offset, to: offset + 5)
        released += feed(&releaser, waitingOnDisk, from: offset + 5, to: offset + 10)
    }
    #expect(released.isEmpty)
    // Once it stops, the hour starts from the last loaded minute.
    #expect(feed(&releaser, waitingOnDisk, from: 7_200, to: 10_700).isEmpty)
    #expect(feed(&releaser, waitingOnDisk, from: 10_700, to: 10_900) == ["s"])
}

@Test func autoReleaserShrugsOffAnIdleSessionsCpuSpikes() throws {
    var releaser = AutoReleaser()
    let idle = try liveSnapshot([sessionJSON()])
    let spike = try liveSnapshot([sessionJSON(cpu: 30)])

    // A 30% sample once a minute, the way an idle prompt's MCP servers do.
    var released: [String] = []
    for offset in stride(from: 0.0, to: 3_660, by: 60) {
        released += feed(&releaser, spike, from: offset, to: offset + 5)
        released += feed(&releaser, idle, from: offset + 5, to: offset + 60)
    }
    #expect(released == ["s"])
}

@Test func autoReleaserCountsIdleTimeEvenWhileOff() throws {
    var releaser = AutoReleaser()
    let idle = try liveSnapshot([sessionJSON()])

    #expect(releaser.sessionsToRelease(in: idle, policy: nil, now: releaseStart).isEmpty)
    #expect(releaser.sessionsToRelease(in: idle, policy: nil, now: releaseStart.addingTimeInterval(7_200)).isEmpty)
    #expect(releaser.sessionsToRelease(in: idle, policy: hourPolicy, now: releaseStart.addingTimeInterval(7_201)).map(\.id) == ["s"])
}

@Test func autoReleaserSurvivesAMissedCpuSample() throws {
    var releaser = AutoReleaser()
    let idle = try liveSnapshot([sessionJSON()])
    let unmeasured = try liveSnapshot([sessionJSON(cpu: nil)])

    _ = releaser.sessionsToRelease(in: idle, policy: hourPolicy, now: releaseStart)
    // No figure, no release — but the clock keeps running.
    #expect(releaser.sessionsToRelease(in: unmeasured, policy: hourPolicy, now: releaseStart.addingTimeInterval(3_600)).isEmpty)
    #expect(releaser.sessionsToRelease(in: idle, policy: hourPolicy, now: releaseStart.addingTimeInterval(3_605)).map(\.id) == ["s"])
}

@Test func autoReleaserCountsAnOpenWindowAsActivity() throws {
    var releaser = AutoReleaser()
    let idle = try liveSnapshot([sessionJSON()])

    #expect(feed(&releaser, idle, from: 0, to: 7_200, watched: ["s"]).isEmpty)
    // The window closed after the 7_195 s sample: the hour starts there, not when the session went idle.
    #expect(feed(&releaser, idle, from: 7_200, to: 10_795).isEmpty)
    #expect(feed(&releaser, idle, from: 10_795, to: 10_800) == ["s"])
}

@Test func autoReleaserSkipsWhatShouldStay() throws {
    var releaser = AutoReleaser()
    let sessions = try liveSnapshot([
        sessionJSON(id: "small", rss: 499),
        sessionJSON(id: "edge", pid: 105, rss: 500),
        sessionJSON(id: "unmeasured", cpu: nil, rss: nil),
        sessionJSON(id: "editor", source: "vscode", pid: 101),
        sessionJSON(id: "waiting", state: "waiting", pid: 103),
        sessionJSON(id: "big", pid: 104),
    ])

    _ = releaser.sessionsToRelease(in: sessions, policy: hourPolicy, now: releaseStart)
    #expect(releaser.sessionsToRelease(in: sessions, policy: hourPolicy, now: releaseStart.addingTimeInterval(3_600)).map(\.id) == ["edge", "big"])

    var anySource = AutoReleaser()
    let all = AutoReleaser.Policy(minimumIdleDuration: 3_600, minimumRssMb: 500, scope: .all)
    _ = anySource.sessionsToRelease(in: sessions, policy: all, now: releaseStart)
    #expect(anySource.sessionsToRelease(in: sessions, policy: all, now: releaseStart.addingTimeInterval(3_600)).map(\.id) == ["edge", "editor", "big"])
}

@Test func autoReleaserTreatsAResumedSessionAsNew() throws {
    var releaser = AutoReleaser()

    _ = releaser.sessionsToRelease(in: try liveSnapshot([sessionJSON(pid: 100)]), policy: hourPolicy, now: releaseStart)
    #expect(releaser.sessionsToRelease(in: try liveSnapshot([sessionJSON(pid: 100)]), policy: hourPolicy, now: releaseStart.addingTimeInterval(3_600)).count == 1)
    // `claude --resume` brings the same id back in a new process.
    let resumed = try liveSnapshot([sessionJSON(pid: 200)])
    #expect(releaser.sessionsToRelease(in: resumed, policy: hourPolicy, now: releaseStart.addingTimeInterval(4_000)).isEmpty)
    #expect(releaser.sessionsToRelease(in: resumed, policy: hourPolicy, now: releaseStart.addingTimeInterval(7_600)).count == 1)
}

@Test func releaseHistoryExplainsAnEndedSessionUntilItIsResumedAndUsed() throws {
    let releasedAt = Date(timeIntervalSince1970: 1_000_000)
    var history = ReleaseHistory()
    history.add(.init(trigger: .auto, at: releasedAt, rssMb: 412), sessionId: "s")

    func ended(lastActivityAt seconds: TimeInterval) throws -> LiveSession {
        let json = sessionJSON(state: "ended").replacingOccurrences(of: #""lastActivityAt":1"#, with: #""lastActivityAt":\#(seconds * 1_000)"#)
        return try #require(liveSnapshot([json]).sessions.first)
    }

    #expect(history.record(for: try ended(lastActivityAt: 996_400))?.trigger == .auto)
    // What Claude Code writes as it exits is part of the release.
    #expect(history.record(for: try ended(lastActivityAt: 1_000_030)) != nil)
    // Resumed and used since: the mark no longer explains how it ended.
    #expect(history.record(for: try ended(lastActivityAt: 1_003_600)) == nil)
    // A running session shows its live state, not the old release.
    #expect(history.record(for: try #require(liveSnapshot([sessionJSON()]).sessions.first)) == nil)
}

@Test func releaseHistoryKeepsADayAndSurvivesARoundTrip() throws {
    let now = Date(timeIntervalSince1970: 1_000_000)
    var history = ReleaseHistory()
    history.add(.init(trigger: .manual, at: now.addingTimeInterval(-90_000), rssMb: nil), sessionId: "old")
    history.add(.init(trigger: .manual, at: now.addingTimeInterval(-60), rssMb: 300), sessionId: "s")

    let decoded = try JSONDecoder().decode(ReleaseHistory.self, from: JSONEncoder().encode(history.pruned(now: now)))
    let ended = try #require(liveSnapshot([sessionJSON(state: "ended")]).sessions.first)
    let old = try #require(liveSnapshot([sessionJSON(id: "old", state: "ended")]).sessions.first)
    #expect(decoded.record(for: ended) == .init(trigger: .manual, at: now.addingTimeInterval(-60), rssMb: 300))
    #expect(decoded.record(for: old) == nil)
}
