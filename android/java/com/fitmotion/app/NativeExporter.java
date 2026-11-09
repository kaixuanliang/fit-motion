package com.fitmotion.app;

import android.content.ContentValues;
import android.content.Context;
import android.graphics.SurfaceTexture;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.net.Uri;
import android.opengl.EGL14;
import android.opengl.EGLConfig;
import android.opengl.EGLContext;
import android.opengl.EGLDisplay;
import android.opengl.EGLExt;
import android.opengl.EGLSurface;
import android.opengl.GLES20;
import android.opengl.GLUtils;
import android.provider.MediaStore;
import android.view.Surface;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Experimental native export path.
 *
 * The WebView still renders the frames, so the current visual result is kept
 * 1:1. Frames are sent as raw RGBA over a loopback HTTP socket, uploaded to an
 * OpenGL texture, drawn to MediaCodec's input Surface, and muxed to H.264 MP4.
 *
 * This is intentionally a benchmark/prototype: it proves whether Huawei's
 * native MediaCodec + GL path is faster than WebCodecs with the same frames.
 */
final class NativeFrameServer {
    private final Context context;
    private ServerSocket server;
    private Thread thread;
    private volatile boolean running;
    private NativeEncoder encoder;
    private int port;

    NativeFrameServer(Context context) {
        this.context = context.getApplicationContext();
    }

    synchronized String start() {
        if (running) return "http://127.0.0.1:" + port;
        try {
            server = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
            port = server.getLocalPort();
            running = true;
            thread = new Thread(new Runnable() {
                @Override
                public void run() {
                    acceptLoop();
                }
            }, "fit-motion-native-encoder");
            thread.start();
            return "http://127.0.0.1:" + port;
        } catch (Exception error) {
            running = false;
            return "";
        }
    }

    synchronized void stop() {
        running = false;
        if (encoder != null) {
            try { encoder.abort(); } catch (Exception ignored) { }
            encoder = null;
        }
        if (server != null) {
            try { server.close(); } catch (Exception ignored) { }
            server = null;
        }
        thread = null;
    }

    private void acceptLoop() {
        while (running) {
            try {
                final Socket socket = server.accept();
                // One thread per request so /progress stays responsive while a
                // long /render blocks its own connection.
                Thread handler = new Thread(new Runnable() {
                    @Override
                    public void run() {
                        handle(socket);
                    }
                }, "fitmotion-http");
                handler.start();
            } catch (Exception error) {
                if (!running) return;
            }
        }
    }

    private void handle(Socket socket) {
        try {
            socket.setSoTimeout(30_000);
            InputStream input = new BufferedInputStream(socket.getInputStream());
            ByteArrayOutputStream headerBuffer = new ByteArrayOutputStream();
            int matched = 0;
            while (matched < 4) {
                int value = input.read();
                if (value < 0) throw new IOException("早于请求头结束");
                headerBuffer.write(value);
                if (matched == 0 && value == '\r') matched = 1;
                else if (matched == 1 && value == '\n') matched = 2;
                else if (matched == 2 && value == '\r') matched = 3;
                else if (matched == 3 && value == '\n') matched = 4;
                else matched = value == '\r' ? 1 : 0;
                if (headerBuffer.size() > 16_384) throw new IOException("请求头过大");
            }
            String header = headerBuffer.toString("UTF-8");
            String[] lines = header.split("\r\n");
            String[] first = lines[0].split(" ");
            if (first.length < 2) throw new IOException("无效请求");
            String method = first[0];
            String target = first[1];
            int contentLength = 0;
            for (int i = 1; i < lines.length; i++) {
                int colon = lines[i].indexOf(':');
                if (colon <= 0) continue;
                String key = lines[i].substring(0, colon).trim();
                if ("Content-Length".equalsIgnoreCase(key)) {
                    contentLength = Integer.parseInt(lines[i].substring(colon + 1).trim());
                }
            }
            byte[] body = readExactly(input, contentLength);
            if ("OPTIONS".equalsIgnoreCase(method)) {
                respond(socket, 200, "{}");
                return;
            }
            int queryAt = target.indexOf('?');
            String path = queryAt >= 0 ? target.substring(0, queryAt) : target;
            String query = queryAt >= 0 ? target.substring(queryAt + 1) : "";
            if (path.endsWith("/start")) {
                int width = queryInt(query, "w", 1080);
                int height = queryInt(query, "h", 1920);
                int bitrate = queryInt(query, "bitrate", 4_000_000);
                int fps = queryInt(query, "fps", 30);
                if (encoder != null) encoder.abort();
                File temp = new File(context.getCacheDir(), "fit-motion-native-" + System.currentTimeMillis() + ".mp4");
                encoder = new NativeEncoder(width, height, bitrate, fps, temp);
                encoder.start();
                respond(socket, 200, "{\"ok\":true}");
            } else if (path.endsWith("/frame")) {
                if (encoder == null) throw new IOException("编码器未启动");
                int index = queryInt(query, "i", -1);
                if (index < 0) throw new IOException("缺少帧号");
                encoder.encodeFrame(body, index);
                respond(socket, 200, "{\"ok\":true}");
            } else if (path.endsWith("/render")) {
                if (encoder != null) {
                    encoder.abort();
                    encoder = null;
                }
                org.json.JSONObject response = NativeRenderJob.render(context, new String(body, "UTF-8"));
                respond(socket, 200, response.toString());
            } else if (path.endsWith("/progress")) {
                org.json.JSONObject progress = new org.json.JSONObject();
                progress.put("phase", NativeRenderJob.progressPhase);
                progress.put("done", NativeRenderJob.progressDone.get());
                progress.put("total", NativeRenderJob.progressTotal.get());
                respond(socket, 200, progress.toString());
            } else if (path.endsWith("/preview")) {
                org.json.JSONObject response = NativePreview.render(context, new String(body, "UTF-8"));
                respond(socket, 200, response.toString());
            } else if (path.endsWith("/finish")) {
                if (encoder == null) throw new IOException("编码器未启动");
                NativeEncoder current = encoder;
                encoder = null;
                File file = current.finish();
                String saved = saveNativeVideo(context, file);
                file.delete();
                respond(socket, 200, "{\"ok\":true,\"uri\":\"" + saved.replace("\"", "\\\"") + "\"}");
            } else if (path.endsWith("/abort")) {
                NativeRenderJob.requestCancel();
                if (encoder != null) {
                    encoder.abort();
                    encoder = null;
                }
                respond(socket, 200, "{\"ok\":true}");
            } else {
                respond(socket, 404, "{\"ok\":false,\"error\":\"not found\"}");
            }
        } catch (Exception error) {
            try {
                respond(socket, 500, "{\"ok\":false,\"error\":\"" + escape(error.getMessage()) + "\"}");
            } catch (Exception ignored) { }
        } finally {
            try { socket.close(); } catch (Exception ignored) { }
        }
    }

    private byte[] readExactly(InputStream input, int length) throws IOException {
        byte[] data = new byte[length];
        int offset = 0;
        while (offset < length) {
            int read = input.read(data, offset, length - offset);
            if (read < 0) throw new IOException("请求体不完整");
            offset += read;
        }
        return data;
    }

    private int queryInt(String query, String key, int fallback) {
        for (String pair : query.split("&")) {
            int equals = pair.indexOf('=');
            if (equals <= 0) continue;
            if (!key.equals(pair.substring(0, equals))) continue;
            try {
                return Integer.parseInt(URLDecoder.decode(pair.substring(equals + 1), "UTF-8"));
            } catch (Exception ignored) {
                return fallback;
            }
        }
        return fallback;
    }

    private void respond(Socket socket, int status, String body) throws IOException {
        byte[] data = body.getBytes("UTF-8");
        String reason = status == 200 ? "OK" : status == 404 ? "Not Found" : "Internal Server Error";
        String header = "HTTP/1.1 " + status + " " + reason + "\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Methods: POST, OPTIONS\r\n"
                + "Access-Control-Allow-Headers: Content-Type\r\n"
                + "Access-Control-Allow-Private-Network: true\r\n"
                + "Content-Length: " + data.length + "\r\n"
                + "Connection: close\r\n\r\n";
        OutputStream output = socket.getOutputStream();
        output.write(header.getBytes("UTF-8"));
        output.write(data);
        output.flush();
    }

    static String saveNativeVideo(Context context, File file) throws IOException {
        if (file == null || !file.exists() || file.length() == 0) throw new IOException("导出的视频为空");
        String name = "fit-motion-native-" + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date()) + ".mp4";
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, name);
        values.put(MediaStore.Downloads.MIME_TYPE, "video/mp4");
        values.put(MediaStore.Downloads.RELATIVE_PATH, "Download/FIT Motion");
        values.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri uri = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IOException("MediaStore 返回空 URI");
        OutputStream output = context.getContentResolver().openOutputStream(uri);
        if (output == null) throw new IOException("无法打开目标文件");
        FileInputStream input = new FileInputStream(file);
        try {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) > 0) output.write(buffer, 0, read);
            output.flush();
        } finally {
            input.close();
            output.close();
        }
        ContentValues done = new ContentValues();
        done.put(MediaStore.Downloads.IS_PENDING, 0);
        context.getContentResolver().update(uri, done, null, null);
        return uri.toString();
    }

    private String escape(String value) {
        if (value == null) return "native encoder error";
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}

final class NativeEncoder {
    private final int width;
    private final int height;
    private final int bitrate;
    private final int fps;
    private final File outputFile;
    private MediaCodec encoder;
    private Surface inputSurface;
    private MediaMuxer muxer;
    private int track = -1;
    private boolean muxerStarted;
    private boolean finished;
    private EGLDisplay eglDisplay;
    private EGLContext eglContext;
    private EGLSurface eglSurface;
    private int program;
    private int texture;
    private int positionHandle;
    private int texCoordHandle;
    private int samplerHandle;
    private FloatBuffer quad;
    private FloatBuffer tex;
    private ByteBuffer frameBuffer;
    private int texW;
    private int texH;
    /** Cost of the last encodeScene call, split into its three stall sources. */
    long lastDrawMs;
    long lastSwapMs;
    long lastDrainMs;

    NativeEncoder(int width, int height, int bitrate, int fps, File outputFile) {
        this.width = width;
        this.height = height;
        this.bitrate = bitrate;
        this.fps = fps;
        this.outputFile = outputFile;
    }

    void start() throws IOException {
        try {
            if (outputFile.exists()) outputFile.delete();
            MediaFormat format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height);
            format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
            format.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);
            format.setInteger(MediaFormat.KEY_FRAME_RATE, fps);
            format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 5);
            try {
                format.setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileHigh);
                format.setInteger(MediaFormat.KEY_LEVEL, MediaCodecInfo.CodecProfileLevel.AVCLevel41);
            } catch (Exception ignored) {
                // Some vendor encoders reject explicit profile/level; keep defaults.
            }
            encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
            encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            inputSurface = encoder.createInputSurface();
            encoder.start();
            muxer = new MediaMuxer(outputFile.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
            setupEgl();
            setupGl();
        } catch (Exception error) {
            abort();
            if (error instanceof IOException) throw (IOException) error;
            throw new IOException(error);
        }
    }

    private void setupEgl() throws IOException {
        eglDisplay = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
        if (eglDisplay == EGL14.EGL_NO_DISPLAY) throw new IOException("没有 EGL display");
        int[] version = new int[2];
        if (!EGL14.eglInitialize(eglDisplay, version, 0, version, 1)) throw new IOException("EGL 初始化失败");
        int[] attributes = {
                EGL14.EGL_RED_SIZE, 8,
                EGL14.EGL_GREEN_SIZE, 8,
                EGL14.EGL_BLUE_SIZE, 8,
                EGL14.EGL_ALPHA_SIZE, 8,
                EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
                0x3142, 1, // EGL_RECORDABLE_ANDROID
                EGL14.EGL_NONE
        };
        EGLConfig[] configs = new EGLConfig[1];
        int[] count = new int[1];
        if (!EGL14.eglChooseConfig(eglDisplay, attributes, 0, configs, 0, 1, count, 0) || count[0] == 0) {
            throw new IOException("没有可用的 EGL config");
        }
        int[] contextAttributes = {EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE};
        eglContext = EGL14.eglCreateContext(eglDisplay, configs[0], EGL14.EGL_NO_CONTEXT, contextAttributes, 0);
        if (eglContext == EGL14.EGL_NO_CONTEXT) throw new IOException("EGL context 创建失败");
        int[] surfaceAttributes = {EGL14.EGL_NONE};
        eglSurface = EGL14.eglCreateWindowSurface(eglDisplay, configs[0], inputSurface, surfaceAttributes, 0);
        if (eglSurface == EGL14.EGL_NO_SURFACE) throw new IOException("EGL surface 创建失败");
        if (!EGL14.eglMakeCurrent(eglDisplay, eglSurface, eglSurface, eglContext)) throw new IOException("EGL makeCurrent 失败");
    }

    private void setupGl() throws IOException {
        String vertex = "attribute vec4 aPos; attribute vec2 aTex; varying vec2 vTex;"
                + "void main(){gl_Position=aPos;vTex=aTex;}";
        String fragment = "precision mediump float; varying vec2 vTex; uniform sampler2D uTex;"
                + "void main(){gl_FragColor=texture2D(uTex,vTex);}";
        int vs = compile(GLES20.GL_VERTEX_SHADER, vertex);
        int fs = compile(GLES20.GL_FRAGMENT_SHADER, fragment);
        program = GLES20.glCreateProgram();
        GLES20.glAttachShader(program, vs);
        GLES20.glAttachShader(program, fs);
        GLES20.glLinkProgram(program);
        int[] linked = new int[1];
        GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, linked, 0);
        if (linked[0] == 0) throw new IOException("GL program link failed: " + GLES20.glGetProgramInfoLog(program));
        positionHandle = GLES20.glGetAttribLocation(program, "aPos");
        texCoordHandle = GLES20.glGetAttribLocation(program, "aTex");
        samplerHandle = GLES20.glGetUniformLocation(program, "uTex");
        quad = floatBuffer(new float[]{-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f});
        tex = floatBuffer(new float[]{0f, 1f, 1f, 1f, 0f, 0f, 1f, 0f});
        int[] textures = new int[1];
        GLES20.glGenTextures(1, textures, 0);
        texture = textures[0];
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_RGBA, width, height, 0,
                GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, null);
        texW = width;
        texH = height;
        GLES20.glViewport(0, 0, width, height);
        frameBuffer = ByteBuffer.allocateDirect(width * height * 4).order(ByteOrder.nativeOrder());
    }

    private int compile(int type, String source) throws IOException {
        int shader = GLES20.glCreateShader(type);
        GLES20.glShaderSource(shader, source);
        GLES20.glCompileShader(shader);
        int[] status = new int[1];
        GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, status, 0);
        if (status[0] == 0) throw new IOException("GL compile failed: " + GLES20.glGetShaderInfoLog(shader));
        return shader;
    }

    private FloatBuffer floatBuffer(float[] values) {
        FloatBuffer buffer = ByteBuffer.allocateDirect(values.length * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
        buffer.put(values).position(0);
        return buffer;
    }

    synchronized void encodeScene(NativeScene scene, int index, int totalFrames) throws IOException {
        if (finished || encoder == null) throw new IOException("编码器已结束");
        long started = System.nanoTime();
        scene.draw(width, height, index, totalFrames);
        long drawn = System.nanoTime();
        long ptsNs = index * 1_000_000_000L / fps;
        EGLExt.eglPresentationTimeANDROID(eglDisplay, eglSurface, ptsNs);
        if (!EGL14.eglSwapBuffers(eglDisplay, eglSurface)) throw new IOException("eglSwapBuffers 失败");
        long swapped = System.nanoTime();
        drain(false);
        long drained = System.nanoTime();
        lastDrawMs = (drawn - started) / 1_000_000L;
        lastSwapMs = (swapped - drawn) / 1_000_000L;
        lastDrainMs = (drained - swapped) / 1_000_000L;
    }

    synchronized void encodeFrame(byte[] rgba, int index) throws IOException {
        encodePixels(rgba, width, height, index);
    }

    /** Uploads an ARGB bitmap (e.g. a PixelCopy window capture) and encodes it. */
    synchronized void encodeBitmap(android.graphics.Bitmap bitmap, int index) throws IOException {
        if (finished || encoder == null) throw new IOException("编码器已结束");
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture);
        if (texW != bitmap.getWidth() || texH != bitmap.getHeight()) {
            texW = bitmap.getWidth();
            texH = bitmap.getHeight();
        }
        GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bitmap, 0);
        GLES20.glClearColor(0f, 0f, 0f, 1f);
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
        GLES20.glUseProgram(program);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture);
        GLES20.glUniform1i(samplerHandle, 0);
        GLES20.glEnableVertexAttribArray(positionHandle);
        GLES20.glVertexAttribPointer(positionHandle, 2, GLES20.GL_FLOAT, false, 0, quad);
        GLES20.glEnableVertexAttribArray(texCoordHandle);
        GLES20.glVertexAttribPointer(texCoordHandle, 2, GLES20.GL_FLOAT, false, 0, tex);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        GLES20.glDisableVertexAttribArray(positionHandle);
        GLES20.glDisableVertexAttribArray(texCoordHandle);
        long ptsNs = index * 1_000_000_000L / fps;
        EGLExt.eglPresentationTimeANDROID(eglDisplay, eglSurface, ptsNs);
        if (!EGL14.eglSwapBuffers(eglDisplay, eglSurface)) throw new IOException("eglSwapBuffers 失败");
        drain(false);
    }

    /**
     * Uploads an RGBA frame of arbitrary size and stretches it across the
     * encoder surface (used by the PixelCopy path where the captured window
     * region has the device's own pixel dimensions).
     */
    synchronized void encodePixels(byte[] rgba, int srcW, int srcH, int index) throws IOException {
        if (finished || encoder == null) throw new IOException("编码器已结束");
        if (rgba.length != srcW * srcH * 4) throw new IOException("帧大小不正确: " + rgba.length);
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture);
        GLES20.glPixelStorei(GLES20.GL_UNPACK_ALIGNMENT, 1);
        if (frameBuffer == null || frameBuffer.capacity() < rgba.length) {
            frameBuffer = ByteBuffer.allocateDirect(rgba.length).order(ByteOrder.nativeOrder());
        }
        if (texW != srcW || texH != srcH) {
            GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_RGBA, srcW, srcH, 0,
                    GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, null);
            texW = srcW;
            texH = srcH;
        }
        frameBuffer.clear();
        frameBuffer.put(rgba);
        frameBuffer.position(0);
        GLES20.glTexSubImage2D(GLES20.GL_TEXTURE_2D, 0, 0, 0, srcW, srcH,
                GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, frameBuffer);
        GLES20.glClearColor(0f, 0f, 0f, 1f);
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
        GLES20.glUseProgram(program);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture);
        GLES20.glUniform1i(samplerHandle, 0);
        GLES20.glEnableVertexAttribArray(positionHandle);
        GLES20.glVertexAttribPointer(positionHandle, 2, GLES20.GL_FLOAT, false, 0, quad);
        GLES20.glEnableVertexAttribArray(texCoordHandle);
        GLES20.glVertexAttribPointer(texCoordHandle, 2, GLES20.GL_FLOAT, false, 0, tex);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        GLES20.glDisableVertexAttribArray(positionHandle);
        GLES20.glDisableVertexAttribArray(texCoordHandle);
        long ptsNs = index * 1_000_000_000L / fps;
        EGLExt.eglPresentationTimeANDROID(eglDisplay, eglSurface, ptsNs);
        if (!EGL14.eglSwapBuffers(eglDisplay, eglSurface)) throw new IOException("eglSwapBuffers 失败");
        drain(false);
    }

    private void drain(boolean end) throws IOException {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        while (true) {
            // A zero timeout starves the pipeline: when the encoder produced more
            // than one buffer while we were drawing, the queue backs up and the
            // next eglSwapBuffers stalls waiting for a free input buffer. Waiting
            // a short moment drains everything that is ready instead.
            int index = encoder.dequeueOutputBuffer(info, end ? 10_000 : 1_000);
            if (index == MediaCodec.INFO_TRY_AGAIN_LATER) {
                if (end) continue;
                return;
            }
            if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                if (!muxerStarted) {
                    track = muxer.addTrack(encoder.getOutputFormat());
                    muxer.start();
                    muxerStarted = true;
                }
                continue;
            }
            if (index < 0) continue;
            ByteBuffer buffer = encoder.getOutputBuffer(index);
            if (info.size > 0 && muxerStarted && buffer != null) {
                buffer.position(info.offset);
                buffer.limit(info.offset + info.size);
                muxer.writeSampleData(track, buffer, info);
            }
            encoder.releaseOutputBuffer(index, false);
            if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return;
        }
    }

    synchronized File finish() throws IOException {
        if (finished) return outputFile;
        finished = true;
        try {
            encoder.signalEndOfInputStream();
            drain(true);
        } finally {
            release();
        }
        if (!outputFile.exists() || outputFile.length() == 0) throw new IOException("原生编码没有输出");
        return outputFile;
    }

    synchronized void abort() {
        finished = true;
        try { release(); } catch (Exception ignored) { }
        if (outputFile != null) outputFile.delete();
    }

    private void release() {
        try { if (eglDisplay != null) EGL14.eglMakeCurrent(eglDisplay, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT); } catch (Exception ignored) { }
        try { if (eglDisplay != null && eglSurface != null) EGL14.eglDestroySurface(eglDisplay, eglSurface); } catch (Exception ignored) { }
        try { if (eglDisplay != null && eglContext != null) EGL14.eglDestroyContext(eglDisplay, eglContext); } catch (Exception ignored) { }
        try { if (eglDisplay != null) EGL14.eglTerminate(eglDisplay); } catch (Exception ignored) { }
        eglSurface = null;
        eglContext = null;
        eglDisplay = null;
        try { if (muxerStarted) muxer.stop(); } catch (Exception ignored) { }
        try { if (muxer != null) muxer.release(); } catch (Exception ignored) { }
        try { if (encoder != null) encoder.stop(); } catch (Exception ignored) { }
        try { if (encoder != null) encoder.release(); } catch (Exception ignored) { }
        try { if (inputSurface != null) inputSurface.release(); } catch (Exception ignored) { }
        muxer = null;
        encoder = null;
        inputSurface = null;
        muxerStarted = false;
    }
}
