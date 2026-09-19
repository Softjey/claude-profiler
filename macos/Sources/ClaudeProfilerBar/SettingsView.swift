import ServiceManagement
import SwiftUI

enum MenuBarStyle: String, CaseIterable, Identifiable {
    case tokensAndCount, tokens, count, iconOnly

    var id: String { rawValue }

    var label: String {
        switch self {
        case .tokensAndCount: "Working sessions + today's tokens"
        case .tokens: "Today's tokens"
        case .count: "Working sessions"
        case .iconOnly: "Icon only"
        }
    }
}

struct SettingsView: View {
    @AppStorage("menuBarStyle") private var menuBarStyle = MenuBarStyle.tokensAndCount
    @AppStorage(SettingsKey.notifyFinished) private var notifyFinished = true
    @AppStorage(SettingsKey.notifyPermission) private var notifyPermission = true
    @AppStorage(SettingsKey.finishedThresholdSeconds) private var finishedThreshold = 60.0
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled
    @State private var loginError: String?
    @Environment(LiveStore.self) private var store

    var body: some View {
        Form {
            Section("Menu bar") {
                Picker("Show", selection: $menuBarStyle) {
                    ForEach(MenuBarStyle.allCases) { Text($0.label).tag($0) }
                }
            }

            Section("Notifications") {
                Toggle("When Claude needs approval", isOn: $notifyPermission)
                Toggle("When Claude finishes a long run", isOn: $notifyFinished)
                if notifyFinished {
                    Picker("Long run means at least", selection: $finishedThreshold) {
                        Text("30 seconds").tag(30.0)
                        Text("1 minute").tag(60.0)
                        Text("5 minutes").tag(300.0)
                    }
                }
                Text("Approval alerts need the profiler hooks: npx claude-profiler install-hooks")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("General") {
                Toggle("Launch at login", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { _, enabled in setLaunchAtLogin(enabled) }
                if let loginError {
                    Text(loginError).font(.caption).foregroundStyle(.red)
                }
                LabeledContent("Collector", value: store.command.description)
                    .font(.caption)
            }
        }
        .formStyle(.grouped)
        .frame(width: 440)
        .fixedSize()
    }

    private func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            loginError = nil
        } catch {
            loginError = "Only works for the bundled app (scripts/bundle.sh): \(error.localizedDescription)"
            launchAtLogin = SMAppService.mainApp.status == .enabled
        }
    }
}
