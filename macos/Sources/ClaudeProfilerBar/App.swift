import AppKit
import ProfilerBarCore
import SwiftUI

/// The app is a menu bar item, but macOS hides menu bar items when the bar
/// is full and gives no sign that it did. This delegate keeps a way in: the
/// session window opens on first launch, and again whenever the app is
/// "opened" while already running (`open -a "Claude Profiler"`, Spotlight).
final class AppDelegate: NSObject, NSApplicationDelegate {
    private static let firstRunKey = "didShowSessionsWindowOnFirstRun"

    func applicationDidFinishLaunching(_ notification: Notification) {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: Self.firstRunKey) else { return }
        defaults.set(true, forKey: Self.firstRunKey)
        // The scene tree has to exist before a window can open into it.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            LiveStore.shared.openSessionsWindow()
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        LiveStore.shared.openSessionsWindow()
        return true
    }
}

@main
struct ClaudeProfilerBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    private var store: LiveStore { .shared }

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

        Window("Claude Sessions", id: "sessions") {
            PopoverView(chrome: .window)
                .environment(store)
        }
        .defaultSize(width: 440, height: 600)

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
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: symbol)
            if let text { Text(text).monospacedDigit() }
        }
        // The label is the one view that is always rendered, so this is where
        // the store picks up SwiftUI's window opener for the AppKit delegate.
        .onAppear {
            LiveStore.shared.bindWindowOpener { id, value in
                if let value {
                    openWindow(id: id, value: value)
                } else {
                    openWindow(id: id)
                }
            }
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
