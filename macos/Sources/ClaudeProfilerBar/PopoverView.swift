import AppKit
import ProfilerBarCore
import SwiftUI

struct PopoverView: View {
    enum Chrome {
        case popover
        case window
    }

    var chrome: Chrome = .popover
    @Environment(LiveStore.self) private var store
    @Environment(\.openSettings) private var openSettings
    @AppStorage("earlierCollapsed") private var earlierCollapsed = false

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
            Divider()
            footer
        }
        .frame(width: chrome == .popover ? 400 : nil)
        .frame(minWidth: chrome == .window ? 380 : nil, minHeight: chrome == .window ? 320 : nil)
        .background {
            if chrome == .popover { PopoverWindowFitter(trigger: layoutKey) }
        }
        .onAppear { store.beginWatching() }
        .onDisappear { store.endWatching() }
    }

    /// Changes whenever the amount of content changes, so the window can be refit.
    private var layoutKey: [String] {
        (store.snapshot?.sessions ?? []).map { "\($0.id):\($0.state.isLive)" }
            + [store.snapshot?.hooksInstalled == false ? "hint" : "", "\(earlierCollapsed)", "\(store.snapshot == nil)"]
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Today").font(.system(size: 11)).foregroundStyle(.secondary)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(Format.tokens(store.snapshot?.today.tokens ?? 0))
                        .font(.system(size: 22, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .contentTransition(.numericText())
                    Text("tokens").font(.system(size: 11)).foregroundStyle(.secondary)
                    if let cost = store.snapshot?.today.costUsd {
                        Text("· \(Format.usd(cost)) recorded")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .help("Only sessions that wrote a cost-state record; live sessions have no cost yet.")
                    }
                }
            }
            Spacer()
            if let snapshot = store.snapshot {
                HStack(spacing: 10) {
                    if snapshot.waitingCount > 0 { counter(snapshot.waitingCount, "waiting", .orange) }
                    counter(snapshot.busyCount, "working", .green)
                    counter(snapshot.liveCount - snapshot.busyCount - snapshot.waitingCount, "idle", .secondary)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private func counter(_ value: Int, _ label: String, _ color: Color) -> some View {
        VStack(spacing: 0) {
            Text("\(value)").font(.system(size: 15, weight: .semibold)).foregroundStyle(color).monospacedDigit()
            Text(label).font(.system(size: 9)).foregroundStyle(.secondary)
        }
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        if let snapshot = store.snapshot {
            if snapshot.sessions.isEmpty {
                placeholder(symbol: "moon.zzz", text: "No Claude Code sessions today")
            } else {
                sessionList(snapshot)
            }
        } else {
            switch store.status {
            case .failed(let reason):
                failure(reason)
            default:
                placeholder(symbol: "hourglass", text: "Reading sessions…")
            }
        }
    }

    private func sessionList(_ snapshot: LiveSnapshot) -> some View {
        let live = snapshot.sessions.filter { $0.state.isLive }
        let ended = snapshot.sessions.filter { !$0.state.isLive }
        return ScrollView {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                LazyVStack(alignment: .leading, spacing: 2) {
                    if !snapshot.hooksInstalled { hooksHint }
                    if !live.isEmpty {
                        sectionTitle("Running")
                        // A session that ends moves from one ForEach to the other with the
                        // same identity, and SwiftUI then keeps the row it already built —
                        // an ended session still drawn with its live CPU, memory and burn.
                        // Scoping the id to the section makes it a new view instead.
                        ForEach(live) { row($0, now: context.date).id("live-\($0.id)") }
                    }
                    if !ended.isEmpty {
                        collapsibleTitle("Earlier today", count: ended.count, collapsed: $earlierCollapsed)
                        if !earlierCollapsed {
                            ForEach(ended) { row($0, now: context.date).id("ended-\($0.id)") }
                        }
                    }
                }
                .padding(6)
            }
        }
        .frame(maxHeight: chrome == .popover ? 520 : .infinity)
        .fixedSize(horizontal: false, vertical: chrome == .popover)
    }

    private func row(_ session: LiveSession, now: Date) -> some View {
        SessionRow(
            session: session,
            now: now,
            release: session.state.isLive && session.pid != nil ? { store.release(session) } : nil,
            goToChat: session.state.isLive ? { Actions.goToChat(session) } : nil,
            released: store.releaseHistory.record(for: session)
        )
            .onTapGesture { store.openSessionWindow(id: session.id) }
            .contextMenu {
                Button(session.state.isLive ? "Go to Chat" : "Resume Chat") { Actions.goToChat(session) }
                Button("Open in Profiler") { Actions.openInProfiler(session) }
                Button("Reveal Transcript") { Actions.revealTranscript(session) }
                    .disabled(session.transcriptPath == nil)
                Button("Copy Session ID") { Actions.copy(session.id) }
                Button("Copy Resume Command") { Actions.copy(SessionRelease.resumeCommand(sessionId: session.id)) }
            }
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.tertiary)
            .padding(.horizontal, 10)
            .padding(.top, 8)
            .padding(.bottom, 2)
    }

    private func collapsibleTitle(_ text: String, count: Int, collapsed: Binding<Bool>) -> some View {
        Button {
            collapsed.wrappedValue.toggle()
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 8, weight: .bold))
                    .rotationEffect(.degrees(collapsed.wrappedValue ? 0 : 90))
                Text(text.uppercased())
                if collapsed.wrappedValue { Text("· \(count)") }
                Spacer()
            }
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.tertiary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 10)
        .padding(.top, 8)
        .padding(.bottom, 2)
    }

    private var hooksHint: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "info.circle").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text("Install hooks to see which tool is running and when Claude waits for approval.")
                    .fixedSize(horizontal: false, vertical: true)
                Button("Copy command") { Actions.copy("npx claude-profiler install-hooks") }
                    .buttonStyle(.link)
            }
        }
        .font(.system(size: 11))
        .padding(10)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, 4)
        .padding(.bottom, 4)
    }

    private func placeholder(symbol: String, text: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: symbol).font(.system(size: 24)).foregroundStyle(.tertiary)
            Text(text).font(.system(size: 12)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 36)
    }

    private func failure(_ reason: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("The session collector is not running", systemImage: "exclamationmark.triangle.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.orange)
            Text(reason)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(6)
                .textSelection(.enabled)
            Text("Retrying automatically. Tried: \(store.command.description)")
                .font(.system(size: 10))
                .foregroundStyle(.tertiary)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Footer

    private var footer: some View {
        HStack {
            if let error = store.lastCollectorError {
                Label("Collector error", systemImage: "exclamationmark.triangle")
                    .font(.system(size: 10))
                    .foregroundStyle(.orange)
                    .help(error)
            }
            Spacer()
            Button {
                openSettings()
                NSApp.activate()
            } label: {
                Image(systemName: "gearshape")
            }
            .help("Settings")
            Button {
                NSApp.terminate(nil)
            } label: {
                Image(systemName: "power")
            }
            .help("Quit")
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

/// The `MenuBarExtra` window grows with its content but never shrinks back, so
/// after sections disappear (a new day drops "Earlier today") it stays tall with
/// the content floating in the middle. This refits the window to the content
/// whenever it changes, keeping the top edge pinned under the menu bar.
private struct PopoverWindowFitter: NSViewRepresentable {
    let trigger: [String]

    func makeNSView(context: Context) -> NSView { NSView() }

    func updateNSView(_ view: NSView, context: Context) {
        DispatchQueue.main.async {
            guard let window = view.window, let content = window.contentView else { return }
            let fitted = content.fittingSize
            guard fitted.height > 0, abs(window.contentLayoutRect.height - fitted.height) > 1 else { return }
            var frame = window.frame
            let target = window.frameRect(forContentRect: NSRect(origin: .zero, size: NSSize(width: frame.width, height: fitted.height)))
            frame.origin.y += frame.height - target.height
            frame.size.height = target.height
            window.setFrame(frame, display: true)
        }
    }
}
