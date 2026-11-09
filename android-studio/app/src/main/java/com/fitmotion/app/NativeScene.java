package com.fitmotion.app;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.opengl.GLES20;
import android.opengl.GLUtils;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Phase 1 native scene: OpenGL gradient/grid, route, current point and a static
 * HUD texture. The production map/tiles/labels are intentionally not ported yet;
 * this scene exists to measure native render + MediaCodec throughput without
 * any WebView frame transfer.
 */
interface NativeScene {
    void draw(int width, int height, int frameIndex, int totalFrames);
}

final class NativeRouteScene implements NativeScene {
    private final int width;
    private final int height;
    private final float[] xs;
    private final float[] ys;
    private final float[] lat;
    private final float[] lon;
    private final NativeVectorMap map;
    private final String title;
    private final String distance;
    private final String speed;
    private final String heart;
    private final String altitude;
    private final String duration;
    private final int accent;

    private int colorProgram;
    private int colorPosition;
    private int colorValue;
    private int textureProgram;
    private int texturePosition;
    private int textureCoord;
    private int textureSampler;
    private int hudTexture = -1;
    private FloatBuffer hudQuad;
    private FloatBuffer hudTex;

    NativeRouteScene(JSONObject payload, int width, int height) throws Exception {
        this(payload, width, height, null);
    }

    NativeRouteScene(JSONObject payload, int width, int height, NativeVectorMap map) throws Exception {
        this.width = width;
        this.map = map;
        this.height = height;
        JSONArray points = payload.optJSONArray("points");
        int count = points == null ? 0 : points.length();
        xs = new float[Math.max(2, count)];
        ys = new float[Math.max(2, count)];
        lat = new float[Math.max(2, count)];
        lon = new float[Math.max(2, count)];
        double minLat = Double.MAX_VALUE;
        double maxLat = -Double.MAX_VALUE;
        double minLon = Double.MAX_VALUE;
        double maxLon = -Double.MAX_VALUE;
        for (int i = 0; i < count; i += 1) {
            JSONArray point = points.getJSONArray(i);
            double pointLat = point.getDouble(0);
            double pointLon = point.getDouble(1);
            lat[i] = (float) pointLat;
            lon[i] = (float) pointLon;
            minLat = Math.min(minLat, pointLat);
            maxLat = Math.max(maxLat, pointLat);
            minLon = Math.min(minLon, pointLon);
            maxLon = Math.max(maxLon, pointLon);
        }
        if (count == 0) {
            xs[0] = 0.5f; ys[0] = 0.5f; xs[1] = 0.5f; ys[1] = 0.5f;
            lat[0] = 39.9f; lon[0] = 116.4f; lat[1] = 39.9f; lon[1] = 116.4f;
        } else {
            double latSpan = Math.max(0.00001, maxLat - minLat);
            double lonSpan = Math.max(0.00001, maxLon - minLon);
            for (int i = 0; i < count; i += 1) {
                JSONArray point = points.getJSONArray(i);
                double nx = (point.getDouble(1) - minLon) / lonSpan;
                double ny = 1.0 - (point.getDouble(0) - minLat) / latSpan;
                xs[i] = (float) (90 + nx * 900);
                ys[i] = (float) (280 + ny * 1080);
            }
        }
        title = payload.optString("title", "我的骑行");
        distance = payload.optString("distance", "");
        speed = payload.optString("maxSpeed", "");
        heart = payload.optString("maxHeart", "");
        altitude = payload.optString("maxAltitude", "");
        duration = payload.optString("duration", "");
        String theme = payload.optString("theme", "tech");
        accent = "bright".equals(theme) ? 0xFF5A7D22 : 0xFFD8FF3E;
        hudQuad = floatBuffer(new float[]{-1, -1, 1, -1, -1, 1, 1, 1});
        hudTex = floatBuffer(new float[]{0, 1, 1, 1, 0, 0, 1, 0});
    }

    @Override
    public void draw(int width, int height, int frameIndex, int totalFrames) {
        ensureGl();
        float progress = totalFrames <= 1 ? 1f : frameIndex / (float) (totalFrames - 1);
        GLES20.glViewport(0, 0, width, height);
        if (map != null && map.available()) {
            map.update(progress);
            map.draw();
            float[] projected = map.projectRoute(progress);
            for (int i = 0; i < xs.length && i * 2 + 1 < projected.length; i += 1) {
                xs[i] = projected[i * 2];
                ys[i] = projected[i * 2 + 1];
            }
        } else {
            GLES20.glClearColor(0.02f, 0.055f, 0.055f, 1f);
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
            drawGrid();
        }
        drawRoute(progress);
        drawPoint(progress);
        drawHud();
    }

    private void ensureGl() {
        if (colorProgram != 0) return;
        String vs = "attribute vec2 aPos; attribute vec4 aColor; varying vec4 vColor;"
                + "void main(){gl_Position=vec4(aPos,0.0,1.0);vColor=aColor;}";
        String fs = "precision mediump float; varying vec4 vColor; void main(){gl_FragColor=vColor;}";
        colorProgram = link(vs, fs);
        colorPosition = GLES20.glGetAttribLocation(colorProgram, "aPos");
        colorValue = GLES20.glGetAttribLocation(colorProgram, "aColor");
        String tvs = "attribute vec2 aPos; attribute vec2 aTex; varying vec2 vTex;"
                + "void main(){gl_Position=vec4(aPos,0.0,1.0);vTex=aTex;}";
        String tfs = "precision mediump float; varying vec2 vTex; uniform sampler2D uTex;"
                + "void main(){gl_FragColor=texture2D(uTex,vTex);}";
        textureProgram = link(tvs, tfs);
        texturePosition = GLES20.glGetAttribLocation(textureProgram, "aPos");
        textureCoord = GLES20.glGetAttribLocation(textureProgram, "aTex");
        textureSampler = GLES20.glGetUniformLocation(textureProgram, "uTex");
        hudTexture = buildHudTexture();
    }

    private int link(String vertex, String fragment) {
        int vs = GLES20.glCreateShader(GLES20.GL_VERTEX_SHADER);
        GLES20.glShaderSource(vs, vertex);
        GLES20.glCompileShader(vs);
        int fs = GLES20.glCreateShader(GLES20.GL_FRAGMENT_SHADER);
        GLES20.glShaderSource(fs, fragment);
        GLES20.glCompileShader(fs);
        int program = GLES20.glCreateProgram();
        GLES20.glAttachShader(program, vs);
        GLES20.glAttachShader(program, fs);
        GLES20.glLinkProgram(program);
        return program;
    }

    private void drawGrid() {
        float[] data = new float[200];
        int cursor = 0;
        for (int i = 0; i <= 7; i += 1) {
            float y = (i / 8f) * 2f - 1f;
            data[cursor++] = -1f; data[cursor++] = y; data[cursor++] = 0.08f; data[cursor++] = 0.18f; data[cursor++] = 0.16f; data[cursor++] = 1f;
            data[cursor++] = 1f; data[cursor++] = y; data[cursor++] = 0.08f; data[cursor++] = 0.18f; data[cursor++] = 0.16f; data[cursor++] = 1f;
        }
        for (int i = 0; i <= 4; i += 1) {
            float x = (i / 4f) * 2f - 1f;
            data[cursor++] = x; data[cursor++] = -1f; data[cursor++] = 0.08f; data[cursor++] = 0.18f; data[cursor++] = 0.16f; data[cursor++] = 1f;
            data[cursor++] = x; data[cursor++] = 1f; data[cursor++] = 0.08f; data[cursor++] = 0.18f; data[cursor++] = 0.16f; data[cursor++] = 1f;
        }
        drawColor(new FloatBuffer[]{floatBuffer(data)}, new int[]{data.length / 6}, GLES20.GL_LINES);
    }

    private void drawRoute(float progress) {
        int count = Math.min(xs.length, Math.max(2, Math.round(xs.length * progress)));
        if (count < 2) return;
        float[] full = new float[(xs.length - 1) * 36];
        int cursor = 0;
        for (int i = 1; i < xs.length; i += 1) {
            cursor = addSegment(full, cursor, xs[i - 1], ys[i - 1], xs[i], ys[i], 0.14f, 0.28f, 0.22f);
        }
        drawColor(new FloatBuffer[]{floatBuffer(full)}, new int[]{cursor / 6}, GLES20.GL_TRIANGLES);
        float[] active = new float[(count - 1) * 36];
        cursor = 0;
        for (int i = 1; i < count; i += 1) {
            cursor = addSegment(active, cursor, xs[i - 1], ys[i - 1], xs[i], ys[i], 0.85f, 1f, 0.24f);
        }
        drawColor(new FloatBuffer[]{floatBuffer(active)}, new int[]{cursor / 6}, GLES20.GL_TRIANGLES);
    }

    private int addSegment(float[] out, int cursor, float x1, float y1, float x2, float y2, float r, float g, float b) {
        float sx1 = x1 / width * 2f - 1f;
        float sy1 = 1f - y1 / height * 2f;
        float sx2 = x2 / width * 2f - 1f;
        float sy2 = 1f - y2 / height * 2f;
        float dx = sx2 - sx1;
        float dy = sy2 - sy1;
        float len = Math.max(0.00001f, (float) Math.hypot(dx, dy));
        float nx = -dy / len * 7f / width * 2f;
        float ny = dx / len * 7f / width * 2f;
        float[][] points = {
                {sx1 + nx, sy1 + ny}, {sx1 - nx, sy1 - ny}, {sx2 + nx, sy2 + ny},
                {sx2 + nx, sy2 + ny}, {sx1 - nx, sy1 - ny}, {sx2 - nx, sy2 - ny},
        };
        for (float[] point : points) {
            out[cursor++] = point[0];
            out[cursor++] = point[1];
            out[cursor++] = r;
            out[cursor++] = g;
            out[cursor++] = b;
            out[cursor++] = 1f;
        }
        return cursor;
    }

    private void drawPoint(float progress) {
        int index = Math.min(xs.length - 1, Math.max(0, Math.round((xs.length - 1) * progress)));
        float cx = xs[index] / width * 2f - 1f;
        float cy = 1f - ys[index] / height * 2f;
        float rx = 18f / width * 2f;
        float ry = 18f / height * 2f;
        float[] data = new float[30 * 18];
        int cursor = 0;
        for (int i = 0; i < 30; i += 1) {
            float a = (float) (i * Math.PI * 2 / 30);
            float b = (float) ((i + 1) * Math.PI * 2 / 30);
            data[cursor++] = cx; data[cursor++] = cy; data[cursor++] = 0.85f; data[cursor++] = 1f; data[cursor++] = 0.25f; data[cursor++] = 1f;
            data[cursor++] = cx + (float) Math.cos(a) * rx; data[cursor++] = cy + (float) Math.sin(a) * ry; data[cursor++] = 1f; data[cursor++] = 1f; data[cursor++] = 0.95f; data[cursor++] = 1f;
            data[cursor++] = cx + (float) Math.cos(b) * rx; data[cursor++] = cy + (float) Math.sin(b) * ry; data[cursor++] = 1f; data[cursor++] = 1f; data[cursor++] = 0.95f; data[cursor++] = 1f;
        }
        drawColor(new FloatBuffer[]{floatBuffer(data)}, new int[]{cursor / 6}, GLES20.GL_TRIANGLES);
    }

    private void drawColor(FloatBuffer[] buffers, int[] counts, int mode) {
        GLES20.glUseProgram(colorProgram);
        for (int i = 0; i < buffers.length; i += 1) {
            GLES20.glEnableVertexAttribArray(colorPosition);
            GLES20.glVertexAttribPointer(colorPosition, 2, GLES20.GL_FLOAT, false, 24, buffers[i]);
            buffers[i].position(2);
            GLES20.glEnableVertexAttribArray(colorValue);
            GLES20.glVertexAttribPointer(colorValue, 4, GLES20.GL_FLOAT, false, 24, buffers[i]);
            GLES20.glDrawArrays(mode, 0, counts[i]);
            GLES20.glDisableVertexAttribArray(colorPosition);
            GLES20.glDisableVertexAttribArray(colorValue);
        }
    }

    private void drawHud() {
        if (hudTexture <= 0) return;
        GLES20.glEnable(GLES20.GL_BLEND);
        GLES20.glBlendFunc(GLES20.GL_SRC_ALPHA, GLES20.GL_ONE_MINUS_SRC_ALPHA);
        GLES20.glUseProgram(textureProgram);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, hudTexture);
        GLES20.glUniform1i(textureSampler, 0);
        GLES20.glEnableVertexAttribArray(texturePosition);
        GLES20.glVertexAttribPointer(texturePosition, 2, GLES20.GL_FLOAT, false, 0, hudQuad);
        GLES20.glEnableVertexAttribArray(textureCoord);
        GLES20.glVertexAttribPointer(textureCoord, 2, GLES20.GL_FLOAT, false, 0, hudTex);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        GLES20.glDisableVertexAttribArray(texturePosition);
        GLES20.glDisableVertexAttribArray(textureCoord);
        GLES20.glDisable(GLES20.GL_BLEND);
    }

    private int buildHudTexture() {
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        paint.setColor(0xFFEFFFE8);
        paint.setTextSize(44);
        canvas.drawText(title, 54, 132, paint);
        paint.setTextSize(22);
        paint.setColor(0xFF9EAF9E);
        canvas.drawText("NATIVE OPENGL · PHASE 1", 56, 174, paint);
        paint.setTextSize(18);
        canvas.drawText("距离 " + distance + " 公里", 56, 1570, paint);
        canvas.drawText("最快 " + speed + " 公里/小时", 56, 1604, paint);
        canvas.drawText("最高心率 " + heart + " 次/分钟", 56, 1638, paint);
        canvas.drawText("最高海拔 " + altitude + " 米", 56, 1672, paint);
        canvas.drawText("时长 " + duration, 56, 1706, paint);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(3);
        paint.setColor(accent);
        canvas.drawLine(54, 1480, width - 54, 1480, paint);
        int[] texture = new int[1];
        GLES20.glGenTextures(1, texture, 0);
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture[0]);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
        GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bitmap, 0);
        bitmap.recycle();
        return texture[0];
    }

    private FloatBuffer floatBuffer(float[] values) {
        FloatBuffer buffer = ByteBuffer.allocateDirect(values.length * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
        buffer.put(values).position(0);
        return buffer;
    }
}

final class NativeRenderJob {
    static JSONObject render(Context context, String payloadJson) throws Exception {
        JSONObject payload = new JSONObject(payloadJson);
        int width = payload.optInt("width", 1080);
        int height = payload.optInt("height", 1920);
        int fps = payload.optInt("fps", 30);
        double duration = payload.optDouble("durationSec", 38.0);
        int totalFrames = Math.max(1, (int) Math.ceil(duration * fps));
        File temp = new File(context.getCacheDir(), "fit-motion-native-scene-" + System.currentTimeMillis() + ".mp4");
        long started = SystemClock.elapsedRealtime();
        NativeVectorMap map = new NativeVectorMap(payload, width, height, payload.optString("theme", "tech"));
        NativeEncoder encoder = new NativeEncoder(width, height, 4_000_000, fps, temp);
        NativeRouteScene scene = new NativeRouteScene(payload, width, height, map);
        try {
            encoder.start();
            for (int i = 0; i < totalFrames; i += 1) {
                encoder.encodeScene(scene, i, totalFrames);
            }
            File result = encoder.finish();
            long elapsed = SystemClock.elapsedRealtime() - started;
            String uri = NativeFrameServer.saveNativeVideo(context, result);
            result.delete();
            JSONObject response = new JSONObject();
            response.put("ok", true);
            response.put("uri", uri);
            response.put("seconds", elapsed / 1000.0);
            response.put("frames", totalFrames);
            response.put("fps", totalFrames / Math.max(0.001, elapsed / 1000.0));
            response.put("mapTiles", map.tileCount());
            response.put("mapFeatures", map.featureCount());
            return response;
        } catch (Exception error) {
            try { encoder.abort(); } catch (Exception ignored) { }
            throw error;
        }
    }
}
