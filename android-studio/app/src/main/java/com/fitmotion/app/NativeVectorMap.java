package com.fitmotion.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.FloatBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import android.opengl.GLES20;
import android.opengl.Matrix;

/**
 * Minimal Phase-2A vector map. It intentionally supports only the layers used
 * by the existing look and keeps labels for the next phase.
 */
final class NativeVectorMap {
    private static final int ZOOM = 14;
    private static final int TILE = 256;
    private final int width;
    private final int height;
    private final float[] routeLat;
    private final float[] routeLon;
    private final Map<String, ParsedTile> tiles = new HashMap<>();
    private float cameraX;
    private float cameraY;
    private float scale = 1f;
    private int featureCount;
    private int program;
    private int position;
    private int color;
    private String template;
    private final int background;
    private final int water;
    private final int park;
    private final int building;
    private final int road;
    private final int roadCasing;

    NativeVectorMap(JSONObject payload, int width, int height, String theme) throws Exception {
        this.width = width;
        this.height = height;
        JSONArray points = payload.optJSONArray("points");
        int count = points == null ? 0 : points.length();
        routeLat = new float[Math.max(2, count)];
        routeLon = new float[Math.max(2, count)];
        Set<String> keys = new HashSet<>();
        double minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
        for (int i = 0; i < count; i += 1) {
            JSONArray p = points.getJSONArray(i);
            float lat = (float) p.getDouble(0);
            float lon = (float) p.getDouble(1);
            routeLat[i] = lat;
            routeLon[i] = lon;
            minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
            minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
            int x = tileX(lon, ZOOM);
            int y = tileY(lat, ZOOM);
            for (int dx = -1; dx <= 1; dx += 1) {
                for (int dy = -1; dy <= 1; dy += 1) {
                    keys.add(ZOOM + "/" + (x + dx) + "/" + (y + dy));
                }
            }
        }
        if (count == 0) {
            routeLat[0] = 39.9f; routeLon[0] = 116.4f;
            routeLat[1] = 39.9f; routeLon[1] = 116.4f;
        }
        boolean light = "bright".equals(theme);
        background = light ? Color.rgb(242, 241, 232) : Color.rgb(7, 18, 20);
        water = light ? Color.rgb(151, 215, 229) : Color.rgb(15, 67, 80);
        park = light ? Color.rgb(176, 220, 179) : Color.rgb(24, 83, 67);
        building = light ? Color.rgb(217, 204, 185) : Color.rgb(47, 60, 58);
        road = light ? Color.rgb(255, 255, 255) : Color.rgb(66, 81, 79);
        roadCasing = light ? Color.rgb(196, 190, 176) : Color.rgb(23, 34, 34);
        template = resolveTemplate();
        loadTiles(keys);
    }

    private String resolveTemplate() {
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL("https://tiles.openfreemap.org/planet").openConnection();
            connection.setConnectTimeout(8_000);
            connection.setReadTimeout(8_000);
            connection.setRequestProperty("User-Agent", "FitMotion/1.0");
            connection.setRequestProperty("Accept-Encoding", "identity");
            JSONObject json = new JSONObject(readString(connection.getInputStream()));
            JSONArray sources = json.optJSONArray("tiles");
            if (sources != null && sources.length() > 0) return sources.getString(0);
        } catch (Exception ignored) { }
        return "https://tiles.openfreemap.org/planet/20261025_080012_pt/{z}/{x}/{y}.pbf";
    }

    private void loadTiles(Set<String> keys) {
        ExecutorService executor = Executors.newFixedThreadPool(8);
        List<Future<ParsedTile>> futures = new ArrayList<>();
        for (final String key : keys) {
            futures.add(executor.submit(new Callable<ParsedTile>() {
                @Override
                public ParsedTile call() {
                    try {
                        String[] parts = key.split("/");
                        int z = Integer.parseInt(parts[0]);
                        int x = Integer.parseInt(parts[1]);
                        int y = Integer.parseInt(parts[2]);
                        String url = template.replace("{z}", String.valueOf(z)).replace("{x}", String.valueOf(x)).replace("{y}", String.valueOf(y));
                        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
                        connection.setConnectTimeout(8_000);
                        connection.setReadTimeout(8_000);
                        connection.setRequestProperty("User-Agent", "FitMotion/1.0");
                        connection.setRequestProperty("Accept-Encoding", "identity");
                        byte[] bytes = readBytes(connection.getInputStream());
                        ParsedTile parsed = Mvt.parse(bytes, z, x, y);
                        parsed.key = key;
                        return parsed;
                    } catch (Exception ignored) {
                        return null;
                    }
                }
            }));
        }
        for (Future<ParsedTile> future : futures) {
            try {
                ParsedTile tile = future.get();
                if (tile != null) {
                    tiles.put(tile.key, tile);
                    for (Mvt.Layer layer : tile.layers) featureCount += layer.features.size();
                }
            } catch (Exception ignored) { }
        }
        executor.shutdown();
    }

    void update(float progress) {
        int index = Math.min(routeLat.length - 1, Math.max(0, Math.round(progress * (routeLat.length - 1))));
        double x = worldX(routeLon[index], ZOOM);
        double y = worldY(routeLat[index], ZOOM);
        cameraX = (float) x;
        cameraY = (float) y;
    }

    void draw() {
        ensureGl();
        GLES20.glClearColor(Color.red(background) / 255f, Color.green(background) / 255f, Color.blue(background) / 255f, 1f);
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
        for (ParsedTile tile : tiles.values()) {
            float left = (float) (width / 2.0 + (tile.x * TILE - cameraX) * scale);
            float top = (float) (height / 2.0 + (tile.y * TILE - cameraY) * scale);
            float size = TILE * scale;
            if (left + size < -80 || left > width + 80 || top + size < -80 || top > height + 80) continue;
            drawTile(tile);
        }
    }

    float[] projectRoute(float progress) {
        float[] result = new float[routeLat.length * 2];
        for (int i = 0; i < routeLat.length; i += 1) {
            double x = worldX(routeLon[i], ZOOM);
            double y = worldY(routeLat[i], ZOOM);
            result[i * 2] = (float) (width / 2.0 + (x - cameraX) * scale);
            result[i * 2 + 1] = (float) (height / 2.0 + (y - cameraY) * scale);
        }
        return result;
    }

    boolean available() { return !tiles.isEmpty(); }
    int tileCount() { return tiles.size(); }
    int featureCount() { return featureCount; }

    private void drawTile(ParsedTile tile) {
        for (Mvt.Layer layer : tile.layers) {
            if ("landcover".equals(layer.name) || "landuse".equals(layer.name) || "park".equals(layer.name)) {
                drawPolygons(tile, layer, park);
            } else if ("water".equals(layer.name)) {
                drawPolygons(tile, layer, water);
            } else if ("building".equals(layer.name)) {
                drawPolygons(tile, layer, building);
            } else if ("waterway".equals(layer.name)) {
                drawLines(tile, layer, water, 22);
            } else if ("transportation".equals(layer.name)) {
                for (Mvt.Feature feature : layer.features) {
                    String kind = String.valueOf(feature.props.get("class"));
                    if ("rail".equals(kind)) continue;
                    drawLines(tile, layer, roadCasing, kind.equals("motorway") || kind.equals("trunk") ? 12 : 7, feature);
                    drawLines(tile, layer, road, kind.equals("motorway") || kind.equals("trunk") ? 7 : 4, feature);
                }
            }
        }
    }

    private void drawPolygons(ParsedTile tile, Mvt.Layer layer, int colorValue) {
        List<float[]> triangles = new ArrayList<>();
        for (Mvt.Feature feature : layer.features) {
            for (List<int[]> ring : feature.rings) {
                if (ring.size() < 3) continue;
                float[] base = new float[ring.size() * 2];
                for (int i = 0; i < ring.size(); i += 1) {
                    int[] point = ring.get(i);
                    float[] screen = screen(tile, point[0], point[1]);
                    base[i * 2] = screen[0];
                    base[i * 2 + 1] = screen[1];
                }
                for (int i = 1; i + 1 < ring.size(); i += 1) {
                    triangles.add(new float[]{base[0], base[1], base[i * 2], base[i * 2 + 1], base[(i + 1) * 2], base[(i + 1) * 2 + 1]});
                }
            }
        }
        if (!triangles.isEmpty()) drawTriangles(triangles, colorValue);
    }

    private void drawLines(ParsedTile tile, Mvt.Layer layer, int colorValue, int lineWidth) {
        drawLines(tile, layer, colorValue, lineWidth, null);
    }

    private void drawLines(ParsedTile tile, Mvt.Layer layer, int colorValue, int lineWidth, Mvt.Feature only) {
        List<float[]> segments = new ArrayList<>();
        for (Mvt.Feature feature : layer.features) {
            if (only != null && feature != only) continue;
            for (List<int[]> line : feature.lines) {
                for (int i = 1; i < line.size(); i += 1) {
                    int[] a = line.get(i - 1);
                    int[] b = line.get(i);
                    float[] sa = screen(tile, a[0], a[1]);
                    float[] sb = screen(tile, b[0], b[1]);
                    addThickSegment(segments, sa[0], sa[1], sb[0], sb[1], lineWidth);
                }
            }
        }
        if (!segments.isEmpty()) drawTriangles(segments, colorValue);
    }

    private void addThickSegment(List<float[]> out, float x1, float y1, float x2, float y2, float widthPx) {
        float dx = x2 - x1;
        float dy = y2 - y1;
        float len = Math.max(0.001f, (float) Math.hypot(dx, dy));
        float nx = -dy / len * widthPx / 2f;
        float ny = dx / len * widthPx / 2f;
        out.add(new float[]{x1 + nx, y1 + ny, x1 - nx, y1 - ny, x2 + nx, y2 + ny});
        out.add(new float[]{x2 + nx, y2 + ny, x1 - nx, y1 - ny, x2 - nx, y2 - ny});
    }

    private float[] screen(ParsedTile tile, int px, int py) {
        double wx = tile.x * TILE + (px / (double) tile.extent) * TILE;
        double wy = tile.y * TILE + (py / (double) tile.extent) * TILE;
        return new float[]{(float) (width / 2.0 + (wx - cameraX) * scale), (float) (height / 2.0 + (wy - cameraY) * scale)};
    }

    private void drawTriangles(List<float[]> triangles, int colorValue) {
        float[] data = new float[triangles.size() * 18];
        int cursor = 0;
        for (float[] triangle : triangles) {
            for (int point = 0; point < 3; point += 1) {
                data[cursor++] = triangle[point * 2];
                data[cursor++] = triangle[point * 2 + 1];
                data[cursor++] = Color.red(colorValue) / 255f;
                data[cursor++] = Color.green(colorValue) / 255f;
                data[cursor++] = Color.blue(colorValue) / 255f;
                data[cursor++] = 1f;
            }
        }
        GLES20.glUseProgram(program);
        FloatBuffer buffer = ByteBuffer.allocateDirect(data.length * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
        buffer.put(data).position(0);
        GLES20.glEnableVertexAttribArray(position);
        GLES20.glVertexAttribPointer(position, 2, GLES20.GL_FLOAT, false, 24, buffer);
        buffer.position(2);
        GLES20.glEnableVertexAttribArray(color);
        GLES20.glVertexAttribPointer(color, 4, GLES20.GL_FLOAT, false, 24, buffer);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLES, 0, triangles.size() * 3);
        GLES20.glDisableVertexAttribArray(position);
        GLES20.glDisableVertexAttribArray(color);
    }

    private void ensureGl() {
        if (program != 0) return;
        String vs = "attribute vec2 aPos; attribute vec4 aColor; varying vec4 vColor;"
                + "void main(){gl_Position=vec4(aPos,0.0,1.0);vColor=aColor;}";
        String fs = "precision mediump float; varying vec4 vColor; void main(){gl_FragColor=vColor;}";
        int v = GLES20.glCreateShader(GLES20.GL_VERTEX_SHADER);
        GLES20.glShaderSource(v, vs);
        GLES20.glCompileShader(v);
        int f = GLES20.glCreateShader(GLES20.GL_FRAGMENT_SHADER);
        GLES20.glShaderSource(f, fs);
        GLES20.glCompileShader(f);
        program = GLES20.glCreateProgram();
        GLES20.glAttachShader(program, v);
        GLES20.glAttachShader(program, f);
        GLES20.glLinkProgram(program);
        position = GLES20.glGetAttribLocation(program, "aPos");
        color = GLES20.glGetAttribLocation(program, "aColor");
    }

    private static int tileX(double lon, int z) {
        return (int) Math.floor((lon + 180.0) / 360.0 * (1 << z));
    }

    private static int tileY(double lat, int z) {
        double rad = Math.toRadians(lat);
        return (int) Math.floor((1.0 - Math.log(Math.tan(Math.PI / 4.0 + rad / 2.0)) / Math.PI) / 2.0 * (1 << z));
    }

    private static double worldX(double lon, int z) {
        return (lon + 180.0) / 360.0 * TILE * (1 << z);
    }

    private static double worldY(double lat, int z) {
        return (1.0 - Math.log(Math.tan(Math.PI / 4.0 + Math.toRadians(lat) / 2.0)) / Math.PI) / 2.0 * TILE * (1 << z);
    }

    private static byte[] readBytes(InputStream input) throws Exception {
        java.io.PushbackInputStream probe = new java.io.PushbackInputStream(input, 2);
        int b1 = probe.read();
        int b2 = probe.read();
        // PushbackInputStream is LIFO: restore b2 first, then b1 so the
        // stream starts with the original bytes in order.
        if (b2 >= 0) probe.unread(b2);
        if (b1 >= 0) probe.unread(b1);
        InputStream source = (b1 == 0x1f && b2 == 0x8b) ? new java.util.zip.GZIPInputStream(probe) : probe;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = source.read(buffer)) > 0) out.write(buffer, 0, read);
        source.close();
        return out.toByteArray();
    }

    private static String readString(InputStream input) throws Exception {
        return new String(readBytes(input), "UTF-8");
    }

    static final class ParsedTile {
        final int z, x, y, extent;
        final List<Mvt.Layer> layers;
        String key;
        ParsedTile(int z, int x, int y, int extent, List<Mvt.Layer> layers) {
            this.z = z; this.x = x; this.y = y; this.extent = extent; this.layers = layers;
        }
    }
}
