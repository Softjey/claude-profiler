import ProfilerBarCore
import SwiftUI

/// Each subagent this session spawned, with its own time split and tools —
/// what the terminal UI opens when you drill into a Task call.
struct SubagentsTab: View {
    let profile: Profile

    var body: some View {
        if profile.subagents.isEmpty {
            EmptyTabNote(symbol: "person.2.slash", text: "This session spawned no subagents")
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    ForEach(profile.subagents) { subagent in
                        Panel(
                            title: subagent.agentId,
                            note: "\(Format.ms(subagent.spanMs)) · \(Format.tokens(subagent.tokens.totals.total)) tokens"
                        ) {
                            TimeSplitBar(split: subagent.timeline)
                            if !subagent.tools.isEmpty {
                                let peak = max(1, subagent.tools.map(\.totalMs).max() ?? 1)
                                ForEach(subagent.tools.prefix(6)) { tool in
                                    BarRow(
                                        label: tool.name,
                                        value: Format.ms(tool.totalMs),
                                        fraction: Double(tool.totalMs) / Double(peak),
                                        color: .teal,
                                        detail: "\(tool.calls)×"
                                    )
                                }
                            }
                        }
                    }
                }
                .padding(20)
            }
        }
    }
}
