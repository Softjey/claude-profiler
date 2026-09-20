import ProfilerBarCore
import SwiftUI

extension SessionState {
    var color: Color {
        switch self {
        case .waiting: .orange
        case .busy: .green
        case .idle: .secondary
        case .ended, .unknown: .secondary.opacity(0.5)
        }
    }

    var label: String {
        switch self {
        case .waiting: "needs approval"
        case .busy: "working"
        case .idle: "idle"
        case .ended: "ended"
        case .unknown: "—"
        }
    }
}

extension SessionSource {
    var label: String {
        switch self {
        case .cli: "CLI"
        case .vscode: "VS Code"
        case .desktop: "Desktop"
        case .sdk: "SDK"
        case .other: "Other"
        }
    }

    var symbol: String {
        switch self {
        case .cli: "terminal"
        case .vscode: "chevron.left.forwardslash.chevron.right"
        case .desktop: "macwindow"
        case .sdk: "shippingbox"
        case .other: "questionmark.circle"
        }
    }
}

/// Status dot; a working session pulses so the eye finds it in the list.
struct StateDot: View {
    let state: SessionState
    @State private var pulse = false

    var body: some View {
        ZStack {
            if state == .busy || state == .waiting {
                Circle()
                    .fill(state.color.opacity(0.35))
                    .frame(width: 14, height: 14)
                    .scaleEffect(pulse ? 1.0 : 0.5)
                    .opacity(pulse ? 0 : 1)
                    .animation(.easeOut(duration: 1.4).repeatForever(autoreverses: false), value: pulse)
            }
            if state == .ended {
                Circle().strokeBorder(state.color, lineWidth: 1.5).frame(width: 8, height: 8)
            } else {
                Circle().fill(state.color).frame(width: 8, height: 8)
            }
        }
        .frame(width: 14, height: 14)
        .onAppear { pulse = true }
        .help(state.label)
    }
}

struct SourceBadge: View {
    let source: SessionSource

    var body: some View {
        Label(source.label, systemImage: source.symbol)
            .labelStyle(.titleAndIcon)
            .font(.system(size: 10, weight: .medium))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.quaternary, in: Capsule())
            .foregroundStyle(.secondary)
    }
}

/// Tokens per minute as a filled line, scaled to its own peak.
struct Sparkline: View {
    let values: [Int]
    var color: Color = .accentColor

    var body: some View {
        Canvas { context, size in
            guard values.count > 1, let peak = values.max(), peak > 0 else {
                var baseline = Path()
                baseline.move(to: CGPoint(x: 0, y: size.height - 0.5))
                baseline.addLine(to: CGPoint(x: size.width, y: size.height - 0.5))
                context.stroke(baseline, with: .color(.secondary.opacity(0.3)), lineWidth: 1)
                return
            }
            let step = size.width / CGFloat(values.count - 1)
            let points = values.enumerated().map { index, value in
                CGPoint(x: CGFloat(index) * step, y: size.height - CGFloat(value) / CGFloat(peak) * (size.height - 1))
            }
            var line = Path()
            line.addLines(points)
            var area = line
            area.addLine(to: CGPoint(x: size.width, y: size.height))
            area.addLine(to: CGPoint(x: 0, y: size.height))
            area.closeSubpath()
            context.fill(area, with: .color(color.opacity(0.18)))
            context.stroke(line, with: .color(color), lineWidth: 1.2)
        }
    }
}

/// "Bash · 42s", ticking every second while the tool runs.
struct ActivityText: View {
    let activity: LiveActivity

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let elapsed = context.date.timeIntervalSince1970 - activity.since / 1_000
            HStack(spacing: 3) {
                Image(systemName: activity.kind == .permission ? "hand.raised.fill" : "gearshape.fill")
                Text("\(activity.tool) · \(Format.duration(seconds: elapsed))")
                    .monospacedDigit()
            }
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(activity.kind == .permission ? Color.orange : Color.secondary)
        }
    }
}

struct Metric: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.system(size: 10)).foregroundStyle(.secondary)
            Text(value).font(.system(size: 13, weight: .semibold)).monospacedDigit()
        }
    }
}
