import AppKit
import ProfilerBarCore
import SwiftUI

/// `ClaudeProfilerBar --render-png <path> [--detail] [--dark]`: renders the
/// popover (or the first session's detail window) from one live snapshot to a
/// PNG and exits — for checking a UI change and for README screenshots
/// without clicking through the menu bar.
@MainActor
enum PreviewRenderer {
    static func runIfRequested(arguments: [String] = CommandLine.arguments) -> Bool {
        guard let flag = arguments.firstIndex(of: "--render-png"), flag + 1 < arguments.count else { return false }
        let path = arguments[flag + 1]
        let dark = arguments.contains("--dark")

        let message = try? CollectorProcess.collectOnce(command: CollectorCommand.resolve())
        guard case .snapshot(let snapshot) = message else {
            FileHandle.standardError.write(Data("render: the collector produced no snapshot\n".utf8))
            exit(1)
        }
        let store = LiveStore(preview: snapshot)

        let view: AnyView
        if arguments.contains("--detail"), let first = snapshot.sessions.first(where: { $0.state.isLive }) ?? snapshot.sessions.first {
            view = AnyView(SessionDetailView(sessionId: first.id).frame(width: 560, height: 600))
        } else {
            view = AnyView(PopoverView())
        }

        let content = view
            .environment(store)
            .environment(\.colorScheme, dark ? .dark : .light)
            .background(dark ? Color(white: 0.16) : Color(white: 0.97))

        // ImageRenderer draws ScrollView and AppKit-backed controls as
        // placeholders, so the view goes into a real, off-screen window instead.
        let host = NSHostingView(rootView: content)
        host.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        let size = host.fittingSize
        let window = NSWindow(
            contentRect: NSRect(origin: CGPoint(x: -10_000, y: -10_000), size: size),
            styleMask: .borderless, backing: .buffered, defer: false
        )
        window.contentView = host
        window.orderFrontRegardless()
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        host.layoutSubtreeIfNeeded()

        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            FileHandle.standardError.write(Data("render: could not rasterize the view\n".utf8))
            exit(1)
        }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        window.orderOut(nil)
        guard let png = bitmap.representation(using: .png, properties: [:]) else {
            FileHandle.standardError.write(Data("render: could not encode the PNG\n".utf8))
            exit(1)
        }
        do {
            try png.write(to: URL(fileURLWithPath: path))
        } catch {
            FileHandle.standardError.write(Data("render: \(error.localizedDescription)\n".utf8))
            exit(1)
        }
        return true
    }
}
