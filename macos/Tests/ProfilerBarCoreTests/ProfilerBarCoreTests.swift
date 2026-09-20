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
    #expect(Format.ms(80_000) == "1m 20s")
    #expect(Format.ms(3_900_000) == "1h 5m")
    #expect(Format.ms(42_000) == "42s")
    #expect(Format.ms(120_000) == "2m")
    #expect(Format.bytes(820) == "820 B")
    #expect(Format.bytes(819_043) == "800 KB")
    #expect(Format.bytes(5_400_000) == "5.1 MB")
    #expect(Format.percent(ratio: 0.424) == "42%")
    #expect(Format.percent(ratio: 0.0042) == "0.4%")
    #expect(Format.percent(ratio: 0.0197) == "2.0%")
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
}
