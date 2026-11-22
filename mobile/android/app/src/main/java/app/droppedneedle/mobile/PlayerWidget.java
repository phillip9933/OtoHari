package app.droppedneedle.mobile;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import androidx.core.content.ContextCompat;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import com.google.common.util.concurrent.ListenableFuture;

/** The launcher and the in-app player share a media session; the widget stores no account or track data. */
public final class PlayerWidget extends AppWidgetProvider {
    private static final String PREFIX = "app.droppedneedle.mobile.WIDGET.";
    private static final int FLAGS = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
    private static PendingIntent control(Context context, String action, int code) {
        return PendingIntent.getBroadcast(context, code, new Intent(context, PlayerWidget.class).setAction(PREFIX + action), FLAGS);
    }
    static void render(Context context, Player player) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, PlayerWidget.class));
        if (ids.length == 0) return;
        boolean active = player != null && player.getCurrentMediaItem() != null;
        boolean playing = active && player.getPlayWhenReady() && player.getPlaybackState() != Player.STATE_ENDED;
        MediaMetadata meta = active ? player.getMediaMetadata() : MediaMetadata.EMPTY;
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.player_widget);
        views.setTextViewText(R.id.widget_title, meta.title == null ? context.getText(R.string.app_name) : meta.title);
        views.setTextViewText(R.id.widget_artist, meta.artist == null ? context.getText(R.string.widget_resume) : meta.artist);
        views.setImageViewResource(R.id.widget_toggle, playing ? R.drawable.widget_pause : R.drawable.widget_play);
        views.setContentDescription(R.id.widget_toggle, context.getText(playing ? R.string.widget_pause : R.string.widget_play));
        views.setOnClickPendingIntent(R.id.widget_text, NotificationRoute.Destination.PLAYER.pendingIntent(context));
        views.setOnClickPendingIntent(R.id.widget_previous, control(context, "PREVIOUS", 1));
        views.setOnClickPendingIntent(R.id.widget_toggle, control(context, "TOGGLE", 2));
        views.setOnClickPendingIntent(R.id.widget_next, control(context, "NEXT", 3));
        manager.updateAppWidget(ids, views);
    }
    @Override public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        String action = intent.getAction();
        boolean refresh = AppWidgetManager.ACTION_APPWIDGET_UPDATE.equals(action);
        if (!refresh && !(PREFIX + "PREVIOUS").equals(action) && !(PREFIX + "TOGGLE").equals(action)
                && !(PREFIX + "NEXT").equals(action)) return;
        if (refresh) render(context, null);
        PendingResult pending = goAsync();
        Context app = context.getApplicationContext();
        SessionToken token = new SessionToken(app, new ComponentName(app, PlaybackService.class));
        ListenableFuture<MediaController> future = new MediaController.Builder(app, token).buildAsync();
        future.addListener(() -> {
            try {
                MediaController player = future.get();
                if ((PREFIX + "TOGGLE").equals(action)) {
                    if (player.getPlayWhenReady() && player.getPlaybackState() != Player.STATE_ENDED) player.pause();
                    else player.play();
                } else if ((PREFIX + "NEXT").equals(action)) player.seekToNext();
                else if ((PREFIX + "PREVIOUS").equals(action)) player.seekToPrevious();
                render(context, player);
            } catch (Exception unavailable) { render(context, null); }
            finally { MediaController.releaseFuture(future); pending.finish(); }
        }, ContextCompat.getMainExecutor(context));
    }
}
