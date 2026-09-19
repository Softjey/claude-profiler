import AppKit
import ProfilerBarCore
import SwiftUI

@main
struct ClaudeProfilerBarApp: App {
    @State private var store = LiveStore()

    init() {
        if PreviewRenderer.runIfRequested() { exit(0) }
        // A menu bar app: no Dock icon, no app menu. The bundled app gets this
        // from LSUIElement; `swift run` needs it set by hand.
        NSApplication.shared.setActivationPolicy(.accessory)
    }

    var body: some Scene {
        MenuBarExtra {
            PopoverView()
                .environment(store)
        } label: {
            MenuBarLabel(snapshot: store.snapshot, failed: store.status.isFailed)
                .task { store.start() }
        }
        .menuBarExtraStyle(.window)

        WindowGroup("Session", id: "session", for: String.self) { $sessionId in
            if let sessionId {
                SessionDetailView(sessionId: sessionId)
                    .environment(store)
            }
        }
        .defaultSize(width: 560, height: 560)

        Settings {
            SettingsView()
                .environment(store)
        }
    }
}

private extension LiveStore.Status {
    var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }
}

struct MenuBarLabel: View {
    let snapshot: LiveSnapshot?
    let failed: Bool
    @AppStorage("menuBarStyle") private var style = MenuBarStyle.tokensAndCount

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: symbol)
            if let text { Text(text).monospacedDigit() }
        }
    }

    private var symbol: String {
        guard !failed, let snapshot else { return failed ? "exclamationmark.triangle" : "sparkle" }
        if snapshot.waitingCount > 0 { return "hand.raised.fill" }
        if snapshot.busyCount > 0 { return "sparkles" }
        return "sparkle"
    }

    private var text: String? {
        guard let snapshot else { return nil }
        let working = snapshot.busyCount + snapshot.waitingCount
        let tokens = Format.tokens(snapshot.today.tokens)
        switch style {
        case .tokensAndCount: return working > 0 ? "\(working) · \(tokens)" : tokens
        case .tokens: return tokens
        case .count: return working > 0 ? "\(working)" : nil
        case .iconOnly: return nil
        }
    }
}
