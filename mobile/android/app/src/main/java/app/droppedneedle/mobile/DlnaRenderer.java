package app.droppedneedle.mobile;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.StringReader;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import javax.net.SocketFactory;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;
import org.xml.sax.InputSource;

/** UPnP descriptions and AVTransport commands stay on the numeric address that answered SSDP. */
final class DlnaRenderer extends NetworkRenderer {
    static final String RENDERER = "urn:schemas-upnp-org:device:MediaRenderer:";
    static final String ZONE_PLAYER = "urn:schemas-upnp-org:device:ZonePlayer:";
    private static final String TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:";
    private static final int XML_LIMIT = 192 * 1024;
    static final String GROUPS = "urn:schemas-upnp-org:service:ZoneGroupTopology:";
    static final String VOLUME = "urn:schemas-upnp-org:service:RenderingControl:";
    final String sonosId;
    final URI descriptionAddress;
    private final Endpoint groups, volume;
    private static final class Endpoint {
        final URI uri;
        final String service;
        Endpoint(URI uri,String service) { this.uri = uri; this.service = service; }
    }
    private final URI control;
    private final String service;
    private final SocketFactory sockets;

    private DlnaRenderer(InetAddress local, InetAddress peer, SocketFactory sockets, URI control, URI descriptionAddress,
                         String service, String name, String sonosId, Endpoint groups, Endpoint volume) {
        super(local, peer, name);
        this.sockets = sockets;
        this.control = control;
        this.descriptionAddress = descriptionAddress;
        this.service = service;
        this.sonosId = sonosId;
        this.groups = groups;
        this.volume = volume;
    }

    static DlnaRenderer describe(InetAddress local, InetAddress peer, SocketFactory sockets,
                                 String location) throws IOException {
        URI descriptionAddress = endpoint(peer, null, location);
        URI address = descriptionAddress;
        Document description = exchange(local, peer, sockets, address, null, null);
        String base = text(description.getDocumentElement(), "URLBase");
        if (!base.isEmpty()) address = endpoint(peer, address, base);
        NodeList devices = description.getElementsByTagNameNS("*", "device");
        String room = "", uuid = "";
        Endpoint topology = null;
        for (int i = 0; i < devices.getLength(); i++) {
            Element device = (Element) devices.item(i);
            if (text(device, "deviceType").startsWith(ZONE_PLAYER)
                    && text(device, "manufacturer").toLowerCase(Locale.ROOT).contains("sonos")) {
                room = text(device, "roomName");
                String udn = text(device,"UDN").replaceFirst("(?i)^uuid:","");
                if (udn.matches("RINCON_[A-Za-z0-9]{8,48}")) {
                    uuid = udn;
                    topology = service(device,peer,address,GROUPS);
                }
                break;
            }
        }
        for (int i = 0; i < devices.getLength(); i++) {
            Element device = (Element) devices.item(i);
            if (!text(device, "deviceType").startsWith(RENDERER)) continue;
            Element services = child(device, "serviceList");
            if (services == null) continue;
            for (Node n = services.getFirstChild(); n != null; n = n.getNextSibling()) {
                if (!(n instanceof Element) || !"service".equals(n.getLocalName())) continue;
                String type = text((Element) n, "serviceType");
                if (!type.matches(TRANSPORT + "[1-9][0-9]?")) continue;
                URI control = endpoint(peer, address, text((Element) n, "controlURL"));
                String name = room.isEmpty() ? text(device, "friendlyName") : room;
                return new DlnaRenderer(local, peer, sockets, control, descriptionAddress, type, name,uuid,topology,
                        uuid.isEmpty() ? null : service(device,peer,address,VOLUME));
            }
        }
        throw new IOException("This device has no audio transport.");
    }

    private static Endpoint service(Element device, InetAddress peer, URI base, String prefix) throws IOException {
        Element list = child(device, "serviceList");
        if (list == null)
            return null;
        for (Node node = list.getFirstChild(); node != null; node = node.getNextSibling()) {
            if (!(node instanceof Element e) || !"service".equals(e.getLocalName()))
                continue;
            String type = text(e, "serviceType");
            if (type.matches(prefix + "[1-9][0-9]?"))
                return new Endpoint(endpoint(peer, base, text(e, "controlURL")), type);
        }
        return null;
    }
    boolean hasGroups() {
        return groups != null && !sonosId.isEmpty();
    }
    Document topology() throws IOException {
        if (!hasGroups())
            throw new IOException("This speaker does not provide Sonos groups.");
        String xml = field(command(groups.uri, groups.service, "GetZoneGroupState", ""), "ZoneGroupState");
        if (xml.isEmpty())
            throw new IOException("The speaker did not return its group membership.");
        return parse(xml);
    }
    int volume() throws IOException {
        if (volume == null)
            return -1;
        String v = field(
                command(volume.uri, volume.service, "GetVolume", "<InstanceID>0</InstanceID><Channel>Master</Channel>"),
                "CurrentVolume");
        if (!v.matches("[0-9]{1,3}") || Integer.parseInt(v) > 100)
            throw new IOException("Speaker volume is unavailable.");
        return Integer.parseInt(v);
    }
    void setVolume(int level) throws IOException {
        if (volume == null || level < 0 || level > 100)
            throw new IOException("Choose a speaker volume between 0 and 100.");
        command(volume.uri, volume.service, "SetVolume",
                "<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>" + level + "</DesiredVolume>");
    }
    void join(String coordinator) throws IOException {
        if (!hasGroups() || coordinator == null || !coordinator.matches("RINCON_[A-Za-z0-9]{8,48}"))
            throw new IOException("Choose a Sonos group on this network.");
        action("SetAVTransportURI",
                "<CurrentURI>x-rincon:" + coordinator + "</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>");
    }
    void ungroup() throws IOException {
        if (hasGroups())
            action("BecomeCoordinatorOfStandaloneGroup", "");
    }

    static URI endpoint(InetAddress peer, URI base, String value) throws IOException {
        try {
            if (value.isEmpty()) throw new IllegalArgumentException();
            URI url = base == null ? URI.create(value.trim()) : base.resolve(value.trim());
            if (!"http".equalsIgnoreCase(url.getScheme()) || !peer.getHostAddress().equals(url.getHost())
                    || url.getRawUserInfo() != null || url.getRawFragment() != null
                    || url.getPort() == 0 || url.getPort() > 65535) throw new IllegalArgumentException();
            return url;
        } catch (IllegalArgumentException e) { throw new IOException("Invalid renderer address."); }
    }

    static String escape(String value) {
        return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\"", "&quot;").replace("'", "&apos;")
                .replaceAll("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f]", "");
    }

    void load(String url, String mime, String title, String artist, String album) throws IOException {
        String metadata = "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" "
                + "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" "
                + "xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\"><item id=\"0\" parentID=\"-1\" restricted=\"1\">"
                + "<dc:title>" + escape(title) + "</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class>"
                + "<upnp:artist>" + escape(artist) + "</upnp:artist><upnp:album>" + escape(album) + "</upnp:album>"
                + "<res protocolInfo=\"http-get:*:" + escape(mime) + ":*\">" + escape(url) + "</res></item></DIDL-Lite>";
        action("SetAVTransportURI", "<CurrentURI>" + escape(url) + "</CurrentURI><CurrentURIMetaData>"
                + escape(metadata) + "</CurrentURIMetaData>");
    }

    void play() throws IOException { action("Play", "<Speed>1</Speed>"); }
    void pause() throws IOException { action("Pause", ""); }
    void stop() throws IOException { action("Stop", ""); }
    void seek(long ms) throws IOException {
        long s = Math.max(0, ms) / 1000;
        String time = String.format(Locale.ROOT, "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60);
        action("Seek", "<Unit>REL_TIME</Unit><Target>" + time + "</Target>");
    }

    Reading read() throws IOException {
        Document info = action("GetTransportInfo", "");
        Document track = action("GetPositionInfo", "");
        return new Reading(field(info, "CurrentTransportState"), field(track, "TrackURI"),
                milliseconds(field(track, "RelTime")), milliseconds(field(track, "TrackDuration")));
    }

    private static long milliseconds(String value) {
        String[] parts = value.split(":");
        if (parts.length != 3) return -1;
        try {
            double seconds = Integer.parseInt(parts[0]) * 3600d + Integer.parseInt(parts[1]) * 60d
                    + Double.parseDouble(parts[2]);
            return seconds >= 0 && Double.isFinite(seconds) ? (long) (seconds * 1000) : -1;
        } catch (NumberFormatException ignored) { return -1; }
    }

    private Document action(String name, String arguments) throws IOException {
        return command(control,service,name,"<InstanceID>0</InstanceID>" + arguments);
    }
    private Document command(URI control,String service,String name,String arguments) throws IOException {
        String body = "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope "
                + "xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" "
                + "s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:" + name
                + " xmlns:u=\"" + service + "\">" + arguments + "</u:"
                + name + "></s:Body></s:Envelope>";
        return exchange(local, peer, sockets, control, service + "#" + name, body);
    }

    private static Document exchange(InetAddress local, InetAddress peer, SocketFactory factory, URI uri,
                                     String soapAction, String body) throws IOException {
        int port = uri.getPort() < 0 ? 80 : uri.getPort();
        try (Socket socket = factory.createSocket()) {
            socket.bind(new InetSocketAddress(local, 0));
            socket.connect(new InetSocketAddress(peer, port), 2200);
            socket.setSoTimeout(3500);
            String path = uri.getRawPath().isEmpty() ? "/" : uri.getRawPath();
            if (uri.getRawQuery() != null) path += "?" + uri.getRawQuery();
            byte[] bytes = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
            String headers = (body == null ? "GET " : "POST ") + path + " HTTP/1.1\r\nHost: "
                    + peer.getHostAddress() + ":" + port + "\r\nConnection: close\r\n"
                    + (body == null ? "" : "SOAPAction: \"" + soapAction
                    + "\"\r\nContent-Type: text/xml; charset=utf-8\r\nContent-Length: " + bytes.length + "\r\n") + "\r\n";
            OutputStream out = socket.getOutputStream();
            out.write(headers.getBytes(StandardCharsets.US_ASCII));
            out.write(bytes);
            out.flush();
            BufferedInputStream in = new BufferedInputStream(socket.getInputStream());
            if (!line(in).matches("HTTP/1\\.[01] 2[0-9]{2}( .*|$)"))
                throw new IOException("The renderer declined the operation.");
            boolean chunked = false;
            int length = -1;
            for (int n = 0; ; n++) {
                String h = line(in);
                if (h.isEmpty()) break;
                if (n >= 48) throw new IOException("Invalid renderer response.");
                int colon = h.indexOf(':');
                if (colon < 0) throw new IOException("Invalid renderer header.");
                String k = h.substring(0, colon), v = h.substring(colon + 1).trim();
                if (k.equalsIgnoreCase("Transfer-Encoding")) chunked = v.equalsIgnoreCase("chunked");
                if (k.equalsIgnoreCase("Content-Length")) length = number(v, 10);
            }
            ByteArrayOutputStream xml = new ByteArrayOutputStream();
            if (chunked) {
                for (;;) {
                    int size = number(line(in).split(";", 2)[0].trim(), 16);
                    if (size == 0) break;
                    transfer(in, xml, size);
                    if (!line(in).isEmpty()) throw new IOException("Invalid renderer chunk.");
                }
            } else transfer(in, xml, length);
            return parse(xml.toString("UTF-8"));
        }
    }

    private static int number(String s, int radix) throws IOException {
        try {
            int n = Integer.parseInt(s, radix);
            if (n >= 0 && n <= XML_LIMIT) return n;
        } catch (NumberFormatException ignored) { }
        throw new IOException("Invalid renderer message size.");
    }
    static String line(InputStream in) throws IOException {
        ByteArrayOutputStream data = new ByteArrayOutputStream();
        while (data.size() < 2048) {
            int next = in.read();
            if (next == -1) throw new EOFException();
            if (next == '\n') return data.toString("US-ASCII").trim();
            data.write(next);
        }
        throw new IOException("Header too long.");
    }

    private static void transfer(InputStream in, ByteArrayOutputStream out, int size) throws IOException {
        byte[] buffer = new byte[4096];
        while (size != 0) {
            int n = in.read(buffer, 0, size < 0 ? buffer.length : Math.min(size, buffer.length));
            if (n < 0) {
                if (size >= 0) throw new EOFException();
                return;
            }
            if (out.size() + n > XML_LIMIT) throw new IOException("Renderer response too large.");
            out.write(buffer, 0, n);
            if (size > 0) size -= n;
        }
    }

    private static Document parse(String xml) throws IOException {
        if (xml.contains("<!DOCTYPE")) throw new IOException("Invalid device description.");
        try {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(true);
            factory.setExpandEntityReferences(false);
            javax.xml.parsers.DocumentBuilder builder = factory.newDocumentBuilder();
            builder.setEntityResolver((id, system) -> { throw new org.xml.sax.SAXException("External entity"); });
            return builder.parse(new InputSource(new StringReader(xml)));
        } catch (Exception e) { throw new IOException("Invalid device description."); }
    }
    private static Element child(Element parent, String name) {
        for (Node n = parent.getFirstChild(); n != null; n = n.getNextSibling())
            if (n instanceof Element && name.equals(n.getLocalName())) return (Element) n;
        return null;
    }
    private static String text(Element parent, String name) {
        Element e = child(parent, name);
        return e == null ? "" : e.getTextContent().trim();
    }
    private static String field(Document doc, String name) {
        Node element = doc.getElementsByTagNameNS("*", name).item(0);
        return element == null ? "" : element.getTextContent().trim();
    }
}
