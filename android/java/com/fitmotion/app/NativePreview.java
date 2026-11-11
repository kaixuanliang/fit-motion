package com.fitmotion.app;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.opengl.EGL14;
import android.opengl.EGLConfig;
import android.opengl.EGLContext;
import android.opengl.EGLDisplay;
import android.opengl.EGLSurface;
import android.opengl.GLES20;
import android.util.Base64;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Renders a few still frames of the native scene into one PNG strip.
 *
 * Visual iteration used to cost a full 20 s export per look. Opening an
 * offscreen pbuffer, drawing three key frames and reading them back takes
 * about a second, so layout can be checked before committing to a video.
 */
final class NativePreview {
    private NativePreview() { }

    static JSONObject render(Context context, String payloadJson) throws Exception {
        JSONObject payload = new JSONObject(payloadJson);
        int width = payload.optInt("width", 1080);
        int height = payload.optInt("height", 1920);
        int fps = payload.optInt("fps", 30);
        double duration = payload.optDouble("durationSec", 38);
        int totalFrames = Math.max(1, (int) Math.ceil(duration * fps));
        float[] ratios = new float[]{0.01f, 0.34f, 0.62f, 0.99f};

        long started = System.currentTimeMillis();
        boolean globalView = payload.optBoolean("globalView", false);
        NativeVectorMap follow = new NativeVectorMap(payload, context.getCacheDir(),
                NativeVectorMap.FOLLOW_ZOOM, false, !globalView);
        NativeVectorMap overview = new NativeVectorMap(payload, context.getCacheDir(),
                NativeRenderJob.overviewZoom(payload), true);
        long tileMs = System.currentTimeMillis() - started;

        OffscreenGl gl = new OffscreenGl(width, height);
        try {
            NativeRouteScene scene = new NativeRouteScene(payload, follow, overview, width, height, fps);
            Bitmap[] shots = new Bitmap[ratios.length];
            for (int i = 0; i < ratios.length; i += 1) {
                int frame = Math.round(ratios[i] * (totalFrames - 1));
                scene.draw(width, height, frame, totalFrames);
                GLES20.glFinish();
                shots[i] = readPixels(width, height);
            }
            Bitmap strip = compose(shots, 300);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            strip.compress(Bitmap.CompressFormat.PNG, 92, out);
            String base64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);

            JSONObject response = new JSONObject();
            response.put("ok", true);
            response.put("image", "data:image/png;base64," + base64);
            response.put("tileMs", tileMs);
            response.put("totalMs", System.currentTimeMillis() - started);
            response.put("routeMsPerFrame", Math.round(scene.routeMs / (double) ratios.length * 10) / 10.0);
            response.put("tileDrawMsPerFrame", Math.round(scene.tileMs / (double) ratios.length * 10) / 10.0);
            response.put("hudMsPerFrame", Math.round(scene.hudMs / (double) ratios.length * 10) / 10.0);
            return response;
        } finally {
            gl.release();
        }
    }

    private static Bitmap readPixels(int width, int height) {
        ByteBuffer buffer = ByteBuffer.allocateDirect(width * height * 4).order(ByteOrder.nativeOrder());
        GLES20.glReadPixels(0, 0, width, height, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, buffer);
        buffer.rewind();
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        // GL rows start at the bottom; flip while copying so the PNG is upright.
        byte[] row = new byte[width * 4];
        ByteBuffer target = ByteBuffer.allocate(width * height * 4);
        for (int y = height - 1; y >= 0; y -= 1) {
            buffer.position(y * width * 4);
            buffer.get(row, 0, width * 4);
            target.put(row);
        }
        target.rewind();
        bitmap.copyPixelsFromBuffer(target);
        return bitmap;
    }

    private static Bitmap compose(Bitmap[] shots, int cellWidth) {
        int cellHeight = Math.round(cellWidth * shots[0].getHeight() / (float) shots[0].getWidth());
        int gap = 14;
        int width = shots.length * cellWidth + (shots.length - 1) * gap;
        Bitmap strip = Bitmap.createBitmap(width, cellHeight, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(strip);
        canvas.drawColor(Color.rgb(10, 14, 18));
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setFilterBitmap(true);
        for (int i = 0; i < shots.length; i += 1) {
            int left = i * (cellWidth + gap);
            canvas.drawBitmap(shots[i], new Rect(0, 0, shots[i].getWidth(), shots[i].getHeight()),
                    new Rect(left, 0, left + cellWidth, cellHeight), paint);
            shots[i].recycle();
        }
        return strip;
    }

    /** Minimal EGL pbuffer wrapper: enough to run the scene without MediaCodec. */
    private static final class OffscreenGl {
        private EGLDisplay display;
        private EGLContext context;
        private EGLSurface surface;

        OffscreenGl(int width, int height) throws Exception {
            display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
            if (display == EGL14.EGL_NO_DISPLAY) throw new IllegalStateException("没有 EGL display");
            int[] version = new int[2];
            if (!EGL14.eglInitialize(display, version, 0, version, 1)) {
                throw new IllegalStateException("EGL 初始化失败");
            }
            int[] configAttributes = {
                    EGL14.EGL_SURFACE_TYPE, EGL14.EGL_PBUFFER_BIT,
                    EGL14.EGL_RED_SIZE, 8,
                    EGL14.EGL_GREEN_SIZE, 8,
                    EGL14.EGL_BLUE_SIZE, 8,
                    EGL14.EGL_ALPHA_SIZE, 8,
                    EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
                    EGL14.EGL_NONE
            };
            EGLConfig[] configs = new EGLConfig[1];
            int[] count = new int[1];
            if (!EGL14.eglChooseConfig(display, configAttributes, 0, configs, 0, 1, count, 0) || count[0] == 0) {
                throw new IllegalStateException("没有可用的 EGL config");
            }
            int[] contextAttributes = {EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE};
            context = EGL14.eglCreateContext(display, configs[0], EGL14.EGL_NO_CONTEXT, contextAttributes, 0);
            if (context == EGL14.EGL_NO_CONTEXT) throw new IllegalStateException("EGL context 创建失败");
            int[] surfaceAttributes = {EGL14.EGL_WIDTH, width, EGL14.EGL_HEIGHT, height, EGL14.EGL_NONE};
            surface = EGL14.eglCreatePbufferSurface(display, configs[0], surfaceAttributes, 0);
            if (surface == EGL14.EGL_NO_SURFACE) throw new IllegalStateException("EGL pbuffer 创建失败");
            if (!EGL14.eglMakeCurrent(display, surface, surface, context)) {
                throw new IllegalStateException("EGL makeCurrent 失败");
            }
        }

        void release() {
            try {
                EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
                if (surface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, surface);
                if (context != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display, context);
                EGL14.eglTerminate(display);
            } catch (Exception ignored) { }
        }
    }
}
