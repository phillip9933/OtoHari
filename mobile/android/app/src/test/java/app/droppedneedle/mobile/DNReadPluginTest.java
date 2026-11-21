package app.droppedneedle.mobile;

import static org.junit.Assert.*;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class DNReadPluginTest {
    @Test public void boundedReadsAcceptTheExactLimitAndRejectAnUnadvertisedExtraByte() throws Exception {
        byte[] data = new byte[16385];
        assertArrayEquals(data, DNReadPlugin.readLimited(new ByteArrayInputStream(data), data.length));
        assertThrows(IOException.class, () -> DNReadPlugin.readLimited(new ByteArrayInputStream(data), data.length - 1));
    }

    @Test public void backgroundPlaybackUsesOnlyTheActiveSessionDuringRevocation() throws Exception {
        JSONObject active = new JSONObject().put("serverUrl", "https://dn.example").put("userId", "current").put("token", "fixture");
        JSONObject pending = new JSONObject().put("serverUrl", "https://dn.example").put("token", "retired");
        JSONObject record = new JSONObject().put("active", active).put("revocations", new JSONArray().put(pending));
        assertEquals("current", HeadsetAccount.storedAccount(JSONObject.quote(active.toString())).userId);
        assertEquals("fixture", HeadsetAccount.storedAccount(JSONObject.quote(record.toString())).token);
        record.put("active", JSONObject.NULL);
        assertNull(HeadsetAccount.storedAccount(JSONObject.quote(record.toString())));
    }
}
