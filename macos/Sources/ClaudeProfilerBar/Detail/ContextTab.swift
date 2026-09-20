import Charts
import ProfilerBarCore
import SwiftUI

/// How the context window filled up over the session, and what each request
/// produced — the terminal UI's Context tab.
struct ContextTab: View {
    let profile: Profile

    private struct Point: Identifiable {
        let id: Int
        let turn: Int
        let context: Int
        let output: Int
        let thinking: Int
    }

    private var points: [Point] {
        profile.context.turns.enumerated().map { index, turn in
            Point(
                id: index,
                turn: turn.turnIndex,
                context: turn.contextTokens,
                output: turn.outputTokens,
                thinking: turn.thinkingTokens
            )
        }
    }

    var body: some View {
        if points.isEmpty {
            EmptyTabNote(symbol: "chart.xyaxis.line", text: "No requests recorded in this session yet")
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Panel(
                        title: "Context per request",
                        note: "input + cache read + cache write — what each request paid to re-read"
                    ) {
                        Chart(points) { point in
                            AreaMark(x: .value("Request", point.id), y: .value("Tokens", point.context))
                                .foregroundStyle(Color.blue.opacity(0.25))
                            LineMark(x: .value("Request", point.id), y: .value("Tokens", point.context))
                                .foregroundStyle(Color.blue)
                        }
                        .chartYAxis { axisMarks }
                        .frame(height: 170)
                    }

                    Panel(title: "Output per request", note: "thinking shown inside output") {
                        Chart(points) { point in
                            BarMark(x: .value("Request", point.id), y: .value("Output", point.output))
                                .foregroundStyle(Color.pink)
                            BarMark(x: .value("Request", point.id), y: .value("Thinking", point.thinking))
                                .foregroundStyle(Color.purple)
                        }
                        .chartYAxis { axisMarks }
                        .frame(height: 140)
                    }

                    Panel(title: "Totals") {
                        let bucket = profile.tokens.totals
                        HStack(spacing: 28) {
                            KeyValue(label: "Cache read", value: Format.tokens(bucket.cacheRead))
                            KeyValue(label: "Cache write", value: Format.tokens(bucket.cacheCreate))
                            KeyValue(label: "Input", value: Format.tokens(bucket.input))
                            KeyValue(label: "Output", value: Format.tokens(bucket.output))
                            KeyValue(label: "Thinking", value: Format.tokens(bucket.thinking))
                            KeyValue(label: "Peak context", value: Format.tokens(points.map(\.context).max() ?? 0))
                        }
                    }
                }
                .padding(20)
            }
        }
    }

    private var axisMarks: some AxisContent {
        AxisMarks { value in
            AxisGridLine()
            AxisValueLabel {
                if let tokens = value.as(Int.self) { Text(Format.tokens(tokens)) }
            }
        }
    }
}
