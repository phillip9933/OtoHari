import SwiftUI
import UIKit
import WidgetKit

private struct Entry: TimelineEntry {
    let date: Date
    let record: PlayerWidgetSnapshot?
}
private struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry {
        Entry(date: Date(), record: PlayerWidgetSnapshot(scope: "", occurrence: "", access: UUID(),
              title: "Track Title", artist: "Artist Name", playing: false, canNext: true, artwork: nil))
    }
    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : Entry(date: Date(), record: PlayerWidgetSnapshot.read()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        completion(Timeline(entries: [Entry(date: Date(), record: PlayerWidgetSnapshot.read())], policy: .never))
    }
}
private struct PlayerTile: View {
    @Environment(\.widgetFamily) private var family
    let entry: Entry
    private let accent = Color(red: 200/255, green: 251/255, blue: 108/255)
    private let background = Color(red: 5/255, green: 7/255, blue: 5/255)
    @ViewBuilder private var art: some View {
        if let data = entry.record?.artwork, let image = UIImage(data: data) {
            Image(uiImage: image).resizable().scaledToFill()
        } else { Image(systemName: "music.note").resizable().scaledToFit().padding(12).foregroundStyle(accent) }
    }
    @ViewBuilder private func action(_ name: String, _ icon: String, _ label: LocalizedStringKey) -> some View {
        if let access = entry.record?.access, let url = PlayerWidgetSnapshot.link(name, access: access) {
            Link(destination: url) {
                Image(systemName: icon).frame(minWidth: 42, minHeight: 40).foregroundStyle(accent)
            }.accessibilityLabel(Text(label))
        }
    }
    @ViewBuilder private var content: some View {
        if family == .accessoryRectangular {
            VStack(alignment: .leading) {
                Label("OtoHari", systemImage: "waveform")
                if let record = entry.record {
                    Text(record.title).fontWeight(.semibold).lineLimit(1).privacySensitive()
                    Text(record.artist).lineLimit(1).privacySensitive()
                } else { Text("Open player") }
            }
        } else if let record = entry.record {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 10) {
                    art.frame(width: family == .systemMedium ? 68 : 42, height: family == .systemMedium ? 68 : 42)
                        .clipShape(RoundedRectangle(cornerRadius: 6)).privacySensitive()
                    if family == .systemMedium {
                        VStack(alignment: .leading) {
                            Text(record.title).font(.headline).lineLimit(2)
                            Text(record.artist).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                        }.privacySensitive()
                    }
                }
                if family == .systemSmall {
                    Spacer(minLength: 2)
                    Text(record.title).font(.headline).lineLimit(2).privacySensitive()
                    Text(record.artist).font(.caption).lineLimit(1).foregroundStyle(.secondary).privacySensitive()
                } else {
                    HStack {
                        action("previous", "backward.end.fill", "Previous track")
                        action(record.playing ? "pause" : "play", record.playing ? "pause.fill" : "play.fill", record.playing ? "Pause" : "Play")
                        if record.canNext { action("next", "forward.end.fill", "Next track") }
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Label("Open player", systemImage: "music.note").font(.headline)
        }
    }
    var body: some View {
        if #available(iOSApplicationExtension 17.0, *) {
            content.containerBackground(for: .widget) { background }
                .environment(\.colorScheme, .dark).widgetURL(PlayerWidgetSnapshot.link())
        } else {
            content.frame(maxWidth: .infinity, maxHeight: .infinity).foregroundStyle(.white)
                .background(background).widgetURL(PlayerWidgetSnapshot.link())
        }
    }
}
@main
struct NowPlayingWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: PlayerWidgetSnapshot.kind, provider: Provider()) { PlayerTile(entry: $0) }
            .configurationDisplayName("Now Playing")
            .description("See what’s playing in OtoHari and control your queue.")
            .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}
