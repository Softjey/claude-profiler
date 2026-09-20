import ProfilerBarCore
import SwiftUI

/// A titled block, the unit every detail tab is built from.
struct Panel<Content: View>: View {
    let title: String
    var note: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title).font(.headline)
                if let note {
                    Text(note).font(.system(size: 10)).foregroundStyle(.secondary)
                }
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One row of a proportion list: label, bar, value, share.
struct BarRow: View {
    let label: String
    let value: String
    let fraction: Double
    var color: Color = .accentColor
    var detail: String?

    var body: some View {
        HStack(spacing: 10) {
            Text(label)
                .font(.system(size: 11))
                .frame(width: 110, alignment: .leading)
                .lineLimit(1)
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(.quaternary).frame(height: 8)
                    Capsule()
                        .fill(color.gradient)
                        .frame(width: max(2, geometry.size.width * min(1, max(0, fraction))), height: 8)
                }
                .frame(maxHeight: .infinity, alignment: .center)
            }
            .frame(height: 14)
            Text(value)
                .font(.system(size: 11, weight: .medium))
                .monospacedDigit()
                .frame(width: 66, alignment: .trailing)
            Text(detail ?? Format.percent(ratio: fraction))
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .monospacedDigit()
                .frame(width: 52, alignment: .trailing)
        }
    }
}

/// The four-bucket session split, in the terminal UI's colours and order.
struct TimeSplitBar: View {
    let split: TimeSplit
    var idleMs: Double?

    private var segments: [(label: String, ms: Double, color: Color)] {
        var parts: [(String, Double, Color)] = [
            ("Model", split.modelMs, .purple),
            ("Tools", split.toolsMs, .teal),
            ("You", split.userMs, .orange),
        ]
        if let idleMs, idleMs > 0 { parts.append(("Idle", idleMs, .gray)) }
        parts.append(("Unaccounted", split.unaccountedMs, .secondary))
        return parts
    }

    var body: some View {
        let total = max(1, segments.reduce(0) { $0 + $1.ms })
        VStack(alignment: .leading, spacing: 10) {
            GeometryReader { geometry in
                HStack(spacing: 2) {
                    ForEach(segments, id: \.label) { segment in
                        segment.color
                            .frame(width: max(0, geometry.size.width * segment.ms / total) - 2)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 4))
            }
            .frame(height: 18)

            HStack(spacing: 14) {
                ForEach(segments, id: \.label) { segment in
                    HStack(spacing: 4) {
                        Circle().fill(segment.color).frame(width: 7, height: 7)
                        Text(segment.label).font(.system(size: 10)).foregroundStyle(.secondary)
                        Text(Format.ms(segment.ms)).font(.system(size: 10, weight: .medium)).monospacedDigit()
                        Text(Format.percent(ratio: segment.ms / total))
                            .font(.system(size: 10))
                            .foregroundStyle(.tertiary)
                            .monospacedDigit()
                    }
                }
            }
        }
    }
}

/// A key/value pair, used in the header strip of each tab.
struct KeyValue: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.system(size: 10)).foregroundStyle(.secondary)
            Text(value).font(.system(size: 12, weight: .semibold)).monospacedDigit().lineLimit(1)
        }
    }
}

struct EmptyTabNote: View {
    let symbol: String
    let text: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol).font(.system(size: 22)).foregroundStyle(.tertiary)
            Text(text)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(30)
    }
}

extension String {
    /// "2026-09-19T21:16:05.426Z" → "21:16:05", for table columns.
    var clockTime: String {
        guard let date = ISO8601DateFormatter.parser.date(from: self) else { return "—" }
        return DateFormatter.clock.string(from: date)
    }
}

extension ISO8601DateFormatter {
    static let parser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

extension DateFormatter {
    static let clock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()
}
