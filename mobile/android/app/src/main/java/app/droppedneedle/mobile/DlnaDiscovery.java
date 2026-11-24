package app.droppedneedle.mobile;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorCompletionService;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/** One user-initiated SSDP search on the connected Wi-Fi or wired LAN. */
final class DlnaDiscovery {
    private static byte[] query(String type) {
        return ("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\n"
                + "MAN: \"ssdp:discover\"\r\nMX: 1\r\nST: " + type + "1\r\n\r\n").getBytes(StandardCharsets.US_ASCII);
    }

    static List<DlnaRenderer> find(Context context) throws Exception {
        Lan link = networkFor(context, null);
        return search(link.network, link.address);
    }

    static final class Lan {
        final Network network;
        final LinkAddress address;
        Lan(Network network, LinkAddress address) { this.network = network; this.address = address; }
    }

    static Lan networkFor(Context context, InetAddress peer) throws IOException {
        ConnectivityManager cm = context.getSystemService(ConnectivityManager.class);
        if (cm == null) throw new IOException("Connect to Wi-Fi to find network speakers.");
        List<Network> networks = new ArrayList<>(Arrays.asList(cm.getAllNetworks()));
        Network active = cm.getActiveNetwork();
        if (networks.remove(active)) networks.add(0, active);
        for (Network network : networks) {
            NetworkCapabilities caps = cm.getNetworkCapabilities(network);
            LinkProperties properties = cm.getLinkProperties(network);
            if (caps == null || properties == null || !(caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                    || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue;
            for (LinkAddress link : properties.getLinkAddresses()) {
                if (link.getAddress() instanceof Inet4Address && !link.getAddress().isLoopbackAddress()
                        && (peer == null || onLink(link, peer))) return new Lan(network, link);
            }
        }
        throw new IOException("Connect to a Wi-Fi or Ethernet network to find speakers.");
    }

    private static boolean onLink(LinkAddress local, InetAddress peer) {
        if (!(peer instanceof Inet4Address) || peer.isLoopbackAddress() || peer.isAnyLocalAddress()
                || peer.isMulticastAddress() || local.getAddress().equals(peer)) return false;
        byte[] a = local.getAddress().getAddress(), b = peer.getAddress();
        int bits = local.getPrefixLength();
        if (bits <= 0 || bits > 32) return false;
        for (int i = 0; bits > 0; i++, bits -= 8) {
            int mask = 0xff << (8 - Math.min(bits, 8));
            if (((a[i] ^ b[i]) & mask & 0xff) != 0) return false;
        }
        return true;
    }

    // Renderers can answer both search types and advertise multiple descriptions.
    // Validate the responding address first and reserve capacity for other peers.
    static void collect(Map<String, InetAddress> candidates, InetAddress peer, String location) {
        if (candidates.size() >= 24 || Collections.frequency(candidates.values(), peer) >= 2) return;
        try {
            String address = DlnaRenderer.endpoint(peer, null, location).normalize().toASCIIString();
            candidates.putIfAbsent(address, peer);
        } catch (IOException invalid) { /* Ignore descriptions outside the responding peer. */ }
    }

    private static List<DlnaRenderer> search(Network network, LinkAddress link) throws Exception {
        Map<String, InetAddress> candidates = new LinkedHashMap<>();
        try (DatagramSocket socket = new DatagramSocket(null)) {
            socket.bind(new InetSocketAddress(link.getAddress(), 0));
            network.bindSocket(socket);
            for (String type : Arrays.asList(DlnaRenderer.RENDERER, DlnaRenderer.ZONE_PLAYER)) {
                byte[] data = query(type);
                socket.send(new DatagramPacket(data, data.length, InetAddress.getByName("239.255.255.250"), 1900));
            }
            long end = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(1700);
            byte[] buffer = new byte[4096];
            while (System.nanoTime() < end && candidates.size() < 24) {
                socket.setSoTimeout((int) Math.max(1, TimeUnit.NANOSECONDS.toMillis(end - System.nanoTime())));
                DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                try { socket.receive(packet); } catch (SocketTimeoutException done) { break; }
                if (!onLink(link, packet.getAddress())) continue;
                String[] lines = new String(buffer, 0, packet.getLength(), StandardCharsets.US_ASCII).split("\r?\n");
                if (lines.length == 0 || !lines[0].startsWith("HTTP/1.1 200")) continue;
                String location = "", type = "";
                for (String line : lines) {
                    if (line.regionMatches(true, 0, "LOCATION:", 0, 9)) location = line.substring(9).trim();
                    if (line.regionMatches(true, 0, "ST:", 0, 3)) type = line.substring(3).trim();
                }
                if (!location.isEmpty() && (type.startsWith(DlnaRenderer.RENDERER) || type.startsWith(DlnaRenderer.ZONE_PLAYER)))
                    collect(candidates, packet.getAddress(), location);
            }
        }
        List<DlnaRenderer> found = new ArrayList<>();
        ExecutorService pool = Executors.newFixedThreadPool(4);
        try {
            ExecutorCompletionService<DlnaRenderer> done = new ExecutorCompletionService<>(pool);
            for (Map.Entry<String, InetAddress> entry : candidates.entrySet()) {
                done.submit(() -> DlnaRenderer.describe(link.getAddress(), entry.getValue(), network.getSocketFactory(), entry.getKey()));
            }
            long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            for (int i = 0; i < candidates.size(); i++) {
                Future<DlnaRenderer> next = done.poll(Math.max(0, end - System.nanoTime()), TimeUnit.NANOSECONDS);
                if (next == null) break;
                try { found.add(next.get()); } catch (java.util.concurrent.ExecutionException ignored) {
                    // Some renderers disappear or only implement video services.
                }
            }
        } finally { pool.shutdownNow(); }
        found.sort((a, b) -> a.name.compareToIgnoreCase(b.name));
        return found;
    }
}
