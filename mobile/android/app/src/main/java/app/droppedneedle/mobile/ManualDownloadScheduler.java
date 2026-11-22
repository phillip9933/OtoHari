package app.droppedneedle.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PersistableBundle;
import androidx.core.app.NotificationCompat;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import java.io.IOException;

final class ManualDownloadScheduler implements ManualDownloads.Scheduler {
    private static final int FIRST = 0x444e10, SECOND = FIRST + 1;
    static final int NOTIFICATION = 0x444e23;
    static final String OWNER = "owner";
    static final String CHANNEL = "offline-downloads";
    private final Context context;

    ManualDownloadScheduler(Context context) { this.context = context; }
    @Override public void start(OfflineStore store, boolean replace) throws Exception {
        if (Build.VERSION.SDK_INT < 34) {
            Constraints rules = new Constraints.Builder().setRequiredNetworkType(
                    store.unmeteredOnly() ? NetworkType.UNMETERED : NetworkType.CONNECTED).build();
            OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(ManualDownloadWorker.class)
                    .setConstraints(rules).setInputData(new Data.Builder().putString(OWNER, store.account).build()).build();
            WorkManager.getInstance(context).enqueueUniqueWork("manual-" + store.account,
                    replace ? ExistingWorkPolicy.REPLACE : ExistingWorkPolicy.APPEND_OR_REPLACE, work).getResult().get();
            return;
        }
        JobScheduler jobs = context.getSystemService(JobScheduler.class);
        if (replace) cancel(store.account);
        // Reserve a successor before an active job can finish. Another tap can replace that successor.
        int id = ManualDownloadJob.runningId == FIRST ? SECOND : FIRST;
        PersistableBundle input = new PersistableBundle();
        input.putString(OWNER, store.account);
        JobInfo.Builder job = new JobInfo.Builder(id, new ComponentName(context, ManualDownloadJob.class))
                .setExtras(input).setPersisted(true).setRequiredNetworkType(
                        store.unmeteredOnly() ? JobInfo.NETWORK_TYPE_UNMETERED : JobInfo.NETWORK_TYPE_ANY);
        // Android can revoke visible scheduling eligibility while a large selection is admitted.
        // A regular constrained job can still drain the same journal when the OS grants time.
        try {
            if (jobs.schedule(job.setUserInitiated(true).build()) == JobScheduler.RESULT_SUCCESS) return;
        } catch (IllegalStateException | SecurityException backgrounded) { /* Try ordinary scheduling below. */ }
        if (jobs.schedule(job.setUserInitiated(false).build()) != JobScheduler.RESULT_SUCCESS)
            throw new IOException("Android could not schedule the downloads.");
    }
    @Override public boolean pending(String owner) throws Exception {
        if (Build.VERSION.SDK_INT < 34) {
            for (androidx.work.WorkInfo work : WorkManager.getInstance(context).getWorkInfosForUniqueWork("manual-" + owner).get())
                if (!work.getState().isFinished()) return true;
            return false;
        }
        JobScheduler jobs = context.getSystemService(JobScheduler.class);
        for (int id : new int[]{FIRST, SECOND}) {
            JobInfo job = jobs.getPendingJob(id);
            if (job != null && owner.equals(job.getExtras().getString(OWNER))) return true;
        }
        return false;
    }
    @Override public void cancel(String owner) {
        if (Build.VERSION.SDK_INT < 34) {
            WorkManager.getInstance(context).cancelUniqueWork("manual-" + owner);
            return;
        }
        JobScheduler jobs = context.getSystemService(JobScheduler.class);
        for (int id : new int[]{FIRST, SECOND}) {
            JobInfo job = jobs.getPendingJob(id);
            if (job != null && owner.equals(job.getExtras().getString(OWNER))) jobs.cancel(id);
        }
    }
    static Notification notification(Context ctx, String owner, int done, int total) {
        if (Build.VERSION.SDK_INT >= 26) ctx.getSystemService(NotificationManager.class).createNotificationChannel(
                new NotificationChannel(CHANNEL, ctx.getString(R.string.offline_downloads), NotificationManager.IMPORTANCE_LOW));
        Intent cancel = new Intent(ctx, ManualDownloadCancel.class).setData(new Uri.Builder()
                .scheme("dn-download").authority("cancel").appendPath(owner).build());
        PendingIntent action = PendingIntent.getBroadcast(ctx, 0, cancel, PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder notification = new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download).setOngoing(true).setOnlyAlertOnce(true)
                .setContentTitle(ctx.getString(R.string.saving_offline)).addAction(0, ctx.getString(android.R.string.cancel), action)
                .setContentIntent(NotificationRoute.Destination.DOWNLOADS.pendingIntent(ctx));
        if (total > 0) notification.setContentText(ctx.getString(R.string.download_progress, done, total));
        notification.setProgress(total, done, total == 0);
        return notification.build();
    }
}
