import ProfilerBarCore
import SwiftUI

/// The terminal UI's Overview: where the session's wall clock went, then the
/// model's own time and the tools that filled the rest.
struct OverviewTab: View {
    let profile: Profile

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Panel(
                    title: "Where the time went",
                    note: profile.timeline.precision == "exact"
                        ? "exact, from hooks"
                        : "derived from the transcript — Tools includes your approvals"
                ) {
                    TimeSplitBar(split: profile.timeline, idleMs: profile.phases?.idleMs)
                }

                if let phases = profile.phases, !phases.phases.isEmpty {
                    Panel(title: "Resumes", note: "time the session sat closed, taken out of You") {
                        ForEach(Array(phases.phases.enumerated()), id: \.offset) { _, resume in
                            HStack(spacing: 8) {
                                Image(systemName: "arrow.clockwise").foregroundStyle(.secondary)
                                Text(resume.resumedAt.clockTime).monospacedDigit()
                                Text("· idle \(Format.ms(resume.idleMs))").foregroundStyle(.secondary)
                                if let usd = resume.cacheWriteUsd, usd > 0 {
                                    Text("· re-cached for \(Format.usd(usd))").foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                            .font(.system(size: 11))
                        }
                    }
                }

                Panel(title: "Model time", note: modelNote) {
                    let total = max(1, profile.modelBreakdown.totalMs)
                    ForEach(topPhases, id: \.id) { phase in
                        BarRow(
                            label: "\(phase.kind) \(phase.position == "first" ? "(first block)" : "")",
                            value: Format.ms(phase.ms),
                            fraction: phase.ms / total,
                            color: .purple
                        )
                    }
                    if !profile.modelBreakdown.byCause.isEmpty {
                        Divider().padding(.vertical, 4)
                        ForEach(profile.modelBreakdown.byCause.prefix(5)) { cause in
                            BarRow(
                                label: cause.key,
                                value: Format.ms(cause.ms),
                                fraction: cause.ms / total,
                                color: .indigo,
                                detail: "\(cause.requests) req"
                            )
                        }
                    }
                }

                Panel(title: "Tools", note: "\(profile.tools.count) tools · \(profile.tools.reduce(0) { $0 + $1.calls }) calls") {
                    let total = max(1, profile.tools.map(\.totalMs).max() ?? 1)
                    ForEach(profile.tools.prefix(8)) { tool in
                        BarRow(
                            label: tool.name,
                            value: Format.ms(tool.totalMs),
                            fraction: tool.totalMs / total,
                            color: .teal,
                            detail: "\(tool.calls)×"
                        )
                    }
                }

                Panel(title: "Tokens", note: profile.session.models.joined(separator: ", ")) {
                    let bucket = profile.tokens.totals
                    let total = max(1, bucket.total)
                    BarRow(label: "Cache read", value: Format.tokens(bucket.cacheRead), fraction: Double(bucket.cacheRead) / Double(total), color: .blue)
                    BarRow(label: "Cache write", value: Format.tokens(bucket.cacheCreate), fraction: Double(bucket.cacheCreate) / Double(total), color: .green)
                    BarRow(label: "Input", value: Format.tokens(bucket.input), fraction: Double(bucket.input) / Double(total), color: .gray)
                    BarRow(label: "Output", value: Format.tokens(bucket.output), fraction: Double(bucket.output) / Double(total), color: .pink)
                    BarRow(label: "of that, thinking", value: Format.tokens(bucket.thinking), fraction: Double(bucket.thinking) / Double(total), color: .purple)
                }
            }
            .padding(20)
        }
    }

    private var modelNote: String {
        var parts = ["\(profile.modelBreakdown.requests.count) requests"]
        if profile.modelBreakdown.suspectMs > 0 {
            parts.append("\(Format.ms(profile.modelBreakdown.suspectMs)) stalled")
        }
        return parts.joined(separator: " · ")
    }

    private var topPhases: [IdentifiedPhase] {
        profile.modelBreakdown.phases
            .sorted { $0.ms > $1.ms }
            .prefix(5)
            .enumerated()
            .map { IdentifiedPhase(id: $0.offset, phase: $0.element) }
    }

    private struct IdentifiedPhase {
        let id: Int
        let phase: ModelPhase
        var kind: String { phase.kind }
        var position: String { phase.position }
        var ms: Double { phase.ms }
    }
}
