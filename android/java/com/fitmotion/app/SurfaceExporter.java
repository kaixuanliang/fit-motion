package com.fitmotion.app;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.view.PixelCopy;
import android.view.Window;

import java.io.File;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Hybrid hardware-encode export (Phase 1 of the native route).
 *
 * The WebView keeps rendering frames, so the visuals stay 1:1 with the
 * WebCodecs path. For each frame the JS side renders and then calls into this
 * class: PixelCopy grabs the composited window region into a reused Bitmap
 * (the platform's GPU screenshot path, with no canvas readback inside JS),
 * the bitmap is uploaded and stretched onto MediaCodec's hardware H.264 input
 * Surface, and MediaMuxer writes the MP4.
 *
 * Compared with the old /frame HTTP route this removes the per-frame
 * getImageData readback and the 8 MB HTTP transfer; the remaining per-frame
 * cost is render + composited capture + one texture upload.
 */
final class SurfaceExporter {
    private final Activity activity;
    private NativeEncoder encoder;
    private Bitmap capture;
    private File outputFile;
    private String lastError = "";
    private int frames;

    SurfaceExporter(Activity activity) {
        this.activity = activity;
    }

    synchronized boolean start(int width, int height, int bitrate, int fps,
                               int left, int top, int right, int bottom) {
        lastError = "";
        frames = 0;
        try {
            if (right - left <= 0 || bottom - top <= 0) throw new Exception("采集区域无效");
            outputFile = new File(activity.getCacheDir(),
                    "fit-motion-surface-" + System.currentTimeMillis() + ".mp4");
            encoder = new NativeEncoder(width, height, bitrate, fps, outputFile);
            encoder.start();
            capture = Bitmap.createBitmap(right - left, bottom - top, Bitmap.Config.ARGB_8888);
            return true;
        } catch (Exception error) {
            lastError = error.getMessage() == null ? "编码器启动失败" : error.getMessage();
            cleanup();
            return false;
        }
    }

    /** Called from the JS bridge thread; blocks until the frame is encoded. */
    synchronized boolean copyFrame(int left, int top, int right, int bottom, int index) {
        if (encoder == null || capture == null) {
            lastError = "导出未启动";
            return false;
        }
        final Rect rect = new Rect(left, top, right, bottom);
        final CountDownLatch latch = new CountDownLatch(1);
        final AtomicBoolean copied = new AtomicBoolean(false);
        try {
            PixelCopy.request(activity.getWindow(), rect, capture,
                    new PixelCopy.OnPixelCopyFinishedListener() {
                        @Override
                        public void onPixelCopyFinished(int result) {
                            copied.set(result == PixelCopy.SUCCESS);
                            latch.countDown();
                        }
                    },
                    new Handler(Looper.getMainLooper()));
        } catch (Exception error) {
            lastError = error.getMessage() == null ? "PixelCopy 异常" : error.getMessage();
            return false;
        }
        try {
            if (!latch.await(3, TimeUnit.SECONDS)) {
                lastError = "PixelCopy 超时";
                return false;
            }
        } catch (InterruptedException error) {
            lastError = "抓帧被中断";
            return false;
        }
        if (!copied.get()) {
            lastError = "PixelCopy 失败";
            return false;
        }
        try {
            encoder.encodeBitmap(capture, index);
            frames += 1;
            return true;
        } catch (Exception error) {
            lastError = error.getMessage() == null ? "编码帧失败" : error.getMessage();
            return false;
        }
    }

    /** Finishes encoding, muxes and saves to MediaStore; returns the uri or "". */
    synchronized String finish() {
        if (encoder == null) {
            lastError = "导出未启动";
            return "";
        }
        try {
            File file = encoder.finish();
            return NativeFrameServer.saveNativeVideo(activity.getApplicationContext(), file);
        } catch (Exception error) {
            lastError = error.getMessage() == null ? "封装失败" : error.getMessage();
            return "";
        } finally {
            cleanup();
        }
    }

    synchronized void abort() {
        cleanup();
    }

    synchronized int frameCount() {
        return frames;
    }

    synchronized String lastError() {
        return lastError;
    }

    private void cleanup() {
        if (encoder != null) {
            try { encoder.abort(); } catch (Exception ignored) { }
            encoder = null;
        }
        if (capture != null) {
            capture.recycle();
            capture = null;
        }
        if (outputFile != null) {
            outputFile.delete();
            outputFile = null;
        }
    }
}
