import Charts
import ProfilerBarCore
import SwiftUI

/// One row per API request, the terminal UI's Model → requests drill-down,
/// with the rollups by cause, model and effort above it.
struct ModelTab: View {
    let profile: Profile
    @State private var sortOrder = [KeyPathComparator(\ModelRequest.totalMs, order: .reverse)]
    @State private var grouping: Grouping = .cause

    enum Grouping: String, CaseIterable, Identifiable {
        case cause, model, effort

        var id: String { rawValue }
        var label: String {
            switch self {
            case .cause: "By cause"
            case .model: "By model"
            case .effort: "By effort"
            }
        }
    }

    private var rollups: [ModelRollup] {
        switch grouping {
        case .cause: profile.modelBreakdown.byCause
        case .model: profile.modelBreakdown.byModel
        case .effort: profile.modelBreakdown.byEffort
        }
    }

    var body: some View {
        VSplitView {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Picker("", selection: $grouping) {
                        ForEach(Grouping.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .frame(width: 260)
                    Spacer()
                    if profile.modelBreakdown.suspectMs > 0 {
                        Label(
                            "\(Format.ms(profile.modelBreakdown.suspectMs)) stalled",
                            systemImage: "exclamationmark.triangle"
                        )
                        .font(.system(size: 11))
                        .foregroundStyle(.orange)
                        .help("Requests that produced tokens far below this session's median rate, or failed outright.")
                    }
                }

                let total = max(1, profile.modelBreakdown.totalMs)
                ForEach(rollups.prefix(6)) { rollup in
                    BarRow(
                        label: rollup.key,
                        value: Format.ms(rollup.ms),
                        fraction: Double(rollup.ms) / Double(total),
                        color: .purple,
                        detail: "\(rollup.requests) req"
                    )
                }
            }
            .padding(16)
            .frame(minHeight: 170)

            Table(profile.modelBreakdown.requests.sorted(using: sortOrder), sortOrder: $sortOrder) {
                TableColumn("#", value: \.index) { Text("\($0.index)").monospacedDigit().foregroundStyle(.secondary) }
                    .width(36)
                TableColumn("Started") { Text($0.at?.clockTime ?? "—").monospacedDigit() }
                    .width(70)
                TableColumn("Total", value: \.totalMs) { Text(Format.ms($0.totalMs)).monospacedDigit() }
                    .width(66)
                TableColumn("1st block", value: \.firstBlockMs) { Text(Format.ms($0.firstBlockMs)).monospacedDigit() }
                    .width(70)
                TableColumn("Out", value: \.outputTokens) { Text(Format.tokens($0.outputTokens)).monospacedDigit() }
                    .width(56)
                TableColumn("Think", value: \.thinkingTokens) {
                    Text(Format.tokens($0.thinkingTokens)).monospacedDigit().foregroundStyle(.secondary)
                }
                .width(56)
                TableColumn("tok/s") { request in
                    Text(request.tokensPerSec.map { String(format: "%.0f", $0) } ?? "—")
                        .monospacedDigit()
                        .foregroundStyle(request.suspect == nil ? Color.primary : Color.orange)
                }
                .width(56)
                TableColumn("Context", value: \.contextTokens) {
                    Text(Format.tokens($0.contextTokens)).monospacedDigit().foregroundStyle(.secondary)
                }
                .width(70)
                TableColumn("Cause") { request in
                    Text(request.cause?.label ?? "—").lineLimit(1).foregroundStyle(.secondary)
                }
            }
            .frame(minHeight: 200)
        }
    }
}
