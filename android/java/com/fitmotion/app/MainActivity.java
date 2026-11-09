package com.fitmotion.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.os.Build;
import android.os.SystemClock;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.Surface;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;

public class MainActivity extends Activity {
    public static final String EXTRA_OPEN_EXPORT = "com.fitmotion.app.OPEN_EXPORT";
    private static final int REQUEST_FILE = 1001;
    private static final int REQUEST_SAVE = 1002;
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private File pendingSaveFile;
    private String pendingSaveName;
    private String pendingSaveMime;
    private NativeFrameServer nativeFrameServer;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private FrameLayout fullscreenContainer;
    /** 开机封面：冷启动时盖在 WebView 上，首页渲染完成后淡出 */
    private FrameLayout splash;
    private long splashShownAt;
    private boolean splashHiding;
    /** 当前焦点是否在 H5 输入框里（长按要还给输入框，否则粘贴菜单出不来） */
    private boolean editingField;
    /** 上一次上报的键盘高度（CSS px），只在变化时回调 JS */
    private int lastImeInset = -1;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.rgb(5, 9, 10));
        getWindow().setNavigationBarColor(Color.rgb(5, 9, 10));
        setImmersive();
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 9001);
            } catch (Exception ignored) { }
        }

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(5, 9, 10));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.addJavascriptInterface(new SaveBridge(), "FitMotionAndroid");

        // 长按不再拉起系统的文字选择菜单（查看/复制/分享/翻译）——
        // App 里没有要划选的正文，这个手势已经让给了记录页的长按操作菜单。
        // 但输入框例外：这里吞掉长按会让 Token / AppKey 之类完全没法粘贴，
        // 所以命中输入框时返回 false，把手势还给 WebView。
        webView.setOnLongClickListener(new View.OnLongClickListener() {
            @Override
            public boolean onLongClick(View v) {
                if (editingField) return false;
                WebView.HitTestResult hit = webView.getHitTestResult();
                return hit == null || hit.getType() != WebView.HitTestResult.EDIT_TEXT_TYPE;
            }
        });

        // 键盘高度上报给 H5：沉浸式 + WebView 下 adjustResize 在部分机型不生效，
        // 底部抽屉表单会被键盘完全挡住，让前端按这个值把抽屉抬起来。
        getWindow().getDecorView().getViewTreeObserver().addOnGlobalLayoutListener(
                new android.view.ViewTreeObserver.OnGlobalLayoutListener() {
                    @Override
                    public void onGlobalLayout() {
                        if (webView == null) return;
                        Rect visible = new Rect();
                        getWindow().getDecorView().getWindowVisibleDisplayFrame(visible);
                        int overlap = getWindow().getDecorView().getHeight() - visible.bottom;
                        float density = getResources().getDisplayMetrics().density;
                        // 小于 120dp 的重叠当成系统栏 / 误报，不算键盘
                        int inset = overlap > 120 * density ? Math.round(overlap / density) : 0;
                        if (inset == lastImeInset) return;
                        lastImeInset = inset;
                        webView.evaluateJavascript(
                                "window.FitMotionJS&&window.FitMotionJS.setKeyboardInset(" + inset + ")", null);
                    }
                });

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setTextZoom(100);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " FitMotion/1.0");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return !url.startsWith("file:///android_asset/");
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                hideSplash();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;
                boolean allowMultiple = params != null
                        && params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;

                // 走 SAF 的「打开文档」而不是 GET_CONTENT：直接落在内部存储，
                // 不再先弹一层「选择应用」，找导出的 GPX/TCX 少两步。
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, allowMultiple);
                intent.putExtra("android.content.extra.SHOW_ADVANCED", true);
                if (Build.VERSION.SDK_INT >= 26) {
                    intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, startFolder());
                }
                try {
                    startActivityForResult(intent, REQUEST_FILE);
                    return true;
                } catch (ActivityNotFoundException missingDocumentsUi) {
                    Intent fallback = new Intent(Intent.ACTION_GET_CONTENT);
                    fallback.addCategory(Intent.CATEGORY_OPENABLE);
                    fallback.setType("*/*");
                    fallback.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, allowMultiple);
                    try {
                        startActivityForResult(fallback, REQUEST_FILE);
                        return true;
                    } catch (ActivityNotFoundException error) {
                        fileCallback = null;
                        Toast.makeText(MainActivity.this, "没有找到文件选择器", Toast.LENGTH_SHORT).show();
                        return false;
                    }
                }
            }

            /** 默认定位到「内部存储/Download」，没有就退回内部存储根目录。 */
            private Uri startFolder() {
                try {
                    File downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    String doc = downloads != null && downloads.exists() ? "primary:Download" : "primary:";
                    return DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", doc);
                } catch (Exception ignored) {
                    return DocumentsContract.buildRootUri("com.android.externalstorage.documents", "primary");
                }
            }
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                fullscreenContainer = new FrameLayout(MainActivity.this);
                fullscreenContainer.setBackgroundColor(Color.BLACK);
                fullscreenContainer.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                ((ViewGroup) getWindow().getDecorView()).addView(fullscreenContainer, new ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                webView.setVisibility(View.GONE);
                setImmersive();
            }

            @Override
            public void onHideCustomView() {
                hideFullscreenView();
            }
        });

        // WebView 垫底，开机封面盖在最上面；页面渲染完成后由 hideSplash 淡出
        FrameLayout root = new FrameLayout(this);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        splash = buildSplash();
        splashShownAt = SystemClock.uptimeMillis();
        root.addView(splash, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        webView.loadUrl("file:///android_asset/www/index.html");
        if (getIntent() != null && getIntent().getBooleanExtra(EXTRA_OPEN_EXPORT, false)) {
            webView.postDelayed(new Runnable() {
                @Override
                public void run() {
                    openExportPage();
                }
            }, 900);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null && intent.getBooleanExtra(EXTRA_OPEN_EXPORT, false)) {
            openExportPage();
        }
    }

    /** 开机封面：品牌色底 + 圆形图标 + 名称 + 一句标语，纯代码布局，不引资源。 */
    private FrameLayout buildSplash() {
        FrameLayout layer = new FrameLayout(this);
        layer.setBackgroundColor(Color.rgb(5, 9, 10));
        layer.setClickable(true);
        layer.setFocusable(true);

        LinearLayout center = new LinearLayout(this);
        center.setOrientation(LinearLayout.VERTICAL);
        center.setGravity(Gravity.CENTER);
        center.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.mipmap.ic_launcher_round);
        logo.setAlpha(0f);
        logo.setScaleX(0.86f);
        logo.setScaleY(0.86f);
        logo.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(420).setStartDelay(60).start();

        TextView name = new TextView(this);
        name.setText("FIT MOTION");
        name.setTextColor(Color.WHITE);
        name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 21);
        name.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        name.setLetterSpacing(0.18f);
        name.setAlpha(0f);
        name.animate().alpha(1f).setDuration(420).setStartDelay(200).start();

        View rule = new View(this);
        rule.setBackgroundColor(Color.rgb(216, 255, 62));
        rule.setAlpha(0f);
        rule.animate().alpha(1f).setDuration(420).setStartDelay(320).start();

        TextView tagline = new TextView(this);
        tagline.setText("轨迹，成影像");
        tagline.setTextColor(Color.rgb(147, 161, 154));
        tagline.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        tagline.setLetterSpacing(0.1f);
        tagline.setAlpha(0f);
        tagline.animate().alpha(1f).setDuration(420).setStartDelay(380).start();

        center.addView(logo, new LinearLayout.LayoutParams(dp(84), dp(84)));
        LinearLayout.LayoutParams nameLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        nameLp.topMargin = dp(18);
        center.addView(name, nameLp);
        LinearLayout.LayoutParams ruleLp = new LinearLayout.LayoutParams(dp(22), dp(3));
        ruleLp.topMargin = dp(14);
        center.addView(rule, ruleLp);
        LinearLayout.LayoutParams tagLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tagLp.topMargin = dp(12);
        center.addView(tagline, tagLp);

        layer.addView(center);
        return layer;
    }

    /** 首页渲染完成后淡出；太快的加载也保底展示 900ms，避免闪一下。 */
    private void hideSplash() {
        if (splashHiding || splash == null) return;
        splashHiding = true;
        long elapsed = SystemClock.uptimeMillis() - splashShownAt;
        long wait = Math.max(0, 900 - elapsed);
        splash.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (splash == null) return;
                splash.animate().alpha(0f).setDuration(320).withEndAction(new Runnable() {
                    @Override
                    public void run() {
                        if (splash != null && splash.getParent() != null) {
                            ((ViewGroup) splash.getParent()).removeView(splash);
                        }
                        splash = null;
                    }
                }).start();
            }
        }, wait);
    }

    private int dp(float value) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }

    private void openExportPage() {
        if (webView == null) return;
        webView.evaluateJavascript(
                "(function(){try{return window.fitMotionOpenExport ? window.fitMotionOpenExport() : false;}catch(e){return false;}})()",
                null);
    }

    private void hideFullscreenView() {
        if (fullscreenContainer != null) {
            ((ViewGroup) getWindow().getDecorView()).removeView(fullscreenContainer);
            fullscreenContainer = null;
        }
        customView = null;
        if (webView != null) webView.setVisibility(View.VISIBLE);
        if (customViewCallback != null) {
            customViewCallback.onCustomViewHidden();
            customViewCallback = null;
        }
        setImmersive();
    }

    private void setImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) setImmersive();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_FILE) {
            if (fileCallback == null) return;
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }
            fileCallback.onReceiveValue(results);
            fileCallback = null;
            return;
        }
        if (requestCode == REQUEST_SAVE) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null && pendingSaveFile != null) {
                try {
                    OutputStream out = getContentResolver().openOutputStream(data.getData());
                    if (out == null) throw new IOException("无法打开目标文件");
                    FileInputStream in = new FileInputStream(pendingSaveFile);
                    try {
                        byte[] buffer = new byte[64 * 1024];
                        int read;
                        while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
                        out.flush();
                    } finally {
                        in.close();
                        out.close();
                    }
                    Toast.makeText(this, pendingSaveMime != null && pendingSaveMime.startsWith("image/") ? "图片已保存" : "视频已保存", Toast.LENGTH_LONG).show();
                } catch (Exception error) {
                    Toast.makeText(this, "保存失败：" + error.getMessage(), Toast.LENGTH_LONG).show();
                }
            } else {
                Toast.makeText(this, "已取消保存", Toast.LENGTH_SHORT).show();
            }
            if (pendingSaveFile != null) pendingSaveFile.delete();
            pendingSaveFile = null;
            pendingSaveName = null;
            pendingSaveMime = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (customView != null) {
            hideFullscreenView();
            return;
        }
        if (webView != null) {
            webView.evaluateJavascript(
                    "(function(){try{return window.fitMotionHandleBack ? window.fitMotionHandleBack() : false;}catch(e){return false;}})()",
                    new ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String value) {
                            boolean handled = "true".equals(value);
                            if (!handled) {
                                if (webView != null && webView.canGoBack()) {
                                    webView.goBack();
                                } else {
                                    finish();
                                }
                            }
                        }
                    });
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onPause() {
        // Keep the WebView timers alive while a foreground export service is active.
        if (webView != null && !ExportService.isActive()) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (customViewCallback != null) {
            customViewCallback.onCustomViewHidden();
            customViewCallback = null;
        }
        if (nativeFrameServer != null) {
            nativeFrameServer.stop();
            nativeFrameServer = null;
        }
        if (webView != null) {
            webView.removeJavascriptInterface("FitMotionAndroid");
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /**
     * Chunked base64 bridge: MediaRecorder output can be 10–25 MB, which is too
     * large for one WebView bridge string. JS slices it into 256 KB chunks.
     */
    private class SaveBridge {
        private File cacheFile;
        private FileOutputStream stream;
        private String fileName = "fit-motion.mp4";
        private String mimeType = "video/mp4";

        /** H5 输入框聚焦 / 失焦时同步过来，长按判断要用（命中结果偶尔拿不到 EDIT_TEXT） */
        @JavascriptInterface
        public void setEditing(boolean editing) {
            editingField = editing;
        }

        @JavascriptInterface
        public void beginExport(String title) {
            try {
                ExportService.start(MainActivity.this, title);
                ExportService.update(MainActivity.this, 0, "准备导出…");
            } catch (Throwable ignored) { }
        }

        @JavascriptInterface
        public void updateExportProgress(int percent, String text) {
            try { ExportService.update(MainActivity.this, percent, text); } catch (Throwable ignored) { }
        }

        @JavascriptInterface
        public void endExport() {
            try { ExportService.stop(MainActivity.this); } catch (Throwable ignored) { }
        }

        @JavascriptInterface
        public boolean isExportCancelled() {
            return ExportService.isCancelRequested();
        }

        @JavascriptInterface
        public String nativeExportUrl() {
            if (nativeFrameServer == null) nativeFrameServer = new NativeFrameServer(MainActivity.this);
            return nativeFrameServer.start();
        }

        @JavascriptInterface
        public boolean beginSave(String name, String mime) {
            closeStream();
            fileName = sanitize(name);
            mimeType = (mime == null || mime.length() == 0) ? "video/mp4" : mime;
            try {
                cacheFile = new File(getCacheDir(), "fit-motion-export.tmp");
                stream = new FileOutputStream(cacheFile);
                return true;
            } catch (Exception error) {
                cacheFile = null;
                return false;
            }
        }

        @JavascriptInterface
        public boolean appendSave(String chunk) {
            if (stream == null) return false;
            try {
                stream.write(Base64.decode(chunk, Base64.DEFAULT));
                return true;
            } catch (Exception error) {
                return false;
            }
        }

        @JavascriptInterface
        public String finishSave() {
            closeStream();
            if (cacheFile == null || !cacheFile.exists() || cacheFile.length() == 0) {
                cleanup();
                return "";
            }
            String cleanMime = mimeType.split(";")[0];
            File outputFile = cacheFile;
            String outputName = fileName;
            String outputMime = cleanMime;
            if (cleanMime.contains("webm")) {
                String base = fileName.replaceAll("\\.(mp4|webm)$", "");
                File converted = new File(getCacheDir(), "fit-motion-export-converted.mp4");
                if (transcodeToMp4(cacheFile, converted)) {
                    outputFile = converted;
                    outputName = base + ".mp4";
                    outputMime = "video/mp4";
                } else {
                    outputName = base + ".webm";
                    outputMime = "video/webm";
                }
            }
            try {
                String uri = saveToMediaStore(outputFile, outputName, outputMime);
                if (outputFile != cacheFile) outputFile.delete();
                cacheFile.delete();
                cacheFile = null;
                final String kind = outputMime.startsWith("image/") ? "图片" : "视频";
                final String message = kind + "已保存到 Download/FIT Motion/" + outputName;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(MainActivity.this, message, Toast.LENGTH_LONG).show();
                    }
                });
                return uri;
            } catch (Exception error) {
                // Huawei/EMUI can reject MediaStore inserts in some storage modes.
                // Keep the output cache file and let the user pick a destination through SAF.
                pendingSaveFile = outputFile;
                pendingSaveName = outputName;
                pendingSaveMime = outputMime;
                if (outputFile != cacheFile) cacheFile.delete();
                cacheFile = null;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        openSavePicker();
                    }
                });
                return "picker";
            }
        }

        @JavascriptInterface
        public void cancelSave() {
            closeStream();
            cleanup();
        }

        /** 用系统浏览器打开外部页面（百度网盘授权页等）：WebView 自己会拦掉外部跳转。 */
        @JavascriptInterface
        public void openUrl(String url) {
            if (url == null || url.length() == 0) return;
            try {
                Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(view);
            } catch (Throwable ignored) {
                // 没有浏览器就静默失败，用户可以手动输验证码
            }
        }

        /** 分享 MediaStore 里已保存的内容（原生导出直接返回的 content uri）。 */
        @JavascriptInterface
        public boolean shareUri(String uri, String mime) {
            try {
                if (uri == null || uri.length() == 0) return false;
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType(mime == null || mime.length() == 0 ? "video/mp4" : mime);
                send.putExtra(Intent.EXTRA_STREAM, Uri.parse(uri));
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(Intent.createChooser(send, "分享"));
                return true;
            } catch (Throwable error) {
                return false;
            }
        }

        /**
         * 系统分享面板：把最近一次导出的文件交给微信 / 抖音等。
         * 走 ShareProvider 的 content:// URI（targetSdk 24+ 禁止 file:// 跨应用）。
         */
        @JavascriptInterface
        public boolean shareExport(String name, String mime) {
            try {
                File source = cacheFile != null && cacheFile.exists()
                        ? cacheFile : new File(getCacheDir(), "fit-motion-export.tmp");
                if (!source.exists()) return false;
                File external = getExternalFilesDir(null);
                if (external == null) return false;
                File dir = new File(external, "share");
                if (!dir.exists()) dir.mkdirs();
                String safe = sanitize(name == null || name.length() == 0 ? "fit-motion.mp4" : name);
                File target = new File(dir, safe);
                java.io.FileInputStream in = new java.io.FileInputStream(source);
                java.io.FileOutputStream out = new java.io.FileOutputStream(target);
                byte[] buffer = new byte[65536];
                int read;
                while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
                in.close();
                out.close();
                Uri uri = Uri.parse("content://com.fitmotion.app.share/share/" + Uri.encode(safe));
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType(mime == null || mime.length() == 0 ? "video/mp4" : mime);
                send.putExtra(Intent.EXTRA_STREAM, uri);
                send.putExtra(Intent.EXTRA_TITLE, safe);
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(Intent.createChooser(send, "分享"));
                return true;
            } catch (Throwable error) {
                return false;
            }
        }

        private boolean transcodeToMp4(File input, File output) {
            MediaExtractor extractor = null;
            MediaCodec decoder = null;
            MediaCodec encoder = null;
            MediaMuxer muxer = null;
            Surface surface = null;
            try {
                if (output.exists()) output.delete();
                extractor = new MediaExtractor();
                extractor.setDataSource(input.getAbsolutePath());
                int videoTrack = -1;
                MediaFormat inFormat = null;
                for (int i = 0; i < extractor.getTrackCount(); i++) {
                    MediaFormat format = extractor.getTrackFormat(i);
                    String mime = format.getString(MediaFormat.KEY_MIME);
                    if (mime != null && mime.startsWith("video/")) {
                        videoTrack = i;
                        inFormat = format;
                        break;
                    }
                }
                if (videoTrack < 0 || inFormat == null) return false;
                extractor.selectTrack(videoTrack);

                int width = inFormat.getInteger(MediaFormat.KEY_WIDTH);
                int height = inFormat.getInteger(MediaFormat.KEY_HEIGHT);
                if ((width & 1) == 1) width -= 1;
                if ((height & 1) == 1) height -= 1;

                encoder = MediaCodec.createEncoderByType("video/avc");
                MediaFormat outFormat = MediaFormat.createVideoFormat("video/avc", width, height);
                outFormat.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
                outFormat.setInteger(MediaFormat.KEY_BIT_RATE, 10_000_000);
                outFormat.setInteger(MediaFormat.KEY_FRAME_RATE, 30);
                outFormat.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
                encoder.configure(outFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
                surface = encoder.createInputSurface();
                encoder.start();

                decoder = MediaCodec.createDecoderByType(inFormat.getString(MediaFormat.KEY_MIME));
                decoder.configure(inFormat, surface, null, 0);
                decoder.start();

                muxer = new MediaMuxer(output.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
                MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
                boolean inputDone = false;
                boolean decoderDone = false;
                boolean eosSignaled = false;
                boolean encoderDone = false;
                boolean muxerStarted = false;
                int outTrack = -1;
                long deadline = System.currentTimeMillis() + 45_000;

                while (!encoderDone && System.currentTimeMillis() < deadline) {
                    if (!inputDone) {
                        int inIndex = decoder.dequeueInputBuffer(10_000);
                        if (inIndex >= 0) {
                            ByteBuffer buffer = decoder.getInputBuffer(inIndex);
                            int size = buffer == null ? -1 : extractor.readSampleData(buffer, 0);
                            if (size < 0) {
                                decoder.queueInputBuffer(inIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                                inputDone = true;
                            } else {
                                decoder.queueInputBuffer(inIndex, 0, size, extractor.getSampleTime(), 0);
                                extractor.advance();
                            }
                        }
                    }

                    while (true) {
                        int outIndex = decoder.dequeueOutputBuffer(info, 0);
                        if (outIndex == MediaCodec.INFO_TRY_AGAIN_LATER) break;
                        if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) continue;
                        if (outIndex >= 0) {
                            boolean eos = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                            decoder.releaseOutputBuffer(outIndex, true);
                            if (eos) decoderDone = true;
                        }
                    }

                    if (decoderDone && !eosSignaled) {
                        encoder.signalEndOfInputStream();
                        eosSignaled = true;
                    }

                    while (true) {
                        int outIndex = encoder.dequeueOutputBuffer(info, 10_000);
                        if (outIndex == MediaCodec.INFO_TRY_AGAIN_LATER) break;
                        if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                            if (!muxerStarted) {
                                outTrack = muxer.addTrack(encoder.getOutputFormat());
                                muxer.start();
                                muxerStarted = true;
                            }
                            continue;
                        }
                        if (outIndex >= 0) {
                            ByteBuffer buffer = encoder.getOutputBuffer(outIndex);
                            if (info.size > 0 && muxerStarted && buffer != null) {
                                buffer.position(info.offset);
                                buffer.limit(info.offset + info.size);
                                muxer.writeSampleData(outTrack, buffer, info);
                            }
                            encoder.releaseOutputBuffer(outIndex, false);
                            if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                                encoderDone = true;
                            }
                        }
                    }
                }
                if (!encoderDone) return false;
                return muxerStarted && output.exists() && output.length() > 0;
            } catch (Exception error) {
                return false;
            } finally {
                try {
                    if (decoder != null) decoder.stop();
                } catch (Exception ignored) {
                }
                try {
                    if (decoder != null) decoder.release();
                } catch (Exception ignored) {
                }
                try {
                    if (encoder != null) encoder.stop();
                } catch (Exception ignored) {
                }
                try {
                    if (encoder != null) encoder.release();
                } catch (Exception ignored) {
                }
                try {
                    if (muxer != null) muxer.stop();
                } catch (Exception ignored) {
                }
                try {
                    if (muxer != null) muxer.release();
                } catch (Exception ignored) {
                }
                try {
                    if (surface != null) surface.release();
                } catch (Exception ignored) {
                }
                try {
                    if (extractor != null) extractor.release();
                } catch (Exception ignored) {
                }
            }
        }

        private String saveToMediaStore(File file, String name, String mime) throws IOException {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, mime);
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/FIT Motion");
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IOException("MediaStore 返回空 URI");
            OutputStream out = getContentResolver().openOutputStream(uri);
            if (out == null) throw new IOException("无法打开输出流");
            FileInputStream in = new FileInputStream(file);
            try {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
                out.flush();
            } finally {
                in.close();
                out.close();
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.Downloads.IS_PENDING, 0);
            getContentResolver().update(uri, done, null, null);
            return uri.toString();
        }

        private void closeStream() {
            if (stream != null) {
                try {
                    stream.close();
                } catch (Exception ignored) {
                }
                stream = null;
            }
        }

        private void cleanup() {
            closeStream();
            if (cacheFile != null) {
                cacheFile.delete();
                cacheFile = null;
            }
        }

        private String sanitize(String value) {
            if (value == null || value.length() == 0) return "fit-motion.mp4";
            return value.replaceAll("[\\\\/:*?\"<>|\\r\\n]", "_");
        }
    }

    private void openSavePicker() {
        if (pendingSaveFile == null) return;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(pendingSaveMime == null ? "video/mp4" : pendingSaveMime);
        intent.putExtra(Intent.EXTRA_TITLE, pendingSaveName);
        try {
            startActivityForResult(intent, REQUEST_SAVE);
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, "没有找到文件保存器，请在系统文件管理器中重试", Toast.LENGTH_LONG).show();
            if (pendingSaveFile != null) pendingSaveFile.delete();
            pendingSaveFile = null;
        }
    }
}
