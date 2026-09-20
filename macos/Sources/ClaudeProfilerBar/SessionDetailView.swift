import ProfilerBarCore
import SwiftUI

/// One session in full: the live header from the snapshot stream, and below
/// it the same tabs the terminal UI has, rendered from the same profile
/// artifact the CLI builds.
struct SessionDetailView: View {
    let sessionId: String
    /// Set by `--render-png --tab <name>` so a screenshot can pick a tab.
    var initialTab: Tab = .overview
    @Environment(LiveStore.self) private var store
    @State private var tab: Tab?

    enum Tab: String, CaseIterable, Identifiable {
        case overview, tools, model, timeline, context, hooks, subagents

        var id: String { rawValue }

        var label: String {
            switch self {
            case .overview: "Overview"
            case .tools: "Tools"
            case .model: "Model"
            case .timeline: "Timeline"
            case .context: "Context"
            case .hooks: "Hooks"
            case .subagents: "Subagents"
            }
        }

        var symbol: String {
            switch self {
            case .overview: "chart.pie"
            case .tools: "wrench.and.screwdriver"
            case .model: "brain"
            case .timeline: "list.bullet.indent"
            case .context: "chart.xyaxis.line"
            case .hooks: "bolt"
            case .subagents: "person.2"
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            body(for: store.profiles[sessionId])
        }
        .frame(minWidth: 720, minHeight: 520)
        .navigationTitle(store.session(id: sessionId)?.displayTitle ?? "Session")
        .onAppear {
            store.beginWatching()
            store.beginProfile(id: sessionId)
        }
        .onDisappear {
            store.endWatching()
            store.endProfile(id: sessionId)
        }
    }

    // MARK: Header

    @ViewBuilder
    private var header: some View {
        let live = store.session(id: sessionId)
        let profile = loadedProfile

        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                if let live {
                    StateDot(state: live.state)
                    Text(live.state.label.capitalized).foregroundStyle(live.state.color)
                    SourceBadge(source: live.source)
                    if let activity = live.activity { ActivityText(activity: activity) }
                }
                Spacer()
                Button {
                    store.reloadProfile(id: sessionId)
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Rebuild the profile now")
                if let live {
                    Button("Open in Profiler", systemImage: "terminal") { Actions.openInProfiler(live) }
                        .buttonStyle(.borderless)
                    Button("Reveal", systemImage: "doc.text.magnifyingglass") { Actions.revealTranscript(live) }
                        .buttonStyle(.borderless)
                        .disabled(live.transcriptPath == nil)
                }
            }
            .font(.system(size: 12, weight: .medium))

            Text(live?.displayTitle ?? profile?.session.title ?? sessionId)
                .font(.title3.bold())
                .lineLimit(1)

            HStack(spacing: 24) {
                if let profile {
                    KeyValue(label: "Span", value: Format.ms(profile.timeline.spanMs))
                    KeyValue(label: "Turns", value: "\(profile.session.turnCount)")
                    KeyValue(label: "Requests", value: "\(profile.modelBreakdown.requests.count)")
                    KeyValue(label: "Tokens", value: Format.tokens(profile.tokens.totals.total))
                    KeyValue(label: "Cost", value: profile.cost.map { Format.usd($0.totalCostUSD) } ?? "—")
                    KeyValue(label: "Model", value: profile.session.models.map(Format.model).joined(separator: ", "))
                } else if let live {
                    KeyValue(label: "Tokens", value: Format.tokens(live.tokens.total))
                    KeyValue(label: "Context", value: live.contextTokens.map(Format.tokens) ?? "—")
                }
                if let live, live.state.isLive {
                    KeyValue(label: "CPU", value: live.cpuPct.map { "\(Int($0.rounded()))%" } ?? "—")
                    KeyValue(label: "Memory", value: live.rssMb.map { "\($0) MB" } ?? "—")
                }
                Spacer()
            }

            Picker("", selection: Binding(get: { tab ?? initialTab }, set: { tab = $0 })) {
                ForEach(Tab.allCases) { tab in
                    Label(tab.label, systemImage: tab.symbol).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
        .padding(16)
    }

    private var loadedProfile: Profile? {
        if case .loaded(let profile) = store.profiles[sessionId] { return profile }
        return nil
    }

    // MARK: Tabs

    @ViewBuilder
    private func body(for state: LiveStore.ProfileState?) -> some View {
        switch state {
        case .loaded(let profile):
            switch tab ?? initialTab {
            case .overview: OverviewTab(profile: profile)
            case .tools: ToolsTab(profile: profile)
            case .model: ModelTab(profile: profile)
            case .timeline: TimelineTab(profile: profile)
            case .context: ContextTab(profile: profile)
            case .hooks: HooksTab(profile: profile)
            case .subagents: SubagentsTab(profile: profile)
            }
        case .failed(let message):
            EmptyTabNote(symbol: "exclamationmark.triangle", text: message)
        default:
            VStack(spacing: 10) {
                ProgressView()
                Text("Building the profile…").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
