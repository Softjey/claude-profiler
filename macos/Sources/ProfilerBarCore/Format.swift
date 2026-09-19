import Foundation

public enum Format {
    /// 950 → "950", 88_295 → "88k", 1_576_617 → "1.6M".
    public static func tokens(_ value: Int) -> String {
        let abs = Swift.abs(value)
        switch abs {
        case ..<1_000:
            return "\(value)"
        case ..<10_000:
            return String(format: "%.1fk", Double(value) / 1_000)
        case ..<1_000_000:
            return "\(Int((Double(value) / 1_000).rounded()))k"
        case ..<10_000_000:
            return String(format: "%.1fM", Double(value) / 1_000_000)
        default:
            return "\(Int((Double(value) / 1_000_000).rounded()))M"
        }
    }

    /// 42 → "42s", 185 → "3m", 3_900 → "1h 5m", 140_520 → "1d 15h".
    public static func duration(seconds: Double) -> String {
        let total = max(0, Int(seconds))
        if total < 60 { return "\(total)s" }
        if total < 3_600 { return "\(total / 60)m" }
        if total < 86_400 {
            let hours = total / 3_600
            let minutes = (total % 3_600) / 60
            return minutes == 0 ? "\(hours)h" : "\(hours)h \(minutes)m"
        }
        let days = total / 86_400
        let hours = (total % 86_400) / 3_600
        return hours == 0 ? "\(days)d" : "\(days)d \(hours)h"
    }

    public static func usd(_ value: Double) -> String {
        String(format: value < 10 ? "$%.2f" : "$%.0f", value)
    }

    /// "claude-opus-5" → "Opus 5", "claude-sonnet-4-5-20250929" → "Sonnet 4.5".
    public static func model(_ id: String) -> String {
        let base = id.split(separator: "[").first.map(String.init) ?? id
        var parts = base.split(separator: "-").map(String.init)
        if parts.first == "claude" { parts.removeFirst() }
        if let last = parts.last, last.count == 8, Int(last) != nil { parts.removeLast() }
        guard let family = parts.first else { return id }
        let version = parts.dropFirst().joined(separator: ".")
        let name = family.prefix(1).uppercased() + family.dropFirst()
        return version.isEmpty ? name : "\(name) \(version)"
    }
}
