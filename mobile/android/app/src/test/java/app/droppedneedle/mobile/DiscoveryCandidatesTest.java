package app.droppedneedle.mobile;

import static org.junit.Assert.*;
import java.net.InetAddress;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.Test;

public final class DiscoveryCandidatesTest {
    @Test public void repeatedAnnouncementsLeaveSpaceForOtherSpeakers() throws Exception {
        InetAddress living = InetAddress.getByName("192.0.2.10");
        InetAddress kitchen = InetAddress.getByName("192.0.2.20");
        Map<String, InetAddress> candidates = new LinkedHashMap<>();
        for (String path : new String[] {"description", "description", "alternate", "another"}) {
            DlnaDiscovery.collect(candidates, living, "http://192.0.2.10:1400/" + path);
        }
        DlnaDiscovery.collect(candidates, kitchen, "http://192.0.2.20:1400/description");
        assertEquals(3, candidates.size());
        assertTrue(candidates.containsValue(kitchen));
    }
}
