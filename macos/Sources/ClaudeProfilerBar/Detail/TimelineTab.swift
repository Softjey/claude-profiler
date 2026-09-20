import ProfilerBarCore
import SwiftUI

/// Turn by turn: what you asked, how long the model took on it, how many
/// tools it ran and for how long — the terminal UI's Timeline tab.
struct TimelineTab: View {
    let profile: Profile

    private struct Turn: Identifiable {
        let index: Int
        let at: String?
        let prompt: String
        let modelMs: Double
        let toolCalls: Int
        let toolMs: Double

        var id: Int { index }
    }

    /// Built by grouping requests and tool calls under the prompt that started
    /// their turn — the profile keeps both keyed by `turnIndex`.
    private var turns: [Turn] {
        var modelMs: [Int: Double] = [:]
        for request in profile.modelBreakdown.requests {
            modelMs[request.turnIndex, default: 0] += request.totalMs
        }
        var calls: [Int: (count: Int, ms: Double)] = [:]
        for tool in profile.tools {
            for call in tool.callRefs {
                let current = calls[call.turnIndex] ?? (0, 0)
                calls[call.turnIndex] = (current.count + 1, current.ms + (call.durationMs ?? 0))
            }
        }
        return profile.prompts.map { prompt in
            Turn(
                index: prompt.turnIndex,
                at: prompt.at,
                prompt: prompt.preview,
                modelMs: modelMs[prompt.turnIndex] ?? 0,
                toolCalls: calls[prompt.turnIndex]?.count ?? 0,
                toolMs: calls[prompt.turnIndex]?.ms ?? 0
            )
        }
    }

    var body: some View {
        if turns.isEmpty {
            EmptyTabNote(symbol: "text.append", text: "No prompts recorded in this session yet")
        } else {
            let peak = max(1, turns.map { $0.modelMs + $0.toolMs }.max() ?? 1)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(turns) { turn in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text("#\(turn.index)")
                                    .font(.system(size: 10, weight: .medium))
                                    .foregroundStyle(.tertiary)
                                    .monospacedDigit()
                                Text(turn.at?.clockTime ?? "—")
                                    .font(.system(size: 10))
                                    .foregroundStyle(.secondary)
                                    .monospacedDigit()
                                Text(turn.prompt.isEmpty ? "(no text)" : turn.prompt)
                                    .font(.system(size: 12))
                                    .lineLimit(2)
                                Spacer(minLength: 8)
                                Text("\(turn.toolCalls) tools")
                                    .font(.system(size: 10))
                                    .foregroundStyle(.secondary)
                                    .monospacedDigit()
                            }
                            HStack(spacing: 2) {
                                Rectangle()
                                    .fill(Color.purple)
                                    .frame(width: barWidth(turn.modelMs, peak: peak), height: 6)
                                Rectangle()
                                    .fill(Color.teal)
                                    .frame(width: barWidth(turn.toolMs, peak: peak), height: 6)
                                Text("\(Format.ms(turn.modelMs)) model · \(Format.ms(turn.toolMs)) tools")
                                    .font(.system(size: 10))
                                    .foregroundStyle(.secondary)
                                    .monospacedDigit()
                                    .padding(.leading, 6)
                            }
                        }
                        .padding(.vertical, 8)
                        Divider()
                    }
                }
                .padding(.horizontal, 16)
            }
        }
    }

    private func barWidth(_ ms: Double, peak: Double) -> CGFloat {
        guard ms > 0 else { return 0 }
        return max(2, CGFloat(ms / peak) * 320)
    }
}
