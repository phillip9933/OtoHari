package app.droppedneedle.mobile;

import java.io.IOException;
import java.net.URI;
import java.util.HashSet;
import java.util.Set;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

/** Group reports describe membership. Only receivers independently discovered on this network can get commands. */
final class SonosRooms {
    static final class Room {
        final String id, coordinator, location;
        int members;
        Room(String id, String coordinator, String location) {
            this.id = id;
            this.location = location;
            this.coordinator = coordinator;
        }
    }
    static Map<String, Room> topology(Document doc) throws IOException {
        Map<String, Room> rooms = new LinkedHashMap<>();
        NodeList groups = doc.getElementsByTagNameNS("*", "ZoneGroup");
        if (groups.getLength() == 0)
            throw new IOException("Sonos groups are unavailable.");
        for (int i = 0; i < groups.getLength(); i++) {
            Element group = (Element) groups.item(i);
            String coordinator = group.getAttribute("Coordinator");
            Map<String, Room> visible = new LinkedHashMap<>();
            for (Node n = group.getFirstChild(); n != null; n = n.getNextSibling()) {
                if (!(n instanceof Element e) || !"ZoneGroupMember".equals(e.getLocalName())
                        || "1".equals(e.getAttribute("Invisible")) || "1".equals(e.getAttribute("IsZoneBridge")))
                    continue;
                String id = e.getAttribute("UUID");
                if (!id.matches("RINCON_[A-Za-z0-9]{8,48}"))
                    continue;
                if (visible.put(id, new Room(id, coordinator, e.getAttribute("Location"))) != null)
                    throw new IOException("Sonos room identity changed. Refresh the rooms.");
            }
            for (Room room : visible.values()) {
                room.members = visible.size();
                if (rooms.put(room.id, room) != null)
                    throw new IOException("Sonos group membership changed. Refresh the rooms.");
            }
        }
        return rooms;
    }
    private static int port(URI endpoint) { return endpoint.getPort() == -1 ? 80 : endpoint.getPort(); }

    // A Sonos UUID and display name are self-reported. Do not choose between
    // distinct discovered endpoints that advertise the same identity.
    static Set<String> ambiguousIds(Iterable<DlnaRenderer> devices) {
        Map<String, DlnaRenderer> first = new HashMap<>();
        Set<String> ambiguous = new HashSet<>();
        for (DlnaRenderer device : devices) {
            if (!device.hasGroups()) continue;
            DlnaRenderer other = first.putIfAbsent(device.sonosId, device);
            if (other != null && (!other.peer.equals(device.peer)
                    || port(other.descriptionAddress) != port(device.descriptionAddress)))
                ambiguous.add(device.sonosId);
        }
        return ambiguous;
    }

    private static boolean identifies(Map<String, Room> report, DlnaRenderer device) {
        Room row = report.get(device.sonosId);
        if (row == null || !device.hasGroups()) return false;
        try {
            // Compare the numeric host and port only. Never fetch a topology URL.
            return port(DlnaRenderer.endpoint(device.peer, null, row.location)) == port(device.descriptionAddress);
        } catch (IOException invalid) { return false; }
    }
    private static boolean agree(Map<String, Room> roomReport, Map<String, Room> leaderReport,
                                 DlnaRenderer room, DlnaRenderer leader, boolean grouped) {
        if (!identifies(roomReport, room) || !identifies(roomReport, leader)
                || !identifies(leaderReport, room) || !identifies(leaderReport, leader)) return false;
        String coordinator = roomReport.get(room.sonosId).coordinator;
        return coordinator.equals(leaderReport.get(room.sonosId).coordinator)
                && (!grouped || coordinator.equals(leader.sonosId))
                && leader.sonosId.equals(roomReport.get(leader.sonosId).coordinator)
                && leader.sonosId.equals(leaderReport.get(leader.sonosId).coordinator);
    }
    static JSONArray list(Map<String, DlnaRenderer> devices) throws IOException, JSONException {
        Map<String, Map<String, Room>> reports = new LinkedHashMap<>();
        Set<String> ambiguous = ambiguousIds(devices.values());
        boolean hasRooms = false;
        for (Map.Entry<String, DlnaRenderer> entry : devices.entrySet()) {
            DlnaRenderer device = entry.getValue();
            if (!device.hasGroups()) continue;
            hasRooms = true;
            if (ambiguous.contains(device.sonosId)) continue;
            try {
                Map<String, Room> report = topology(device.topology());
                if (identifies(report, device)) reports.put(entry.getKey(), report);
            } catch (IOException unavailable) { /* Other rooms can still be listed. */ }
        }
        if (hasRooms && reports.isEmpty()) throw new IOException("Unable to verify Sonos rooms. Refresh the speakers.");
        JSONArray result = new JSONArray();
        for (Map.Entry<String, Map<String, Room>> entry : reports.entrySet()) {
            String id = entry.getKey();
            DlnaRenderer device = devices.get(id);
            Map<String, Room> own = entry.getValue();
            Room room = own.get(device.sonosId);
            JSONArray leaders = new JSONArray();
            JSONObject item = new JSONObject().put("id", id).put("name", device.name)
                    .put("groupName", device.name).put("members", room.members);
            for (Map.Entry<String, Map<String, Room>> candidate : reports.entrySet()) {
                DlnaRenderer leader = devices.get(candidate.getKey());
                if (!agree(own, candidate.getValue(), device, leader, false)) continue;
                leaders.put(candidate.getKey());
                if (leader.sonosId.equals(room.coordinator))
                    item.put("coordinator", candidate.getKey()).put("groupName", leader.name);
            }
            item.put("leaders", leaders);
            try {
                int volume = device.volume();
                if (volume >= 0) item.put("volume", volume);
            } catch (IOException unavailable) { /* Room controls still work. */ }
            result.put(item);
        }
        return result;
    }
    static DlnaRenderer route(Map<String, DlnaRenderer> devices, DlnaRenderer room) throws IOException {
        if (!room.hasGroups()) return room;
        Map<String, Room> own = topology(room.topology());
        Set<String> ambiguous = ambiguousIds(devices.values());
        if (identifies(own, room) && !ambiguous.contains(room.sonosId)) {
            String coordinator = own.get(room.sonosId).coordinator;
            if (room.sonosId.equals(coordinator)) return room;
            for (DlnaRenderer leader : devices.values()) {
                if (!leader.sonosId.equals(coordinator) || ambiguous.contains(coordinator) || !identifies(own, leader)) continue;
                if (agree(own, topology(leader.topology()), room, leader, true)) return leader;
            }
        }
        throw new IOException("Could not verify the Sonos group coordinator. Refresh the speakers.");
    }
    static boolean needsConfirmation(DlnaRenderer selected, DlnaRenderer resolved, DlnaRenderer approved) throws IOException {
        if (approved != null && resolved != approved)
            throw new IOException("Sonos group changed. Select the room again.");
        return resolved != selected && approved == null;
    }
    static void group(DlnaRenderer device, DlnaRenderer target) throws IOException {
        if (!device.hasGroups())
            throw new IOException("Choose a Sonos room.");
        Map<String, Room> group = topology(device.topology());
        Room room = group.get(device.sonosId);
        if (!identifies(group, device))
            throw new IOException("Refresh Sonos rooms before changing a group.");
        if (target == null) {
            if (!room.id.equals(room.coordinator))
                device.ungroup();
            else if (room.members > 1)
                throw new IOException("Ungroup the other rooms to make this coordinator independent.");
            return;
        }
        Room leader = group.get(target.sonosId);
        if (!identifies(group, target) || !agree(group, topology(target.topology()), device, target, false))
            throw new IOException("Choose a coordinator in the same Sonos household.");
        if (room.coordinator.equals(leader.id))
            return;
        if (room.members > 1 && room.id.equals(room.coordinator))
            throw new IOException("Ungroup the other rooms before moving this coordinator.");
        device.join(leader.id);
    }
}
