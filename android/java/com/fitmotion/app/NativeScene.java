package com.fitmotion.app;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;
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
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Native renderer (Phase 2). Draws the whole 1080x1920 scene on the GPU and
 * feeds MediaCodec's input Surface directly: no WebView, no frame readback and
 * no per-frame JNI round trip.
 *
 * The shot is cut into three phases like the Canvas renderer: a whole-route
 * cover, the first-person run (which freezes on the ride's key moments), and an
 * outro that pulls back to the whole route while the result card fades in.
 * A low-zoom tile set draws the cover and outro, the z14 corridor set draws the
 * run; both share one camera expressed in z14 pixels.
 */
interface NativeScene {
    void draw(int width, int height, int frameIndex, int totalFrames);
}

final class NativeRouteScene implements NativeScene {
    private static final int ROUTE_CORE = 9;
    private static final int ROUTE_CASE = 16;
    private static final int ROUTE_GLOW = 26;

    private static final float COVER_SECONDS = 1.0f;
    private static final float INTRO_SECONDS = 0.8f;
    private static final float OUTRO_SECONDS = 4.0f;
    private static final float PAUSE_SECONDS = 1.4f;

    private final int width;
    private final int height;
    private final int fps;
    private final int totalFrames;
    private float[] xs;
    private float[] ys;
    private float[] cumulative;
    private final double totalDistance;
    private final float followScale;
    private final int followTilePx;
    private final float fitScale;
    private final float fitCamX;
    private final float fitCamY;
    private int overviewTilePx;
    /** Overview tiles a single poster viewport needs, kept for cache sizing. */
    private int overviewTileCount;
    private final float overviewRatio;
    private final float followAnchor;
    private final float fitAnchor;
    private final float[] routeColors = new float[16];
    private final int accent;
    private final int accent2;
    private final int textColor;
    private final int mutedColor;
    private final int glassColor;
    private final int stageBg;
    private final int background;
    private final String title;
    private final String subtitle;
    private final String place;
    private final String startText;
    private final String avgSpeedText;
    private final String caloriesText;
    private final double activitySeconds;
    /** 运动时长（不含停留），尾页数据卡与 H5 口径一致 */
    private final double movingSeconds;
    /** 总时长（含停留）；没有时间戳时 elapsedAvailable=false，尾页不显示这一项 */
    private final double elapsedSeconds;
    private final boolean elapsedAvailable;
    private final String heart;
    private final String maxSpeedText;
    private final String maxAltitudeText;
    private final double totalMeters;
    /**
     * 展示用总里程。合并行程（多日 / 同一条路线多刷）只播放一遍几何，但
     * HUD 与成绩卡要显示真实总量，因此可能大于 totalMeters。
     */
    private final double displayMeters;
    /** 真实时长 ÷ 播放时长：HUD 计时按它放大，避免「518km 只用了 8 小时」。 */
    private final double timeScale;
    private final float[] speedSeries;
    private final float[] speedNorm;
    private final float[] heartSeries;

    // Speed-curve geometry is built once. A 200 km ride carries tens of
    // thousands of samples, and rebuilding a path with one lineTo per sample —
    // three times per HUD refresh, with a blurred shadow on top — was the
    // single most expensive thing in the export. The curve is 972 px wide, so
    // a few hundred samples are already sub-pixel; the rest is pure waste.
    private static final int SPEED_SAMPLES = 320;
    private float[] speedCurveX = new float[0];
    private float[] speedCurveY = new float[0];
    private float[] lats;
    private float[] lons;

    private final NativeVectorMap follow;
    private final NativeVectorMap overview;

    // Kilometre chips along the route: one dot per km plus a pre-rendered
    // number texture, so a frame costs a handful of extra quads.
    private static final int KM_CELL = 72;
    private static final int KM_COLS = 6;
    private final int[] kmValues;
    private final float[] kmT;
    private Bitmap kmAtlas;
    private int kmAtlasTexture;
    private int kmAtlasRows;

    // Timeline: alternating travel segments and moment freezes.
    private final Moment[] moments;
    private int[] segStart;
    private int[] segEnd;
    private float[] segP0;
    private float[] segP1;
    private int[] segMoment;
    private int segCount;
    private int coverEnd;
    private int introEnd;
    private int outroStart;

    private int colorProgram;
    private int colorPosition;
    private int colorValue;
    private int colorViewport;
    private int textureProgram;
    private int texturePosition;
    private int textureCoord;
    private int textureSampler;
    private int textureViewport;
    private int textureOrigin;
    private int textureSize;
    private int textureAlpha;

    private FloatBuffer unitQuad;
    private FloatBuffer unitTex;
    private FloatBuffer regionTex;
    private float[] vertexBuffer = new float[1 << 17];
    private int vertexCursor;
    private FloatBuffer uploadBuffer;

    private final Bitmap hudTop;
    private final Bitmap hudBottom;
    private final Bitmap hudResult;
    private int hudTopTexture;
    private int hudBottomTexture;
    private int hudResultTexture;
    private final Canvas hudTopCanvas;
    private final Canvas hudBottomCanvas;
    private final Canvas hudResultCanvas;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF rect = new RectF();
    private final Path path = new Path();
    private float[] screenX = new float[2];
    private float[] screenY = new float[2];
    private int hudFrame = -100;
    private float hudPaintedProgress = -1f;
    private boolean resultPainted;

    // The cover and the held tail of the outro are the same still poster: the
    // camera, the route fade, the moment drawers and the result card have all
    // settled, so those frames are pixel-identical to each other. Painting that
    // poster once and re-blitting the captured texture turns ~110 frames of
    // full map + HUD work into a single full-screen quad — that tail used to be
    // the slow, visibly stalled last 10% of the progress bar.
    private int posterTex;
    private boolean posterTried;
    private Bitmap posterBitmap;
    private ByteBuffer posterPixels;
    private int posterHoldStart;

    // Per-frame cost of the last draw, read by the render loop so the export
    // report can tell a slow cruise frame from a slow poster frame.
    long lastTileMs;
    long lastRouteMs;
    long lastHudMs;
    int posterReused;

    private final Bitmap[] bubbleBitmaps;
    private final int[] bubbleTextures;
    private final Bitmap[] drawerBitmaps;
    private final int[] drawerTextures;

    long routeMs;
    long hudMs;
    long tileMs;

    NativeRouteScene(JSONObject payload, NativeVectorMap follow, NativeVectorMap overview,
                     int width, int height, int fps) throws Exception {
        this.follow = follow;
        this.overview = overview;
        this.width = width;
        this.height = height;
        this.fps = Math.max(1, fps);
        this.totalFrames = Math.max(1, (int) Math.ceil(payload.optDouble("durationSec", 38) * this.fps));
        this.title = payload.optString("title", "我的运动");
        this.subtitle = payload.optString("subtitle", "");
        this.place = payload.optString("place", payload.optString("title", "我的运动"));
        this.startText = payload.optString("startText", "");
        this.avgSpeedText = payload.optString("avgSpeed", "");
        this.caloriesText = payload.optString("calories", "");
        this.activitySeconds = payload.optDouble("activityDurationSec", payload.optDouble("durationSec", 38));
        this.movingSeconds = payload.optDouble("movingDurationSec", this.activitySeconds);
        this.elapsedSeconds = payload.optDouble("elapsedDurationSec", this.activitySeconds);
        this.elapsedAvailable = payload.optBoolean("elapsedAvailable", false);
        this.heart = payload.optString("maxHeart", "—");
        this.maxSpeedText = payload.optString("maxSpeed", "—");
        this.maxAltitudeText = payload.optString("maxAltitude", "—");

        String theme = payload.optString("theme", "tech");
        boolean bright = "bright".equals(theme);
        boolean night = "night".equals(theme);
        if (bright) {
            accent = 0xFF0F9F86; accent2 = 0xFF0C9CAF; textColor = 0xFF122923;
            mutedColor = 0x99132F29; glassColor = 0xB3FFFFFF; stageBg = 0xFFEEF2E8;
        } else if (night) {
            accent = 0xFF4DE3FF; accent2 = 0xFF4EF0B5; textColor = 0xFFEEF6FF;
            mutedColor = 0x99DBEBFF; glassColor = 0x990C1B31; stageBg = 0xFF081224;
        } else {
            accent = 0xFF00F0D0; accent2 = 0xFF00C8FF; textColor = 0xFFEAFFFF;
            mutedColor = 0x99BEFFF5; glassColor = 0x9905232A; stageBg = 0xFF041A22;
        }
        background = follow.background;
        parseRoute(payload.optJSONArray("points"));
        totalDistance = cumulative[cumulative.length - 1];
        totalMeters = Math.max(1.0, payload.optDouble("distanceMeters", totalDistance));
        displayMeters = Math.max(totalMeters, payload.optDouble("displayMeters", totalMeters));
        timeScale = activitySeconds > 0 && movingSeconds > 0
                ? Math.max(1.0, movingSeconds / activitySeconds)
                : 1.0;
        speedSeries = parseRawSeries(payload.optJSONArray("speedSeries"));
        speedNorm = normalizeSeries(speedSeries);
        heartSeries = parseRawSeries(payload.optJSONArray("heartSeries"));
        moments = parseMoments(payload.optJSONArray("moments"));

        double centerLat = centerLat(payload);
        double meterPerZ14Pixel = 156543.03392 * Math.cos(Math.toRadians(centerLat)) / 16384.0;
        double routeMeters = totalDistance * meterPerZ14Pixel;
        double windowMeters = Math.min(4500, Math.max(1200, routeMeters * 1.5));
        followScale = (float) Math.min(6.0, Math.max(0.3, width * meterPerZ14Pixel / windowMeters));
        followTilePx = Math.max(48, Math.round(NativeVectorMap.TILE * followScale));
        followAnchor = height * 0.62f;

        // Whole-route framing: identical for the cover and the closing shot, and
        // fully contained between the speed panel (ends y≈302) and the result
        // card (top edge ≥1040) so no part of the route is ever occluded.
        float minX = Float.MAX_VALUE, maxX = -Float.MAX_VALUE;
        float minY = Float.MAX_VALUE, maxY = -Float.MAX_VALUE;
        for (int i = 0; i < xs.length; i += 1) {
            minX = Math.min(minX, xs[i]);
            maxX = Math.max(maxX, xs[i]);
            minY = Math.min(minY, ys[i]);
            maxY = Math.max(maxY, ys[i]);
        }
        float routeW = Math.max(1f, maxX - minX);
        float routeH = Math.max(1f, maxY - minY);
        fitScale = Math.min(930f / routeW, 660f / routeH);
        fitCamX = (minX + maxX) / 2f;
        // The route sits slightly below the optical centre: the top of the frame
        // carries the speed panel, so a lower anchor keeps the loop clear of it
        // while leaving the same breathing room above the result card.
        fitAnchor = 700f;
        fitCamY = (minY + maxY) / 2f + (height / 2f - fitAnchor) / fitScale;

        overviewRatio = (float) Math.pow(2, (overview == null ? NativeVectorMap.FOLLOW_ZOOM : overview.zoom)
                - NativeVectorMap.FOLLOW_ZOOM);
        // One poster viewport is a few hundred overview tiles. Size the raster
        // 1:1 with its on-screen footprint, then cap it so the whole viewport
        // fits in a sane GPU budget — the tile count itself is fixed by the
        // camera, only the per-tile resolution can shrink.
        if (overview == null) {
            overviewTilePx = 0;
            overviewTileCount = 0;
        } else {
            float perMapPx = fitScale / overviewRatio;
            int ideal = Math.round(NativeVectorMap.TILE * perMapPx);
            int cols = (int) Math.ceil(width / (NativeVectorMap.TILE * perMapPx)) + 3;
            int rows = (int) Math.ceil(height / (NativeVectorMap.TILE * perMapPx)) + 3;
            overviewTileCount = cols * rows;
            int memoryCap = (int) Math.sqrt(56_000_000.0 / Math.max(1, overviewTileCount * 4));
            overviewTilePx = Math.max(48, Math.min(512, Math.min(ideal, Math.max(64, memoryCap))));
        }

        JSONArray route = payload.optJSONArray("themeRoute");
        String[] fallback = bright
                ? new String[]{"#0b9db3", "#0f9273", "#d78b18", "#d94f4f"}
                : night
                ? new String[]{"#39ddff", "#4df0b0", "#ffc857", "#ff6b7a"}
                : new String[]{"#00e5ff", "#00ffa3", "#ffd166", "#ff5c86"};
        for (int i = 0; i < 4; i += 1) {
            int color = Color.parseColor(fallback[i]);
            routeColors[i * 4] = Color.red(color) / 255f;
            routeColors[i * 4 + 1] = Color.green(color) / 255f;
            routeColors[i * 4 + 2] = Color.blue(color) / 255f;
            routeColors[i * 4 + 3] = 1f;
        }
        if (route != null && route.length() >= 4) {
            for (int i = 0; i < 4 && i < route.length(); i += 1) {
                int color = Color.parseColor(route.getString(i));
                routeColors[i * 4] = Color.red(color) / 255f;
                routeColors[i * 4 + 1] = Color.green(color) / 255f;
                routeColors[i * 4 + 2] = Color.blue(color) / 255f;
            }
        }

        // 310: the top HUD content ends at y=294, the extra rows only cost
        // texture upload bandwidth on every refresh.
        hudTop = Bitmap.createBitmap(width, 310, Bitmap.Config.ARGB_8888);
        hudTopCanvas = new Canvas(hudTop);
        hudBottom = Bitmap.createBitmap(width, 330, Bitmap.Config.ARGB_8888);
        hudBottomCanvas = new Canvas(hudBottom);
        hudResult = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        hudResultCanvas = new Canvas(hudResult);

        // Whole numbers along a 200 km route become a wall of digits, so the
        // label interval grows with the distance. The web preview uses the very
        // same ladder, which is what keeps the player and the MP4 in step.
        int totalKm = (int) Math.floor(totalMeters / 1000.0);
        int step;
        if (totalKm <= 10) step = 1;
        else if (totalKm <= 30) step = 5;
        else if (totalKm <= 80) step = 10;
        else if (totalKm <= 150) step = 20;
        else step = 25;
        int count = Math.max(0, totalKm / step);
        kmValues = new int[count];
        kmT = new float[count];
        for (int i = 0; i < count; i += 1) {
            kmValues[i] = (i + 1) * step;
            kmT[i] = (float) Math.min(1.0, kmValues[i] * 1000.0 / totalMeters);
        }
        buildKmAtlas(count);

        bubbleBitmaps = new Bitmap[moments.length];
        bubbleTextures = new int[moments.length];
        drawerBitmaps = new Bitmap[moments.length];
        drawerTextures = new int[moments.length];

        buildTimeline();
        buildSpeedCurve();
    }

    /**
     * Pre-computes the speed curve in screen space. The panel geometry is fixed
     * for a given width, so this never has to run again per frame.
     */
    private void buildSpeedCurve() {
        int count = speedNorm.length;
        if (count < 2) return;
        int samples = Math.min(SPEED_SAMPLES, count);
        float left = HUD_X + 18f;
        float right = width - HUD_X - 18f;
        float top = HUD_SPEED_Y + 34f;
        float bottom = HUD_SPEED_Y + HUD_SPEED_H - 30f;
        float center = (top + bottom) / 2f;
        float graphH = bottom - top;
        float graphW = right - left;
        speedCurveX = new float[samples];
        speedCurveY = new float[samples];
        float span = Math.max(1, samples - 1);
        for (int i = 0; i < samples; i += 1) {
            int src = Math.round(i * (count - 1) / span);
            float norm = speedNorm[src];
            float previous = speedNorm[Math.max(0, src - 1)];
            float delta = norm - previous;
            float phase = (src % 16) / 16f;
            float beat = 0f;
            if (phase < 0.08f) beat = (float) Math.sin((phase / 0.08f) * Math.PI) * 0.18f;
            else if (phase < 0.16f) beat = (float) -Math.sin(((phase - 0.08f) / 0.08f) * Math.PI) * 0.16f;
            else if (phase < 0.23f) beat = (float) Math.sin(((phase - 0.16f) / 0.07f) * Math.PI);
            else if (phase < 0.31f) beat = (float) -Math.sin(((phase - 0.23f) / 0.08f) * Math.PI) * 0.32f;
            else if (phase < 0.5f) beat = (float) Math.sin(((phase - 0.31f) / 0.19f) * Math.PI) * 0.2f;
            speedCurveX[i] = left + (i / span) * graphW;
            float value = center - (norm - 0.45f) * graphH * 1.02f
                    - beat * graphH * 0.36f
                    - Math.max(-0.8f, Math.min(0.8f, delta * 2.6f)) * graphH * 0.46f;
            speedCurveY[i] = Math.max(top + 2, Math.min(bottom - 2, value));
        }
    }

    // ------------------------------------------------------------ setup

    private static float[] parseRawSeries(JSONArray array) {
        if (array == null || array.length() < 2) return new float[0];
        float[] values = new float[array.length()];
        for (int i = 0; i < array.length(); i += 1) {
            values[i] = (float) Math.max(0, array.optDouble(i, 0));
        }
        return values;
    }

    /** Scales a raw series into 0..1 for the curve shape (not for the labels). */
    private static float[] normalizeSeries(float[] values) {
        if (values.length == 0) return values;
        double min = Double.MAX_VALUE;
        double max = -Double.MAX_VALUE;
        for (int i = 0; i < values.length; i += 1) {
            min = Math.min(min, values[i]);
            max = Math.max(max, values[i]);
        }
        if (max - min < 0.05) {
            float[] flat = new float[values.length];
            for (int i = 0; i < flat.length; i += 1) flat[i] = 0.5f;
            return flat;
        }
        float[] out = new float[values.length];
        for (int i = 0; i < values.length; i += 1) {
            out[i] = (float) ((values[i] - min) / (max - min));
        }
        return out;
    }

    private static float sampleSeries(float[] values, float progress) {
        if (values.length == 0) return 0f;
        float t = Math.max(0f, Math.min(1f, progress)) * (values.length - 1);
        int low = (int) Math.floor(t);
        int high = Math.min(values.length - 1, low + 1);
        float frac = t - low;
        return values[low] + (values[high] - values[low]) * frac;
    }

    private static Moment[] parseMoments(JSONArray array) {
        if (array == null || array.length() == 0) return new Moment[0];
        List<Moment> list = new ArrayList<>();
        for (int i = 0; i < array.length(); i += 1) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) continue;
            Moment moment = new Moment();
            moment.label = item.optString("label", "");
            moment.value = item.optString("value", "");
            moment.unit = item.optString("unit", "");
            moment.icon = item.optString("icon", "pin");
            moment.progress = (float) Math.max(0.02, Math.min(0.97, item.optDouble("progress", 0.5)));
            String color = item.optString("color", "#00F0D0");
            try {
                moment.color = Color.parseColor(color);
            } catch (Exception error) {
                moment.color = 0xFF00F0D0;
            }
            if (moment.label.isEmpty() || moment.value.isEmpty()) continue;
            list.add(moment);
        }
        Moment[] result = list.toArray(new Moment[0]);
        Arrays.sort(result, new java.util.Comparator<Moment>() {
            @Override
            public int compare(Moment a, Moment b) {
                return Float.compare(a.progress, b.progress);
            }
        });
        return result;
    }

    private static double centerLat(JSONObject payload) {
        JSONArray points = payload.optJSONArray("points");
        if (points == null || points.length() == 0) return 39.9;
        try {
            return points.getJSONArray(points.length() / 2).getDouble(0);
        } catch (Exception error) {
            return 39.9;
        }
    }

    private void parseRoute(JSONArray points) {
        int count = points == null ? 0 : points.length();
        int size = Math.max(2, count);
        xs = new float[size];
        ys = new float[size];
        lats = new float[size];
        lons = new float[size];
        cumulative = new float[size];
        if (count == 0) {
            xs[0] = (float) follow.worldX(116.4);
            ys[0] = (float) follow.worldY(39.9);
            xs[1] = xs[0];
            ys[1] = ys[0];
            lats[0] = 39.9f;
            lons[0] = 116.4f;
            lats[1] = lats[0];
            lons[1] = lons[0];
            return;
        }
        for (int i = 0; i < count; i += 1) {
            try {
                JSONArray point = points.getJSONArray(i);
                lats[i] = (float) point.getDouble(0);
                lons[i] = (float) point.getDouble(1);
                xs[i] = (float) follow.worldX(point.getDouble(1));
                ys[i] = (float) follow.worldY(point.getDouble(0));
            } catch (Exception error) {
                xs[i] = i == 0 ? 0 : xs[i - 1];
                ys[i] = i == 0 ? 0 : ys[i - 1];
                lats[i] = i == 0 ? 39.9f : lats[i - 1];
                lons[i] = i == 0 ? 116.4f : lons[i - 1];
            }
        }
        if (count == 1) {
            xs[1] = xs[0];
            ys[1] = ys[0];
            lats[1] = lats[0];
            lons[1] = lons[0];
        }
        double sum = 0;
        for (int i = 1; i < size; i += 1) {
            sum += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
            cumulative[i] = (float) sum;
        }
        if (sum <= 0) cumulative[size - 1] = 1f;
    }

    /**
     * Lays out travel and freeze segments. The route progress advances only
     * during travel; every key moment owns a short freeze in between.
     */
    private void buildTimeline() {
        int coverFrames = Math.max(2, Math.round(COVER_SECONDS * fps));
        int introFrames = Math.max(2, Math.round(INTRO_SECONDS * fps));
        int outroFrames = Math.max(6, Math.round(OUTRO_SECONDS * fps));
        int pauseFrames = Math.max(4, Math.round(PAUSE_SECONDS * fps));
        int fixed = coverFrames + introFrames + outroFrames + pauseFrames * moments.length;
        if (fixed > totalFrames * 0.85f) {
            float shrink = (totalFrames * 0.85f) / fixed;
            coverFrames = Math.max(2, Math.round(coverFrames * shrink));
            introFrames = Math.max(2, Math.round(introFrames * shrink));
            outroFrames = Math.max(6, Math.round(outroFrames * shrink));
            pauseFrames = Math.max(4, Math.round(pauseFrames * shrink));
        }
        this.coverEnd = coverFrames;
        this.introEnd = coverFrames + introFrames;
        this.outroStart = totalFrames - outroFrames;
        // The pull-back to the poster takes 1.2 s; everything after it is the
        // same still frame as the cover, so the tail can be replayed.
        this.posterHoldStart = Math.min(totalFrames, outroStart + Math.max(4, Math.round(1.2f * fps)));

        int runStart = introEnd;
        int runEnd = Math.max(runStart + 30, outroStart);
        int travelFrames = Math.max(30, runEnd - runStart - pauseFrames * moments.length);

        List<int[]> ranges = new ArrayList<>();
        List<float[]> progress = new ArrayList<>();
        List<Integer> owner = new ArrayList<>();

        int cursor = runStart;
        float previous = 0f;
        float spent = 0f;
        for (int i = 0; i < moments.length; i += 1) {
            float delta = Math.max(0f, moments[i].progress - previous);
            int frames = Math.max(3, Math.round(delta * travelFrames));
            frames = Math.min(frames, Math.max(3, Math.round(travelFrames - spent)));
            ranges.add(new int[]{cursor, cursor + frames});
            progress.add(new float[]{previous, moments[i].progress});
            owner.add(-1);
            cursor += frames;
            spent += frames;
            ranges.add(new int[]{cursor, cursor + pauseFrames});
            progress.add(new float[]{moments[i].progress, moments[i].progress});
            owner.add(i);
            cursor += pauseFrames;
            previous = moments[i].progress;
        }
        int tail = Math.max(3, runEnd - cursor);
        ranges.add(new int[]{cursor, cursor + tail});
        progress.add(new float[]{previous, 1f});
        owner.add(-1);
        cursor += tail;
        ranges.add(new int[]{Math.max(cursor, outroStart), totalFrames});
        progress.add(new float[]{1f, 1f});
        owner.add(-1);

        segCount = ranges.size();
        segStart = new int[segCount];
        segEnd = new int[segCount];
        segP0 = new float[segCount];
        segP1 = new float[segCount];
        segMoment = new int[segCount];
        for (int i = 0; i < segCount; i += 1) {
            segStart[i] = ranges.get(i)[0];
            segEnd[i] = ranges.get(i)[1];
            segP0[i] = progress.get(i)[0];
            segP1[i] = progress.get(i)[1];
            segMoment[i] = owner.get(i);
        }
    }

    private int segmentAt(int frame) {
        for (int i = 0; i < segCount; i += 1) {
            if (frame < segEnd[i]) return i;
        }
        return segCount - 1;
    }

    private float progressAt(int frame) {
        int index = segmentAt(frame);
        int span = Math.max(1, segEnd[index] - segStart[index]);
        float t = Math.max(0f, Math.min(1f, (frame - segStart[index]) / (float) span));
        // ease the tail of the final travel so the marker settles instead of
        // hitting the finish line at full speed.
        return segP0[index] + (segP1[index] - segP0[index]) * t;
    }

    private int activeMoment(int frame) {
        int index = segmentAt(frame);
        if (segMoment[index] >= 0) return segMoment[index];
        // keep the bubble alive for a moment after the freeze ends
        if (index > 0 && segMoment[index - 1] >= 0 && frame - segEnd[index - 1] < Math.round(0.25f * fps)) {
            return segMoment[index - 1];
        }
        return -1;
    }

    private float momentStart(int frame, int moment) {
        for (int i = 0; i < segCount; i += 1) {
            if (segMoment[i] == moment) return (frame - segStart[i]) / (float) Math.max(1, segEnd[i] - segStart[i]);
        }
        return -1f;
    }

    // ------------------------------------------------------------ frame

    @Override
    public void draw(int width, int height, int frameIndex, int totalFrames) {
        ensureGl();

        // Identical poster frame (cover, or the settled tail of the outro):
        // reuse the captured backdrop instead of re-painting map + route + HUD.
        // The tracking marker keeps animating on top, so the still shot still
        // breathes like it does in the moving part of the clip.
        if (posterTex != 0 && isStaticPoster(frameIndex)) {
            GLES20.glViewport(0, 0, width, height);
            follow.drainDeleted();
            if (overview != null) overview.drainDeleted();
            drawTexture(posterTex, 0, 0, width, height, 1f);
            long markerStart = System.nanoTime();
            drawMarker(fitCamX, fitCamY, fitScale, 1f, frameIndex);
            lastTileMs = 0;
            lastHudMs = 0;
            lastRouteMs = (System.nanoTime() - markerStart) / 1_000_000L;
            posterReused += 1;
            return;
        }
        boolean stillPoster = isStaticPoster(frameIndex);

        float progress = progressAt(frameIndex);
        float[] current = positionAt(progress);

        float camX;
        float camY;
        float scale;

        if (frameIndex < coverEnd) {
            // Static poster: the exact same framing as the closing shot, so the
            // first and the last frame of the video are identical.
            scale = fitScale;
            camX = fitCamX;
            camY = fitCamY;
        } else if (frameIndex < introEnd) {
            float t = easeInOut((frameIndex - coverEnd) / (float) Math.max(1, introEnd - coverEnd));
            float[] followCam = followCamera(progress);
            camX = fitCamX + (followCam[0] - fitCamX) * t;
            camY = fitCamY + (followCam[1] - fitCamY) * t;
            scale = (float) Math.exp(Math.log(fitScale) + (Math.log(followScale) - Math.log(fitScale)) * t);
        } else if (frameIndex >= outroStart) {
            // Pull back fast (1.2s), then hold the poster for the rest of the
            // outro so the closing shot is unmistakably the finish card.
            float t = easeInOut(Math.min(1f, (frameIndex - outroStart) / (1.2f * fps)));
            float[] followCam = followCamera(1f);
            camX = followCam[0] + (fitCamX - followCam[0]) * t;
            camY = followCam[1] + (fitCamY - followCam[1]) * t;
            scale = (float) Math.exp(Math.log(followScale) + (Math.log(fitScale) - Math.log(followScale)) * t);
        } else {
            float[] followCam = followCamera(progress);
            camX = followCam[0];
            camY = followCam[1];
            scale = followScale;
        }

        GLES20.glViewport(0, 0, width, height);
        GLES20.glDisable(GLES20.GL_BLEND);
        GLES20.glClearColor(Color.red(background) / 255f, Color.green(background) / 255f,
                Color.blue(background) / 255f, 1f);
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);

        // Bitmaps evicted on raster worker threads defer their GL delete to
        // here, the only thread that owns the EGL context.
        follow.drainDeleted();
        if (overview != null) overview.drainDeleted();

        long started = System.nanoTime();
        drawTiles(camX, camY, scale);
        lastTileMs = (System.nanoTime() - started) / 1_000_000L;
        tileMs += lastTileMs;

        boolean wholeRoute = frameIndex < introEnd || frameIndex >= outroStart;
        // The cover is a poster of the finished ride: markers, HUD and card all
        // show the final state, exactly like the closing frame.
        float hudProgress = frameIndex < coverEnd ? 1f : progress;
        // 1 = poster (whole route in full colour), 0 = trail style. The intro
        // crossfades between the two so the cover never cuts to the run.
        float routeFade;
        if (frameIndex < coverEnd) routeFade = 1f;
        else if (frameIndex < introEnd) routeFade = 1f - easeInOut((frameIndex - coverEnd) / (float) Math.max(1, introEnd - coverEnd));
        else routeFade = frameIndex >= outroStart ? 1f : 0f;

        started = System.nanoTime();
        drawRoute(camX, camY, scale, progress, wholeRoute, routeFade);
        drawKmMarkers(camX, camY, scale, hudProgress);
        drawEndpoints(camX, camY, scale, progress, wholeRoute || progress > 0.94f);
        if (!stillPoster) drawMarker(camX, camY, scale, hudProgress, frameIndex);
        lastRouteMs = (System.nanoTime() - started) / 1_000_000L;
        routeMs += lastRouteMs;

        long hudStart = System.nanoTime();
        drawMoments(frameIndex, camX, camY, scale, progress);

        if (frameIndex < coverEnd) {
            drawOverviewLabels(camX, camY, scale, 1f);
        } else if (frameIndex >= outroStart) {
            float labelAlpha = Math.min(1f, (frameIndex - outroStart) / (0.4f * fps));
            drawOverviewLabels(camX, camY, scale, labelAlpha);
        }

        float resultReveal;
        if (frameIndex < coverEnd) resultReveal = 1f;
        else if (frameIndex < introEnd) {
            resultReveal = 1f - easeInOut((frameIndex - coverEnd) / (float) Math.max(1, introEnd - coverEnd));
        } else if (frameIndex >= outroStart) {
            resultReveal = Math.min(1f, (frameIndex - outroStart) / (0.45f * fps));
        } else {
            resultReveal = 0f;
        }
        drawHud(hudProgress, frameIndex, resultReveal, 1f);
        lastHudMs = (System.nanoTime() - hudStart) / 1_000_000L;
        hudMs += lastHudMs;

        if (isStaticPoster(frameIndex)) {
            capturePoster();
            drawMarker(fitCamX, fitCamY, fitScale, 1f, frameIndex);
        }
    }

    /**
     * True for the frames whose whole scene is frozen: every cover frame, and
     * the outro once the pull-back, the label/drawer fades and the result card
     * reveal have finished. Their pixels never change, so they can be replayed
     * from the captured poster texture.
     */
    private boolean isStaticPoster(int frameIndex) {
        if (frameIndex < coverEnd) return true;
        return posterHoldStart > 0 && frameIndex >= posterHoldStart;
    }

    private void capturePoster() {
        if (posterTried) return;
        posterTried = true;
        try {
            int stride = width * 4;
            int bytes = stride * height;
            ByteBuffer pixels = posterPixels;
            if (pixels == null || pixels.capacity() < bytes) {
                pixels = ByteBuffer.allocateDirect(bytes).order(ByteOrder.nativeOrder());
                posterPixels = pixels;
            }
            pixels.position(0);
            GLES20.glReadPixels(0, 0, width, height, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, pixels);

            // A driver that refuses the readback leaves the buffer at zero; skip
            // the cache then rather than blitting black frames.
            byte[] sample = new byte[3];
            boolean any = false;
            for (int i = 0; i + 3 < bytes; i += 4093) {
                pixels.position(i);
                pixels.get(sample);
                if (sample[0] != 0 || sample[1] != 0 || sample[2] != 0) { any = true; break; }
            }
            if (!any) return;

            // glReadPixels hands back the bottom row first; Android bitmaps are
            // top row first, so flip in place here instead of guessing at the
            // texture coordinates on every blit.
            byte[] rowA = new byte[stride];
            byte[] rowB = new byte[stride];
            for (int y = 0; y < height / 2; y += 1) {
                int top = y * stride;
                int bottom = (height - 1 - y) * stride;
                pixels.position(top);
                pixels.get(rowA);
                pixels.position(bottom);
                pixels.get(rowB);
                pixels.position(top);
                pixels.put(rowB);
                pixels.position(bottom);
                pixels.put(rowA);
            }
            pixels.position(0);
            Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
            bitmap.copyPixelsFromBuffer(pixels);
            posterBitmap = bitmap;
            posterTex = upload(bitmap, 0);
            posterPixels = null;
        } catch (Throwable error) {
            posterTex = 0;
        }
    }

    private float[] followCamera(float progress) {
        float[] current = positionAt(progress);
        float[] ahead = positionAt(Math.min(1f, progress + 0.006f));
        float[] cam = new float[2];
        cam[0] = current[0] * 0.7f + ahead[0] * 0.3f;
        cam[1] = current[1] * 0.7f + ahead[1] * 0.3f;
        cam[1] += (height / 2f - followAnchor) / followScale;
        return cam;
    }

    int followTilePx() {
        return followTilePx;
    }

    /** Frame boundaries, so the render loop can report per-phase frame costs. */
    int introEndFrame() {
        return introEnd;
    }

    int outroStartFrame() {
        return outroStart;
    }

    int overviewTilePx() {
        return overviewTilePx;
    }

    /**
     * Every follow-zoom tile the travelling camera can see, in route order —
     * the exact set the parallel pre-raster pass must paint before encoding
     * starts so the loop never stalls on a first-use tile.
     */
    List<long[]> followPrerasterTargets() {
        Set<Long> seen = new HashSet<Long>();
        List<long[]> out = new ArrayList<long[]>();
        int n = xs.length;
        if (n < 2) return out;
        int stride = Math.max(1, n / 600);
        for (int i = 0; i < n; i += stride) {
            addVisibleTiles(followCamera(i / (float) (n - 1)), seen, out);
        }
        addVisibleTiles(followCamera(1f), seen, out);
        return out;
    }

    private void addVisibleTiles(float[] cam, Set<Long> seen, List<long[]> out) {
        float halfW = width / 2f / followScale;
        float halfH = height / 2f / followScale;
        int x0 = (int) Math.floor((cam[0] - halfW) / NativeVectorMap.TILE);
        int x1 = (int) Math.floor((cam[0] + halfW) / NativeVectorMap.TILE);
        int y0 = (int) Math.floor((cam[1] - halfH) / NativeVectorMap.TILE);
        int y1 = (int) Math.floor((cam[1] + halfH) / NativeVectorMap.TILE);
        for (int tx = x0; tx <= x1; tx += 1) {
            for (int ty = y0; ty <= y1; ty += 1) {
                long key = (long) tx << 32 | (ty & 0xffffffffL);
                if (seen.add(key)) out.add(new long[]{tx, ty});
            }
        }
    }

    /**
     * Every overview tile visible in the whole-route framing — the exact set the
     * cover and closing poster need. Computing it from the fit camera instead of
     * guessing a bounding box is what keeps the map flush to every screen edge.
     */
    List<long[]> overviewPrerasterTargets() {
        List<long[]> out = new ArrayList<long[]>();
        if (overview == null || overviewTilePx <= 0) return out;
        float perMapPx = fitScale / overviewRatio;
        float halfW = width / 2f / perMapPx;
        float halfH = height / 2f / perMapPx;
        float mapCamX = fitCamX * overviewRatio;
        float mapCamY = fitCamY * overviewRatio;
        int x0 = (int) Math.floor((mapCamX - halfW) / NativeVectorMap.TILE) - 1;
        int x1 = (int) Math.floor((mapCamX + halfW) / NativeVectorMap.TILE) + 1;
        int y0 = (int) Math.floor((mapCamY - halfH) / NativeVectorMap.TILE) - 1;
        int y1 = (int) Math.floor((mapCamY + halfH) / NativeVectorMap.TILE) + 1;
        for (int tx = x0; tx <= x1; tx += 1) {
            for (int ty = y0; ty <= y1; ty += 1) {
                out.add(new long[]{tx, ty});
            }
        }
        return out;
    }

    /** How many overview rasters the poster framing needs to keep resident. */
    int overviewCacheLimit() {
        return Math.max(overviewTileCount, overviewTilePx <= 0 ? 0 : 64) + 16;
    }

    // ------------------------------------------------------------ tiles

    private void drawTiles(float camX, float camY, float scale) {
        float overviewWeight = 1f - smoothstep(0.10f, 0.42f, scale);
        if (overview != null && overviewWeight > 0.001f && overviewTilePx > 0) {
            drawTileLayer(overview, camX, camY, scale, overviewTilePx, overviewRatio, 1f);
        }
        if (scale > 0.10f) {
            float alpha = smoothstep(0.10f, 0.42f, scale);
            drawTileLayer(follow, camX, camY, scale, followTilePx, 1f, alpha);
        }
    }

    private void drawTileLayer(NativeVectorMap map, float camX, float camY, float scale,
                               int rasterPx, float ratio, float alpha) {
        float perMapPx = scale / ratio;
        float halfW = width / 2f / perMapPx;
        float halfH = height / 2f / perMapPx;
        float mapCamX = camX * ratio;
        float mapCamY = camY * ratio;
        int x0 = (int) Math.floor((mapCamX - halfW) / NativeVectorMap.TILE);
        int x1 = (int) Math.floor((mapCamX + halfW) / NativeVectorMap.TILE);
        int y0 = (int) Math.floor((mapCamY - halfH) / NativeVectorMap.TILE);
        int y1 = (int) Math.floor((mapCamY + halfH) / NativeVectorMap.TILE);
        int pad = NativeVectorMap.PAD;
        float side = NativeVectorMap.TILE * perMapPx + pad * 2;
        // When the viewport spans more than ~40 follow tiles (cover/result
        // crossfades and the zoom sweeps) only reuse already-painted tiles —
        // painting hundreds on demand would stall the export. The overview
        // layer is exempt: its whole viewport is pre-rastered, so a miss there
        // is a real hole in the poster map and worth one on-demand paint (the
        // raster cache makes repeats free).
        boolean readyOnly = (x1 - x0 + 1) * (y1 - y0 + 1) > 40 && map != overview;
        for (int tx = x0; tx <= x1; tx += 1) {
            for (int ty = y0; ty <= y1; ty += 1) {
                int texture = readyOnly
                        ? map.textureIfReady(tx, ty, rasterPx)
                        : map.texture(tx, ty, rasterPx);
                if (texture == 0) continue;
                float sx = width / 2f + (tx * NativeVectorMap.TILE - mapCamX) * perMapPx - pad;
                float sy = height / 2f + (ty * NativeVectorMap.TILE - mapCamY) * perMapPx - pad;
                drawTexture(texture, sx, sy, side, side, alpha);
            }
        }
    }

    // ------------------------------------------------------------ route

    /**
     * Draws the polyline as one continuous ribbon: per-segment quads plus round
     * joints, so corners show no teeth and the colour fades smoothly. The
     * whole-route shots decimate the line to ~3 px spacing first, otherwise a
     * 200 km ride would push tens of thousands of vertices per frame.
     */
    private void drawRoute(float camX, float camY, float scale, float progress,
                           boolean wholeRoute, float routeFade) {
        int count = xs.length;
        if (screenX.length != count) {
            screenX = new float[count];
            screenY = new float[count];
        }
        for (int i = 0; i < count; i += 1) {
            screenX[i] = width / 2f + (xs[i] - camX) * scale;
            screenY[i] = height / 2f + (ys[i] - camY) * scale;
        }

        if (wholeRoute) {
            int n = decimate(3.2f, count - 1);
            float brightness = 0.55f + 0.45f * routeFade;
            float coreAlpha = 0.32f + 0.68f * routeFade;
            float glowAlpha = 0.13f * routeFade;
            float caseAlpha = 0.94f * routeFade;
            if (glowAlpha > 0.005f) {
                ribbonPass(decimX, decimY, decimT, n, ROUTE_GLOW, glowAlpha, 1f, true);
            }
            if (caseAlpha > 0.005f) {
                ribbonPass(decimX, decimY, decimT, n, ROUTE_CASE, caseAlpha, 0f, false);
            }
            ribbonPass(decimX, decimY, decimT, n, ROUTE_CORE, coreAlpha, brightness, true);
            return;
        }

        int endIndex = count - 1;
        float headX = screenX[count - 1];
        float headY = screenY[count - 1];
        if (progress < 1f) {
            float target = progress * cumulative[count - 1];
            int low = 0;
            int high = count - 1;
            while (low < high - 1) {
                int mid = (low + high) >>> 1;
                if (cumulative[mid] <= target) low = mid;
                else high = mid;
            }
            endIndex = low;
            float[] point = positionAt(progress);
            headX = width / 2f + (point[0] - camX) * scale;
            headY = height / 2f + (point[1] - camY) * scale;
        }

        float total = Math.max(1f, cumulative[count - 1]);

        // Walked trail: persist in world space so it never "snake-vanishes" behind
        // the camera. Dim pass under the bright head ribbon (matches the TS preview).
        if (endIndex >= 2) {
            int walkedN = decimate(3.2f, endIndex);
            if (walkedN >= 2) {
                ribbonPass(decimX, decimY, decimT, walkedN, ROUTE_CORE * 0.67f, 0.35f, 0.75f, true);
            }
        }

        // Untravelled remainder: dim, no casing, no joints.
        if (endIndex < count - 1) {
            beginColorBatch();
            for (int i = Math.max(1, endIndex + 1); i < count; i += 1) {
                if (!segmentVisible(i)) continue;
                routeColor(cumulative[i - 1] / total, tmpColor);
                float r0 = tmpColor[0] * 0.55f;
                float g0 = tmpColor[1] * 0.55f;
                float b0 = tmpColor[2] * 0.55f;
                routeColor(cumulative[i] / total, tmpColor);
                addQuad(screenX[i - 1], screenY[i - 1], r0, g0, b0, screenX[i], screenY[i],
                        tmpColor[0] * 0.55f, tmpColor[1] * 0.55f, tmpColor[2] * 0.55f,
                        ROUTE_CORE * 0.31f, 0.32f);
            }
            endColorBatch();
        }

        // Splice the interpolated head so the ribbon ends under the marker.
        int from = Math.max(0, endIndex - 1200);
        int length = endIndex - from + 2;
        if (headScreenX.length < length) {
            headScreenX = new float[length + 64];
            headScreenY = new float[length + 64];
            headT = new float[length + 64];
        }
        System.arraycopy(screenX, from, headScreenX, 0, endIndex - from + 1);
        System.arraycopy(screenY, from, headScreenY, 0, endIndex - from + 1);
        for (int i = 0; i <= endIndex - from; i += 1) headT[i] = cumulative[from + i] / total;
        headScreenX[length - 1] = headX;
        headScreenY[length - 1] = headY;
        headT[length - 1] = progress;

        ribbonPass(headScreenX, headScreenY, headT, length, ROUTE_GLOW, 0.13f, 1f, true);
        ribbonPass(headScreenX, headScreenY, headT, length, ROUTE_CASE, 0.94f, 0f, false);
        ribbonPass(headScreenX, headScreenY, headT, length, ROUTE_CORE, 1f, 1f, true);
    }

    private float[] headScreenX = new float[0];
    private float[] headScreenY = new float[0];
    private float[] headT = new float[0];
    private float[] decimX = new float[0];
    private float[] decimY = new float[0];
    private float[] decimT = new float[0];

    /** Keeps every point that is at least {@code spacing} screen px from the last one,
     *  walking the route up to {@code endIdx} (inclusive). */
    private int decimate(float spacing, int endIdx) {
        int count = Math.min(screenX.length, endIdx + 1);
        if (decimX.length < count + 2) {
            decimX = new float[count + 2];
            decimY = new float[count + 2];
            decimT = new float[count + 2];
        }
        float total = Math.max(1f, cumulative[count - 1]);
        int n = 0;
        float lastX = 0f;
        float lastY = 0f;
        for (int i = 0; i < count; i += 1) {
            boolean far = n == 0 || Math.hypot(screenX[i] - lastX, screenY[i] - lastY) >= spacing;
            if (!far && i != count - 1) continue;
            decimX[n] = screenX[i];
            decimY[n] = screenY[i];
            decimT[n] = cumulative[i] / total;
            lastX = screenX[i];
            lastY = screenY[i];
            n += 1;
        }
        return n;
    }

    private void ribbonPass(float[] sx, float[] sy, float[] t, int count, float widthPx,
                            float alpha, float brightness, boolean gradient) {
        if (count < 2) return;
        beginColorBatch();
        addRibbon(sx, sy, t, count, widthPx, alpha, brightness, gradient);
        endColorBatch();
    }

    private boolean segmentVisible(int i) {
        float margin = ROUTE_GLOW + 40;
        float minX = Math.min(screenX[i - 1], screenX[i]);
        float maxX = Math.max(screenX[i - 1], screenX[i]);
        float minY = Math.min(screenY[i - 1], screenY[i]);
        float maxY = Math.max(screenY[i - 1], screenY[i]);
        return maxX > -margin && minX < width + margin && maxY > -margin && minY < height + margin;
    }

    private void addRibbon(float[] sx, float[] sy, float[] t, int count, float widthPx,
                           float alpha, float brightness, boolean gradient) {
        float half = widthPx / 2f;
        int joints = widthPx >= ROUTE_GLOW ? 8 : 12;
        for (int i = 1; i < count; i += 1) {
            float minX = Math.min(sx[i - 1], sx[i]);
            float maxX = Math.max(sx[i - 1], sx[i]);
            float minY = Math.min(sy[i - 1], sy[i]);
            float maxY = Math.max(sy[i - 1], sy[i]);
            boolean visible = maxX > -half - 60 && minX < width + half + 60
                    && maxY > -half - 60 && minY < height + half + 60;
            if (!visible) continue;
            if (gradient) {
                routeColor(t[i - 1], tmpColor);
                float r0 = tmpColor[0] * brightness;
                float g0 = tmpColor[1] * brightness;
                float b0 = tmpColor[2] * brightness;
                routeColor(t[i], tmpColor);
                addQuad(sx[i - 1], sy[i - 1], r0, g0, b0,
                        sx[i], sy[i], tmpColor[0] * brightness, tmpColor[1] * brightness,
                        tmpColor[2] * brightness, half, alpha);
                routeColor(t[i - 1], tmpColor);
                vertexCursor = disc(sx[i - 1], sy[i - 1], half, tmpColor[0] * brightness,
                        tmpColor[1] * brightness, tmpColor[2] * brightness, alpha, joints);
            } else {
                addQuad(sx[i - 1], sy[i - 1], sx[i], sy[i], half, 1f, 1f, 1f, alpha);
                vertexCursor = disc(sx[i - 1], sy[i - 1], half, 1f, 1f, 1f, alpha, joints);
            }
        }
        int last = count - 1;
        if (gradient) {
            routeColor(t[last], tmpColor);
            vertexCursor = disc(sx[last], sy[last], half, tmpColor[0] * brightness,
                    tmpColor[1] * brightness, tmpColor[2] * brightness, alpha, joints);
        } else {
            vertexCursor = disc(sx[last], sy[last], half, 1f, 1f, 1f, alpha, joints);
        }
    }

    private float fractionAt(int index) {
        float total = cumulative[cumulative.length - 1];
        return total <= 0 ? 0f : cumulative[index] / total;
    }

    /** Screen-space position of the point at {@code t} (0..1) along the route. */
    private float[] positionAt(float t) {
        float target = t * cumulative[cumulative.length - 1];
        int low = 0;
        int high = cumulative.length - 1;
        while (low < high - 1) {
            int mid = (low + high) >>> 1;
            if (cumulative[mid] <= target) low = mid;
            else high = mid;
        }
        float span = cumulative[high] - cumulative[low];
        float local = span <= 0 ? 0 : (target - cumulative[low]) / span;
        return new float[]{
                xs[low] + (xs[high] - xs[low]) * local,
                ys[low] + (ys[high] - ys[low]) * local,
        };
    }

    private void beginColorBatch() {
        vertexCursor = 0;
        GLES20.glUseProgram(colorProgram);
        GLES20.glUniform2f(colorViewport, width, height);
        GLES20.glEnable(GLES20.GL_BLEND);
        GLES20.glBlendFunc(GLES20.GL_SRC_ALPHA, GLES20.GL_ONE_MINUS_SRC_ALPHA);
    }

    private void endColorBatch() {
        int vertexCount = vertexCursor / 6;
        if (vertexCount <= 0) return;
        int needed = vertexCount * 6;
        if (uploadBuffer == null || uploadBuffer.capacity() < needed) {
            uploadBuffer = ByteBuffer.allocateDirect(Math.max(needed, 8192) * 4)
                    .order(ByteOrder.nativeOrder()).asFloatBuffer();
        }
        FloatBuffer buffer = uploadBuffer;
        buffer.clear();
        buffer.put(vertexBuffer, 0, needed).position(0);
        GLES20.glEnableVertexAttribArray(colorPosition);
        GLES20.glVertexAttribPointer(colorPosition, 2, GLES20.GL_FLOAT, false, 24, buffer);
        buffer.position(2);
        GLES20.glEnableVertexAttribArray(colorValue);
        GLES20.glVertexAttribPointer(colorValue, 4, GLES20.GL_FLOAT, false, 24, buffer);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLES, 0, vertexCount);
        GLES20.glDisableVertexAttribArray(colorPosition);
        GLES20.glDisableVertexAttribArray(colorValue);
        GLES20.glDisable(GLES20.GL_BLEND);
    }

    private final float[] tmpColor = new float[3];

    private void addQuad(float x1, float y1, float x2, float y2, float half,
                         float r, float g, float b, float a) {
        addQuad(x1, y1, r, g, b, x2, y2, r, g, b, half, a);
    }

    private void addQuad(float x1, float y1, float r0, float g0, float b0,
                         float x2, float y2, float r1, float g1, float b1,
                         float half, float a) {
        float dx = x2 - x1;
        float dy = y2 - y1;
        float len = (float) Math.hypot(dx, dy);
        if (len < 0.0001f) return;
        float nx = -dy / len * half;
        float ny = dx / len * half;
        ensureCapacity(36);
        vertexCursor = put(vertexCursor, x1 + nx, y1 + ny, r0, g0, b0, a);
        vertexCursor = put(vertexCursor, x1 - nx, y1 - ny, r0, g0, b0, a);
        vertexCursor = put(vertexCursor, x2 + nx, y2 + ny, r1, g1, b1, a);
        vertexCursor = put(vertexCursor, x2 + nx, y2 + ny, r1, g1, b1, a);
        vertexCursor = put(vertexCursor, x1 - nx, y1 - ny, r0, g0, b0, a);
        vertexCursor = put(vertexCursor, x2 - nx, y2 - ny, r1, g1, b1, a);
    }

    private void ensureCapacity(int vertices) {
        if (vertexCursor + vertices * 6 <= vertexBuffer.length) return;
        int size = vertexBuffer.length;
        while (vertexCursor + vertices * 6 > size) size *= 2;
        float[] bigger = new float[size];
        System.arraycopy(vertexBuffer, 0, bigger, 0, vertexCursor);
        vertexBuffer = bigger;
    }

    private int put(int cursor, float x, float y, float r, float g, float b, float a) {
        vertexBuffer[cursor] = x;
        vertexBuffer[cursor + 1] = y;
        vertexBuffer[cursor + 2] = r;
        vertexBuffer[cursor + 3] = g;
        vertexBuffer[cursor + 4] = b;
        vertexBuffer[cursor + 5] = a;
        return cursor + 6;
    }

    private int disc(float cx, float cy, float radius, float r, float g, float b, float a, int segments) {
        ensureCapacity(segments * 3);
        int cursor = vertexCursor;
        for (int i = 0; i < segments; i += 1) {
            float a0 = (float) (i * Math.PI * 2 / segments);
            float a1 = (float) ((i + 1) * Math.PI * 2 / segments);
            cursor = put(cursor, cx, cy, r, g, b, a);
            cursor = put(cursor, cx + (float) Math.cos(a0) * radius, cy + (float) Math.sin(a0) * radius, r, g, b, a);
            cursor = put(cursor, cx + (float) Math.cos(a1) * radius, cy + (float) Math.sin(a1) * radius, r, g, b, a);
        }
        return cursor;
    }

    private void routeColor(float t, float[] out) {
        float scaled = Math.max(0f, Math.min(0.9999f, t)) * 3f;
        int index = (int) scaled;
        float local = scaled - index;
        for (int c = 0; c < 3; c += 1) {
            float a = routeColors[index * 4 + c];
            float b = routeColors[(index + 1) * 4 + c];
            out[c] = a + (b - a) * local;
        }
    }

    // ------------------------------------------------------------ markers

    private void drawKmMarkers(float camX, float camY, float scale, float progress) {
        if (kmValues.length == 0 || progress < 0.02f) return;
        beginColorBatch();
        int shown = 0;
        for (int i = 0; i < kmT.length; i += 1) {
            if (kmT[i] > progress) break;
            float[] point = positionAt(kmT[i]);
            float cx = width / 2f + (point[0] - camX) * scale;
            float cy = height / 2f + (point[1] - camY) * scale;
            if (cx < -60 || cx > width + 60 || cy < -60 || cy > height + 60) continue;
            vertexCursor = disc(cx, cy, 4.2f, Color.red(textColor) / 255f,
                    Color.green(textColor) / 255f, Color.blue(textColor) / 255f, 0.4f, 18);
            shown += 1;
        }
        if (shown == 0) {
            vertexCursor = 0;
            return;
        }
        endColorBatch();

        if (kmAtlas == null || kmAtlasTexture == 0) return;
        float cell = 72f;
        for (int i = 0; i < kmT.length; i += 1) {
            if (kmT[i] > progress) break;
            float[] point = positionAt(kmT[i]);
            float cx = width / 2f + (point[0] - camX) * scale;
            float cy = height / 2f + (point[1] - camY) * scale;
            if (cx < -60 || cx > width + 60 || cy < -60 || cy > height + 60) continue;
            int col = i % KM_COLS;
            int row = i / KM_COLS;
            float u0 = (col * KM_CELL) / (float) kmAtlas.getWidth();
            float u1 = ((col + 1) * KM_CELL) / (float) kmAtlas.getWidth();
            float v0 = (row * KM_CELL) / (float) kmAtlas.getHeight();
            float v1 = ((row + 1) * KM_CELL) / (float) kmAtlas.getHeight();
            drawTextureRegion(kmAtlasTexture, cx - cell / 2f, cy - cell + 20f, cell, cell,
                    0.9f, u0, v0, u1, v1);
        }
    }

    private void drawEndpoints(float camX, float camY, float scale, float progress, boolean wholeRoute) {
        beginColorBatch();
        float[] start = positionAt(0f);
        float sx = width / 2f + (start[0] - camX) * scale;
        float sy = height / 2f + (start[1] - camY) * scale;
        if (sx > -40 && sx < width + 40 && sy > -40 && sy < height + 40) {
            vertexCursor = disc(sx, sy, 15f, 1f, 1f, 1f, 0.9f, 20);
            vertexCursor = disc(sx, sy, 9f, Color.red(accent2) / 255f,
                    Color.green(accent2) / 255f, Color.blue(accent2) / 255f, 1f, 20);
        }
        if (wholeRoute || progress > 0.94f) {
            float[] end = positionAt(1f);
            float ex = width / 2f + (end[0] - camX) * scale;
            float ey = height / 2f + (end[1] - camY) * scale;
            if (ex > -60 && ex < width + 60 && ey > -60 && ey < height + 60) {
                routeColor(1f, tmpColor);
                vertexCursor = disc(ex, ey, 26f, 1f, 1f, 1f, 0.95f, 24);
                vertexCursor = disc(ex, ey, 20f, tmpColor[0], tmpColor[1], tmpColor[2], 1f, 24);
                vertexCursor = disc(ex, ey, 8f, 1f, 1f, 1f, 1f, 18);
            }
        }
        endColorBatch();
    }

    private void drawMarker(float camX, float camY, float scale, float progress, int frameIndex) {
        float[] point = positionAt(progress);
        float cx = width / 2f + (point[0] - camX) * scale;
        float cy = height / 2f + (point[1] - camY) * scale;
        float pulse = (frameIndex % 30) / 30f;

        beginColorBatch();
        for (int ring = 2; ring >= 0; ring -= 1) {
            float phase = (pulse + ring / 3f) % 1f;
            float radius = 26f + phase * 54f;
            float alpha = (1f - phase) * 0.35f;
            vertexCursor = disc(cx, cy, radius, Color.red(accent) / 255f,
                    Color.green(accent) / 255f, Color.blue(accent) / 255f, alpha, 22);
        }
        vertexCursor = disc(cx, cy, 17f, 1f, 1f, 1f, 0.95f, 24);
        vertexCursor = disc(cx, cy, 9f, Color.red(accent) / 255f,
                Color.green(accent) / 255f, Color.blue(accent) / 255f, 1f, 24);
        endColorBatch();
    }

    // ------------------------------------------------------------ moments

    private void drawMoments(int frameIndex, float camX, float camY, float scale, float progress) {
        if (moments.length == 0) return;
        float resultFade = 1f;
        if (frameIndex >= outroStart) {
            resultFade = Math.max(0f, 1f - (frameIndex - outroStart) / (0.3f * fps));
        }
        for (int i = 0; i < moments.length; i += 1) {
            int start = momentStartFrame(i);
            if (start < 0 || frameIndex < start) continue;
            float age = (frameIndex - start) / (float) fps;
            float reveal = Math.min(1f, age / 0.32f) * resultFade;
            if (reveal <= 0.01f) continue;
            drawDrawerItem(i, reveal);
        }

        int active = activeMoment(frameIndex);
        if (active < 0 || resultFade <= 0f) return;
        float pauseT = momentStart(frameIndex, active);
        if (pauseT < 0f) return;
        float[] point = positionAt(moments[active].progress);
        float cx = width / 2f + (point[0] - camX) * scale;
        float cy = height / 2f + (point[1] - camY) * scale;
        float in = Math.min(1f, pauseT / 0.16f);
        float out = Math.min(1f, (1f - pauseT) / 0.22f);
        float alpha = Math.min(in, out);
        if (alpha <= 0.01f) return;
        float pop = 0.72f + 0.28f * easeOutBack(in);
        drawBubble(active, cx, cy, pop, alpha * resultFade);
    }

    private int momentStartFrame(int index) {
        for (int i = 0; i < segCount; i += 1) {
            if (segMoment[i] == index) return segStart[i];
        }
        return -1;
    }

    private void drawBubble(int index, float cx, float cy, float pop, float alpha) {
        Bitmap bitmap = bubbleBitmaps[index];
        if (bitmap == null) {
            bitmap = buildBubbleBitmap(moments[index]);
            bubbleBitmaps[index] = bitmap;
        }
        if (bubbleTextures[index] == 0) {
            bubbleTextures[index] = upload(bitmap, 0);
        }
        float w = bitmap.getWidth() * pop;
        float h = bitmap.getHeight() * pop;
        drawTexture(bubbleTextures[index], cx - w / 2f, cy - 238f * pop, w, h, alpha);
    }

    private void drawDrawerItem(int index, float reveal) {
        Bitmap bitmap = drawerBitmaps[index];
        if (bitmap == null) {
            bitmap = buildDrawerBitmap(moments[index]);
            drawerBitmaps[index] = bitmap;
        }
        if (drawerTextures[index] == 0) {
            drawerTextures[index] = upload(bitmap, 0);
        }
        float itemH = 96f;
        float gap = 14f;
        float bottom = 1370f - index * (itemH + gap);
        float top = bottom - bitmap.getHeight();
        float slide = (1f - reveal) * 30f;
        float x = width - 14f - bitmap.getWidth() + slide;
        drawTexture(drawerTextures[index], x, top, bitmap.getWidth(), bitmap.getHeight(), reveal);
    }

    private Bitmap buildBubbleBitmap(Moment moment) {
        int size = 240;
        Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        float cx = size / 2f;
        float cy = 108f;
        float radius = 82f;

        paint.setStyle(Paint.Style.FILL);
        paint.setColor(withAlpha(glassColor, 0.96f));
        canvas.drawCircle(cx, cy, radius, paint);

        path.reset();
        path.moveTo(cx - 16f, cy + radius - 6f);
        path.lineTo(cx, cy + radius + 30f);
        path.lineTo(cx + 16f, cy + radius - 6f);
        path.close();
        canvas.drawPath(path, paint);

        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(3f);
        paint.setColor(withAlpha(moment.color, 0.85f));
        canvas.drawCircle(cx, cy, radius, paint);
        canvas.drawPath(path, paint);
        paint.setStyle(Paint.Style.FILL);

        paint.setStyle(Paint.Style.FILL);
        paint.setColor(withAlpha(moment.color, 0.14f));
        canvas.drawCircle(cx, cy, radius - 12f, paint);

        drawIcon(canvas, moment.icon, cx, cy, 62f, moment.color);
        return bitmap;
    }

    private Bitmap buildDrawerBitmap(Moment moment) {
        int bitmapWidth = 288;
        int bitmapHeight = 104;
        Bitmap bitmap = Bitmap.createBitmap(bitmapWidth, bitmapHeight, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);

        float right = bitmapWidth - 4f;
        float top = 4f;
        float bottom = bitmapHeight - 4f;
        float topLeft = right - 176f;
        float bottomLeft = right - 244f;
        path.reset();
        path.moveTo(topLeft + 20f, top);
        path.lineTo(right, top);
        path.quadTo(right + 4f, top, right + 4f, top + 12f);
        path.lineTo(right + 4f, bottom - 12f);
        path.quadTo(right + 4f, bottom, right, bottom);
        path.lineTo(bottomLeft + 20f, bottom);
        path.quadTo(bottomLeft, bottom, bottomLeft + 6f, bottom - 10f);
        path.lineTo(topLeft - 6f, top + 10f);
        path.quadTo(topLeft, top, topLeft + 20f, top);
        path.close();

        paint.setStyle(Paint.Style.FILL);
        paint.setShader(new LinearGradient(0, top, 0, bottom,
                withAlpha(glassColor, 0.92f), withAlpha(glassColor, 0.66f), Shader.TileMode.CLAMP));
        canvas.drawPath(path, paint);
        paint.setShader(null);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(2f);
        paint.setColor(withAlpha(moment.color, 0.55f));
        canvas.drawPath(path, paint);
        paint.setStyle(Paint.Style.FILL);

        // The left edge of the trapezoid is slanted, so the icon is placed from
        // the edge at mid-height plus a real gap — otherwise the glyph grows
        // straight through the outline near the top corner.
        float cy = (top + bottom) / 2f;
        float edgeX = (topLeft + bottomLeft) / 2f;
        float iconX = edgeX + 42f;
        paint.setStyle(Paint.Style.FILL);
        paint.setShader(null);
        paint.setColor(withAlpha(moment.color, 0.3f));
        canvas.drawCircle(iconX, cy, 17f, paint);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(1.6f);
        paint.setColor(withAlpha(moment.color, 0.72f));
        canvas.drawCircle(iconX, cy, 17f, paint);
        paint.setStyle(Paint.Style.FILL);
        drawIcon(canvas, moment.icon, iconX, cy, 20f, moment.color);

        float valueSize = 33f;
        float unitSize = 14f;
        float padRight = 16f;
        // The value and its unit are stacked, not laid side by side. On a
        // 288 px trapezoid "35.0 公里/小时" is wider than the space right of the
        // icon, so the old single-line layout pushed the number straight
        // through the icon plate. Stacking keeps the number right-aligned no
        // matter how long the unit string is.
        float contentRight = right - padRight;
        float iconRight = iconX + 17f + 10f;
        float available = Math.max(60f, contentRight - iconRight);
        float valueWidth = measure(moment.value, valueSize, true);
        while (valueSize > 18f && valueWidth > available) {
            valueSize -= 2f;
            valueWidth = measure(moment.value, valueSize, true);
        }
        float valueX = Math.max(iconRight, contentRight - valueWidth);
        text(canvas, moment.value, valueX, cy - 2f, valueSize, textColor, true, 0f);
        if (moment.unit != null && !moment.unit.isEmpty()) {
            float unitWidth = measure(moment.unit, unitSize, false);
            while (unitSize > 9f && unitWidth > available) {
                unitSize -= 1f;
                unitWidth = measure(moment.unit, unitSize, false);
            }
            float unitX = Math.max(iconRight, contentRight - unitWidth);
            text(canvas, moment.unit, unitX, cy + 20f, unitSize, mutedColor, false, 0.02f);
        }
        return bitmap;
    }

    // ------------------------------------------------------------ HUD

    // ------------------------------------------------------------ overview labels

    private final java.util.Map<String, Integer> shieldTextures = new java.util.HashMap<String, Integer>();

    /**
     * Closing overview: national-road shields only. Landmark illustrations were
     * dropped — on a dense city they turned the poster into a pile of icons and
     * fought the route for attention.
     */
    private void drawOverviewLabels(float camX, float camY, float scale, float alpha) {
        List<RectF> placed = new ArrayList<RectF>();

        if (overview == null) return;
        List<NativeVectorMap.Shield> shields = overview.shields(camX, camY, scale, width, height);
        int shown = 0;
        for (int i = 0; i < shields.size() && shown < 4; i += 1) {
            NativeVectorMap.Shield shield = shields.get(i);
            float w = 112f;
            float h = 40f;
            float[] spot = placeBox(placed, shield.x, shield.y, w, h);
            if (spot == null) continue;
            placed.add(new RectF(spot[0], spot[1], spot[0] + w, spot[1] + h));
            float cx = spot[0] + w / 2f;
            float cy = spot[1] + h / 2f;
            if (Math.abs(cx - shield.x) > 4f || Math.abs(cy - shield.y) > 4f) {
                drawLeader(shield.x, shield.y, cx, cy, alpha);
            }
            int texture = shieldTexture(shield.ref);
            if (texture != 0) {
                drawTexture(texture, spot[0], spot[1], w, h, alpha);
            }
            shown += 1;
        }
    }

    private boolean overlaps(List<RectF> placed, float x, float y, float w, float h) {
        for (int i = 0; i < placed.size(); i += 1) {
            RectF box = placed.get(i);
            if (x < box.right + 8 && x + w + 8 > box.left && y < box.bottom + 6 && y + h + 6 > box.top) {
                return true;
            }
        }
        return false;
    }

    private float[] placeBox(List<RectF> placed, float ax, float ay, float w, float h) {
        float[][] offsets = {
                {0f, 0f}, {w * 0.9f, 0f}, {-w * 0.9f, 0f}, {0f, -h * 0.95f}, {0f, h * 0.95f},
                {w * 0.85f, -h * 0.95f}, {-w * 0.85f, -h * 0.95f},
                {w * 0.85f, h * 0.95f}, {-w * 0.85f, h * 0.95f},
        };
        for (int i = 0; i < offsets.length; i += 1) {
            float x = Math.max(18f, Math.min(width - w - 18f, ax - w / 2f + offsets[i][0]));
            float y = Math.max(318f, Math.min(1000f - h, ay - h / 2f + offsets[i][1]));
            if (!overlaps(placed, x, y, w, h)) return new float[]{x, y};
        }
        return null;
    }

    private void drawLeader(float ax, float ay, float bx, float by, float alpha) {
        beginColorBatch();
        float r = Color.red(accent) / 255f;
        float g = Color.green(accent) / 255f;
        float b = Color.blue(accent) / 255f;
        addQuad(ax, ay, bx, by, 0.9f, r, g, b, 0.5f * alpha);
        vertexCursor = disc(ax, ay, 3.2f, r, g, b, 0.9f * alpha, 12);
        endColorBatch();
    }

    private int shieldTexture(String ref) {
        Integer cached = shieldTextures.get(ref);
        if (cached != null) return cached;
        int w = 224;
        int h = 80;
        Bitmap bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setColor(0xD9051226);
        rect.set(2, 2, w - 2, h - 2);
        canvas.drawRoundRect(rect, 14, 14, paint);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(2f);
        paint.setColor(withAlpha(accent, 0.62f));
        canvas.drawRoundRect(rect, 14, 14, paint);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(2f);
        canvas.drawCircle(34, h / 2f, 15, paint);
        Path arrow = new Path();
        arrow.moveTo(28, h / 2f + 8);
        arrow.lineTo(34, h / 2f - 6);
        arrow.lineTo(40, h / 2f + 8);
        canvas.drawPath(arrow, paint);
        float refWidth = measure(ref, 34, true);
        text(canvas, ref, 60, h / 2f + 13, 34, accent, true, 0.02f);
        text(canvas, "国道", 60 + refWidth + 8, h / 2f + 10, 20, withAlpha(textColor, 0.62f), false, 0.06f);
        int texture = upload(bitmap, 0);
        shieldTextures.put(ref, texture);
        return texture;
    }

    // ------------------------------------------------------------ hud

    private static final int HUD_X = 54;
    private static final int HUD_BAR_H = 190;
    private static final int HUD_BAR_Y = 54;       // local Y inside the bottom bitmap
    private static final int HUD_SPEED_Y = 136;    // local Y inside the top bitmap
    private static final int HUD_SPEED_H = 158;
    private static final int RED = 0xFFFF6B8A;
    private static final int ORANGE = 0xFFFFB347;

    private void drawHud(float progress, int frameIndex, float resultReveal, float bottomAlpha) {
        // Repaint at most every third frame, and only when the readouts actually
        // moved. Freeze segments and the outro hold sit on one progress value,
        // so they used to re-render two full-width canvases for no visible
        // change at all.
        if (frameIndex - hudFrame >= 3 && Math.abs(progress - hudPaintedProgress) > 0.0008f) {
            hudFrame = frameIndex;
            hudPaintedProgress = progress;
            paintHudTop(progress);
            paintHudBottom(progress);
            uploadHud(false);
            if (resultReveal > 0f && !resultPainted) {
                paintHudResult();
                hudResultTexture = upload(hudResult, hudResultTexture);
                resultPainted = true;
            }
        }
        drawTexture(hudTopTexture, 0, 0, width, hudTop.getHeight(), 1f);
        if (bottomAlpha > 0.01f) {
            drawTexture(hudBottomTexture, 0, height - hudBottom.getHeight(),
                    width, hudBottom.getHeight(), bottomAlpha);
        }
        if (resultReveal > 0f && hudResultTexture != 0) {
            drawTexture(hudResultTexture, 0, 0, width, height, easeInOut(resultReveal));
        }
    }

    private void paintHudTop(float progress) {
        Canvas canvas = hudTopCanvas;
        canvas.drawColor(0, android.graphics.PorterDuff.Mode.CLEAR);
        Paint scrim = new Paint(Paint.ANTI_ALIAS_FLAG);
        scrim.setShader(new LinearGradient(0, 0, 0, hudTop.getHeight(),
                withAlpha(stageBg, 0.92f), withAlpha(stageBg, 0f), Shader.TileMode.CLAMP));
        canvas.drawRect(0, 0, width, hudTop.getHeight(), scrim);
        drawPlacePill(canvas, progress);
        drawCoordPill(canvas, progress);
        // Speed curve lives under the top pills, matching the reference layout.
        drawSpeedPanel(canvas, progress);
    }

    /** Web-style pill: accent pin, place name, then start / elapsed segments. */
    private void drawPlacePill(Canvas canvas, float progress) {
        float x = HUD_X;
        float y = 52;
        float h = 64;
        float placeWidth = measure(place, 34, true);
        String elapsed = "用时 " + formatClock(activitySeconds * progress * timeScale);
        float startWidth = startText.isEmpty() ? 0f : measure(startText, 22, false);
        float elapsedWidth = measure(elapsed, 22, false);
        float w = 44 + placeWidth + (startText.isEmpty() ? 0f : 20f + startWidth) + 20f + elapsedWidth + 24f;

        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        // A 26 px blurred shadowLayer over a 600×64 pill costs more than the
        // rest of this pill put together. A flat offset plate reads the same on
        // both the dark and the bright theme and is essentially free.
        paint.setColor(0x33000000);
        rect.set(x, y + 6, x + w, y + h + 6);
        canvas.drawRoundRect(rect, 20, 20, paint);
        paint.setColor(glassColor);
        rect.set(x, y, x + w, y + h);
        canvas.drawRoundRect(rect, 20, 20, paint);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(1.2f);
        paint.setColor(withAlpha(textColor, 0.16f));
        canvas.drawRoundRect(rect, 20, 20, paint);
        paint.setStyle(Paint.Style.FILL);

        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(2.4f);
        paint.setColor(accent);
        canvas.drawCircle(x + 26, y + 27, 5.5f, paint);
        canvas.drawLine(x + 26, y + 33, x + 26, y + 46, paint);
        paint.setStyle(Paint.Style.FILL);

        text(canvas, place, x + 44, y + 42, 34, textColor, true, 0f);
        float cursor = x + 44 + placeWidth;
        if (!startText.isEmpty()) {
            canvas.drawLine(cursor + 10, y + 18, cursor + 10, y + 46, dividerPaint());
            text(canvas, startText, cursor + 20, y + 41, 22, mutedColor, false, 0.02f);
            cursor = cursor + 20 + startWidth;
        }
        canvas.drawLine(cursor + 10, y + 18, cursor + 10, y + 46, dividerPaint());
        text(canvas, elapsed, cursor + 20, y + 41, 22, mutedColor, false, 0.02f);
    }

    private Paint dividerPaint() {
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(1f);
        paint.setColor(withAlpha(textColor, 0.18f));
        return paint;
    }

    private void drawCoordPill(Canvas canvas, float progress) {
        float[] ll = latLonAt(progress);
        String lat = String.format(Locale.US, "%.5f°%s", Math.abs(ll[0]), ll[0] >= 0 ? "N" : "S");
        String lon = String.format(Locale.US, "%.5f°%s", Math.abs(ll[1]), ll[1] >= 0 ? "E" : "W");
        String value = lat + "   " + lon;
        float textWidth = measure(value, 22, false);
        float w = textWidth + 48;
        float h = 58;
        float x = width - HUD_X - w;
        float y = 55;

        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setColor(0x33000000);
        rect.set(x, y + 5, x + w, y + h + 5);
        canvas.drawRoundRect(rect, 18, 18, paint);
        paint.setColor(glassColor);
        rect.set(x, y, x + w, y + h);
        canvas.drawRoundRect(rect, 18, 18, paint);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(1.2f);
        paint.setColor(withAlpha(textColor, 0.16f));
        canvas.drawRoundRect(rect, 18, 18, paint);
        text(canvas, value, x + 24, y + 36, 22, textColor, false, 0.01f);
    }

    private void paintHudBottom(float progress) {
        Canvas canvas = hudBottomCanvas;
        canvas.drawColor(0, android.graphics.PorterDuff.Mode.CLEAR);
        Paint scrim = new Paint(Paint.ANTI_ALIAS_FLAG);
        scrim.setShader(new LinearGradient(0, 20, 0, hudBottom.getHeight(), new int[]{
                withAlpha(stageBg, 0f),
                withAlpha(stageBg, 0.48f),
                withAlpha(stageBg, 0.82f),
        }, new float[]{0f, 0.42f, 1f}, Shader.TileMode.CLAMP));
        canvas.drawRect(0, 0, width, hudBottom.getHeight(), scrim);
        drawMetricBar(canvas, progress);
    }

    /** Speed panel: sits under the top pills, above the metric bar. */
    private void drawSpeedPanel(Canvas canvas, float progress) {
        float x = HUD_X;
        float y = HUD_SPEED_Y;
        float w = width - HUD_X * 2f;
        float h = HUD_SPEED_H;

        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setShader(new LinearGradient(0, y, 0, y + h,
                withAlpha(stageBg, 0.58f), withAlpha(stageBg, 0.08f), Shader.TileMode.CLAMP));
        canvas.drawRoundRect(x, y, x + w, y + h, 16, 16, paint);
        paint.setShader(null);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(1f);
        paint.setColor(withAlpha(textColor, 0.12f));
        canvas.drawRoundRect(x, y, x + w, y + h, 16, 16, paint);
        paint.setStyle(Paint.Style.FILL);

        text(canvas, "速度", x + 18, y + 26, 15, mutedColor, false, 0.06f);
        String speed = String.format(Locale.US, "%.1f", sampleSeries(speedSeries, progress));
        text(canvas, speed, x + 52, y + 27, 23, textColor, true, 0f);
        float valueWidth = measure(speed, 23, true);
        text(canvas, "公里/小时", x + 52 + 8 + valueWidth, y + 26, 12, mutedColor, false, 0.02f);

        float left = x + 18;
        float right = x + w - 18;
        float top = y + 34;
        float bottom = y + h - 30;
        float center = (top + bottom) / 2f;
        float graphH = bottom - top;

        Paint grid = new Paint(Paint.ANTI_ALIAS_FLAG);
        grid.setStyle(Paint.Style.STROKE);
        grid.setStrokeWidth(1f);
        grid.setColor(withAlpha(textColor, 0.10f));
        for (float gx = left; gx <= right; gx += 42) {
            canvas.drawLine(gx, top, gx, bottom, grid);
        }
        canvas.drawLine(left, center, right, center, grid);

        int count = speedCurveX.length;
        if (count < 2) return;

        float[] px = speedCurveX;
        float[] py = speedCurveY;

        Path full = new Path();
        full.moveTo(px[0], py[0]);
        for (int i = 1; i < count; i += 1) full.lineTo(px[i], py[i]);
        Paint line = new Paint(Paint.ANTI_ALIAS_FLAG);
        line.setStyle(Paint.Style.STROKE);
        line.setStrokeWidth(1.5f);
        line.setColor(withAlpha(accent, 0.32f));
        canvas.drawPath(full, line);

        float travelled = Math.max(0f, Math.min(1f, progress)) * (count - 1);
        int last = Math.max(0, Math.min(count - 2, (int) Math.floor(travelled)));
        float frac = travelled - last;
        float dotX = px[last] + (px[last + 1] - px[last]) * frac;
        float dotY = py[last] + (py[last + 1] - py[last]) * frac;

        Path area = new Path();
        area.moveTo(px[0], bottom);
        area.lineTo(px[0], py[0]);
        for (int i = 1; i <= last; i += 1) area.lineTo(px[i], py[i]);
        area.lineTo(dotX, dotY);
        area.lineTo(dotX, bottom);
        area.close();
        Paint fillPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        fillPaint.setShader(new LinearGradient(0, top, 0, bottom, new int[]{
                withAlpha(accent, 0.38f), withAlpha(accent, 0.12f), withAlpha(accent, 0f),
        }, new float[]{0f, 0.6f, 1f}, Shader.TileMode.CLAMP));
        canvas.drawPath(area, fillPaint);

        Path active = new Path();
        active.moveTo(px[0], py[0]);
        for (int i = 1; i <= last; i += 1) active.lineTo(px[i], py[i]);
        active.lineTo(dotX, dotY);
        Paint hot = new Paint(Paint.ANTI_ALIAS_FLAG);
        hot.setStyle(Paint.Style.STROKE);
        hot.setStrokeCap(Paint.Cap.ROUND);
        hot.setStrokeJoin(Paint.Join.ROUND);
        // A shadowLayer here re-blurs the whole curve bounding box on every HUD
        // refresh. Two stacked strokes read the same and cost nothing.
        hot.setStrokeWidth(6.5f);
        hot.setColor(withAlpha(accent, 0.20f));
        canvas.drawPath(active, hot);
        hot.setStrokeWidth(2.7f);
        hot.setColor(accent);
        canvas.drawPath(active, hot);

        Paint glow = new Paint(Paint.ANTI_ALIAS_FLAG);
        glow.setShader(new android.graphics.RadialGradient(dotX, dotY, 46f,
                new int[]{withAlpha(accent, 0.24f), withAlpha(accent, 0f)},
                new float[]{0f, 1f}, Shader.TileMode.CLAMP));
        canvas.drawCircle(dotX, dotY, 46, glow);

        Paint dot = new Paint(Paint.ANTI_ALIAS_FLAG);
        dot.setColor(accent);
        canvas.drawCircle(dotX, dotY, 5, dot);
        dot.setStyle(Paint.Style.STROKE);
        dot.setStrokeWidth(1.5f);
        dot.setColor(0xD9FFFFFF);
        canvas.drawCircle(dotX, dotY, 5, dot);

        text(canvas, "速度曲线", x + 18, y + h - 9, 12, mutedColor, false, 0.08f);
    }

    private void drawMetricBar(Canvas canvas, float progress) {
        float x = HUD_X;
        float y = HUD_BAR_Y;
        float w = width - HUD_X * 2f;
        float h = HUD_BAR_H;

        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setColor(0x2E000000);
        rect.set(x, y + 6, x + w, y + h + 6);
        canvas.drawRoundRect(rect, 27, 27, paint);
        paint.setColor(glassColor);
        rect.set(x, y, x + w, y + h);
        canvas.drawRoundRect(rect, 27, 27, paint);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(1.2f);
        paint.setColor(withAlpha(textColor, 0.16f));
        canvas.drawRoundRect(rect, 27, 27, paint);
        paint.setStyle(Paint.Style.FILL);
        paint.setShader(new LinearGradient(0, y, 0, y + h,
                withAlpha(textColor, 0.15f), withAlpha(textColor, 0.01f), Shader.TileMode.CLAMP));
        canvas.drawRoundRect(rect, 27, 27, paint);
        paint.setShader(null);

        List<String[]> items = new ArrayList<>();
        items.add(new String[]{"route", "距离",
                String.format(Locale.US, "%.2f", displayMeters * progress / 1000.0), "公里"});
        items.add(new String[]{"clock", "时间", formatClock(activitySeconds * progress * timeScale), ""});
        if (heartSeries.length > 0) {
            items.add(new String[]{"heart", "心率",
                    String.valueOf(Math.round(sampleSeries(heartSeries, progress))), "次/分钟"});
        }
        items.add(new String[]{"speed", "速度",
                String.format(Locale.US, "%.1f", sampleSeries(speedSeries, progress)), "公里/小时"});

        int[] iconColors = {accent, accent2, RED, ORANGE};
        float column = w / items.size();
        float unitSize = 14f;
        // One shared size for all four columns: "163.38 公里" is the widest cell,
        // and a 45 px number plus its unit overflowed into the next column.
        // Shrinking together keeps the row visually even.
        float valueSize = 45f;
        for (int i = 0; i < items.size(); i += 1) {
            String[] probe = items.get(i);
            float unitWidth = probe[3].isEmpty() ? 0f : measure(probe[3], unitSize, false);
            while (valueSize > 26f
                    && measure(probe[2], valueSize, true) + (unitWidth > 0f ? 8f + unitWidth : 0f)
                    > column - 70f) {
                valueSize -= 1f;
            }
        }
        for (int i = 0; i < items.size(); i += 1) {
            String[] item = items.get(i);
            float cx = x + column * i;
            if (i > 0) {
                canvas.drawLine(cx, y + 35, cx, y + h - 35, dividerPaint());
            }
            int color = iconColors[i % iconColors.length];
            badge(canvas, cx + 34, y + 70, 16, color);
            drawIcon(canvas, item[0], cx + 34, y + 70, 18, color);
            text(canvas, item[1], cx + 66, y + 53, 18, mutedColor, false, 0.06f);
            float valueWidth = measure(item[2], valueSize, true);
            text(canvas, item[2], cx + 58, y + 122, valueSize, textColor, true, -0.01f);
            if (!item[3].isEmpty()) {
                text(canvas, item[3], cx + 58 + valueWidth + 8, y + 119, unitSize, mutedColor, false, 0.02f);
            }
        }
    }

    private void paintHudResult() {
        Canvas canvas = hudResultCanvas;
        canvas.drawColor(0, android.graphics.PorterDuff.Mode.CLEAR);

        Paint scrim = new Paint(Paint.ANTI_ALIAS_FLAG);
        scrim.setShader(new LinearGradient(0, 720, 0, height, new int[]{
                withAlpha(stageBg, 0f),
                withAlpha(stageBg, 0.72f),
                withAlpha(stageBg, 0.90f),
        }, new float[]{0f, 0.28f, 1f}, Shader.TileMode.CLAMP));
        canvas.drawRect(0, 0, width, height, scrim);

        List<String[]> metrics = new ArrayList<>();
        metrics.add(new String[]{"route", "总距离", formatDistance(displayMeters), "公里", String.valueOf(accent)});
        metrics.add(new String[]{"clock", "运动时长", formatSpan(movingSeconds), spanUnit(movingSeconds), String.valueOf(accent2)});
        if (elapsedAvailable) {
            metrics.add(new String[]{"hourglass", "总时长", formatSpan(elapsedSeconds), spanUnit(elapsedSeconds), String.valueOf(accent2)});
        }
        if (!"—".equals(maxSpeedText) && !maxSpeedText.isEmpty()) {
            metrics.add(new String[]{"speedometer", "最快速度", maxSpeedText, "公里/小时", String.valueOf(ORANGE)});
        }
        if (!"—".equals(heart) && !heart.isEmpty()) {
            metrics.add(new String[]{"heart", "最高心率", heart, "次/分钟", String.valueOf(RED)});
        }
        if (!"—".equals(maxAltitudeText) && !maxAltitudeText.isEmpty()) {
            metrics.add(new String[]{"mountain", "最高海拔", maxAltitudeText, "米", String.valueOf(accent)});
        }
        if (!avgSpeedText.isEmpty()) {
            metrics.add(new String[]{"gauge", "平均速度", avgSpeedText, "公里/小时", String.valueOf(accent2)});
        }
        if (!caloriesText.isEmpty()) {
            metrics.add(new String[]{"flame", "消耗热量", caloriesText, "千卡", String.valueOf(ORANGE)});
        }

        float panelX = HUD_X;
        float panelW = width - HUD_X * 2f;
        float innerW = panelW - 76;
        float gap = 14;
        float cardW = (innerW - gap) / 2f;
        float cardH = 128;
        float rowGap = 14;
        int rows = Math.max(1, (metrics.size() + 1) / 2);
        float panelH = 132 + rows * cardH + (rows - 1) * rowGap + 34;
        float panelY = Math.max(1040, 1782 - panelH);

        Paint panel = new Paint(Paint.ANTI_ALIAS_FLAG);
        panel.setShadowLayer(46f, 0f, 16f, 0x99000000);
        panel.setColor(glassColor);
        rect.set(panelX, panelY, panelX + panelW, panelY + panelH);
        canvas.drawRoundRect(rect, 34, 34, panel);
        panel.clearShadowLayer();
        panel.setStyle(Paint.Style.STROKE);
        panel.setStrokeWidth(1.6f);
        panel.setColor(withAlpha(textColor, 0.18f));
        canvas.drawRoundRect(rect, 34, 34, panel);
        panel.setStyle(Paint.Style.FILL);

        Paint tick = new Paint(Paint.ANTI_ALIAS_FLAG);
        tick.setStyle(Paint.Style.STROKE);
        tick.setStrokeWidth(4f);
        tick.setStrokeCap(Paint.Cap.ROUND);
        tick.setColor(accent);
        canvas.drawLine(panelX + 40, panelY, panelX + 198, panelY, tick);

        text(canvas, title, panelX + 42, panelY + 76, 54, textColor, true, 0f);
        text(canvas, subtitle, panelX + 44, panelY + 112, 20, mutedColor, false, 0.02f);

        for (int i = 0; i < metrics.size(); i += 1) {
            int col = i % 2;
            int row = i / 2;
            boolean wide = metrics.size() % 2 == 1 && i == metrics.size() - 1;
            float x = panelX + 38 + (wide ? 0 : col * (cardW + gap));
            float y = panelY + 132 + row * (cardH + rowGap);
            gridMetric(canvas, metrics.get(i), x, y, wide ? innerW : cardW, cardH, wide);
        }

        String credit = "MAP © ESRI";
        text(canvas, credit, panelX + panelW - 38 - measure(credit, 10, false), panelY + panelH - 22, 10,
                withAlpha(textColor, 0.28f), false, 0.08f, false);
    }

    private void gridMetric(Canvas canvas, String[] item, float x, float y, float w, float h, boolean wide) {
        int color = Integer.parseInt(item[4]);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setColor(glassColor);
        rect.set(x, y, x + w, y + h);
        canvas.drawRoundRect(rect, 18, 18, paint);
        paint.setColor(withAlpha(color, 0.065f));
        canvas.drawRoundRect(rect, 18, 18, paint);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(1f);
        paint.setColor(withAlpha(textColor, 0.14f));
        canvas.drawRoundRect(rect, 18, 18, paint);
        paint.setStyle(Paint.Style.FILL);

        // Icon + label sit in the top band, the value in its own band below.
        // At the old offsets (icon centre 42, value baseline 98) a 46 px number
        // grew straight into the icon plate, which read as "glued together".
        badge(canvas, x + 32, y + 38, 21, color);
        drawIcon(canvas, item[0], x + 32, y + 38, 22, color);
        text(canvas, item[1], x + 74, y + 44, 20, mutedColor, false, 0.06f);

        float unitGap = 14;
        float unitWidth = measure(item[3], 18, true);
        // Shrink until value + unit fit the card; a long number with a long unit
        // ("公里/小时") could otherwise run past the card edge.
        float valueSize = 46;
        float valueWidth = measure(item[2], valueSize, true);
        float budget = wide ? 420f : w - 56f;
        while (valueSize > 30f && valueWidth + unitGap + unitWidth > budget) {
            valueSize -= 2f;
            valueWidth = measure(item[2], valueSize, true);
        }
        float right = x + w - 26;
        float valueX = wide ? right - valueWidth - unitWidth - unitGap : x + 28;
        text(canvas, item[2], valueX, y + 108, valueSize, textColor, true, -0.01f);
        text(canvas, item[3], valueX + valueWidth + unitGap, y + 106, 18, color, true, 0.02f);
    }

    private void badge(Canvas canvas, float cx, float cy, float size, int color) {
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        rect.set(cx - size, cy - size, cx + size, cy + size);
        paint.setShader(new LinearGradient(0f, cy - size, 0f, cy + size,
                withAlpha(color, 0.26f), withAlpha(color, 0.07f), Shader.TileMode.CLAMP));
        canvas.drawRoundRect(rect, size * 0.58f, size * 0.58f, paint);
        paint.setShader(null);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(1.2f);
        paint.setColor(withAlpha(color, 0.38f));
        canvas.drawRoundRect(rect, size * 0.58f, size * 0.58f, paint);
        paint.setStyle(Paint.Style.FILL);
    }

    private float[] latLonAt(float progress) {
        float target = Math.max(0f, Math.min(1f, progress)) * cumulative[cumulative.length - 1];
        int low = 0;
        int high = cumulative.length - 1;
        while (low < high - 1) {
            int mid = (low + high) >>> 1;
            if (cumulative[mid] <= target) low = mid;
            else high = mid;
        }
        float span = cumulative[high] - cumulative[low];
        float local = span <= 0 ? 0 : (target - cumulative[low]) / span;
        return new float[]{
                lats[low] + (lats[high] - lats[low]) * local,
                lons[low] + (lons[high] - lons[low]) * local,
        };
    }

    /**
     * Metric glyphs. Filled and lit rather than thin line art: at export size a
     * 2 px stroke reads as a smudge, while a filled mark with a highlight keeps
     * its shape on glass. Geometry is authored in a 20×20 box and scaled, so
     * the bubble, the drawer and the result card all share one drawing.
     */
    private final java.util.HashMap<String, Bitmap> iconCache = new java.util.HashMap<String, Bitmap>();

    /**
     * Icons are pure geometry with a fixed colour, so they are rasterised once
     * per (kind, size, colour) and blitted afterwards. Drawing them from paths
     * every frame meant a handful of Paint/Path/Shader allocations per icon per
     * HUD refresh, which showed up as allocation churn in the export profile.
     */
    private void drawIcon(Canvas canvas, String kind, float cx, float cy, float size, int color) {
        int box = Math.max(20, Math.round(size * 1.6f));
        int quantised = Math.round(size);
        String key = kind + "|" + quantised + "|" + Integer.toHexString(color);
        Bitmap cache = iconCache.get(key);
        if (cache == null) {
            cache = Bitmap.createBitmap(box, box, Bitmap.Config.ARGB_8888);
            paintIcon(new Canvas(cache), kind, box / 2f, box / 2f, quantised, color);
            iconCache.put(key, cache);
        }
        float half = quantised * 0.8f;
        rect.set(cx - half, cy - half, cx + half, cy + half);
        canvas.drawBitmap(cache, null, rect, null);
    }

    private void paintIcon(Canvas canvas, String kind, float cx, float cy, float size, int color) {
        float k = size / 20f;
        Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        fill.setStyle(Paint.Style.FILL);
        Paint line = new Paint(Paint.ANTI_ALIAS_FLAG);
        line.setStyle(Paint.Style.STROKE);
        line.setStrokeCap(Paint.Cap.ROUND);
        line.setStrokeJoin(Paint.Join.ROUND);
        Path glyph = new Path();

        canvas.save();
        canvas.translate(cx, cy);
        canvas.scale(k, k);

        if ("heart".equals(kind)) {
            glyph.reset();
            glyph.moveTo(0f, 8f);
            glyph.cubicTo(-12f, 0f, -9f, -12f, 0f, -5f);
            glyph.cubicTo(9f, -12f, 12f, 0f, 0f, 8f);
            fill.setColor(color);
            canvas.drawPath(glyph, fill);
            line.setColor(0xB8FFFFFF);
            line.setStrokeWidth(1.1f);
            glyph.reset();
            glyph.moveTo(-5f, -5f);
            glyph.quadTo(-7f, -1f, -4f, 2f);
            canvas.drawPath(glyph, line);
            fill.setColor(0xA6FFFFFF);
            canvas.drawCircle(-4f, -4f, 1.4f, fill);
        } else if ("speedometer".equals(kind)) {
            line.setColor(color);
            line.setStrokeWidth(2.8f);
            glyph.reset();
            glyph.addArc(-9.5f, -7.5f, 9.5f, 11.5f, 200f, 140f);
            canvas.drawPath(glyph, line);
            line.setColor(0xCCFFFFFF);
            line.setStrokeWidth(1.2f);
            for (int i = -2; i <= 2; i += 1) {
                double a = -Math.PI / 2 + i * 0.28;
                float cos = (float) Math.cos(a);
                float sin = (float) Math.sin(a);
                glyph.reset();
                glyph.moveTo(cos * 6.7f, 2f + sin * 6.7f);
                glyph.lineTo(cos * 8.7f, 2f + sin * 8.7f);
                canvas.drawPath(glyph, line);
            }
            line.setStrokeWidth(2.2f);
            glyph.reset();
            glyph.moveTo(0f, 3f);
            glyph.lineTo(6.1f, -4.2f);
            canvas.drawPath(glyph, line);
            fill.setColor(0xFFFFFFFF);
            canvas.drawCircle(0f, 3f, 1.8f, fill);
        } else if ("speed".equals(kind)) {
            glyph.reset();
            glyph.moveTo(-7f, 8f);
            glyph.lineTo(0f, -9f);
            glyph.lineTo(1f, -1f);
            glyph.lineTo(8f, -3f);
            glyph.lineTo(-1f, 9f);
            glyph.close();
            fill.setColor(color);
            canvas.drawPath(glyph, fill);
            line.setColor(0xBFFFFFFF);
            line.setStrokeWidth(1f);
            glyph.reset();
            glyph.moveTo(-3f, 4f);
            glyph.lineTo(1f, -3f);
            canvas.drawPath(glyph, line);
        } else if ("clock".equals(kind)) {
            fill.setShader(null);
            fill.setColor(withAlpha(color, 0.18f));
            canvas.drawCircle(0f, 0f, 9f, fill);
            line.setColor(color);
            line.setStrokeWidth(2f);
            canvas.drawCircle(0f, 0f, 9f, line);
            line.setColor(0xF2FFFFFF);
            line.setStrokeWidth(1.8f);
            glyph.reset();
            glyph.moveTo(0f, -5f);
            glyph.lineTo(0f, 1f);
            glyph.lineTo(4f, 4f);
            canvas.drawPath(glyph, line);
            fill.setColor(0xFFFFFFFF);
            canvas.drawCircle(0f, 0f, 1.4f, fill);
        } else if ("hourglass".equals(kind)) {
            line.setColor(color);
            line.setStrokeWidth(2.2f);
            // 上下横杠
            glyph.reset();
            glyph.moveTo(-7.5f, -9.5f);
            glyph.lineTo(7.5f, -9.5f);
            canvas.drawPath(glyph, line);
            glyph.reset();
            glyph.moveTo(-7.5f, 9.5f);
            glyph.lineTo(7.5f, 9.5f);
            canvas.drawPath(glyph, line);
            // 杯身：上宽 → 腰 → 下宽
            glyph.reset();
            glyph.moveTo(-6.5f, -8f);
            glyph.lineTo(6.5f, -8f);
            glyph.quadTo(6.5f, -2f, 1.5f, 0f);
            glyph.quadTo(6.5f, 2f, 6.5f, 8f);
            glyph.lineTo(-6.5f, 8f);
            glyph.quadTo(-6.5f, 2f, -1.5f, 0f);
            glyph.quadTo(-6.5f, -2f, -6.5f, -8f);
            glyph.close();
            fill.setShader(new LinearGradient(0f, -8f, 0f, 8f,
                    withAlpha(color, 0.5f), withAlpha(color, 0.12f), Shader.TileMode.CLAMP));
            canvas.drawPath(glyph, fill);
            fill.setShader(null);
            // 沙：上仓剩余 + 流柱 + 下仓堆积
            fill.setColor(0xE6FFFFFF);
            glyph.reset();
            glyph.moveTo(-3.4f, -6.5f);
            glyph.lineTo(3.4f, -6.5f);
            glyph.lineTo(0f, -1.5f);
            glyph.close();
            canvas.drawPath(glyph, fill);
            glyph.reset();
            glyph.moveTo(-2.6f, 7.6f);
            glyph.lineTo(2.6f, 7.6f);
            glyph.lineTo(0f, 3.4f);
            glyph.close();
            canvas.drawPath(glyph, fill);
            line.setColor(0xB8FFFFFF);
            line.setStrokeWidth(1f);
            glyph.reset();
            glyph.moveTo(0f, -1.2f);
            glyph.lineTo(0f, 3.2f);
            canvas.drawPath(glyph, line);
        } else if ("mountain".equals(kind)) {
            glyph.reset();
            glyph.moveTo(-11f, 8f);
            glyph.lineTo(-2f, -9f);
            glyph.lineTo(3f, 1f);
            glyph.lineTo(6f, -5f);
            glyph.lineTo(11f, 8f);
            glyph.close();
            fill.setShader(new LinearGradient(0f, -10f, 0f, 10f,
                    withAlpha(color, 0.95f), withAlpha(color, 0.42f), Shader.TileMode.CLAMP));
            canvas.drawPath(glyph, fill);
            fill.setShader(null);
            line.setColor(0xD1FFFFFF);
            line.setStrokeWidth(1.4f);
            glyph.reset();
            glyph.moveTo(-6f, 1f);
            glyph.lineTo(-2f, -3f);
            glyph.lineTo(1f, 0f);
            glyph.moveTo(4f, -2f);
            glyph.lineTo(6f, -4.5f);
            glyph.lineTo(8f, -2f);
            canvas.drawPath(glyph, line);
        } else if ("gauge".equals(kind)) {
            line.setColor(color);
            line.setStrokeWidth(2.6f);
            glyph.reset();
            glyph.addArc(-9.5f, -6.5f, 9.5f, 12.5f, 180f, 180f);
            canvas.drawPath(glyph, line);
            line.setColor(0xE6FFFFFF);
            line.setStrokeWidth(1.8f);
            glyph.reset();
            glyph.moveTo(0f, 3f);
            glyph.lineTo(5.4f, -4.4f);
            canvas.drawPath(glyph, line);
            fill.setColor(0xFFFFFFFF);
            canvas.drawCircle(0f, 3f, 1.5f, fill);
        } else if ("flame".equals(kind)) {
            glyph.reset();
            glyph.moveTo(0f, 9f);
            glyph.cubicTo(-9f, 4f, -6f, -3f, -1f, -10f);
            glyph.cubicTo(0f, -5f, 4f, -5f, 3f, -1f);
            glyph.cubicTo(7f, -2f, 9f, 6f, 0f, 9f);
            glyph.close();
            fill.setShader(new LinearGradient(0f, -11f, 0f, 10f, new int[]{
                    0xFFFFE16A, color, withAlpha(color, 0.55f)},
                    new float[]{0f, 0.55f, 1f}, Shader.TileMode.CLAMP));
            canvas.drawPath(glyph, fill);
            fill.setShader(null);
            fill.setColor(0xA6FFFFFF);
            glyph.reset();
            glyph.moveTo(0f, 6f);
            glyph.quadTo(-3f, 2f, 0f, -3f);
            glyph.quadTo(3f, 2f, 0f, 6f);
            canvas.drawPath(glyph, fill);
        } else if ("route".equals(kind)) {
            line.setColor(color);
            line.setStrokeWidth(2.2f);
            glyph.reset();
            glyph.moveTo(-10f, 6f);
            glyph.cubicTo(-7f, -1f, -2f, 1f, 0f, -5f);
            glyph.cubicTo(3f, 4f, 7f, 0f, 10f, 6f);
            canvas.drawPath(glyph, line);
            fill.setColor(color);
            float[][] dots = {{-10f, 6f}, {0f, -5f}, {10f, 6f}};
            for (int i = 0; i < dots.length; i += 1) {
                canvas.drawCircle(dots[i][0], dots[i][1], 2.5f, fill);
                line.setColor(0xB3FFFFFF);
                line.setStrokeWidth(0.8f);
                canvas.drawCircle(dots[i][0], dots[i][1], 2.5f, line);
            }
        } else if ("pin".equals(kind)) {
            line.setColor(color);
            line.setStrokeWidth(2f);
            glyph.reset();
            glyph.addCircle(0f, -4f, 5.4f, Path.Direction.CW);
            canvas.drawPath(glyph, line);
            glyph.reset();
            glyph.moveTo(-3.4f, 0f);
            glyph.lineTo(0f, 8f);
            glyph.lineTo(3.4f, 0f);
            canvas.drawPath(glyph, line);
            fill.setColor(color);
            canvas.drawCircle(0f, -4f, 1.6f, fill);
        } else {
            fill.setColor(color);
            canvas.drawCircle(0f, 0f, 7f, fill);
        }
        canvas.restore();
    }

    private final int[] liveTextureW = new int[2];
    private final int[] liveTextureH = new int[2];

    private void uploadHud(boolean withResult) {
        hudTopTexture = uploadLive(hudTop, hudTopTexture, 0);
        hudBottomTexture = uploadLive(hudBottom, hudBottomTexture, 1);
        if (withResult) hudResultTexture = upload(hudResult, hudResultTexture);
    }

    /**
     * HUD textures keep their size for the whole export, so they can be updated
     * in place with texSubImage2D. texImage2D re-specifies the texture and makes
     * the driver reallocate it every refresh, which dominated the HUD cost.
     */
    private int uploadLive(Bitmap bitmap, int texture, int slot) {
        if (texture == 0 || liveTextureW[slot] != bitmap.getWidth()
                || liveTextureH[slot] != bitmap.getHeight()) {
            liveTextureW[slot] = bitmap.getWidth();
            liveTextureH[slot] = bitmap.getHeight();
            return upload(bitmap, texture);
        }
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture);
        GLUtils.texSubImage2D(GLES20.GL_TEXTURE_2D, 0, 0, 0, bitmap);
        return texture;
    }

    private int upload(Bitmap bitmap, int texture) {
        if (texture == 0) {
            int[] textures = new int[1];
            GLES20.glGenTextures(1, textures, 0);
            texture = textures[0];
        }
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
        GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bitmap, 0);
        return texture;
    }

    private void text(Canvas canvas, String value, float x, float y, float size,
                      int color, boolean bold, float letterSpacing) {
        text(canvas, value, x, y, size, color, bold, letterSpacing, false);
    }

    private static final Typeface FONT_BOLD = Typeface.create("sans-serif", Typeface.BOLD);
    private static final Typeface FONT_NORMAL = Typeface.create("sans-serif", Typeface.NORMAL);
    private final Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);

    private void text(Canvas canvas, String value, float x, float y, float size,
                      int color, boolean bold, float letterSpacing, boolean centered) {
        Paint p = textPaint;
        p.setTypeface(bold ? FONT_BOLD : FONT_NORMAL);
        p.setTextSize(size);
        p.setColor(color);
        p.setLetterSpacing(letterSpacing);
        float px = centered ? x - p.measureText(value) / 2f : x;
        canvas.drawText(value, px, y, p);
    }

    private float measure(String value, float size, boolean bold) {
        Paint p = textPaint;
        p.setTypeface(bold ? FONT_BOLD : FONT_NORMAL);
        p.setTextSize(size);
        p.setLetterSpacing(0f);
        return p.measureText(value);
    }

    private static String formatDistance(double meters) {
        return String.format(Locale.US, "%.2f", meters / 1000.0);
    }

    private static String formatSpan(double seconds) {
        int total = (int) Math.max(0, Math.round(seconds));
        if (total < 86400) return formatClock(total);
        int days = total / 86400;
        int hours = (int) Math.round((total % 86400) / 3600.0);
        return hours > 0 ? days + " 天 " + hours + " 小时" : days + " 天";
    }

    /** 跨天时长自带单位，卡片里不再补「时:分:秒」。 */
    private static String spanUnit(double seconds) {
        return seconds >= 86400 ? "" : "时:分:秒";
    }

    private static String formatClock(double seconds) {
        int total = (int) Math.max(0, Math.round(seconds));
        int hours = total / 3600;
        int minutes = (total % 3600) / 60;
        int secs = total % 60;
        return hours > 0
                ? String.format(Locale.US, "%d:%02d:%02d", hours, minutes, secs)
                : String.format(Locale.US, "%02d:%02d", minutes, secs);
    }

    private static String formatPace(double seconds, double meters) {
        if (meters < 60) return "--'--\"";
        double perKm = seconds / (meters / 1000.0);
        int minutes = (int) (perKm / 60);
        int secs = (int) Math.round(perKm - minutes * 60);
        if (secs == 60) { minutes += 1; secs = 0; }
        return String.format(Locale.US, "%d'%02d\"", minutes, secs);
    }

    private static int withAlpha(int color, float alpha) {
        return withAlphaInt(color, (int) (255 * alpha));
    }

    private static int withAlphaInt(int color, int alpha) {
        return (Math.max(0, Math.min(255, alpha)) << 24) | (color & 0x00FFFFFF);
    }

    private static float easeOut(float t) {
        float c = Math.max(0f, Math.min(1f, t));
        return 1f - (1f - c) * (1f - c);
    }

    private static float easeInOut(float t) {
        float c = Math.max(0f, Math.min(1f, t));
        return c < 0.5f ? 2f * c * c : 1f - (float) Math.pow(-2f * c + 2f, 2f) / 2f;
    }

    private static float easeOutBack(float t) {
        float c = Math.max(0f, Math.min(1f, t));
        float c1 = 1.70158f;
        float c3 = c1 + 1f;
        return 1f + c3 * (float) Math.pow(c - 1, 3) + c1 * (float) Math.pow(c - 1, 2);
    }

    private static float smoothstep(float edge0, float edge1, float x) {
        float t = Math.max(0f, Math.min(1f, (x - edge0) / (edge1 - edge0)));
        return t * t * (3f - 2f * t);
    }

    private void buildKmAtlas(int count) {
        if (count <= 0) return;
        kmAtlasRows = (int) Math.ceil(count / (double) KM_COLS);
        kmAtlas = Bitmap.createBitmap(KM_COLS * KM_CELL, kmAtlasRows * KM_CELL, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(kmAtlas);
        Paint label = new Paint(Paint.ANTI_ALIAS_FLAG);
        label.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
        label.setTextSize(24);
        label.setTextAlign(Paint.Align.CENTER);
        label.setColor(withAlpha(textColor, 0.86f));
        Paint halo = new Paint(Paint.ANTI_ALIAS_FLAG);
        halo.setStyle(Paint.Style.STROKE);
        halo.setStrokeWidth(5f);
        halo.setStrokeJoin(Paint.Join.ROUND);
        halo.setTypeface(label.getTypeface());
        halo.setTextSize(24);
        halo.setTextAlign(Paint.Align.CENTER);
        halo.setColor(withAlpha(background, 0.85f));
        Paint.FontMetrics metrics = label.getFontMetrics();
        float baseline = KM_CELL / 2f - (metrics.ascent + metrics.descent) / 2f;
        for (int i = 0; i < count; i += 1) {
            float cx = (i % KM_COLS) * KM_CELL + KM_CELL / 2f;
            float cy = (i / KM_COLS) * KM_CELL + baseline;
            String value = String.valueOf(kmValues[i]);
            canvas.drawText(value, cx, cy, halo);
            canvas.drawText(value, cx, cy, label);
        }
    }

    // ------------------------------------------------------------- GL setup

    private void ensureGl() {
        if (colorProgram != 0) return;
        String colorVs = "attribute vec2 aPos; attribute vec4 aColor; uniform vec2 uViewport;"
                + "varying vec4 vColor;"
                + "void main(){ gl_Position=vec4(aPos.x/uViewport.x*2.0-1.0, 1.0-aPos.y/uViewport.y*2.0,0.0,1.0);"
                + "vColor=aColor; }";
        String colorFs = "precision mediump float; varying vec4 vColor;"
                + "void main(){ gl_FragColor=vColor; }";
        colorProgram = link(colorVs, colorFs);
        colorPosition = GLES20.glGetAttribLocation(colorProgram, "aPos");
        colorValue = GLES20.glGetAttribLocation(colorProgram, "aColor");
        colorViewport = GLES20.glGetUniformLocation(colorProgram, "uViewport");

        String texVs = "attribute vec2 aPos; attribute vec2 aTex; uniform vec2 uViewport;"
                + "uniform vec2 uOrigin; uniform vec2 uSize; varying vec2 vTex;"
                + "void main(){ vec2 p = uOrigin + aPos*uSize;"
                + "gl_Position=vec4(p.x/uViewport.x*2.0-1.0, 1.0-p.y/uViewport.y*2.0,0.0,1.0);"
                + "vTex=aTex; }";
        String texFs = "precision mediump float; varying vec2 vTex; uniform sampler2D uTex;"
                + "uniform float uAlpha;"
                + "void main(){ vec4 c = texture2D(uTex, vTex); gl_FragColor=vec4(c.rgb*uAlpha, c.a*uAlpha); }";
        textureProgram = link(texVs, texFs);
        texturePosition = GLES20.glGetAttribLocation(textureProgram, "aPos");
        textureCoord = GLES20.glGetAttribLocation(textureProgram, "aTex");
        textureSampler = GLES20.glGetUniformLocation(textureProgram, "uTex");
        textureViewport = GLES20.glGetUniformLocation(textureProgram, "uViewport");
        textureOrigin = GLES20.glGetUniformLocation(textureProgram, "uOrigin");
        textureSize = GLES20.glGetUniformLocation(textureProgram, "uSize");
        textureAlpha = GLES20.glGetUniformLocation(textureProgram, "uAlpha");

        unitQuad = floatBuffer(new float[]{0f, 0f, 1f, 0f, 0f, 1f, 1f, 1f});
        unitTex = floatBuffer(new float[]{0f, 0f, 1f, 0f, 0f, 1f, 1f, 1f});
        if (kmAtlas != null) kmAtlasTexture = upload(kmAtlas, 0);
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

    private FloatBuffer floatBuffer(float[] values) {
        FloatBuffer buffer = ByteBuffer.allocateDirect(values.length * 4)
                .order(ByteOrder.nativeOrder()).asFloatBuffer();
        buffer.put(values).position(0);
        return buffer;
    }

    private void drawTexture(int texture, float x, float y, float w, float h, float alpha) {
        drawTextureWith(texture, x, y, w, h, alpha, unitTex);
    }

    /** Draws a sub-rectangle of a texture (used by the kilometre-label atlas). */
    private void drawTextureRegion(int texture, float x, float y, float w, float h,
                                   float alpha, float u0, float v0, float u1, float v1) {
        if (texture == 0) return;
        if (regionTex == null) regionTex = floatBuffer(new float[8]);
        regionTex.clear();
        regionTex.put(u0).put(v0).put(u1).put(v0).put(u0).put(v1).put(u1).put(v1).position(0);
        drawTextureWith(texture, x, y, w, h, alpha, regionTex);
    }

    private void drawTextureWith(int texture, float x, float y, float w, float h,
                                 float alpha, FloatBuffer coords) {
        if (texture == 0) return;
        GLES20.glUseProgram(textureProgram);
        GLES20.glUniform2f(textureViewport, width, height);
        GLES20.glUniform2f(textureOrigin, x, y);
        GLES20.glUniform2f(textureSize, w, h);
        GLES20.glUniform1f(textureAlpha, alpha);
        GLES20.glEnable(GLES20.GL_BLEND);
        GLES20.glBlendFunc(GLES20.GL_ONE, GLES20.GL_ONE_MINUS_SRC_ALPHA);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture);
        GLES20.glUniform1i(textureSampler, 0);
        GLES20.glEnableVertexAttribArray(texturePosition);
        GLES20.glVertexAttribPointer(texturePosition, 2, GLES20.GL_FLOAT, false, 0, unitQuad);
        GLES20.glEnableVertexAttribArray(textureCoord);
        GLES20.glVertexAttribPointer(textureCoord, 2, GLES20.GL_FLOAT, false, 0, coords);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        GLES20.glDisableVertexAttribArray(texturePosition);
        GLES20.glDisableVertexAttribArray(textureCoord);
        GLES20.glDisable(GLES20.GL_BLEND);
    }

    private static final class Moment {
        String label;
        String value;
        String unit;
        String icon;
        float progress;
        int color;
    }
}

final class NativeRenderJob {
    /** Export progress for the /progress poller; coarse values, cross-thread. */
    static volatile String progressPhase = "idle";
    static volatile boolean cancelRequested;
    static final java.util.concurrent.atomic.AtomicInteger progressDone =
            new java.util.concurrent.atomic.AtomicInteger();
    static final java.util.concurrent.atomic.AtomicInteger progressTotal =
            new java.util.concurrent.atomic.AtomicInteger();

    /** Called by /abort: the render loop stops at the next frame boundary. */
    static void requestCancel() {
        cancelRequested = true;
    }

    static JSONObject render(Context context, String payloadJson) throws Exception {
        cancelRequested = false;
        JSONObject payload = new JSONObject(payloadJson);
        int width = payload.optInt("width", 1080);
        int height = payload.optInt("height", 1920);
        int fps = payload.optInt("fps", 30);
        int bitrate = payload.optInt("bitrate", 4_000_000);
        double duration = payload.optDouble("durationSec", 38.0);
        int totalFrames = Math.max(1, (int) Math.ceil(duration * fps));
        File temp = new File(context.getCacheDir(), "fit-motion-native-scene-" + System.currentTimeMillis() + ".mp4");
        long started = SystemClock.elapsedRealtime();

        long tilesStart = SystemClock.elapsedRealtime();
        progressPhase = "prefetch";
        progressDone.set(0);
        progressTotal.set(1);
        NativeVectorMap follow = new NativeVectorMap(payload, context.getCacheDir(),
                NativeVectorMap.FOLLOW_ZOOM, false);
        NativeVectorMap overview = new NativeVectorMap(payload, context.getCacheDir(),
                overviewZoom(payload), true);
        long tileLoadMs = SystemClock.elapsedRealtime() - tilesStart;

        NativeEncoder encoder = new NativeEncoder(width, height, bitrate, fps, temp);
        NativeRouteScene scene = new NativeRouteScene(payload, follow, overview, width, height, fps);

        // Pre-rasterise every follow tile the travelling camera can see — in
        // parallel, before encoding starts — so the render loop draws steady
        // textured quads instead of stalling on a first-use paint. Rasters are
        // also cached on disk, so repeat exports of the route are much faster.
        int threads = Math.max(2, Math.min(5, Runtime.getRuntime().availableProcessors() - 2));
        List<long[]> followTargets = scene.followPrerasterTargets();
        List<long[]> overviewTargets = scene.overviewPrerasterTargets();
        // The poster framing shows the whole overview viewport at once, so the
        // cache has to hold every one of those tiles; at the follow layer's cap
        // of 28 the rest were evicted before the first frame was drawn.
        overview.setBitmapLimit(Math.max(scene.overviewCacheLimit(), overviewTargets.size() + 24));
        overview.ensureTiles(overviewTargets);
        progressPhase = "raster";
        progressTotal.set(followTargets.size() + overviewTargets.size());
        progressDone.set(0);
        follow.preRaster(followTargets, scene.followTilePx(), threads, progressDone);
        overview.preRaster(overviewTargets, scene.overviewTilePx(), threads, progressDone);
        follow.awaitPreRaster();
        overview.awaitPreRaster();
        if (cancelRequested) throw new java.io.IOException("导出已取消");

        progressPhase = "render";
        progressTotal.set(totalFrames);
        try {
            encoder.start();
            // Frames in the cover/intro, the cruise and the outro cost very
            // different amounts; keep them apart so a stalled tail is obvious.
            int introEnd = scene.introEndFrame();
            int outroStart = scene.outroStartFrame();
            int[] segFrames = new int[3];
            long[] segDraw = new long[3];
            long[] segTile = new long[3];
            long[] segRoute = new long[3];
            long[] segHud = new long[3];
            long swapMs = 0;
            long drainMs = 0;
            long loopStart = SystemClock.elapsedRealtime();
            for (int i = 0; i < totalFrames; i += 1) {
                if (cancelRequested) throw new java.io.IOException("导出已取消");
                progressDone.set(i);
                encoder.encodeScene(scene, i, totalFrames);
                int seg = i < introEnd ? 0 : (i >= outroStart ? 2 : 1);
                segFrames[seg] += 1;
                segDraw[seg] += encoder.lastDrawMs;
                segTile[seg] += scene.lastTileMs;
                segRoute[seg] += scene.lastRouteMs;
                segHud[seg] += scene.lastHudMs;
                swapMs += encoder.lastSwapMs;
                drainMs += encoder.lastDrainMs;
            }
            progressDone.set(totalFrames);
            long loopMs = SystemClock.elapsedRealtime() - loopStart;
            File encoded = encoder.finish();
            // 背景音乐：JS 侧把整轨渲染成 base64 的 16-bit PCM 一并送来，
            // 这里编成 AAC 与视频混流。视频轨原样拷贝，不重编码。
            long audioMs = -1;
            long audioTrackMs = -1;
            long outMs = -1;
            String audioNote = null;
            File result = encoded;
            JSONObject audio = payload.optJSONObject("audio");
            if (audio != null) {
                String b64 = audio.optString("pcm", "");
                int sampleRate = audio.optInt("sampleRate", 44100);
                int channels = Math.max(1, Math.min(2, audio.optInt("channels", 2)));
                if (b64.length() > 0) {
                    progressPhase = "audio";
                    byte[] pcm = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
                    File mixed = new File(context.getCacheDir(),
                            "fit-motion-audio-" + System.currentTimeMillis() + ".mp4");
                    try {
                        AudioMixer.Result mix = AudioMixer.mux(encoded, pcm, sampleRate, channels, mixed);
                        audioMs = mix.mixMs;
                        audioTrackMs = mix.audioTrackMs;
                        outMs = mix.outMs;
                        encoded.delete();
                        result = mixed;
                    } catch (Exception mixError) {
                        // 混流失败也要给用户一条能用的片子：退回静音版，并把原因报给前端。
                        try { mixed.delete(); } catch (Exception ignored) { }
                        audioNote = mixError.getMessage() == null ? "混流失败" : mixError.getMessage();
                    }
                }
            }
            long elapsed = SystemClock.elapsedRealtime() - started;
            String uri = NativeFrameServer.saveNativeVideo(context, result);
            result.delete();
            JSONObject response = new JSONObject();
            if (audioMs >= 0) response.put("audioMs", audioMs);
            if (audioTrackMs >= 0) response.put("audioTrackMs", audioTrackMs);
            if (outMs >= 0) response.put("outMs", outMs);
            if (audioNote != null) response.put("audioNote", audioNote);
            response.put("ok", true);
            response.put("uri", uri);
            response.put("seconds", elapsed / 1000.0);
            response.put("frames", totalFrames);
            response.put("fps", totalFrames / Math.max(0.001, elapsed / 1000.0));
            response.put("loopSeconds", loopMs / 1000.0);
            response.put("tileLoadMs", tileLoadMs);
            response.put("tileRasterMs", follow.rasterMs() + overview.rasterMs());
            response.put("tileUploads", follow.uploads() + overview.uploads());
            response.put("routeMsPerFrame", round(scene.routeMs / (double) totalFrames));
            response.put("hudMsPerFrame", round(scene.hudMs / (double) totalFrames));
            response.put("tileDrawMsPerFrame", round(scene.tileMs / (double) totalFrames));
            response.put("mapTiles", follow.tileCount() + overview.tileCount());
            response.put("posterFrames", scene.posterReused);
            response.put("swapMsPerFrame", round(swapMs / (double) totalFrames));
            response.put("drainMsPerFrame", round(drainMs / (double) totalFrames));
            putPhase(response, "cover", segFrames, segDraw, segTile, segRoute, segHud, 0);
            putPhase(response, "cruise", segFrames, segDraw, segTile, segRoute, segHud, 1);
            putPhase(response, "outro", segFrames, segDraw, segTile, segRoute, segHud, 2);
            return response;
        } catch (Exception error) {
            try { encoder.abort(); } catch (Exception ignored) { }
            throw error;
        }
    }

    private static void putPhase(JSONObject response, String name, int[] frames, long[] draw,
                                 long[] tile, long[] route, long[] hud, int seg) throws Exception {
        if (frames[seg] <= 0) return;
        double n = frames[seg];
        response.put(name + "Frames", frames[seg]);
        response.put(name + "MsPerFrame", round(draw[seg] / n));
        response.put(name + "TileMs", round(tile[seg] / n));
        response.put(name + "RouteMs", round(route[seg] / n));
        response.put(name + "HudMs", round(hud[seg] / n));
    }

    /**
     * Picks the tile zoom whose route bounding box lands near 1700 px, the same
     * rule the Canvas renderer uses, so the cover and result shots stay sharp
     * without fetching thousands of high-zoom tiles.
     */
    static int overviewZoom(JSONObject payload) {
        JSONArray points = payload.optJSONArray("points");
        int zoom = NativeVectorMap.FOLLOW_ZOOM;
        while (zoom > 8) {
            double minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
            boolean any = false;
            if (points != null) {
                for (int i = 0; i < points.length(); i += Math.max(1, points.length() / 400)) {
                    try {
                        JSONArray point = points.getJSONArray(i);
                        double lat = point.getDouble(0);
                        double lon = point.getDouble(1);
                        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
                        minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
                        any = true;
                    } catch (Exception ignored) { }
                }
            }
            if (!any) return zoom;
            double scale = NativeVectorMap.TILE * (double) (1 << zoom);
            double x0 = (minLon + 180.0) / 360.0 * scale;
            double x1 = (maxLon + 180.0) / 360.0 * scale;
            double y0 = (1.0 - Math.log(Math.tan(Math.PI / 4.0 + Math.toRadians(maxLat) / 2.0)) / Math.PI) / 2.0 * scale;
            double y1 = (1.0 - Math.log(Math.tan(Math.PI / 4.0 + Math.toRadians(minLat) / 2.0)) / Math.PI) / 2.0 * scale;
            if (Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) <= 1700) return zoom;
            zoom -= 1;
        }
        return zoom;
    }

    private static double round(double value) {
        return Math.round(value * 10.0) / 10.0;
    }
}
