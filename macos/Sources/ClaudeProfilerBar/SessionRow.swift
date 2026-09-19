import ProfilerBarCore
import SwiftUI

struct SessionRow: View {
    let session: LiveSession
    let now: Date
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
                    if let seen = lastSeen {
                        Text(seen).monospacedDigit()
                    }
                }
                .font(.system(size: 10))
                .foregroundStyle(.secondary)

                if session.state.isLive {
                    HStack(spacing: 8) {
                        Sparkline(values: session.burn, color: session.state == .idle ? .accentColor : session.state.color)
                            .frame(width: 90, height: 16)
                        if let activity = session.activity {
                            ActivityText(activity: activity)
                        }
                        Spacer(minLength: 0)
                        if let cpu = session.cpuPct, let rss = session.rssMb {
                            Text("CPU \(Int(cpu.rounded()))% · \(rss) MB")
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
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
