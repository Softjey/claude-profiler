import Charts
import ProfilerBarCore
import SwiftUI

struct SessionDetailView: View {
    let sessionId: String
    @Environment(LiveStore.self) private var store

    var body: some View {
        Group {
            if let session = store.session(id: sessionId) {
                content(session)
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "questionmark.circle").font(.system(size: 28)).foregroundStyle(.tertiary)
                    Text("This session is no longer in today's list.").foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(minWidth: 520, minHeight: 440)
        .onAppear { store.beginWatching() }
        .onDisappear { store.endWatching() }
    }

    private func content(_ session: LiveSession) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header(session)
                metrics(session)
                burnChart(session)
                tokenBreakdown(session.tokens)
                actions(session)
            }
            .padding(20)
        }
        .navigationTitle(session.displayTitle)
    }

    private func header(_ session: LiveSession) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                StateDot(state: session.state)
                Text(session.state.label.capitalized).foregroundStyle(session.state.color)
                SourceBadge(source: session.source)
                if let activity = session.activity { ActivityText(activity: activity) }
            }
            .font(.system(size: 12, weight: .medium))
            Text(session.displayTitle).font(.title2.bold()).lineLimit(2)
            if let cwd = session.cwd {
                Text(cwd).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
    }

    private func metrics(_ session: LiveSession) -> some View {
        Grid(alignment: .leading, horizontalSpacing: 28, verticalSpacing: 12) {
            GridRow {
                Metric(label: "Tokens (session)", value: Format.tokens(session.tokens.total))
                Metric(label: "Tokens (today)", value: Format.tokens(session.tokensToday))
                Metric(label: "Context", value: session.contextTokens.map(Format.tokens) ?? "—")
                Metric(label: "Cost", value: session.costUsd.map(Format.usd) ?? "—")
            }
            GridRow {
                Metric(label: "Model", value: session.model.map(Format.model) ?? "—")
                Metric(label: "Subagents", value: "\(session.subagents)")
                Metric(label: "CPU", value: session.cpuPct.map { "\(Int($0.rounded()))%" } ?? "—")
                Metric(label: "Memory", value: session.rssMb.map { "\($0) MB" } ?? "—")
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
    }

    private func burnChart(_ session: LiveSession) -> some View {
        let count = session.burn.count
        return VStack(alignment: .leading, spacing: 8) {
            Text("Tokens per minute · last \(count) min").font(.headline)
            Chart(Array(session.burn.enumerated()), id: \.offset) { index, value in
                BarMark(x: .value("Minutes ago", index - count + 1), y: .value("Tokens", value))
                    .foregroundStyle(Color.accentColor.gradient)
            }
            .chartXAxis {
                AxisMarks(values: .stride(by: 5)) { value in
                    AxisGridLine()
                    AxisValueLabel { if let minutes = value.as(Int.self) { Text(minutes == 0 ? "now" : "\(minutes)m") } }
                }
            }
            .chartYAxis {
                AxisMarks { value in
                    AxisGridLine()
                    AxisValueLabel { if let tokens = value.as(Int.self) { Text(Format.tokens(tokens)) } }
                }
            }
            .frame(height: 140)
        }
    }

    private func tokenBreakdown(_ tokens: LiveTokens) -> some View {
        let parts: [(String, Int)] = [
            ("Cache read", tokens.cacheRead),
            ("Cache write", tokens.cacheCreate),
            ("Input", tokens.input),
            ("Output", tokens.output),
        ]
        return VStack(alignment: .leading, spacing: 8) {
            Text("Where the tokens went").font(.headline)
            Chart(parts, id: \.0) { name, value in
                BarMark(x: .value("Tokens", value), y: .value("Kind", name))
                    .foregroundStyle(by: .value("Kind", name))
                    .annotation(position: .trailing) {
                        Text(Format.tokens(value)).font(.system(size: 10)).foregroundStyle(.secondary)
                    }
            }
            .chartLegend(.hidden)
            .chartXAxis(.hidden)
            .frame(height: 120)
        }
    }

    private func actions(_ session: LiveSession) -> some View {
        HStack {
            Button("Open in Profiler", systemImage: "chart.bar.doc.horizontal") { Actions.openInProfiler(session) }
                .buttonStyle(.borderedProminent)
            Button("Reveal Transcript", systemImage: "doc.text.magnifyingglass") { Actions.revealTranscript(session) }
                .disabled(session.transcriptPath == nil)
            Button("Copy ID", systemImage: "doc.on.doc") { Actions.copy(session.id) }
        }
    }
}
