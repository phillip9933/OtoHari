package app.droppedneedle.mobile;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.SocketFactory;
import javax.xml.parsers.DocumentBuilderFactory;

/** A loopback-only UPnP renderer that plays by reading a range of the published media. */
final class SyntheticSpeaker implements Closeable {
    final InetAddress loopback = InetAddress.getByName("127.0.0.1");
    private final ServerSocket listener = new ServerSocket();
    private final Thread worker;
    private final AtomicReference<Throwable> failure = new AtomicReference<>();
    volatile String state = "STOPPED", time = "0:00:00", uri = "", metadata = "", sample = "";
    volatile String lastBody = "", contentRange = "";
    final String service = "urn:schemas-upnp-org:service:AVTransport:1";

    final String sonosId;
    volatile String groups = "";
    volatile int volume = 27;

    SyntheticSpeaker() throws IOException { this(""); }
    SyntheticSpeaker(String sonosId) throws IOException {
        this.sonosId=sonosId;
        listener.bind(new InetSocketAddress(loopback, 0));
        worker = new Thread(() -> {
            try {
                while (!listener.isClosed()) try (Socket s = listener.accept()) { respond(s); }
            } catch (SocketException e) { if (!listener.isClosed()) failure.set(e); }
            catch (Throwable e) { failure.set(e); }
        }, "synthetic-dlna-speaker");
        worker.setDaemon(true);
        worker.start();
    }

    String location() { return "http://127.0.0.1:" + listener.getLocalPort() + "/renderer/description.xml"; }

    DlnaRenderer describe() throws IOException {
        return DlnaRenderer.describe(loopback, loopback, SocketFactory.getDefault(), location());
    }
    static String element(String xml, String tag) throws Exception {
        return DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(new ByteArrayInputStream(
                xml.getBytes(StandardCharsets.UTF_8))).getElementsByTagName(tag).item(0).getTextContent();
    }

    private void respond(Socket s) throws Exception {
        s.setSoTimeout(3500);
        InputStream in = new BufferedInputStream(s.getInputStream());
        String request = DlnaRenderer.line(in);
        String action = "";
        int length = 0;
        for (String h = DlnaRenderer.line(in); !h.isEmpty(); h = DlnaRenderer.line(in)) {
            if (h.startsWith("SOAPAction: ")) action = h.substring(h.indexOf('#') + 1, h.length() - 1);
            if (h.startsWith("Content-Length: ")) length = Integer.parseInt(h.substring(16));
            if (h.startsWith("Authorization:") || h.startsWith("Cookie:")) throw new AssertionError("Renderer received credentials");
        }
        String reply;
        if (request.equals("GET /renderer/description.xml HTTP/1.1")) {
            String transport="<device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>Test speaker</friendlyName>"
                    + "<serviceList><service><serviceType>" + service + "</serviceType><controlURL>transport</controlURL></service>"
                    + (sonosId.isEmpty()?"": "<service><serviceType>"+DlnaRenderer.VOLUME+"1</serviceType><controlURL>volume</controlURL></service>")
                    + "</serviceList></device>";
            String root=sonosId.isEmpty()?transport:"<device><deviceType>" + DlnaRenderer.ZONE_PLAYER + "1</deviceType><manufacturer>Sonos</manufacturer>"
                    + "<roomName>Room " + sonosId + "</roomName><UDN>uuid:" + sonosId + "</UDN><serviceList><service><serviceType>"
                    + DlnaRenderer.GROUPS + "1</serviceType><controlURL>groups</controlURL></service></serviceList>"
                    + "<deviceList>" + transport + "</deviceList></device>";
            reply="<root xmlns='urn:schemas-upnp-org:device-1-0'>"+root+"</root>";
        } else {
            String path= action.equals("GetZoneGroupState") ? "groups" : action.endsWith("Volume") ? "volume" : "transport";
            if (!request.equals("POST /renderer/" + path + " HTTP/1.1")) throw new AssertionError("Invalid control URL");
            byte[] body = new byte[length];
            new java.io.DataInputStream(in).readFully(body);
            String xml = new String(body, StandardCharsets.UTF_8);
            if (xml.contains("auth-token") || xml.contains("dn.example") || xml.contains("file://"))
                throw new AssertionError("Private source was disclosed");
            String fields = "";
            switch (action) {
                case "GetZoneGroupState":
                    if (xml.contains("InstanceID")) throw new AssertionError("Topology commands have no transport instance.");
                    fields="<ZoneGroupState>" + groups.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;") + "</ZoneGroupState>";
                    break;
                case "GetVolume": case "SetVolume":
                    if (!element(xml,"Channel").equals("Master") || !element(xml,"InstanceID").equals("0")) throw new AssertionError();
                    if (action.equals("SetVolume")) volume=Integer.parseInt(element(xml,"DesiredVolume"));
                    else fields="<CurrentVolume>"+volume+"</CurrentVolume>";
                    break;
                case "BecomeCoordinatorOfStandaloneGroup": uri=""; break;
                case "SetAVTransportURI":
                    uri = element(xml, "CurrentURI");
                    metadata = element(xml, "CurrentURIMetaData");
                    lastBody = xml;
                    time = "0:00:00";
                    state = "STOPPED";
                    break;
                case "Play":
                    readAudio();
                    state = "PLAYING";
                    break;
                case "Pause": state = "PAUSED_PLAYBACK"; break;
                case "Stop": state = "STOPPED"; break;
                case "Seek": time = element(xml, "Target"); break;
                case "GetTransportInfo": fields = "<CurrentTransportState>" + state + "</CurrentTransportState>"; break;
                case "GetPositionInfo": fields = "<TrackURI>" + uri + "</TrackURI><RelTime>" + time
                        + "</RelTime><TrackDuration>0:02:00</TrackDuration>"; break;
                default: throw new AssertionError("Unknown AVTransport action: " + action);
            }
            reply = "<s:Envelope xmlns:s='http://schemas.xmlsoap.org/soap/envelope/'><s:Body><u:"
                    + action + "Response xmlns:u='" + service + "'>" + fields + "</u:" + action + "Response></s:Body></s:Envelope>";
        }
        byte[] data = reply.getBytes(StandardCharsets.UTF_8);
        s.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\nContent-Length: "
                + data.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        s.getOutputStream().write(data);
    }

    private void readAudio() throws Exception {
        URL media = new URL(uri);
        if (!loopback.getHostAddress().equals(media.getHost())) throw new AssertionError("Not the synthetic relay");
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(loopback, media.getPort()), 1200);
            socket.setSoTimeout(1800);
            socket.getOutputStream().write(("GET " + media.getPath() + " HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=1-3\r\n\r\n")
                    .getBytes(StandardCharsets.US_ASCII));
            InputStream audio = new BufferedInputStream(socket.getInputStream());
            if (!DlnaRenderer.line(audio).startsWith("HTTP/1.1 206")) throw new AssertionError("Range was not served");
            for (String h = DlnaRenderer.line(audio); !h.isEmpty(); h = DlnaRenderer.line(audio)) {
                if (h.startsWith("Content-Range: ")) contentRange = h.substring(15);
                if (h.startsWith("Authorization:") || h.startsWith("Set-Cookie:")) throw new AssertionError("Credentials in media headers");
            }
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            for (int n = audio.read(); n != -1; n = audio.read()) bytes.write(n);
            sample = bytes.toString("US-ASCII");
        }
    }

    @Override public void close() throws IOException {
        listener.close();
        try { worker.join(2500); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        if (failure.get() != null) throw new AssertionError("Synthetic renderer", failure.get());
    }
}
