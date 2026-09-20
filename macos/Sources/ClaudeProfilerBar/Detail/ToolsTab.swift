import ProfilerBarCore
import SwiftUI

/// The sortable tool table and, under it, the calls of the selected tool —
/// the terminal UI's Tools → tool → call drill-down, in one view.
struct ToolsTab: View {
    let profile: Profile
    @State private var sortOrder = [KeyPathComparator(\ToolStat.totalMs, order: .reverse)]
    @State private var selection: ToolStat.ID?

    private var tools: [ToolStat] { profile.tools.sorted(using: sortOrder) }

    var body: some View {
        VSplitView {
            Table(tools, selection: $selection, sortOrder: $sortOrder) {
                TableColumn("Tool", value: \.name) { tool in
                    HStack(spacing: 6) {
                        Text(tool.name).lineLimit(1)
                        if tool.kind == "mcp", let server = tool.mcpServer {
                            Text(server).font(.system(size: 9)).foregroundStyle(.secondary)
                        }
                    }
                }
                TableColumn("Calls", value: \.calls) { Text("\($0.calls)").monospacedDigit() }
                    .width(52)
                TableColumn("Total", value: \.totalMs) { Text(Format.ms($0.totalMs)).monospacedDigit() }
                    .width(70)
                TableColumn("Median", value: \.medianMs) { Text(Format.ms($0.medianMs)).monospacedDigit() }
                    .width(70)
                TableColumn("p90", value: \.p90Ms) { Text(Format.ms($0.p90Ms)).monospacedDigit() }
                    .width(70)
                TableColumn("Max", value: \.maxMs) { Text(Format.ms($0.maxMs)).monospacedDigit() }
                    .width(70)
                TableColumn("Share", value: \.pctOfSession) {
                    Text(Format.percent(ratio: $0.pctOfSession)).monospacedDigit().foregroundStyle(.secondary)
                }
                .width(60)
                TableColumn("Failed") { tool in
                    Text(tool.failedCalls.map { "\($0)" } ?? "—")
                        .monospacedDigit()
                        .foregroundStyle((tool.failedCalls ?? 0) > 0 ? .orange : .secondary)
                }
                .width(56)
                TableColumn("Result bytes") { tool in
                    Text(tool.responseBytes.map(Format.bytes) ?? "—")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                .width(90)
            }
            .frame(minHeight: 180)

            callList
                .frame(minHeight: 140)
        }
    }

    @ViewBuilder
    private var callList: some View {
        if let selected = tools.first(where: { $0.id == selection }) {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("\(selected.name) · \(selected.calls) calls").font(.system(size: 11, weight: .semibold))
                    if let approval = selected.approvalMs, approval > 0 {
                        Text("· \(Format.ms(approval)) waiting for you").font(.system(size: 11)).foregroundStyle(.orange)
                    }
                    Spacer()
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)

                if let groups = selected.bashGroups, !groups.isEmpty {
                    List(groups) { group in
                        HStack(spacing: 10) {
                            Text(group.group).font(.system(size: 11, design: .monospaced)).lineLimit(1)
                            Spacer()
                            Text("\(group.calls)×").font(.system(size: 10)).foregroundStyle(.secondary)
                            Text(Format.ms(group.totalMs)).font(.system(size: 11)).monospacedDigit()
                            Text(Format.percent(ratio: group.pctOfBash)).font(.system(size: 10)).foregroundStyle(.tertiary)
                        }
                    }
                } else {
                    List(selected.callRefs.sorted { ($0.durationMs ?? 0) > ($1.durationMs ?? 0) }) { call in
                        HStack(alignment: .top, spacing: 10) {
                            Text(call.startedAt?.clockTime ?? "—")
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                                .frame(width: 60, alignment: .leading)
                            Text(call.inputPreview)
                                .font(.system(size: 11, design: .monospaced))
                                .lineLimit(2)
                            Spacer(minLength: 8)
                            Text(call.durationMs.map(Format.ms) ?? "unfinished")
                                .font(.system(size: 11))
                                .monospacedDigit()
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
        } else {
            EmptyTabNote(symbol: "hand.tap", text: "Select a tool to see its calls")
        }
    }
}
