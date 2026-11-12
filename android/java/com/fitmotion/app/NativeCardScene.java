package com.fitmotion.app;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.opengl.GLES20;
import android.opengl.GLUtils;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;

/**
 * 年度回顾的数据卡幕：片头（年份 + 总里程数字滚动 + 称号）与片尾
 * （12 个月柱状图逐月长出来 + 累计里程 + 称号落版）。
 *
 * 为什么不塞进 NativeRouteScene：这一幕既不需要地图瓦片也不需要路线几何，
 * 只是 2D 排版 + 数字动画。整帧用 Canvas 直绘到一张位图，再作为纹理上传、
 * 铺一个全屏 quad —— 每帧一次重绘（10~20ms），比拉一套地图便宜得多，也让
 * "分章"能真正混排「路线幕 / 数据幕」，而不是十二段同样的地图。
 *
 * 必须在持有 EGL 上下文的渲染线程创建与释放（release()）。
 */
final class NativeCardScene implements NativeScene {
    /** 缺省调色板（payload 未带 palette 时的回退，保持旧观感）。 */
    private static final int INK = 0xFFF4F7EE;
    private static final int LIME = 0xFFD8FF3E;
    private static final int GOLD = 0xFFE8B84A;
    private static final int BG_TOP = 0xFF12384A;
    private static final int BG_BOTTOM = 0xFF08131C;

    private final int width;
    private final int height;
    private final int fps;
    private final boolean opening;
    /** 主题调色板：JS 侧按当前 data-theme 传（ink/accent/warn/bgTop/bgBottom）。 */
    private final int ink;
    private final int accent;
    private final int warn;
    private final int bgTop;
    private final int bgBottom;
    private final int year;
    private final double totalMeters;
    private final int rideDays;
    private final int rides;
    private final double climbM;
    private final String titleName;
    private final String titleDesc;
    private final float[] months = new float[12];

    private Bitmap bitmap;
    private Canvas canvas;
    private int texture;
    private boolean uploaded;
    private Paint paint;
    private LinearGradient bg;
    private RadialGradient glow;

    private int program;
    private int aPos;
    private int aTex;
    private int uViewport;
    private int uOrigin;
    private int uSize;
    private int uAlpha;
    private int uTex;
    private FloatBuffer quad;
    private FloatBuffer texCoords;

    NativeCardScene(JSONObject chapter, int width, int height, int fps) {
        this.width = width;
        this.height = height;
        this.fps = fps;
        this.opening = !"closing".equals(chapter.optString("cardKind", "opening"));
        this.year = chapter.optInt("year", 2025);
        JSONObject palette = chapter.optJSONObject("palette");
        this.ink = colorOf(palette, "ink", INK);
        this.accent = colorOf(palette, "accent", LIME);
        this.warn = colorOf(palette, "warn", GOLD);
        this.bgTop = colorOf(palette, "bgTop", BG_TOP);
        this.bgBottom = colorOf(palette, "bgBottom", BG_BOTTOM);
        this.totalMeters = chapter.optDouble("totalMeters", 0);
        this.rideDays = chapter.optInt("rideDays", 0);
        this.rides = chapter.optInt("rides", 0);
        this.climbM = chapter.optDouble("climbM", 0);
        this.titleName = chapter.optString("titleName", "");
        this.titleDesc = chapter.optString("titleDesc", "");
        JSONArray array = chapter.optJSONArray("months");
        if (array != null) {
            for (int i = 0; i < Math.min(12, array.length()); i += 1) {
                months[i] = (float) array.optDouble(i, 0);
            }
        }
    }

    /** "#rrggbb" → ARGB int，解析失败回退 fallback。 */
    private static int colorOf(JSONObject palette, String key, int fallback) {
        if (palette == null) return fallback;
        try {
            return android.graphics.Color.parseColor(palette.optString(key, ""));
        } catch (Exception ignored) {
            return fallback;
        }
    }

    private static int withAlpha(int color, int alpha) {
        return (color & 0x00FFFFFF) | (alpha << 24);
    }

    @Override
    public void draw(int w, int h, int frameIndex, int totalFrames) {
        ensureGl();
        ensureBitmap();
        float progress = totalFrames <= 1 ? 1f : Math.max(0f, Math.min(1f, frameIndex / (float) (totalFrames - 1)));
        if (opening) paintOpening(progress);
        else paintClosing(progress);
        uploadFrame();
        blit();
    }

    // ------------------------------------------------------------- 片头卡

    private void paintOpening(float p) {
        paintBackground();
        float t = easeOut(Math.min(1f, p / 0.55f));
        // 年份：从下方轻轻推上来
        textAlpha = fade(p, 0.02f, 0.16f);
        if (textAlpha > 0) {
            centered("FIT MOTION · 年度回顾", height * 0.29f, 34, accent, 12, null, 0.9f);
            centered(String.valueOf(year), height * 0.40f, 168, ink, 4, null, 1f);
            centered("我的骑行年度", height * 0.445f, 38, withAlpha(ink, 0xB3), 10, null, 1f);
        }

        // 总里程：数字滚动
        double km = totalMeters / 1000.0 * t;
        String kmText = number(km, km >= 1000 ? 0 : 1);
        float alpha = fade(p, 0.10f, 0.24f);
        if (alpha > 0) {
            textAlpha = alpha;
            centered("年度总里程", height * 0.545f, 32, withAlpha(ink, 0x99), 8, null, 1f);
            centered(kmText, height * 0.625f, 176, accent, 2, null, 1f);
            centered("公里", height * 0.665f, 34, ink, 10, null, 0.8f);
        }

        // 副行数据
        float meta = fade(p, 0.30f, 0.44f);
        if (meta > 0) {
            textAlpha = meta;
            String line = rideDays + " 天在路上 · " + rides + " 次出发";
            if (climbM >= 100) line += " · 爬升 " + number(climbM, 0) + " 米";
            centered(line, height * 0.715f, 34, withAlpha(ink, 0xC8), 2, null, 1f);
        }

        // 称号
        float badge = fade(p, 0.60f, 0.78f);
        if (badge > 0 && !titleName.isEmpty()) {
            textAlpha = badge;
            centered("年度称号", height * 0.795f, 26, warn, 8, null, 1f);
            centered(titleName, height * 0.845f, 66, ink, 6, null, 1f);
        }

        textAlpha = 0.35f * fade(p, 0.2f, 0.5f);
        centered("FIT MOTION · YEAR IN MOTION", height * 0.94f, 24, ink, 8, null, 1f);

        fadeEdges(p, 0.06f, 0.1f);
    }

    // ------------------------------------------------------------- 片尾卡

    private void paintClosing(float p) {
        paintBackground();
        float head = fade(p, 0.00f, 0.14f);
        if (head > 0) {
            textAlpha = head;
            centered(String.valueOf(year), height * 0.115f, 46, accent, 10, null, 0.9f);
            centered("月度节奏", height * 0.165f, 44, ink, 12, null, 1f);
        }

        // 12 根柱子：自适应宽度
        float left = width * 0.085f;
        float right = width * 0.915f;
        float gap = (right - left) * 0.012f;
        float barW = (right - left - gap * 11) / 12f;
        float baseline = height * 0.60f;
        float chartH = height * 0.30f;
        float max = 0.0001f;
        for (float v : months) max = Math.max(max, v);
        int topMonth = 0;
        for (int i = 0; i < 12; i += 1) if (months[i] >= months[topMonth]) topMonth = i;

        Paint bar = reuse();
        bar.setShader(null);
        bar.setStyle(Paint.Style.FILL);
        RectF rectF = new RectF();
        for (int i = 0; i < 12; i += 1) {
            float grow = clamp((p - 0.08f - i * 0.032f) / 0.20f);
            if (grow <= 0f) continue;
            float ratio = months[i] / max;
            float bh = Math.max(height * 0.004f, chartH * ratio * easeOut(grow));
            float x = left + i * (barW + gap);
            bar.setColor(i == topMonth ? accent : withAlpha(accent, 0x3A));
            rectF.set(x, baseline - bh, x + barW, baseline);
            canvas.drawRoundRect(rectF, barW * 0.28f, barW * 0.28f, bar);

            textAlpha = 0.55f * grow;
            Paint label = textPaint(24, i == topMonth ? accent : withAlpha(ink, 0x80), 0);
            canvas.drawText(String.valueOf(i + 1), x + barW / 2f, baseline + height * 0.026f, label);
        }
        // 最高月数值
        float topX = left + topMonth * (barW + gap) + barW / 2f;
        textAlpha = fade(p, 0.35f, 0.48f);
        Paint peak = textPaint(26, accent, 0);
        peak.setTextAlign(Paint.Align.CENTER);
        float peakH = chartH * (months[topMonth] / max);
        canvas.drawText(number(months[topMonth] / 1000.0, 0) + " km", topX,
                baseline - peakH - height * 0.014f, peak);

        textAlpha = 0.45f;
        leftText("月度里程（公里）", left, baseline + height * 0.056f, 22, ink);

        // 累计里程
        float total = fade(p, 0.28f, 0.52f);
        if (total > 0) {
            textAlpha = total;
            double km = totalMeters / 1000.0 * easeOut(Math.min(1f, (p - 0.28f) / 0.42f));
            centered(number(km, 0) + " 公里", height * 0.715f, 96, ink, 4, null, 1f);
            textAlpha = 0.6f * total;
            centered(rideDays + " 天在路上 · " + rides + " 次出发", height * 0.755f, 30, ink, 2, null, 1f);
        }

        // 称号落版
        float badge = fade(p, 0.55f, 0.72f);
        if (badge > 0 && !titleName.isEmpty()) {
            textAlpha = badge;
            centered(titleName, height * 0.825f, 58, accent, 6, null, 1f);
            textAlpha = 0.55f * badge;
            centered(titleDesc, height * 0.862f, 26, ink, 1, null, 1f);
        }
        textAlpha = 0.32f * fade(p, 0.6f, 0.8f);
        centered("FIT MOTION · YEAR IN MOTION", height * 0.94f, 24, ink, 8, null, 1f);

        fadeEdges(p, 0.04f, 0.10f);
    }

    // -------------------------------------------------------------- 绘制辅助

    private float textAlpha = 1f;

    private void paintBackground() {
        if (bg == null) {
            bg = new LinearGradient(0, 0, 0, height, bgTop, bgBottom, Shader.TileMode.CLAMP);
            glow = new RadialGradient(width * 0.86f, -height * 0.04f, height * 0.52f,
                    new int[]{withAlpha(accent, 0x3F), 0x00000000}, new float[]{0f, 1f}, Shader.TileMode.CLAMP);
        }
        Paint fill = reuse();
        fill.setShader(bg);
        canvas.drawRect(0, 0, width, height, fill);
        fill.setShader(glow);
        canvas.drawRect(0, 0, width, height, fill);
        fill.setShader(null);
        // 装饰圆环，压住右上角的空
        fill.setStyle(Paint.Style.STROKE);
        fill.setStrokeWidth(2f);
        fill.setColor(withAlpha(accent, 0x1F));
        canvas.drawCircle(width * 0.86f, -height * 0.02f, height * 0.30f, fill);
        fill.setColor(withAlpha(accent, 0x12));
        canvas.drawCircle(width * 0.86f, -height * 0.02f, height * 0.40f, fill);
        fill.setStyle(Paint.Style.FILL);
    }

    /** 首尾各做一次黑场过渡，避免硬切和末尾定格太生硬。 */
    private void fadeEdges(float p, float in, float out) {
        float alpha = 0f;
        if (p < in) alpha = 1f - clamp(p / in);
        else if (p > 1f - out) alpha = clamp((p - (1f - out)) / out);
        if (alpha <= 0.001f) return;
        Paint black = reuse();
        black.setShader(null);
        black.setStyle(Paint.Style.FILL);
        black.setColor(((int) (alpha * 255) << 24));
        canvas.drawRect(0, 0, width, height, black);
    }

    private Paint reuse() {
        paint.reset();
        paint.setAlpha(255);
        paint.setStyle(Paint.Style.FILL);
        paint.setShader(null);
        paint.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        paint.setTextAlign(Paint.Align.LEFT);
        paint.setFakeBoldText(false);
        return paint;
    }

    private Paint textPaint(int size, int color, int letterSpacing) {
        Paint p = reuse();
        p.setTextSize(size);
        p.setColor(color);
        if (size >= 40) p.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        return p;
    }

    private void centered(String text, float y, int size, int color, float letterSpacing,
                          Paint unused, float alphaScale) {
        if (text == null || text.isEmpty()) return;
        Paint p = textPaint(size, color, 0);
        p.setTextAlign(Paint.Align.CENTER);
        p.setAlpha((int) (255 * clamp(textAlpha * alphaScale)));
        canvas.drawText(text, width / 2f, y, p);
    }

    private void leftText(String text, float x, float y, int size, int color) {
        if (text == null || text.isEmpty()) return;
        Paint p = textPaint(size, color, 0);
        p.setTextAlign(Paint.Align.LEFT);
        p.setAlpha((int) (255 * clamp(textAlpha)));
        canvas.drawText(text, x, y, p);
    }

    private static float fade(float p, float from, float to) {
        if (p <= from) return 0f;
        if (p >= to) return 1f;
        return easeInOut((p - from) / (to - from));
    }

    private static float clamp(float v) {
        return Math.max(0f, Math.min(1f, v));
    }

    private static float easeOut(float t) {
        float v = clamp(t);
        return 1f - (1f - v) * (1f - v);
    }

    private static float easeInOut(float t) {
        float v = clamp(t);
        return v < 0.5f ? 2f * v * v : 1f - (float) Math.pow(-2f * v + 2f, 2) / 2f;
    }

    private static String number(double value, int digits) {
        String text = digits > 0 ? String.format(java.util.Locale.US, "%." + digits + "f", value)
                : String.valueOf(Math.round(value));
        int dot = text.indexOf('.');
        String head = dot >= 0 ? text.substring(0, dot) : text;
        String tail = dot >= 0 ? text.substring(dot) : "";
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < head.length(); i += 1) {
            if (i > 0 && (head.length() - i) % 3 == 0) builder.append(',');
            builder.append(head.charAt(i));
        }
        return builder + tail;
    }

    // ------------------------------------------------------------------ GL

    private void ensureBitmap() {
        if (bitmap != null) return;
        bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        canvas = new Canvas(bitmap);
        paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        paint.setSubpixelText(true);
    }

    private void uploadFrame() {
        if (!uploaded) {
            texture = upload(bitmap, 0);
            uploaded = true;
        } else {
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture);
            GLUtils.texSubImage2D(GLES20.GL_TEXTURE_2D, 0, 0, 0, bitmap);
        }
    }

    private void blit() {
        if (texture == 0) return;
        GLES20.glViewport(0, 0, width, height);
        GLES20.glUseProgram(program);
        GLES20.glUniform2f(uViewport, width, height);
        GLES20.glUniform2f(uOrigin, 0f, 0f);
        GLES20.glUniform2f(uSize, width, height);
        GLES20.glUniform1f(uAlpha, 1f);
        GLES20.glEnable(GLES20.GL_BLEND);
        GLES20.glBlendFunc(GLES20.GL_ONE, GLES20.GL_ONE_MINUS_SRC_ALPHA);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture);
        GLES20.glUniform1i(uTex, 0);
        GLES20.glEnableVertexAttribArray(aPos);
        GLES20.glVertexAttribPointer(aPos, 2, GLES20.GL_FLOAT, false, 0, quad);
        GLES20.glEnableVertexAttribArray(aTex);
        GLES20.glVertexAttribPointer(aTex, 2, GLES20.GL_FLOAT, false, 0, texCoords);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        GLES20.glDisableVertexAttribArray(aPos);
        GLES20.glDisableVertexAttribArray(aTex);
        GLES20.glDisable(GLES20.GL_BLEND);
    }

    private int upload(Bitmap source, int existing) {
        int[] ids = new int[1];
        if (existing == 0) {
            GLES20.glGenTextures(1, ids, 0);
            existing = ids[0];
        }
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, existing);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
        GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, source, 0);
        return existing;
    }

    private void ensureGl() {
        if (program != 0) return;
        String vertex = "attribute vec2 aPos; attribute vec2 aTex; uniform vec2 uViewport;"
                + "uniform vec2 uOrigin; uniform vec2 uSize; varying vec2 vTex;"
                + "void main(){ vec2 p = uOrigin + aPos*uSize;"
                + "gl_Position=vec4(p.x/uViewport.x*2.0-1.0, 1.0-p.y/uViewport.y*2.0,0.0,1.0);"
                + "vTex=aTex; }";
        String fragment = "precision mediump float; varying vec2 vTex; uniform sampler2D uTex;"
                + "uniform float uAlpha;"
                + "void main(){ vec4 c = texture2D(uTex, vTex); gl_FragColor=vec4(c.rgb*uAlpha, c.a*uAlpha); }";
        program = link(vertex, fragment);
        aPos = GLES20.glGetAttribLocation(program, "aPos");
        aTex = GLES20.glGetAttribLocation(program, "aTex");
        uViewport = GLES20.glGetUniformLocation(program, "uViewport");
        uOrigin = GLES20.glGetUniformLocation(program, "uOrigin");
        uSize = GLES20.glGetUniformLocation(program, "uSize");
        uAlpha = GLES20.glGetUniformLocation(program, "uAlpha");
        uTex = GLES20.glGetUniformLocation(program, "uTex");
        quad = floatBuffer(new float[]{0f, 0f, 1f, 0f, 0f, 1f, 1f, 1f});
        texCoords = floatBuffer(new float[]{0f, 0f, 1f, 0f, 0f, 1f, 1f, 1f});
    }

    private int link(String vertex, String fragment) {
        int vs = GLES20.glCreateShader(GLES20.GL_VERTEX_SHADER);
        GLES20.glShaderSource(vs, vertex);
        GLES20.glCompileShader(vs);
        int fs = GLES20.glCreateShader(GLES20.GL_FRAGMENT_SHADER);
        GLES20.glShaderSource(fs, fragment);
        GLES20.glCompileShader(fs);
        int id = GLES20.glCreateProgram();
        GLES20.glAttachShader(id, vs);
        GLES20.glAttachShader(id, fs);
        GLES20.glLinkProgram(id);
        return id;
    }

    private FloatBuffer floatBuffer(float[] values) {
        FloatBuffer buffer = ByteBuffer.allocateDirect(values.length * 4)
                .order(ByteOrder.nativeOrder()).asFloatBuffer();
        buffer.put(values).position(0);
        return buffer;
    }

    /** 编码结束立即释放：与 NativeRouteScene 同一套逐章回收策略。 */
    void release() {
        if (texture != 0) {
            GLES20.glDeleteTextures(1, new int[]{texture}, 0);
            texture = 0;
        }
        if (program != 0) {
            GLES20.glDeleteProgram(program);
            program = 0;
        }
        if (bitmap != null) {
            bitmap.recycle();
            bitmap = null;
        }
        canvas = null;
    }
}
