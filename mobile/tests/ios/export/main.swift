import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

let server = "https://fixture.invalid/music"
let prefix = "&prefix=Music+live%2F%E5%86%AC"
let csv = Data("title,artist,album,path\r\n\"Café, 冬\",Artist,Album,Music/song.flac\r\n".utf8)
let m3u = Data("#EXTM3U\n#PLAYLIST:冬\nMusic/one.flac\nMusic/one.flac\n".utf8)
let attachment = "attachment; filename=playlist.csv; filename*=UTF-8''Caf%C3%A9.csv"

final class ExportReply: URLProtocol, @unchecked Sendable {
    static let started = DispatchSemaphore(value: 0), stopped = DispatchSemaphore(value: 0)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        precondition(url.host == "fixture.invalid" && request.httpMethod == "GET")
        precondition(request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-only")
        precondition(request.value(forHTTPHeaderField: "Cookie") == nil && !url.absoluteString.contains("fixture-only"))
        let id = url.deletingLastPathComponent().lastPathComponent
        var status = 200, headers: [String: String] = [:], chunks = [Data]()
        switch id {
        case "shared":
            precondition(url.absoluteString.hasSuffix(prefix))
            headers = ["Content-Type":"Text/Csv; charset=utf-8", "Content-Disposition":attachment,
                       "X-DroppedNeedle-Skipped-Tracks":"03"]
            chunks = Array(repeating: Data(repeating: 0x20, count: 32768) + csv, count: 64)
        case "m3u":
            headers = ["Content-Type":"audio/x-mpegurl"]; chunks = [m3u]
        case "pause":
            headers = ["Content-Type":"text/csv"]; chunks = [csv]
        case "short":
            headers = ["Content-Type":"text/csv", "Content-Length":"2000"]; chunks = [csv]
        case "interrupted":
            headers = ["Content-Type":"text/csv"]; chunks = [csv]
        case "gateway":
            status = 401; headers = ["Content-Type":"text/html"]
            chunks = [Data(#"{"error":{"code":"UNAUTHORIZED"}}"#.utf8)]
        case "expired", "other401", "huge401", "partial401":
            status = 401; headers = ["Content-Type":"application/json; charset=utf-8"]
            let code = id == "other401" ? "DIFFERENT" : "UNAUTHORIZED"
            chunks = [Data("{\"error\":{\"code\":\"\(code)\"}}".utf8)]
            if id == "huge401" { chunks.append(Data(repeating: 32, count: 1024 * 1024)) }
            if id == "partial401" { headers["Content-Length"] = "250" }
        case "redirect":
            status = 302; headers = ["Location":"https://elsewhere.invalid/"]
        case "missing":
            status = 404
        case "oidc":
            headers = ["Content-Type":"text/html"]; chunks = [Data("<html>Sign in</html>".utf8)]
        default: preconditionFailure("Unexpected request escaped the endpoint validation")
        }
        let reply = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: headers)!
        client?.urlProtocol(self, didReceive: reply, cacheStoragePolicy: .notAllowed)
        for chunk in chunks { client?.urlProtocol(self, didLoad: chunk) }
        if id == "pause" { Self.started.signal(); return }
        if id == "interrupted" { client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost)); return }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { if request.url?.path.contains("/pause/") == true { Self.stopped.signal() } }
}

final class ExportResult<T: Sendable>: @unchecked Sendable {
    private var answer: Result<T, PlaylistExportError>?
    private let done = DispatchSemaphore(value: 0)
    func complete(_ result: Result<T, PlaylistExportError>) { answer = result; done.signal() }
    func wait() -> Result<T, PlaylistExportError> {
        precondition(done.wait(timeout: .now() + 5) == .success)
        return answer!
    }
}
func awaitResult<T: Sendable>(_ work: (@escaping PlaylistExports.Completion<T>) -> Void) -> Result<T, PlaylistExportError> {
    let result = ExportResult<T>()
    work(result.complete)
    return result.wait()
}
let root = FileManager.default.temporaryDirectory.appendingPathComponent("dn-export-fixture-" + UUID().uuidString)
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
let stale = root.appendingPathComponent("prior-run")
try Data("old export".utf8).write(to: stale)
defer { try? FileManager.default.removeItem(at: root) }
let config = URLSessionConfiguration.ephemeral
config.protocolClasses = [ExportReply.self]
let exports = PlaylistExports(root: root, configuration: config)
func endpoint(_ playlist: String, _ format: PlaylistExportFormat = .csv) -> String {
    server + "/api/v3/playlists/" + playlist + "/export?format=" + format.rawValue
}
func prepare(_ id: UUID, _ url: String, _ format: PlaylistExportFormat = .csv) -> Result<[String:String], PlaylistExportError> {
    awaitResult { exports.prepare(id, server: server, url: url, token: "fixture-only", format: format, done: $0) }
}
func pickerFile(_ id: UUID, _ name: String) -> Result<URL, PlaylistExportError> {
    awaitResult { exports.pickerFile(id, filename: name, done: $0) }
}
func discard(_ id: UUID) {
    let wait = DispatchSemaphore(value: 0)
    exports.discard(id) { wait.signal() }
    precondition(wait.wait(timeout: .now() + 3) == .success)
}
func expectFailure<T>(_ result: Result<T, PlaylistExportError>, _ code: String) {
    guard case let .failure(error) = result else { preconditionFailure("Accepted an invalid export") }
    precondition(error.code == code, "Expected \(code), received \(error.code)")
}

let id = UUID()
let headers = try prepare(id, endpoint("shared") + prefix).get()
precondition(!FileManager.default.fileExists(atPath: stale.path))
precondition(headers == ["contentDisposition":attachment, "skippedTracks":"03"])
for unsafe in ["../escape.csv", "folder/list.csv", ".hidden.csv", "list.csv.exe", "new\nline.csv", "list\\name.csv"] {
    expectFailure(pickerFile(id, unsafe), "INVALID_EXPORT")
}
let file = try pickerFile(id, "Café.csv").get()
let repeated = Data(repeating: 0x20, count: 32768) + csv
let bytes = try Data(contentsOf: file)
precondition(bytes == (0..<64).reduce(into: Data()) { total, _ in total.append(repeated) })
let permissions = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
precondition(permissions?.intValue == 0o600 && file.lastPathComponent == "Café.csv")
discard(id); discard(id)
precondition(!FileManager.default.fileExists(atPath: file.path))
let m3uID = UUID(), m3uHeaders = try prepare(m3uID, endpoint("m3u", .m3u8), .m3u8).get()
precondition(m3uHeaders.isEmpty)
let m3uFile = try pickerFile(m3uID, "Listening.m3u8").get(), preserved = try Data(contentsOf: m3uFile)
precondition(preserved == m3u); discard(m3uID)

for (name, error) in [("short","INVALID_RESPONSE"), ("interrupted","EXPORT_NETWORK"), ("gateway","HTTP_401"),
                      ("expired","DN_UNAUTHORIZED"), ("other401","HTTP_401"), ("huge401","HTTP_401"), ("partial401","HTTP_401"),
                      ("redirect","HTTP_302"), ("missing","HTTP_404"), ("oidc","INVALID_RESPONSE")] {
    expectFailure(prepare(UUID(), endpoint(name)), error)
    let leftovers = try FileManager.default.contentsOfDirectory(atPath: root.path)
    precondition(leftovers.isEmpty, "Left an incomplete file from \(name)")
}
let good = endpoint("shared")
let invalid = [
    good.replacingOccurrences(of: "fixture.invalid", with: "elsewhere.invalid"),
    good.replacingOccurrences(of: "/music/", with: "/other/"),
    good.replacingOccurrences(of: "https:", with: "http:"),
    good.replacingOccurrences(of: "fixture.invalid", with: "user@fixture.invalid"),
    good.replacingOccurrences(of: "shared", with: "..%2fprivate"),
    good.replacingOccurrences(of: "shared", with: "%252e%252e"),
    good + "#fragment", good + "&format=csv", good + "&token=fixture-only",
    good.replacingOccurrences(of: "format=csv", with: "format=m3u8")
]
for target in invalid { expectFailure(prepare(UUID(), target), "INVALID_EXPORT") }

let cancelling = UUID(), done = DispatchSemaphore(value: 0)
exports.prepare(cancelling, server: server, url: endpoint("pause"), token: "fixture-only", format: .csv) { result in
    expectFailure(result, "EXPORT_CANCELLED"); done.signal()
}
precondition(ExportReply.started.wait(timeout: .now()+3) == .success)
discard(cancelling)
precondition(done.wait(timeout: .now()+3) == .success && ExportReply.stopped.wait(timeout: .now()+3) == .success)
expectFailure(pickerFile(cancelling, "retry.csv"), "EXPORT_UNAVAILABLE")
let leftovers = try FileManager.default.contentsOfDirectory(atPath: root.path)
precondition(leftovers.isEmpty)

func stageLayout(_ id: UUID, _ text: String) -> Result<URL, PlaylistExportError> {
    awaitResult { exports.layoutFile(id, text: text, done: $0) }
}
func finishLayout(_ id: UUID, _ decision: FilePickerOutcome) -> Result<Bool, PlaylistExportError> {
    awaitResult { exports.finishPicker(id, decision, done: $0) }
}

let layoutID = UUID(), layout = "{\"title\":\"演奏 🪕 Cafe\u{301}\"}\n"
let layoutFile = try stageLayout(layoutID, layout).get()
let layoutFolder = layoutFile.deletingLastPathComponent()
let layoutBytes = try Data(contentsOf: layoutFile)
let fileMode = try FileManager.default.attributesOfItem(atPath: layoutFile.path)[.posixPermissions] as? NSNumber
let folderMode = try FileManager.default.attributesOfItem(atPath: layoutFolder.path)[.posixPermissions] as? NSNumber
precondition(layoutFile.lastPathComponent == "droppedneedle-player-layout.json")
precondition(layoutFolder.lastPathComponent == layoutID.uuidString && layoutBytes == Data(layout.utf8))
precondition(fileMode?.intValue == 0o600 && folderMode?.intValue == 0o700)
expectFailure(stageLayout(layoutID, "replacement"), "INVALID_EXPORT")
expectFailure(prepare(layoutID, endpoint("shared")), "INVALID_EXPORT")
let unchangedBytes = try Data(contentsOf: layoutFile)
precondition(unchangedBytes == layoutBytes)

let exactID = UUID(), exactText = "\"" + String(repeating: "🪕", count: 16_383) + "aa\""
precondition(exactText.utf8.count == 65_536)
let exactFile = try stageLayout(exactID, exactText).get()
let exactBytes = try Data(contentsOf: exactFile)
precondition(exactBytes == Data(exactText.utf8) && exactFile != layoutFile)
let oversizedID = UUID()
expectFailure(stageLayout(oversizedID, exactText + " "), "INVALID_LAYOUT")
precondition(!FileManager.default.fileExists(atPath: root.appendingPathComponent(oversizedID.uuidString).path))

let cancelledByUser = try finishLayout(exactID, .cancelled).get()
precondition(!cancelledByUser && !FileManager.default.fileExists(atPath: exactFile.deletingLastPathComponent().path))
discard(exactID)
let pickedCopy = root.appendingPathComponent("picked-copy.json")
try FileManager.default.copyItem(at: layoutFile, to: pickedCopy)
let saved = try finishLayout(layoutID, .selected(pickedCopy)).get()
let pickedBytes = try Data(contentsOf: pickedCopy)
precondition(saved && pickedBytes == layoutBytes && !FileManager.default.fileExists(atPath: layoutFolder.path))
try FileManager.default.removeItem(at: pickedCopy)
let failedID = UUID(), failedFile = try stageLayout(failedID, layout).get()
expectFailure(finishLayout(failedID, .failed(.picker)), "EXPORT_PICKER_UNAVAILABLE")
precondition(!FileManager.default.fileExists(atPath: failedFile.deletingLastPathComponent().path))
let emptySelectionID = UUID()
_ = try stageLayout(emptySelectionID, layout).get()
expectFailure(finishLayout(emptySelectionID, .selected(nil)), "EXPORT_FILE")
let afterLayouts = try FileManager.default.contentsOfDirectory(atPath: root.path)
precondition(afterLayouts.isEmpty)
print("iOS player layout exports preserve Unicode, accept exactly 65,536 bytes, and clean private staging after save, cancellation, or picker failure.")

// URLProtocol on Linux returns a 302 as a response without exercising URLSession's redirect delegate.
// This optional loopback fixture exercises the actual HTTP challenge and redirect handling.
if CommandLine.arguments.contains("--loopback") {
    let service = Process(), portOutput = Pipe()
    service.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    service.arguments = ["python3", "-u", "-c", #"""
import http.server
routes = iter(("redirect", "proxy", "expired", "shared"))
class Reply(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        name = next(routes)
        assert self.path == "/dn/api/v3/playlists/" + name + "/export?format=csv"
        assert self.headers["Authorization"] == "Bearer local-fixture"
        assert "Cookie" not in self.headers
        if name == "redirect":
            self.send_response(302)
            self.send_header("Location", "/not-a-playlist")
            body = b""
        elif name == "proxy":
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="fixture"')
            self.send_header("Content-Type", "text/html")
            body = b"<html>Sign in</html>"
        elif name == "expired":
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            body = b'{"error":{"code":"UNAUTHORIZED"}}'
        else:
            self.send_response(200)
            self.send_header("Content-Type", "text/csv")
            body = b"title,path\r\nCaf\xc3\xa9,Music/a.flac\r\n"
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
with http.server.HTTPServer(("127.0.0.1", 0), Reply) as server:
    print(server.server_port)
    for _ in range(4): server.handle_request()
"""#]
    service.standardOutput = portOutput
    try service.run()
    defer { if service.isRunning { service.terminate() }; service.waitUntilExit() }
    let port = String(decoding: portOutput.fileHandleForReading.availableData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    precondition(UInt16(port) != nil, "Start the loopback fixture with local socket access")
    let origin = "http://127.0.0.1:" + port + "/dn"
    let liveRoot = root.appendingPathComponent("transport")
    let wire = PlaylistExports(root: liveRoot)
    func send(_ name: String, _ id: UUID = UUID()) -> Result<[String:String], PlaylistExportError> {
        awaitResult { wire.prepare(id, server: origin, url: origin + "/api/v3/playlists/" + name + "/export?format=csv",
                                   token: "local-fixture", format: .csv, done: $0) }
    }
    expectFailure(send("redirect"), "HTTP_302")
    expectFailure(send("proxy"), "HTTP_401")
    expectFailure(send("expired"), "DN_UNAUTHORIZED")
    let save = UUID()
    _ = try send("shared", save).get()
    let copy = try awaitResult { wire.pickerFile(save, filename: "Playlist.csv", done: $0) }.get()
    let downloaded = try Data(contentsOf: copy)
    precondition(downloaded == Data("title,path\r\nCafé,Music/a.flac\r\n".utf8))
    let cleaned = DispatchSemaphore(value: 0)
    wire.discard(save) { cleaned.signal() }
    precondition(cleaned.wait(timeout: .now() + 3) == .success && !FileManager.default.fileExists(atPath: copy.path))
    service.waitUntilExit()
    precondition(service.terminationStatus == 0)
}
print("iOS playlist exports preserve DN bytes and headers, isolate the destination and credentials, and clean up on cancellation and rejection.")
