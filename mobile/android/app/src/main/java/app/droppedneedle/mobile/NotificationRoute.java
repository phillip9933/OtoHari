package app.droppedneedle.mobile;

import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import java.util.concurrent.atomic.AtomicReference;

/** Holds the latest private notification destination until the signed-in UI is ready. */
final class NotificationRoute {
    enum Destination {
        DOWNLOADS("DownloadsNotification", "OPEN_DOWNLOADS"),
        PLAYER("NowPlayingNotification", "OPEN_PLAYER");

        private final String alias;
        private final String action;

        Destination(String alias, String action) {
            this.alias = "app.droppedneedle.mobile." + alias;
            this.action = "app.droppedneedle.mobile." + action;
        }

        Intent intent(Context context) {
            return new Intent(action).setComponent(new ComponentName(context, alias))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        }

        PendingIntent pendingIntent(Context context) {
            return PendingIntent.getActivity(context, 0, intent(context), PendingIntent.FLAG_IMMUTABLE);
        }
    }

    private static final String STATE = "dn.notificationDestination";
    private final AtomicReference<Destination> pending = new AtomicReference<>();

    Destination receive(Context context, Intent intent) {
        if (intent == null || intent.getData() != null
                || (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return null;
        for (Destination route : Destination.values()) {
            if (route.action.equals(intent.getAction())
                    && new ComponentName(context, route.alias).equals(intent.getComponent())) {
                pending.set(route);
                return route;
            }
        }
        return null;
    }

    void restore(Context context, Intent initial, Bundle state) {
        if (state != null && state.containsKey(STATE)) {
            String saved = state.getString(STATE);
            for (Destination route : Destination.values())
                if (route.name().equals(saved)) pending.set(route);
        } else if (state != null && state.containsKey("dn.openDownloads")) {
            if (state.getBoolean("dn.openDownloads")) pending.set(Destination.DOWNLOADS);
        } else receive(context, initial);
    }

    void save(Bundle state) {
        Destination route = pending.get();
        state.putString(STATE, route == null ? null : route.name());
    }

    boolean take(Destination route) { return pending.compareAndSet(route, null); }
}
