import AppKit
import ProfilerBarCore
import SwiftUI

struct SessionRow: View {
    let session: LiveSession
    let now: Date
    /// Set for a live session with a known pid: quits its process.
    var release: (() -> Void)?
    /// Brings the chat forward in the editor, terminal or desktop app.
    var goToChat: (() -> Void)?
    /// Set for an ended session this app quit, by the Free button or on its own.
    var released: ReleaseHistory.Record?
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            StateDot(state: session.state).padding(.top, 1)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(session.displayTitle)
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 4)
                    Text(Format.tokens(session.tokens.total))
                        .font(.system(size: 12, weight: .semibold))
                        .monospacedDigit()
                }

                HStack(spacing: 6) {
                    SourceBadge(source: session.source)
                    Text(details).lineLimit(1)
                    Spacer(minLength: 0)
                    if let released {
                        Text(released.summary(now: now))
                            .monospacedDigit()
                            .help(released.explanation)
                    } else if let seen = lastSeen {
                        Text(seen).monospacedDigit()
                    }
                }
                .font(.system(size: 10))
                .foregroundStyle(.secondary)

                if session.state.isLive {
                    HStack(spacing: 8) {
                        Sparkline(values: session.burn, color: session.state == .idle ? .accentColor : session.state.color)
                            // Narrower when the row also carries the action buttons.
                            .frame(width: goToChat == nil ? 90 : 56, height: 16)
                        if let activity = session.activity {
                            ActivityText(activity: activity)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        if let cpu = session.cpuPct, let rss = session.rssMb {
                            // With the Free button the memory figure is on the button itself.
                            Text(release == nil ? "CPU \(Int(cpu.rounded()))% · \(rss) MB" : "CPU \(Int(cpu.rounded()))%")
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                                .fixedSize()
                        }
                        if let goToChat {
                            Button(action: goToChat) { Text("Go to Chat").fixedSize() }
                                .buttonStyle(DefaultPushButtonStyle(prominent: false))
                                .help("Switch to this chat in VS Code, the terminal or the Claude app")
                        }
                        if let release {
                            Button(action: release) {
                                Text(session.rssMb.map { "Free \($0) MB" } ?? "Free Memory")
                                    .monospacedDigit()
                                    .fixedSize()
                            }
                            .buttonStyle(DefaultPushButtonStyle())
                            .help("Quit this chat's Claude Code process to free its memory. The chat is kept: continue it with claude --resume (right-click → Copy Resume Command).")
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(hovering ? Color.primary.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }

    private var details: String {
        var parts: [String] = []
        if let project = session.projectName, project != session.displayTitle { parts.append(project) }
        if let model = session.model { parts.append(Format.model(model)) }
        if let context = session.contextTokens { parts.append("ctx \(Format.tokens(context))") }
        if let cost = session.costUsd { parts.append(Format.usd(cost)) }
        return parts.joined(separator: " · ")
    }

    private var lastSeen: String? {
        guard session.state != .busy, session.state != .waiting, let last = session.lastActivityAt else { return nil }
        return Format.duration(seconds: now.timeIntervalSince1970 - last / 1_000) + " ago"
    }
}

/// A small macOS default push button — accent fill with the system's soft
/// top highlight, hairline edge and drop shadow. Drawn by hand because the
/// system `.borderedProminent` turns grey in an inactive window, and the menu
/// bar popover is often not the key window.
private struct DefaultPushButtonStyle: ButtonStyle {
    /// Accent-filled like a default button, or the plain secondary kind.
    var prominent = true

    func makeBody(configuration: Configuration) -> some View {
        PushButton(configuration: configuration, prominent: prominent)
    }

    /// A view of its own, because hover is state and a style has none.
    private struct PushButton: View {
        let configuration: ButtonStyleConfiguration
        let prominent: Bool
        @State private var hovering = false
        @Environment(\.colorScheme) private var colorScheme

        private var fill: Color {
            if prominent { return .accentColor }
            return colorScheme == .dark ? Color(white: 0.42) : .white
        }

        var body: some View {
            let shape = RoundedRectangle(cornerRadius: 5, style: .continuous)
            configuration.label
                .font(.system(size: 11))
                .foregroundStyle(prominent || colorScheme == .dark ? Color.white : Color.primary)
                .padding(.horizontal, 9)
                .frame(height: 19)
                .background {
                    shape.fill(fill)
                    shape.fill(LinearGradient(
                        colors: [.white.opacity(hovering ? 0.28 : 0.17), .white.opacity(hovering ? 0.08 : 0)],
                        startPoint: .top,
                        endPoint: .bottom
                    ))
                    if !prominent, hovering { shape.fill(Color.primary.opacity(0.05)) }
                    if configuration.isPressed { shape.fill(.black.opacity(0.15)) }
                }
                .overlay(shape.strokeBorder(.black.opacity(prominent ? 0.12 : 0.2), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.18), radius: 0.75, y: 0.5)
                .contentShape(shape)
                .animation(.easeOut(duration: 0.12), value: hovering)
                .onHover { inside in
                    guard inside != hovering else { return }
                    hovering = inside
                    if inside { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                }
                // The row can vanish under the pointer (the session ends), and
                // then no hover-out arrives to undo the push.
                .onDisappear { if hovering { NSCursor.pop() } }
        }
    }
}

extension ReleaseHistory.Record {
    /// "Freed 412 MB" or "Auto-freed 412 MB".
    var title: String {
        let verb = trigger == .auto ? "Auto-freed" : "Freed"
        return rssMb.map { "\(verb) \($0) MB" } ?? verb
    }

    /// Takes the place of "12m ago" on an ended row.
    func summary(now: Date) -> String {
        "\(trigger == .auto ? "auto-freed" : "freed") \(Format.duration(seconds: now.timeIntervalSince(at))) ago"
    }

    var explanation: String {
        let how = trigger == .auto
            ? "Freed automatically after sitting idle (Settings → Memory)"
            : "Freed with the Free button"
        let memory = rssMb.map { ", \($0) MB" } ?? ""
        return "\(how)\(memory). The chat is kept: continue it with claude --resume."
    }
}
