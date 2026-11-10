package com.fitmotion.app;

import android.app.Activity;
import android.graphics.SurfaceTexture;
import android.os.Looper;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import org.json.JSONObject;

/**
 * 原生预览宿主：一块挖洞区域 + 一个渲染核心（{@link NativePreviewRenderer}）。
 *
 * 画面载体有两种：
 *  - SurfaceView（默认）：独立合成层，性能最好。WebView 透明挖洞后从下层透出。
 *  - TextureView（退级）：参与普通视图层级逐层合成。个别 ROM 上 WebView 透明
 *    挖洞 + SurfaceView 会黑屏/闪黑，这时退到 TextureView 通常能正常出画。
 *
 * 自动退级：启动后若 2.5s 内没拿到 surface（SurfaceView 路线不可用），
 * 或首帧渲染报错，自动换成 TextureView 重试一次。JS 也可以通过 payload 的
 * `renderer` 字段直接指定 "surface" / "texture"（设置页的兼容渲染开关）。
 */
final class NativePreviewView extends FrameLayout {

    private static final long SURFACE_TIMEOUT_MS = 2500;

    private static NativePreviewView instance;
    /** 最近一次 JS 报来的核心区位置（物理像素）；视图建好前先暂存 */
    private static final android.graphics.Rect pendingRect = new android.graphics.Rect();

    private final Activity host;
    private final String payloadJson;
    private final NativePreviewRenderer.Callback outCallback;
    private final int totalFrames;

    private NativePreviewRenderer renderer;
    private View surfaceHost;
    private Surface textureSurface;
    private String mode;
    private boolean switched;
    private boolean shutdownDone;

    private NativePreviewView(Activity activity, String payloadJson,
                              NativePreviewRenderer.Callback callback) {
        super(activity);
        this.host = activity;
        this.payloadJson = payloadJson;
        this.outCallback = callback;
        String requested = "surface";
        int frames = 1;
        try {
            JSONObject payload = new JSONObject(payloadJson);
            requested = payload.optString("renderer", "surface");
            double durationSec = payload.optDouble("durationSec", 30);
            int fps = Math.max(1, payload.optInt("fps", 30));
            frames = (int) Math.ceil(durationSec * fps);
        } catch (Exception ignored) { }
        this.totalFrames = Math.max(1, frames);
        this.mode = "texture".equals(requested) ? "texture" : "surface";
    }

    // ------------------------------------------------------------ lifecycle

    static synchronized void start(final MainActivity activity, final String payloadJson,
                                   final NativePreviewRenderer.Callback callback) {
        stop();
        instance = new NativePreviewView(activity, payloadJson, callback);
        FrameLayout root = activity.rootLayout();
        ViewGroup.LayoutParams lp = new FrameLayout.LayoutParams(0, 0);
        synchronized (pendingRect) {
            if (!pendingRect.isEmpty()) {
                FrameLayout.LayoutParams flp = new FrameLayout.LayoutParams(
                        pendingRect.width(), pendingRect.height());
                flp.leftMargin = pendingRect.left;
                flp.topMargin = pendingRect.top;
                lp = flp;
            }
        }
        root.addView(instance, 0, lp);
        instance.begin(activity);
    }

    /** 停止并移除预览视图；没有活动实例时是安全空操作。 */
    static synchronized void stop() {
        if (instance == null) return;
        final NativePreviewView view = instance;
        instance = null;
        view.shutdown();
        Runnable remove = new Runnable() {
            @Override
            public void run() {
                if (view.getParent() instanceof ViewGroup) {
                    ((ViewGroup) view.getParent()).removeView(view);
                }
            }
        };
        if (Looper.myLooper() == Looper.getMainLooper()) remove.run();
        else view.post(remove);
    }

    static void postFrame(int frame) {
        NativePreviewView view = instance;
        if (view != null && view.renderer != null) view.renderer.postFrame(frame);
    }

    /** JS 传来的是 CSS px，这里换算成物理像素并摆位；视图未建好时先暂存。 */
    static void layoutRect(MainActivity activity, double x, double y, double w, double h) {
        float density = activity.getResources().getDisplayMetrics().density;
        final int left = Math.round((float) x * density);
        final int top = Math.round((float) y * density);
        final int width = Math.max(1, Math.round((float) w * density));
        final int height = Math.max(1, Math.round((float) h * density));
        synchronized (pendingRect) {
            pendingRect.set(left, top, left + width, top + height);
        }
        final NativePreviewView view = instance;
        if (view == null) return;
        view.post(new Runnable() {
            @Override
            public void run() {
                ViewGroup.LayoutParams lp = view.getLayoutParams();
                if (lp instanceof FrameLayout.LayoutParams) {
                    FrameLayout.LayoutParams flp = (FrameLayout.LayoutParams) lp;
                    if (flp.leftMargin != left || flp.topMargin != top
                            || flp.width != width || flp.height != height) {
                        flp.leftMargin = left;
                        flp.topMargin = top;
                        flp.width = width;
                        flp.height = height;
                        view.setLayoutParams(flp);
                    }
                }
            }
        });
    }

    private void begin(Activity activity) {
        renderer = new NativePreviewRenderer(activity, payloadJson, new NativePreviewRenderer.Callback() {
            @Override
            public void onReady(final int frames) {
                // 首帧成功：取消「surface 超时退级」的兜底
                cancelFallback();
                post(new Runnable() {
                    @Override
                    public void run() {
                        if (outCallback != null) outCallback.onReady(frames);
                    }
                });
            }

            @Override
            public void onError(final String message) {
                // 首帧都没出就报错：可能是这条渲染路线在本机不可用，退 TextureView 再试
                post(new Runnable() {
                    @Override
                    public void run() {
                        if (switchMode("texture")) return;
                        if (outCallback != null) outCallback.onError(message);
                    }
                });
            }
        });
        renderer.start();
        switchMode(mode);
        if ("surface".equals(mode)) scheduleFallback();
    }

    // ------------------------------------------------------------ surface host

    /** 换载体：拆旧视图 → 建新视图 → 新 surface 就绪后挂到渲染核心。 */
    private boolean switchMode(String next) {
        if (shutdownDone) return false;
        // 已经退到 TextureView 就停在那里，不要来回跳
        if ("surface".equals(next) && switched) return false;
        // 已经是 TextureView 又要求 TextureView（例如退级后再收到错误）：不重建
        if (next.equals(mode) && surfaceHost != null) return false;
        mode = next;
        if (surfaceHost != null) {
            removeView(surfaceHost);
            releaseTextureSurface();
            surfaceHost = null;
        }
        if (renderer != null) renderer.detachSurface();
        View created = "texture".equals(next) ? buildTextureView() : buildSurfaceView();
        surfaceHost = created;
        addView(created, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        return true;
    }

    private View buildSurfaceView() {
        SurfaceView view = new SurfaceView(host);
        view.getHolder().addCallback(new SurfaceHolder.Callback() {
            @Override
            public void surfaceCreated(SurfaceHolder holder) {
                cancelFallback();
                renderer.attachSurface(holder.getSurface(), getWidth(), getHeight());
            }

            @Override
            public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
                renderer.attachSurface(holder.getSurface(), width, height);
            }

            @Override
            public void surfaceDestroyed(SurfaceHolder holder) {
                renderer.detachSurface();
            }
        });
        return view;
    }

    private View buildTextureView() {
        TextureView view = new TextureView(host);
        view.setOpaque(true);
        view.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override
            public void onSurfaceTextureAvailable(SurfaceTexture texture, int width, int height) {
                cancelFallback();
                texture.setDefaultBufferSize(Math.max(1, width), Math.max(1, height));
                releaseTextureSurface();
                textureSurface = new Surface(texture);
                renderer.attachSurface(textureSurface, width, height);
            }

            @Override
            public void onSurfaceTextureSizeChanged(SurfaceTexture texture, int width, int height) {
                texture.setDefaultBufferSize(Math.max(1, width), Math.max(1, height));
            }

            @Override
            public boolean onSurfaceTextureDestroyed(SurfaceTexture texture) {
                renderer.detachSurface();
                releaseTextureSurface();
                // 返回 true 表示由系统回收 SurfaceTexture（视图即将销毁）
                return true;
            }

            @Override
            public void onSurfaceTextureUpdated(SurfaceTexture texture) {
                // 渲染线程自己 eglSwapBuffers，这里不需要做任何事
            }
        });
        return view;
    }

    private void releaseTextureSurface() {
        if (textureSurface != null) {
            try { textureSurface.release(); } catch (Throwable ignored) { }
            textureSurface = null;
        }
    }

    // ------------------------------------------------------------ auto fallback

    private final Runnable fallbackCheck = new Runnable() {
        @Override
        public void run() {
            if (shutdownDone) return;
            if (renderer != null && renderer.isGlReady()) return;
            switched = true;
            switchMode("texture");
        }
    };

    private void scheduleFallback() {
        postDelayed(fallbackCheck, SURFACE_TIMEOUT_MS);
    }

    private void cancelFallback() {
        removeCallbacks(fallbackCheck);
    }

    private void shutdown() {
        shutdownDone = true;
        cancelFallback();
        if (renderer != null) {
            renderer.shutdown();
            renderer = null;
        }
        releaseTextureSurface();
        surfaceHost = null;
    }
}
