package com.fitmotion.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/** Keeps the WebView export alive while the app is in the background. */
public class ExportService extends Service {
    public static final String ACTION_START = "com.fitmotion.app.EXPORT_START";
    public static final String ACTION_CANCEL = "com.fitmotion.app.EXPORT_CANCEL";
    public static final String ACTION_STOP = "com.fitmotion.app.EXPORT_STOP";
    public static final String EXTRA_TITLE = "title";
    private static final String CHANNEL = "fit-motion-export";
    private static final int NOTIFICATION_ID = 4101;
    private static volatile boolean active;
    private static volatile boolean cancelRequested;
    private PowerManager.WakeLock wakeLock;

    static boolean isActive() { return active; }
    static boolean isCancelRequested() { return cancelRequested; }

    static void start(Context context, String title) {
        try {
            cancelRequested = false;
            Intent intent = new Intent(context, ExportService.class);
            intent.setAction(ACTION_START);
            intent.putExtra(EXTRA_TITLE, title);
            // Start as a normal service first. The app is in the foreground
            // when export begins; this avoids the strict 5s foreground-start
            // watchdog killing the process if a vendor rejects the notification.
            context.startService(intent);
        } catch (Throwable ignored) {
            // Never let notification policy kill the whole export.
        }
    }

    static void stop(Context context) {
        try {
            Intent intent = new Intent(context, ExportService.class);
            intent.setAction(ACTION_STOP);
            context.startService(intent);
        } catch (Throwable ignored) { }
    }

    static void update(Context context, int percent, String text) {
        try {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;
            ensureChannel(context, manager);
            manager.notify(NOTIFICATION_ID, build(context, Math.max(0, Math.min(100, percent)), text));
        } catch (Throwable ignored) { }
    }

    private static void ensureChannel(Context context, NotificationManager manager) {
        if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "轨迹视频导出", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("显示视频导出进度，可取消导出");
            manager.createNotificationChannel(channel);
        }
    }

    private static Notification build(Context context, int percent, String text) {
        ensureChannel(context, (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE));
        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        open.putExtra(MainActivity.EXTRA_OPEN_EXPORT, true);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent content = PendingIntent.getActivity(context, 0, open, flags);
        Intent cancel = new Intent(context, ExportService.class);
        cancel.setAction(ACTION_CANCEL);
        PendingIntent cancelPending = PendingIntent.getService(context, 1, cancel, flags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(context, CHANNEL)
                : new Notification.Builder(context);
        builder.setContentTitle("正在导出轨迹视频")
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_stat_export)
                .setContentIntent(content)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_PROGRESS)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setStyle(new Notification.BigTextStyle().bigText(text + " · 点击返回导出页面"))
                .setProgress(100, percent, false)
                .addAction(new Notification.Action.Builder(
                        R.drawable.ic_stat_export, "取消导出", cancelPending).build());
        return builder.build();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (manager != null) ensureChannel(this, manager);
        } catch (Throwable ignored) { }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_CANCEL.equals(action)) {
            cancelRequested = true;
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (manager != null) manager.notify(NOTIFICATION_ID, build(this, 0, "正在取消导出…"));
            return START_NOT_STICKY;
        }
        if (ACTION_STOP.equals(action)) {
            active = false;
            cancelRequested = false;
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        active = true;
        cancelRequested = false;
        String title = intent == null ? "轨迹视频" : intent.getStringExtra(EXTRA_TITLE);
        if (title == null) title = "轨迹视频";
        try {
            Notification notification = build(this, 0, "准备导出…");
            startForeground(NOTIFICATION_ID, notification);
        } catch (Throwable error) {
            try {
                Notification.Builder fallbackBuilder = Build.VERSION.SDK_INT >= 26
                        ? new Notification.Builder(this, CHANNEL)
                        : new Notification.Builder(this);
                Notification fallback = fallbackBuilder
                        .setContentTitle("正在导出轨迹视频")
                        .setContentText("导出继续运行")
                        .setSmallIcon(android.R.drawable.stat_sys_download)
                        .setOngoing(true)
                        .build();
                startForeground(NOTIFICATION_ID, fallback);
            } catch (Throwable ignored) {
                // Do not crash the app if the vendor rejects notifications.
                active = false;
                stopSelf();
                return START_NOT_STICKY;
            }
        }
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        if (power != null && wakeLock == null) {
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FitMotion:export");
            wakeLock.acquire(30 * 60 * 1000L);
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        active = false;
        if (wakeLock != null) {
            try { wakeLock.release(); } catch (Exception ignored) { }
            wakeLock = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
