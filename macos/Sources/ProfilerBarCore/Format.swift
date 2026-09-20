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

    /// 240 → "240ms", 3_542 → "3.5s", 80_000 → "1m 20s", 3_900_000 → "1h 5m".
    /// Keeps the seconds a profile reader wants, where `duration` rounds to
    /// whole minutes for "how long ago" labels.
    public static func ms(_ value: Double) -> String {
        if value < 1_000 { return "\(Int(value.rounded()))ms" }
        if value < 10_000 { return String(format: "%.1fs", value / 1_000) }
        let seconds = Int(value / 1_000)
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3_600 {
            let rest = seconds % 60
            return rest == 0 ? "\(seconds / 60)m" : "\(seconds / 60)m \(rest)s"
        }
        return duration(seconds: Double(seconds))
    }

    /// 820 → "820 B", 819_043 → "800 KB", 5_400_000 → "5.2 MB".
    public static func bytes(_ value: Double) -> String {
        if value < 1_024 { return "\(Int(value.rounded())) B" }
        if value < 1_024 * 1_024 { return "\(Int((value / 1_024).rounded())) KB" }
        return String(format: "%.1f MB", value / (1_024 * 1_024))
    }

    /// Takes a ratio, the way every `pct…` field in the profile artifact is
    /// stored: 0.0197 → "2.0%", 0.45 → "45%".
    public static func percent(ratio: Double) -> String {
        let value = ratio * 100
        return value >= 10 ? String(format: "%.0f%%", value) : String(format: "%.1f%%", value)
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
