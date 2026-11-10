package com.fitmotion.app;

import android.app.Activity;
import android.opengl.EGL14;
import android.opengl.EGLConfig;
import android.opengl.EGLContext;
import android.opengl.EGLDisplay;
import android.opengl.EGLSurface;
import android.opengl.GLES20;
import android.opengl.GLES30;
import android.view.Surface;

import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * 预览渲染核心：EGL 上下文 + 场景 FBO + 瓦片地图 + 渲染线程。
 *
 * 与「画面挂在哪」解耦：SurfaceView 和 TextureView 都只是提供一块 Surface，
 * 这里 attach/detach 即可。个别 ROM 上 WebView 透明挖洞配 SurfaceView 会黑屏，
 * 宿主视图会自动换成 TextureView 重挂同一个 Surface 流程。
 *
 * 场景固定按 1080×1920 渲染到 FBO（HUD 排版按这个宽度写死的），再用一个
 * 全屏 quad 缩放拷贝到窗口 surface——预览表面通常只有几百物理像素宽，
 * 直接用它当渲染目标会让 HUD 文字比例失真。
 */
final class NativePreviewRenderer {

    interface Callback {
        void onReady(int totalFrames);
        void onError(String message);
    }

    private static final int SCENE_W = 1080;
    private static final int SCENE_H = 1920;
    private static final int PREVIEW_FPS = 30;

    private final Activity host;
    private final String payloadJson;
    private final Callback callback;
    private final int totalFrames;

    private Thread prepareThread;
    private Thread renderThread;
    private volatile boolean running;
    private volatile boolean mapsReady;
    private volatile boolean glReady;
    private volatile boolean surfaceValid;
    private volatile int surfaceW = 1;
    private volatile int surfaceH = 1;
    private volatile boolean errorReported;
    private volatile int targetFrame;
    /** 当前 EGL 上下文是否为 OpenGL ES 3（决定能否用 MSAA 渲染缓冲） */
    private boolean es3;

    private NativeVectorMap follow;
    private NativeVectorMap overview;
    private NativeRouteScene scene;

    private EGLDisplay display = EGL14.EGL_NO_DISPLAY;
    private EGLContext context = EGL14.EGL_NO_CONTEXT;
    private EGLSurface eglSurface = EGL14.EGL_NO_SURFACE;

    /**
     * 路线 ribbon 是硬边几何，没有片元级抗锯齿；导出成片按 1080 全屏播放看不出，
     * 但预览要把 FBO 缩放到更小的表面，锯齿加双线性缩放会让路线看起来又粗又糊。
     * ES3 可用时给场景 FBO 挂 4x MSAA 渲染缓冲，resolve 时硬件做高质量降采样；
     * 不可用（或帧缓冲不完整）就退回普通纹理 FBO。
     */
    private boolean msaa;
    private int msaaFbo;
    private int msaaRb;
    private int resolveFbo;
    private int fbo;
    private int fboTex;
    private int blitProgram;
    private int blitPosition;
    private int blitCoord;
    private int blitViewport;
    private int blitSampler;

    private final Object frameLock = new Object();
    private boolean dirty;

    NativePreviewRenderer(Activity activity, String payloadJson, Callback callback) {
        this.host = activity;
        this.payloadJson = payloadJson;
        this.callback = callback;
        int frames = 1;
        try {
            JSONObject payload = new JSONObject(payloadJson);
            double durationSec = payload.optDouble("durationSec", 30);
            int fps = Math.max(1, payload.optInt("fps", PREVIEW_FPS));
            frames = (int) Math.ceil(durationSec * fps);
        } catch (Exception ignored) { }
        this.totalFrames = Math.max(1, frames);
    }

    int totalFrames() {
        return totalFrames;
    }

    /** 是否已经成功出过帧（宿主据此判断 SurfaceView 路线是否可用）。 */
    boolean isGlReady() {
        return glReady;
    }

    // ------------------------------------------------------------ lifecycle

    void start() {
        running = true;
        renderThread = new Thread(new Runnable() {
            @Override
            public void run() {
                renderLoop();
            }
        }, "fm-preview-gl");
        renderThread.start();
        beginPrepare(host);
    }

    /** 新 surface 就绪（SurfaceView 的 holder 或 TextureView 的 SurfaceTexture）。 */
    void attachSurface(Surface surface, int width, int height) {
        if (surface == null || !surface.isValid()) return;
        if (width > 0) surfaceW = width;
        if (height > 0) surfaceH = height;
        currentSurface = surface;
        surfaceValid = true;
        if (!mapsReady && host != null) beginPrepare(host);
        kick();
    }

    private volatile Surface currentSurface;

    /** surface 被销毁（含切后台、TextureView 模式换视图）：标记失效，由渲染线程收尾。 */
    void detachSurface() {
        surfaceValid = false;
        currentSurface = null;
        kick();
    }

    void postFrame(int frame) {
        if (frame < 0) frame = 0;
        if (frame >= totalFrames) frame = totalFrames - 1;
        targetFrame = frame;
        kick();
    }

    void shutdown() {
        running = false;
        kick();
        if (renderThread != null) {
            try { renderThread.join(1500); } catch (InterruptedException ignored) { }
            renderThread = null;
        }
        releaseGl();
        follow = null;
        overview = null;
        scene = null;
        surfaceValid = false;
        glReady = false;
    }

    private void kick() {
        synchronized (frameLock) {
            dirty = true;
            frameLock.notifyAll();
        }
    }

    private void reportError(String message) {
        if (errorReported) return;
        errorReported = true;
        if (callback != null) callback.onError(message);
    }

    /**
     * 瓦片准备：下载 PBF + 走廊光栅化，纯后台，不占 GL 线程。
     * Activity 暂停导致 surface 销毁时 GL 上下文连同场景、瓦片纹理一起失效，
     * 恢复后重新走一遍（瓦片磁盘缓存在，这一步通常只要几百毫秒）。
     */
    private void beginPrepare(final Activity activity) {
        if (prepareThread != null && prepareThread.isAlive()) return;
        mapsReady = false;
        scene = null;
        follow = null;
        overview = null;
        prepareThread = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    JSONObject payload = new JSONObject(payloadJson);
                    NativeVectorMap f = new NativeVectorMap(payload, activity.getCacheDir(),
                            NativeVectorMap.FOLLOW_ZOOM, false);
                    NativeVectorMap o = new NativeVectorMap(payload, activity.getCacheDir(),
                            NativeRenderJob.overviewZoom(payload), true);
                    follow = f;
                    overview = o;
                    // 场景构造是纯解析（不碰 GL），在这里建好，渲染线程直接复用；
                    // 预烤目标/瓦片尺寸也从这个实例取，与导出保持同一套数值。
                    NativeRouteScene s = new NativeRouteScene(payload, f, o,
                            SCENE_W, SCENE_H, PREVIEW_FPS);
                    scene = s;
                    mapsReady = true;
                    kick();
                    // 立即放行渲染，预烤在后台继续：走廊瓦片按路线顺序并行光栅化，
                    // 播放中的镜头始终领先于烤图进度 → 不会出现"先糊后清"。
                    preRasterCorridor(s, f, o);
                } catch (Throwable error) {
                    if (running) {
                        reportError(error.getMessage() == null ? "地图准备失败" : error.getMessage());
                    }
                }
            }
        }, "fm-preview-maps");
        prepareThread.start();
    }

    /**
     * 导出在编码前会预烤全部可见瓦片，预览此前没有这一步：回放 zoom 扫掠阶段
     * 视口跨越的 follow 瓦片数超过 40 时只复用已烤好的（textureIfReady），
     * 没烤过的直接跳过 → 画面只剩低清晰度的 overview 层，等镜头拉近才按需
     * 现烤、突然变清晰。补上与导出相同的预烤（不阻塞进页），扫掠阶段随烤随清，
     * 稳定巡航段也不再在 GL 线程上现烤瓦片卡帧。
     */
    private void preRasterCorridor(NativeRouteScene s, NativeVectorMap f, NativeVectorMap o) {
        try {
            boolean lowRam = isLowRamDevice();
            int threads = Math.max(2, Math.min(lowRam ? 3 : 5,
                    Runtime.getRuntime().availableProcessors() - 2));
            java.util.List<long[]> followTargets = s.followPrerasterTargets();
            // 预烤结果要驻留内存才对播放有用：按单瓦片字节量算上限（常规 64MB，
            // 低内存设备 32MB——Android 低端机总堆可能只有 64~128MB，常驻过大会
            // 被系统直接杀后台），短中路线整条走廊常驻（重播也全清晰），
            // 超长路线 LRU 淘汰后走磁盘缓存。
            int budgetMb = lowRam ? 32 : 64;
            int tileBytes = (s.followTilePx() + NativeVectorMap.PAD * 2)
                    * (s.followTilePx() + NativeVectorMap.PAD * 2) * 4;
            int resident = Math.max(28, Math.min(followTargets.size(),
                    budgetMb * 1024 * 1024 / Math.max(1, tileBytes)));
            f.setBitmapLimit(resident);
            java.util.concurrent.atomic.AtomicInteger done =
                    new java.util.concurrent.atomic.AtomicInteger();
            f.preRaster(followTargets, s.followTilePx(), threads, done);
            f.awaitPreRaster();
            java.util.List<long[]> overviewTargets = s.overviewPrerasterTargets();
            if (o != null && !overviewTargets.isEmpty() && s.overviewTilePx() > 0) {
                o.setBitmapLimit(Math.max(s.overviewCacheLimit(), overviewTargets.size() + 24));
                o.ensureTiles(overviewTargets);
                o.preRaster(overviewTargets, s.overviewTilePx(), threads, done);
                o.awaitPreRaster();
            }
        } catch (Throwable ignored) { }
    }

    /** 低内存设备判定：isLowRamDevice 或 Java 堆上限 < 192MB。 */
    private boolean isLowRamDevice() {
        try {
            android.app.ActivityManager am = (android.app.ActivityManager)
                    host.getSystemService(android.content.Context.ACTIVITY_SERVICE);
            if (am != null && am.isLowRamDevice()) return true;
            return Runtime.getRuntime().maxMemory() < 192L * 1024 * 1024;
        } catch (Throwable ignored) {
            return false;
        }
    }

    // ------------------------------------------------------------ render

    private void renderLoop() {
        while (running) {
            synchronized (frameLock) {
                while (!dirty && running) {
                    try {
                        frameLock.wait(300);
                    } catch (InterruptedException ignored) { }
                }
                dirty = false;
            }
            if (!running) break;
            if (!surfaceValid || currentSurface == null) {
                // surface 没了：旧 EGL 上下文连同场景、瓦片纹理全部作废，
                // 由渲染线程自己释放（不在主线程 join，避免卡 UI）；
                // 新 surface 挂上来时 beginPrepare 重建（磁盘缓存命中，很快）
                if (glReady || scene != null || mapsReady) {
                    releaseGl();
                    glReady = false;
                    scene = null;
                    mapsReady = false;
                    follow = null;
                    overview = null;
                }
                continue;
            }
            if (!mapsReady) continue;
            try {
                drawOnce();
            } catch (Throwable error) {
                if (running && surfaceValid) {
                    reportError(error.getMessage() == null ? "渲染失败" : error.getMessage());
                    return;
                }
                // surface 正常销毁（翻页/息屏）：GL 状态整体失效，surface 回来时重建
                glReady = false;
                scene = null;
            }
        }
    }

    private void drawOnce() {
        if (!glReady) {
            initEgl(currentSurface);
            buildBlit();
            buildFbo();
            glReady = true;
            if (callback != null) callback.onReady(totalFrames);
        }
        if (scene == null) {
            try {
                scene = new NativeRouteScene(new JSONObject(payloadJson), follow, overview,
                        SCENE_W, SCENE_H, PREVIEW_FPS);
            } catch (Exception error) {
                throw new IllegalStateException("场景构建失败: "
                        + (error.getMessage() == null ? "unknown" : error.getMessage()));
            }
        }
        if (msaa) {
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, msaaFbo);
            scene.draw(SCENE_W, SCENE_H, targetFrame, totalFrames);
            // 多重采样渲染缓冲 → 纹理 FBO：硬件 resolve 顺带做高质量降采样
            GLES30.glBindFramebuffer(GLES30.GL_READ_FRAMEBUFFER, msaaFbo);
            GLES30.glBindFramebuffer(GLES30.GL_DRAW_FRAMEBUFFER, resolveFbo);
            GLES30.glBlitFramebuffer(0, 0, SCENE_W, SCENE_H, 0, 0, SCENE_W, SCENE_H,
                    GLES20.GL_COLOR_BUFFER_BIT, GLES20.GL_NEAREST);
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);
        } else {
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo);
            scene.draw(SCENE_W, SCENE_H, targetFrame, totalFrames);
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);
        }
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
        blit();
        if (!EGL14.eglSwapBuffers(display, eglSurface)) {
            throw new IllegalStateException("swapBuffers 失败");
        }
    }

    private void buildBlit() {
        String vs = "attribute vec2 aPos; attribute vec2 aTex; uniform vec2 uViewport;"
                + "varying vec2 vTex;"
                + "void main(){ vec2 p = aPos*uViewport;"
                + "gl_Position=vec4(p.x/uViewport.x*2.0-1.0, 1.0-p.y/uViewport.y*2.0,0.0,1.0);"
                + "vTex=aTex; }";
        String fs = "precision mediump float; varying vec2 vTex; uniform sampler2D uTex;"
                + "void main(){ gl_FragColor=texture2D(uTex, vTex); }";
        blitProgram = link(vs, fs);
        blitPosition = GLES20.glGetAttribLocation(blitProgram, "aPos");
        blitCoord = GLES20.glGetAttribLocation(blitProgram, "aTex");
        blitViewport = GLES20.glGetUniformLocation(blitProgram, "uViewport");
        blitSampler = GLES20.glGetUniformLocation(blitProgram, "uTex");
    }

    private void buildFbo() {
        int[] tex = new int[1];
        GLES20.glGenTextures(1, tex, 0);
        fboTex = tex[0];
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, fboTex);
        GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_RGBA, SCENE_W, SCENE_H, 0,
                GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, null);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
        int[] frame = new int[1];
        GLES20.glGenFramebuffers(1, frame, 0);
        fbo = frame[0];
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo);
        GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0,
                GLES20.GL_TEXTURE_2D, fboTex, 0);
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0);
        resolveFbo = fbo;
        attachMsaa();
    }

    /** ES3 可用时给场景渲染挂 4x MSAA；任何一步失败都退回普通纹理 FBO。 */
    private void attachMsaa() {
        if (!es3) return;
        try {
            int[] maxSamples = new int[1];
            GLES30.glGetIntegerv(GLES30.GL_MAX_SAMPLES, maxSamples, 0);
            int samples = Math.min(4, Math.max(0, maxSamples[0]));
            if (samples < 2) return;
            int[] buffers = new int[1];
            int[] frames = new int[1];
            GLES30.glGenRenderbuffers(1, buffers, 0);
            GLES30.glGenFramebuffers(1, frames, 0);
            GLES30.glBindRenderbuffer(GLES30.GL_RENDERBUFFER, buffers[0]);
            GLES30.glRenderbufferStorageMultisample(GLES30.GL_RENDERBUFFER, samples,
                    GLES30.GL_RGBA8, SCENE_W, SCENE_H);
            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, frames[0]);
            GLES30.glFramebufferRenderbuffer(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0,
                    GLES30.GL_RENDERBUFFER, buffers[0]);
            if (GLES30.glCheckFramebufferStatus(GLES30.GL_FRAMEBUFFER)
                    != GLES30.GL_FRAMEBUFFER_COMPLETE) {
                GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0);
                GLES30.glDeleteFramebuffers(1, frames, 0);
                GLES30.glDeleteRenderbuffers(1, buffers, 0);
                return;
            }
            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0);
            msaaFbo = frames[0];
            msaaRb = buffers[0];
            msaa = true;
        } catch (Throwable ignored) {
            msaa = false;
        }
    }

    /** FBO(场景, y 向下) → 窗口 surface：采样时翻转 v。 */
    private void blit() {
        float w = surfaceW;
        float h = surfaceH;
        GLES20.glViewport(0, 0, Math.max(1, (int) w), Math.max(1, (int) h));
        GLES20.glUseProgram(blitProgram);
        GLES20.glUniform2f(blitViewport, w, h);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, fboTex);
        GLES20.glUniform1i(blitSampler, 0);
        // aPos 单位 quad，aTex 与之垂直翻转
        float[] pos = {0, 0, 1, 0, 0, 1, 1, 1};
        float[] tex = {0, 1, 1, 1, 0, 0, 1, 0};
        FloatBuffers posBuf = new FloatBuffers(pos);
        FloatBuffers texBuf = new FloatBuffers(tex);
        GLES20.glEnableVertexAttribArray(blitPosition);
        GLES20.glVertexAttribPointer(blitPosition, 2, GLES20.GL_FLOAT, false, 0, posBuf.buffer);
        GLES20.glEnableVertexAttribArray(blitCoord);
        GLES20.glVertexAttribPointer(blitCoord, 2, GLES20.GL_FLOAT, false, 0, texBuf.buffer);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        GLES20.glDisableVertexAttribArray(blitPosition);
        GLES20.glDisableVertexAttribArray(blitCoord);
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

    // ------------------------------------------------------------ EGL

    private void initEgl(Surface surface) {
        display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
        if (display == EGL14.EGL_NO_DISPLAY) throw new IllegalStateException("没有 EGL display");
        int[] version = new int[2];
        if (!EGL14.eglInitialize(display, version, 0, version, 1)) {
            throw new IllegalStateException("EGL 初始化失败");
        }
        int[] configAttributes = {
                EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT,
                EGL14.EGL_RED_SIZE, 8,
                EGL14.EGL_GREEN_SIZE, 8,
                EGL14.EGL_BLUE_SIZE, 8,
                EGL14.EGL_ALPHA_SIZE, 8,
                // ES2 | ES3 位一起声明：驱动才能给 ES3 上下文挑出合法 config；
                // 个别老驱动不认 ES3 位时回退纯 ES2。
                EGL14.EGL_RENDERABLE_TYPE, 0x0004 | 0x0040,
                EGL14.EGL_NONE
        };
        EGLConfig[] configs = new EGLConfig[1];
        int[] count = new int[1];
        if (!EGL14.eglChooseConfig(display, configAttributes, 0, configs, 0, 1, count, 0)
                || count[0] == 0) {
            configAttributes[11] = EGL14.EGL_OPENGL_ES2_BIT;
            if (!EGL14.eglChooseConfig(display, configAttributes, 0, configs, 0, 1, count, 0)
                    || count[0] == 0) {
                throw new IllegalStateException("没有可用的 EGL config");
            }
        }
        // 优先 ES3（MSAA 依赖），创建失败退回 ES2
        int[] contextAttributes = {EGL14.EGL_CONTEXT_CLIENT_VERSION, 3, EGL14.EGL_NONE};
        context = EGL14.eglCreateContext(display, configs[0], EGL14.EGL_NO_CONTEXT, contextAttributes, 0);
        if (context != EGL14.EGL_NO_CONTEXT) {
            es3 = true;
        } else {
            contextAttributes[1] = 2;
            context = EGL14.eglCreateContext(display, configs[0], EGL14.EGL_NO_CONTEXT, contextAttributes, 0);
            if (context == EGL14.EGL_NO_CONTEXT) throw new IllegalStateException("EGL context 创建失败");
        }
        // TextureView 的 Surface 走的是同一个 API；surface 失效时建立 window surface
        // 会直接失败，交给外层换视图重试
        eglSurface = EGL14.eglCreateWindowSurface(display, configs[0], surface, new int[1], 0);
        if (eglSurface == EGL14.EGL_NO_SURFACE) throw new IllegalStateException("EGL window surface 创建失败");
        if (!EGL14.eglMakeCurrent(display, eglSurface, eglSurface, context)) {
            throw new IllegalStateException("EGL makeCurrent 失败");
        }
        int[] size = new int[1];
        EGL14.eglQuerySurface(display, eglSurface, EGL14.EGL_WIDTH, size, 0);
        surfaceW = Math.max(1, size[0]);
        EGL14.eglQuerySurface(display, eglSurface, EGL14.EGL_HEIGHT, size, 0);
        surfaceH = Math.max(1, size[0]);
    }

    private void releaseGl() {
        try {
            if (display != null && display != EGL14.EGL_NO_DISPLAY) {
                if (msaaFbo != 0) {
                    GLES20.glDeleteFramebuffers(1, new int[]{msaaFbo}, 0);
                    msaaFbo = 0;
                }
                if (msaaRb != 0) {
                    GLES20.glDeleteRenderbuffers(1, new int[]{msaaRb}, 0);
                    msaaRb = 0;
                }
                msaa = false;
                if (fboTex != 0) {
                    GLES20.glDeleteTextures(1, new int[]{fboTex}, 0);
                    fboTex = 0;
                }
                if (fbo != 0) {
                    GLES20.glDeleteFramebuffers(1, new int[]{fbo}, 0);
                    fbo = 0;
                }
                if (blitProgram != 0) {
                    GLES20.glDeleteProgram(blitProgram);
                    blitProgram = 0;
                }
                EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
                if (eglSurface != null && eglSurface != EGL14.EGL_NO_SURFACE) {
                    EGL14.eglDestroySurface(display, eglSurface);
                }
                if (context != null && context != EGL14.EGL_NO_CONTEXT) {
                    EGL14.eglDestroyContext(display, context);
                }
                EGL14.eglReleaseThread();
                EGL14.eglTerminate(display);
            }
        } catch (Throwable ignored) { }
        display = EGL14.EGL_NO_DISPLAY;
        context = EGL14.EGL_NO_CONTEXT;
        eglSurface = EGL14.EGL_NO_SURFACE;
        glReady = false;
    }

    /** 让内层类少写点样板：just a tiny direct buffer wrapper. */
    private static final class FloatBuffers {
        final ByteBuffer buffer;

        FloatBuffers(float[] values) {
            buffer = ByteBuffer.allocateDirect(values.length * 4).order(ByteOrder.nativeOrder());
            buffer.asFloatBuffer().put(values);
            buffer.rewind();
        }
    }
}
