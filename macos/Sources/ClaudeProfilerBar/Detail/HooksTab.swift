import ProfilerBarCore
import SwiftUI

/// What only hooks can measure: your approval time, failed calls, how much
/// tool output went into the context window, and what a resume cost to
/// re-cache — the terminal UI's Hooks tab.
struct HooksTab: View {
    let profile: Profile

    var body: some View {
        if let hooks = profile.hooks {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    approval(hooks.approval)
                    reliability(hooks.reliability)
                    parallelism(hooks.parallelism)
                    pollution(hooks.contextPollution)
                    if let waste = hooks.cacheWaste, (waste.totalUsd ?? 0) > 0 { cacheWaste(waste) }
                    lifecycle(hooks.lifecycle)
                }
                .padding(20)
            }
        } else {
            VStack(spacing: 10) {
                EmptyTabNote(
                    symbol: "bolt.slash",
                    text: "This session ran without the profiler hooks, so approval time,\nfailed calls and result sizes were never recorded."
                )
                Button("Copy install command") { Actions.copy("npx claude-profiler install-hooks") }
                    .buttonStyle(.link)
            }
            .padding(.bottom, 24)
        }
    }

    private func approval(_ approval: HookInsights.Approval) -> some View {
        Panel(
            title: "Approvals",
            note: approval.precision == "split" ? "your decision split from dispatch overhead" : "v1 sidecar: decision and overhead combined"
        ) {
            HStack(spacing: 28) {
                KeyValue(label: "You decided", value: approval.decisionMs.map(Format.ms) ?? "—")
                KeyValue(label: "Harness overhead", value: approval.overheadMs.map(Format.ms) ?? "—")
                KeyValue(label: "Total wait", value: Format.ms(approval.totalWaitMs))
                KeyValue(label: "Prompted", value: "\(approval.promptedCalls)")
                KeyValue(label: "Auto-approved", value: "\(approval.autoApprovedCalls)")
                KeyValue(label: "Denied", value: "\(approval.deniedCalls)")
                KeyValue(label: "Slowest", value: approval.slowestDecisionMs.map(Format.ms) ?? "—")
            }
        }
    }

    private func reliability(_ reliability: HookInsights.Reliability) -> some View {
        Panel(title: "Retry tax", note: "time spent on calls that did not succeed") {
            HStack(spacing: 28) {
                KeyValue(label: "Failed", value: "\(reliability.failedCalls)")
                KeyValue(label: "Interrupted", value: "\(reliability.interruptedCalls)")
                KeyValue(label: "Denied", value: "\(reliability.deniedCalls)")
                KeyValue(label: "Wasted", value: Format.ms(reliability.wastedMs))
            }
            ForEach(reliability.byTool.prefix(6)) { failure in
                HStack(spacing: 8) {
                    Text(failure.name).font(.system(size: 11, weight: .medium)).frame(width: 110, alignment: .leading)
                    Text("\(failure.failedCalls) failed · \(failure.interruptedCalls) interrupted")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                    if let preview = failure.errorPreview, !preview.isEmpty {
                        Text(preview).font(.system(size: 10, design: .monospaced)).foregroundStyle(.tertiary).lineLimit(1)
                    }
                    Spacer()
                    Text(Format.ms(failure.wastedMs)).font(.system(size: 11)).monospacedDigit()
                }
            }
        }
    }

    private func parallelism(_ parallelism: HookInsights.Parallelism) -> some View {
        Panel(title: "Parallel tool calls") {
            HStack(spacing: 28) {
                KeyValue(label: "Batches", value: "\(parallelism.batches)")
                KeyValue(label: "With >1 call", value: "\(parallelism.multiCallBatches)")
                KeyValue(label: "Largest", value: "\(parallelism.largestBatch)")
                KeyValue(label: "Saved", value: parallelism.savedMs.map(Format.ms) ?? "—")
            }
        }
    }

    private func pollution(_ pollution: HookInsights.ContextPollution) -> some View {
        Panel(title: "What filled the context window", note: "tool result bytes") {
            HStack(spacing: 28) {
                KeyValue(label: "Total", value: Format.bytes(pollution.totalBytes))
                KeyValue(label: "Largest single result", value: Format.bytes(pollution.maxBytes))
            }
            let peak = max(1, pollution.byTool.map(\.totalBytes).max() ?? 1)
            ForEach(pollution.byTool.prefix(8)) { tool in
                BarRow(
                    label: tool.name,
                    value: Format.bytes(tool.totalBytes),
                    fraction: Double(tool.totalBytes) / Double(peak),
                    color: .orange,
                    detail: "\(tool.calls)×"
                )
            }
        }
    }

    private func cacheWaste(_ waste: HookInsights.CacheWaste) -> some View {
        Panel(title: "Cache rewrites", note: "what resuming a cold session cost to re-cache") {
            HStack(spacing: 28) {
                KeyValue(label: "After resume", value: waste.resumeUsd.map(Format.usd) ?? "—")
                KeyValue(label: "After model switch", value: waste.modelSwitchUsd.map(Format.usd) ?? "—")
                KeyValue(label: "Total", value: waste.totalUsd.map(Format.usd) ?? "—")
                KeyValue(label: "Resumes", value: "\(waste.resumes)")
            }
        }
    }

    private func lifecycle(_ lifecycle: HookInsights.Lifecycle) -> some View {
        Panel(title: "Session lifecycle", note: "\(Format.ms(lifecycle.idleMs)) closed between runs") {
            ForEach(Array(lifecycle.starts.enumerated()), id: \.offset) { _, start in
                HStack(spacing: 8) {
                    Image(systemName: start.source == "resume" ? "arrow.clockwise" : "power")
                        .foregroundStyle(.secondary)
                    Text(start.at.clockTime).monospacedDigit()
                    Text(start.source).foregroundStyle(.secondary)
                    if let idle = start.idleMs { Text("· idle \(Format.ms(idle))").foregroundStyle(.secondary) }
                    if start.cacheLikelyExpired == true {
                        Text("· cache expired").foregroundStyle(.orange)
                    }
                    Spacer()
                }
                .font(.system(size: 11))
            }
            if let reason = lifecycle.endReason {
                Text("Ended: \(reason)").font(.system(size: 11)).foregroundStyle(.secondary)
            }
        }
    }
}
