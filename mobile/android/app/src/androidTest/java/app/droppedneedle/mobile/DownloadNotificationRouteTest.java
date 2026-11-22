package app.droppedneedle.mobile;

import static org.junit.Assert.*;
import android.app.Notification;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class DownloadNotificationRouteTest {
    private final Context app = InstrumentationRegistry.getInstrumentation().getTargetContext();

    @Test public void notificationUsesOnlyThePrivateOfflineDestination() throws Exception {
        Intent target = NotificationRoute.Destination.DOWNLOADS.intent(app);
        ActivityInfo alias = app.getPackageManager().getActivityInfo(target.getComponent(), 0);
        assertFalse(alias.exported);
        assertEquals(MainActivity.class.getName(), alias.targetActivity);
        assertNull(target.getData());
        assertNull(target.getExtras());
        Notification first = ManualDownloadScheduler.notification(app, "synthetic-one", 1, 5);
        Notification second = ManualDownloadScheduler.notification(app, "synthetic-two", 0, 3);
        assertEquals(first.contentIntent, second.contentIntent);
        assertEquals(PendingIntent.getActivity(app, 0, target, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_NO_CREATE), first.contentIntent);
        if (Build.VERSION.SDK_INT >= 31) assertTrue(first.contentIntent.isImmutable());
    }

    @Test public void coldWarmAndRestoredTapsAreConsumedOnceAndLeaveOtherIntentsAlone() {
        Intent tap = NotificationRoute.Destination.DOWNLOADS.intent(app);
        NotificationRoute route = new NotificationRoute();
        route.restore(app, tap, null);
        Bundle beforeSignIn = new Bundle();
        route.save(beforeSignIn);
        route = new NotificationRoute();
        route.restore(app, tap, beforeSignIn);
        assertTrue(route.take(NotificationRoute.Destination.DOWNLOADS));
        assertFalse(route.take(NotificationRoute.Destination.DOWNLOADS));
        Bundle afterSignIn = new Bundle();
        route.save(afterSignIn);
        route.restore(app, tap, afterSignIn);
        assertFalse(route.take(NotificationRoute.Destination.DOWNLOADS));
        assertNull(route.receive(app, new Intent(tap).addFlags(Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY)));
        assertNull(route.receive(app, new Intent(Intent.ACTION_MAIN)));
        assertNull(route.receive(app, new Intent(tap).setComponent(new ComponentName(app, MainActivity.class))));
        Uri approval = Uri.parse("app.droppedneedle.mobile://connect/callback#fixture");
        Intent browser = new Intent(Intent.ACTION_VIEW, approval).setComponent(new ComponentName(app, MainActivity.class));
        assertNull(route.receive(app, browser));
        assertEquals(approval, browser.getData());
        assertFalse(route.take(NotificationRoute.Destination.DOWNLOADS));
        assertNotNull(route.receive(app, tap));
        assertNotNull(route.receive(app, tap));
        assertTrue(route.take(NotificationRoute.Destination.DOWNLOADS));
        assertFalse(route.take(NotificationRoute.Destination.DOWNLOADS));
    }

    @Test public void playerTapTakesPrecedenceAndSurvivesActivityRecreation() throws Exception {
        NotificationRoute route = new NotificationRoute();
        Intent tap = NotificationRoute.Destination.PLAYER.intent(app);
        ActivityInfo alias = app.getPackageManager().getActivityInfo(tap.getComponent(), 0);
        assertFalse(alias.exported);
        assertEquals(MainActivity.class.getName(), alias.targetActivity);
        route.restore(app, NotificationRoute.Destination.DOWNLOADS.intent(app), null);
        assertEquals(NotificationRoute.Destination.PLAYER, route.receive(app, tap));
        Bundle state = new Bundle();
        route.save(state);
        route = new NotificationRoute();
        route.restore(app, null, state);
        assertFalse(route.take(NotificationRoute.Destination.DOWNLOADS));
        assertTrue(route.take(NotificationRoute.Destination.PLAYER));
        assertFalse(route.take(NotificationRoute.Destination.PLAYER));
        assertNull(route.receive(app, tap.addFlags(Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY)));
    }

    @Test public void notificationTapReusesTheRunningActivity() throws Exception {
        try (ActivityScenario<MainActivity> screen = ActivityScenario.launch(MainActivity.class)) {
            takeNextTap(screen, NotificationRoute.Destination.DOWNLOADS,
                    ManualDownloadScheduler.notification(app, "synthetic", 1, 2).contentIntent);
        }
    }
    @Test public void anotherTapWorksWhenTheFirstTapCreatedTheActivity() throws Exception {
        Intent first = NotificationRoute.Destination.DOWNLOADS.intent(app);
        try (ActivityScenario<MainActivity> screen = ActivityScenario.launch(first)) {
            screen.onActivity(activity -> assertEquals(first.getComponent(), activity.getIntent().getComponent()));
            takeNextTap(screen, NotificationRoute.Destination.DOWNLOADS,
                    ManualDownloadScheduler.notification(app, "synthetic", 1, 2).contentIntent);
        }
    }
    @Test public void systemMediaSessionOpensNowPlayingInTheRunningActivity() throws Exception {
        try (ActivityScenario<MainActivity> screen = ActivityScenario.launch(MainActivity.class)) {
            SessionToken service = new SessionToken(app, new ComponentName(app, PlaybackService.class));
            MediaController controller = new MediaController.Builder(app, service).buildAsync()
                    .get(10, TimeUnit.SECONDS);
            try {
                AtomicReference<PendingIntent> tap = new AtomicReference<>();
                screen.onActivity(activity -> tap.set(controller.getSessionActivity()));
                assertEquals(NotificationRoute.Destination.PLAYER.pendingIntent(app), tap.get());
                takeNextTap(screen, NotificationRoute.Destination.PLAYER, tap.get());
            } finally {
                InstrumentationRegistry.getInstrumentation().runOnMainSync(controller::release);
            }
        }
    }

    private void takeNextTap(ActivityScenario<MainActivity> screen, NotificationRoute.Destination destination,
                             PendingIntent tap) throws Exception {
        // The native fixture consumes the route itself, independent of the app's signed-in state.
        screen.onActivity(activity -> {
            activity.getBridge().getWebView().getSettings().setJavaScriptEnabled(false);
            activity.notifications.take(destination);
        });
        tap.send();
        AtomicBoolean delivered = new AtomicBoolean();
        long end = SystemClock.elapsedRealtime() + 8000;
        while (!delivered.get() && SystemClock.elapsedRealtime() < end) {
            screen.onActivity(activity -> delivered.set(activity.notifications.take(destination)));
            if (!delivered.get()) SystemClock.sleep(50);
        }
        assertTrue("The notification did not reach the running activity", delivered.get());
        screen.onActivity(activity -> assertFalse(activity.notifications.take(destination)));
    }
}
