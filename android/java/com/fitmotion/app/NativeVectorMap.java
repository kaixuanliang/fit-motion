package com.fitmotion.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Typeface;
import android.opengl.GLES20;
import android.opengl.GLUtils;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Vector tile store for the native renderer.
 *
 * Tiles are fetched once for the corridor the route passes through, parsed on
 * demand and rasterised into a Bitmap at exactly the size they will be drawn
 * on screen (the same trick the Canvas renderer uses: project + stroke once,
 * then blit). The bitmap is uploaded to a GL texture and cached, so a steady
 * frame is just a handful of textured quads.
 */
final class NativeVectorMap {
    static final int FOLLOW_ZOOM = 14;
    static final int TILE = 256;
    static final int PAD = 8;

    private static final int PARSED_LIMIT = 48;
    private static final int BITMAP_LIMIT = 28;

    final int zoom;
    private final Map<String, byte[]> raw = new HashMap<>();
    private final Map<String, ParsedTile> parsed = lru(PARSED_LIMIT);
    /**
     * Per-map cap on cached rasters. The follow layer only ever shows a couple
     * of dozen tiles, but the whole-route poster framing covers a few hundred
     * overview tiles at once, and a shared cap of 28 evicted most of them
     * before they were ever drawn — that is what left the left half of the
     * poster map blank. Sized by the caller to the actual viewport.
     */
    private volatile int bitmapLimit = BITMAP_LIMIT;
    /**
     * Rasterised tiles, bounded. Eviction MUST free the GL texture: a long
     * route walks through hundreds of tiles, and textures that outlive their
     * bitmap would accumulate until the GPU runs out of memory and the app
     * dies mid-export. Deletion is deferred to the GL thread via
     * {@link #pendingDeletes} because eviction may now happen on raster
     * worker threads, which own no EGL context.
     */
    private final Map<String, TileBitmap> bitmaps =
            new LinkedHashMap<String, TileBitmap>(BITMAP_LIMIT * 2, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, TileBitmap> eldest) {
            if (size() <= bitmapLimit) return false;
            TileBitmap victim = eldest.getValue();
            if (victim != null && victim.texture != 0) {
                synchronized (pendingDeletes) {
                    pendingDeletes.add(victim.texture);
                }
                victim.texture = 0;
            }
            return true;
        }
    };
    private final List<Integer> pendingDeletes = new ArrayList<>();
    /** Tile coordinates in route order, used by the parallel pre-raster pass. */
    private final List<long[]> orderedCoords;
    private final File tileCacheDir;
    private final String themeKey;
    /**
     * Whole-route framing runs on a low tile zoom, where every lane of the city
     * is still in the data. Drawing them all turns the poster into a grey mesh,
     * so the overview layer keeps the main network only and dims the rest.
     */
    private final boolean sparse;
    private String template;

    private Thread[] preRasterWorkers;

    final int background;
    final int water;
    final int park;
    final int building;
    final int road;
    final int roadMajor;
    final int roadPrimary;
    final int roadMinor;
    final int roadEdge;
    final int transit;
    final int nationalRoad;
    private final int labelColor;
    private final int labelHalo;
    /** Terrain / land-use tints, keyed by MVT subclass then class. */
    private final Map<String, Integer> areas = new HashMap<>();
    private int rock;

    /**
     * Per-thread canvas tools. Paint and Path are not thread-safe, and tiles
     * are now rasterised on worker threads during the pre-raster pass, so
     * every thread paints with its own set.
     */
    private final ThreadLocal<Tools> tools = new ThreadLocal<Tools>() {
        @Override
        protected Tools initialValue() {
            return new Tools();
        }
    };

    static final class Tools {
        final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
        final Path path = new Path();

        Tools() {
            fill.setStyle(Paint.Style.FILL);
            stroke.setStyle(Paint.Style.STROKE);
            stroke.setStrokeCap(Paint.Cap.ROUND);
            stroke.setStrokeJoin(Paint.Join.ROUND);
        }
    }

    private int uploads;
    private long rasterMs;

    NativeVectorMap(JSONObject payload, File cacheDir, int zoom, boolean wholeRoute) throws Exception {
        this.zoom = zoom;
        this.tileCacheDir = new File(cacheDir, "native-tiles");
        String theme = payload.optString("theme", "tech");
        this.themeKey = theme;
        this.sparse = zoom <= 11;
        boolean light = "bright".equals(theme);
        boolean night = "night".equals(theme);
        if (light) {
            background = 0xFFF4F2E7; water = 0xFF94D9EA; park = 0xFFB7E49E;
            building = 0xFFE8E2D2; road = 0xFF98AAA2; roadEdge = 0xFFFFFEFA; transit = 0xFF68A6CA;
            roadMajor = 0xFFD99F53; roadPrimary = 0xFFC4A97A; roadMinor = 0xFFB0BDB6;
            nationalRoad = 0xFFE8940A;
            labelColor = 0xFF3F5A50; labelHalo = 0xFFF8F5EA;
            rock = 0xFFB2A488;
            tint(0xFFA9D294, 0xFFC8E6AE, 0xFFBCDC9E, 0xFFB7E49E); // wood grass scrub park
            areas.put("garden", 0xFFBEE3A6);
            areas.put("sand", 0xFFEFE0B9);
            areas.put("farmland", 0xFFDFE7A4);
            areas.put("ice", 0xFFF6FAFB);
            areas.put("residential", 0xFFE7DFCB);
            areas.put("commercial", 0xFFF4E2D1);
            areas.put("retail", 0xFFF4E2D1);
            areas.put("industrial", 0xFFE2DFD6);
            areas.put("railway", 0xFFE0DBD0);
            areas.put("school", 0xFFDCE9E5);
            areas.put("university", 0xFFDCE9E5);
            areas.put("hospital", 0xFFF3DCD8);
            areas.put("pitch", 0xFFA6DCA0);
            areas.put("military", 0xFFDEE3CE);
            areas.put("cemetery", 0xFFD8E5C4);
            areas.put("nature_reserve", 0xFFABD79B);
            areas.put("wildlife_refuge", 0xFFABD79B);
            areas.put("historic", 0xFFE8DBBF);
            areas.put("default", 0xFFEFEDE0);
        } else if (night) {
            // Night: one navy family. Greens are pushed to a dark blue-teal and
            // every built-up class sits within a couple of steps of the base, so
            // the map reads as calm terrain instead of a patchwork quilt.
            background = 0xFF0A1425; water = 0xFF0F2C44; park = 0xFF102E2C;
            building = 0xFF142033; road = 0xFF8FA2B6; roadEdge = 0xFF0F1D2C; transit = 0xFF4A9FD0;
            roadMajor = 0xFFC7B48E; roadPrimary = 0xFFA08F74; roadMinor = 0xFF647A90;
            nationalRoad = 0xFFFFC15A;
            labelColor = 0xFFD8E8FA; labelHalo = 0xFF0A1425;
            rock = 0xFF7186A2;
            tint(0xFF0F2A29, 0xFF102E2C, 0xFF112C2B, 0xFF102E2C);
            areas.put("garden", 0xFF102E2C);
            areas.put("sand", 0xFF1B2735);
            areas.put("farmland", 0xFF112B28);
            areas.put("ice", 0xFF1B2E40);
            areas.put("residential", 0xFF0C1D31);
            areas.put("commercial", 0xFF0F2436);
            areas.put("retail", 0xFF0F2436);
            areas.put("industrial", 0xFF122334);
            areas.put("railway", 0xFF131F2C);
            areas.put("school", 0xFF0E2638);
            areas.put("university", 0xFF0E2638);
            areas.put("hospital", 0xFF182235);
            areas.put("pitch", 0xFF102F2C);
            areas.put("military", 0xFF122A30);
            areas.put("cemetery", 0xFF102B26);
            areas.put("nature_reserve", 0xFF0E2926);
            areas.put("wildlife_refuge", 0xFF0E2926);
            areas.put("historic", 0xFF1E2634);
            areas.put("default", 0xFF0B1929);
        } else {
            // Tech: one deep-teal family, same rule as night — no stray hues.
            background = 0xFF051820; water = 0xFF0A3140; park = 0xFF0D2F2C;
            building = 0xFF0D2530; road = 0xFF5FA6A8; roadEdge = 0xFF041A22; transit = 0xFF00D2C2;
            roadMajor = 0xFFC2A26C; roadPrimary = 0xFF9C8560; roadMinor = 0xFF3E7476;
            nationalRoad = 0xFFFFB648;
            labelColor = 0xFFD2F6EE; labelHalo = 0xFF051820;
            rock = 0xFF2A6462;
            tint(0xFF0B2B29, 0xFF0D2F2C, 0xFF0E2D2B, 0xFF0D2F2C);
            areas.put("garden", 0xFF0D2F2C);
            areas.put("sand", 0xFF14262B);
            areas.put("farmland", 0xFF0D2C26);
            areas.put("ice", 0xFF17303B);
            areas.put("residential", 0xFF07202A);
            areas.put("commercial", 0xFF0A2A33);
            areas.put("retail", 0xFF0A2A33);
            areas.put("industrial", 0xFF0C2730);
            areas.put("railway", 0xFF0E2229);
            areas.put("school", 0xFF092A33);
            areas.put("university", 0xFF092A33);
            areas.put("hospital", 0xFF14252C);
            areas.put("pitch", 0xFF0D332C);
            areas.put("military", 0xFF0E2C2C);
            areas.put("cemetery", 0xFF0C2C24);
            areas.put("nature_reserve", 0xFF0A2A26);
            areas.put("wildlife_refuge", 0xFF0A2A26);
            areas.put("historic", 0xFF1B2A29);
            areas.put("default", 0xFF061C24);
        }
        template = resolveTemplate();
        JSONArray points = payload.optJSONArray("points");
        orderedCoords = wholeRoute ? boundsCoords(points) : corridorCoords(points);
        pruneLegacyRasterCache();
        prefetch(orderedCoords);
    }

    /**
     * Older builds cached rasters without the theme in the file name; those can
     * never be reused now and would just eat hundreds of megabytes, so clear the
     * directory once.
     */
    private void pruneLegacyRasterCache() {
        try {
            File dir = new File(tileCacheDir, "raster");
            File marker = new File(dir, "raster-v2.cache");
            if (marker.isFile()) return;
            if (!dir.isDirectory() && !dir.mkdirs()) return;
            File[] files = dir.listFiles();
            if (files != null) {
                for (int i = 0; i < files.length; i += 1) {
                    if (files[i].isFile()) files[i].delete();
                }
            }
            new FileOutputStream(marker).close();
        } catch (Exception ignored) { }
    }

    private static <V> Map<String, V> lru(final int limit) {
        return new LinkedHashMap<String, V>(limit * 2, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, V> eldest) {
                return size() > limit;
            }
        };
    }

    /** Tile coords covering the route plus one tile of margin on each side. */
    private List<long[]> corridorCoords(JSONArray points) {
        Set<Long> seen = new LinkedHashSet<Long>();
        if (points != null) {
            for (int i = 0; i < points.length(); i += 1) {
                try {
                    JSONArray point = points.getJSONArray(i);
                    int x = tileX(point.getDouble(1));
                    int y = tileY(point.getDouble(0));
                    for (int dx = -2; dx <= 2; dx += 1) {
                        for (int dy = -2; dy <= 2; dy += 1) {
                            seen.add(coordKey(x + dx, y + dy));
                        }
                    }
                } catch (Exception ignored) { }
            }
        }
        return coordsFrom(seen);
    }

    /**
     * Tile coords covering the route bounding box, used by the lower-zoom map
     * that renders the whole-route cover and result shots.
     */
    private List<long[]> boundsCoords(JSONArray points) {
        if (points == null || points.length() == 0) return new ArrayList<long[]>();
        int minX = Integer.MAX_VALUE, maxX = Integer.MIN_VALUE;
        int minY = Integer.MAX_VALUE, maxY = -Integer.MAX_VALUE;
        for (int i = 0; i < points.length(); i += 1) {
            try {
                JSONArray point = points.getJSONArray(i);
                int x = tileX(point.getDouble(1));
                int y = tileY(point.getDouble(0));
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
            } catch (Exception ignored) { }
        }
        if (minX > maxX) return new ArrayList<long[]>();
        Set<Long> seen = new LinkedHashSet<Long>();
        for (int x = minX - 1; x <= maxX + 1; x += 1) {
            for (int y = minY - 1; y <= maxY + 1; y += 1) {
                seen.add(coordKey(x, y));
            }
        }
        return coordsFrom(seen);
    }

    private static Long coordKey(int x, int y) {
        return (long) x << 32 | (y & 0xffffffffL);
    }

    private static List<long[]> coordsFrom(Set<Long> seen) {
        List<long[]> coords = new ArrayList<long[]>(seen.size());
        for (Long key : seen) {
            long value = key.longValue();
            coords.add(new long[]{(int) (value >> 32), (int) value});
        }
        return coords;
    }

    List<long[]> corridorCoords() {
        return orderedCoords;
    }

    /**
     * Makes sure every given tile is in memory, fetching only the ones the
     * corridor prefetch missed (the whole-route framing can reach past it).
     */
    void ensureTiles(List<long[]> coords) {
        List<long[]> missing = new ArrayList<long[]>();
        for (int i = 0; i < coords.size(); i += 1) {
            long[] c = coords.get(i);
            if (!raw.containsKey(zoom + "/" + c[0] + "/" + c[1])) missing.add(c);
        }
        if (!missing.isEmpty()) prefetch(missing);
    }

    private void prefetch(final List<long[]> coords) {
        // Network-bound: pbf tiles compress ~2/3 over the wire (transparent
        // gzip — do NOT set Accept-Encoding manually, that disables it), and
        // HttpURLConnection reuses keep-alive connections when streams are
        // fully drained. Results are cached on disk, so repeat exports of the
        // same route skip the network almost entirely.
        ExecutorService executor = Executors.newFixedThreadPool(20);
        List<Future<Object[]>> futures = new ArrayList<>();
        for (int i = 0; i < coords.size(); i += 1) {
            final long[] coord = coords.get(i);
            final String key = zoom + "/" + coord[0] + "/" + coord[1];
            futures.add(executor.submit(new Callable<Object[]>() {
                @Override
                public Object[] call() {
                    try {
                        byte[] cached = readTileCache(key);
                        if (cached != null) return new Object[]{key, cached};
                        String[] parts = key.split("/");
                        String url = template.replace("{z}", parts[0])
                                .replace("{x}", parts[1]).replace("{y}", parts[2]);
                        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
                        connection.setConnectTimeout(8_000);
                        connection.setReadTimeout(8_000);
                        connection.setRequestProperty("User-Agent", "FitMotion/1.0");
                        byte[] bytes = readBytes(connection.getInputStream());
                        writeTileCache(key, bytes);
                        return new Object[]{key, bytes};
                    } catch (Exception ignored) {
                        return null;
                    }
                }
            }));
        }
        for (Future<Object[]> future : futures) {
            try {
                Object[] result = future.get();
                if (result != null) raw.put((String) result[0], (byte[]) result[1]);
            } catch (Exception ignored) { }
        }
        executor.shutdown();
    }

    private File tileCacheFile(String key) {
        return new File(tileCacheDir, key.replace('/', '_') + ".pbf");
    }

    private byte[] readTileCache(String key) {
        try {
            File file = tileCacheFile(key);
            if (!file.isFile() || file.length() == 0) return null;
            byte[] bytes = new byte[(int) file.length()];
            FileInputStream in = new FileInputStream(file);
            try {
                int read = in.read(bytes);
                if (read != bytes.length) return null;
                return bytes;
            } finally {
                in.close();
            }
        } catch (Exception ignored) {
            return null;
        }
    }

    private void writeTileCache(String key, byte[] bytes) {
        try {
            if (bytes == null || bytes.length == 0) return;
            if (tileCacheDir != null && !tileCacheDir.isDirectory()) tileCacheDir.mkdirs();
            File file = tileCacheFile(key);
            File tmp = new File(file.getParentFile(), file.getName() + "." + Thread.currentThread().getId());
            FileOutputStream out = new FileOutputStream(tmp);
            out.write(bytes);
            out.close();
            if (!tmp.renameTo(file)) tmp.delete();
        } catch (Exception ignored) { }
    }

    private String resolveTemplate() {
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL("https://tiles.openfreemap.org/planet").openConnection();
            connection.setConnectTimeout(8_000);
            connection.setReadTimeout(8_000);
            connection.setRequestProperty("User-Agent", "FitMotion/1.0");
            JSONObject json = new JSONObject(readString(connection.getInputStream()));
            JSONArray sources = json.optJSONArray("tiles");
            if (sources != null && sources.length() > 0) return sources.getString(0);
        } catch (Exception ignored) { }
        return "https://tiles.openfreemap.org/planet/20261025_080012_pt/{z}/{x}/{y}.pbf";
    }

    int tileCount() { return raw.size(); }
    long rasterMs() { return rasterMs; }
    int uploads() { return uploads; }

    /**
     * Raises (or lowers) how many rasters this layer keeps alive. The overview
     * layer must hold a whole poster viewport, otherwise eviction silently
     * drops tiles and the map comes out half painted.
     */
    void setBitmapLimit(int limit) {
        bitmapLimit = Math.max(BITMAP_LIMIT, limit);
    }

    private ParsedTile tile(int x, int y) {
        String key = zoom + "/" + x + "/" + y;
        ParsedTile cached;
        synchronized (parsed) {
            cached = parsed.get(key);
        }
        if (cached != null) return cached;
        byte[] bytes = raw.get(key);
        if (bytes == null) return null;
        try {
            ParsedTile result = Mvt.parse(bytes, zoom, x, y);
            synchronized (parsed) {
                parsed.put(key, result);
            }
            return result;
        } catch (Exception error) {
            return null;
        }
    }

    /**
     * Returns the rasterised tile at {@code size} device pixels, or null while
     * the tile data has not arrived yet. Thread-safe: rasterisation runs on
     * worker threads during the pre-raster pass and on the GL thread as a
     * fallback. Results are also cached on disk, so the next export of the
     * same route skips the painting step entirely.
     */
    Bitmap bitmap(int x, int y, int size) {
        String key = zoom + "/" + x + "/" + y + "@" + size;
        TileBitmap cached;
        synchronized (bitmaps) {
            cached = bitmaps.get(key);
        }
        if (cached != null) return cached.bitmap;
        Bitmap bitmap = readRasterCache(x, y, size);
        if (bitmap == null) {
            bitmap = rasterize(x, y, size);
            if (bitmap == null) return null;
            writeRasterCache(x, y, size, bitmap);
        }
        TileBitmap entry = new TileBitmap();
        entry.bitmap = bitmap;
        entry.texture = 0;
        synchronized (bitmaps) {
            bitmaps.put(key, entry);
        }
        return bitmap;
    }

    private Bitmap rasterize(int x, int y, int size) {
        ParsedTile tile = tile(x, y);
        if (tile == null) return null;
        Bitmap bitmap;
        try {
            long started = System.nanoTime();
            bitmap = Bitmap.createBitmap(size + PAD * 2, size + PAD * 2, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            canvas.translate(PAD, PAD);
            paintTile(canvas, tile, size, tools.get());
            rasterMs += (System.nanoTime() - started) / 1_000_000L;
        } catch (OutOfMemoryError error) {
            // A 200 km corridor churns through hundreds of large tiles; under
            // memory pressure it is far better to skip one tile (a blank patch
            // for a frame) than to kill the whole export.
            return null;
        }
        return bitmap;
    }

    private File rasterCacheFile(int x, int y, int size) {
        // Theme is part of the key: a light-theme raster must never be reused
        // by a dark export (that mismatch is what made night/tech look garish).
        // The paint version is in there too, so a style change cannot come back
        // from an older cache.
        return new File(new File(tileCacheDir, "raster"),
                "v2_" + themeKey + "_" + zoom + "_" + x + "_" + y + "@" + size + ".png");
    }

    private Bitmap readRasterCache(int x, int y, int size) {
        try {
            File file = rasterCacheFile(x, y, size);
            if (!file.isFile() || file.length() == 0) return null;
            Bitmap bitmap = BitmapFactory.decodeFile(file.getAbsolutePath());
            if (bitmap == null) file.delete();
            return bitmap;
        } catch (Exception ignored) {
            return null;
        }
    }

    private void writeRasterCache(int x, int y, int size, Bitmap bitmap) {
        try {
            File dir = new File(tileCacheDir, "raster");
            if (!dir.isDirectory()) dir.mkdirs();
            File file = rasterCacheFile(x, y, size);
            File tmp = new File(dir, file.getName() + "." + Thread.currentThread().getId());
            FileOutputStream out = new FileOutputStream(tmp);
            try {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
            } finally {
                out.close();
            }
            if (!tmp.renameTo(file)) tmp.delete();
        } catch (Exception ignored) { }
    }

    /** Uploads a rasterised tile into a GL texture, rasterising on first use. */
    int texture(int x, int y, int size) {
        String key = zoom + "/" + x + "/" + y + "@" + size;
        TileBitmap entry;
        synchronized (bitmaps) {
            entry = bitmaps.get(key);
        }
        if (entry == null) {
            // First time this tile is asked for at this raster size: paint it
            // once, cache the bitmap, then upload. Without this step no tile
            // would ever reach the GPU and the map would stay blank.
            if (bitmap(x, y, size) == null) return 0;
            synchronized (bitmaps) {
                entry = bitmaps.get(key);
            }
            if (entry == null) return 0;
        }
        return upload(entry);
    }

    /**
     * Like {@link #texture} but never rasterises: used while the camera is far
     * from follow zoom (cover and result crossfades), where the viewport spans
     * hundreds of tiles and painting them all on demand would stall the
     * export. The overview tiles carry those frames instead.
     */
    int textureIfReady(int x, int y, int size) {
        String key = zoom + "/" + x + "/" + y + "@" + size;
        TileBitmap entry;
        synchronized (bitmaps) {
            entry = bitmaps.get(key);
        }
        if (entry == null) return 0;
        return upload(entry);
    }

    private int upload(TileBitmap entry) {
        if (entry.texture != 0) return entry.texture;
        int[] textures = new int[1];
        GLES20.glGenTextures(1, textures, 0);
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, textures[0]);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
        GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, entry.bitmap, 0);
        entry.texture = textures[0];
        uploads += 1;
        return entry.texture;
    }

    /** Frees GL textures whose bitmaps were evicted on non-GL threads. */
    void drainDeleted() {
        int[] batch;
        synchronized (pendingDeletes) {
            if (pendingDeletes.isEmpty()) return;
            batch = new int[pendingDeletes.size()];
            for (int i = 0; i < batch.length; i += 1) batch[i] = pendingDeletes.get(i);
            pendingDeletes.clear();
        }
        GLES20.glDeleteTextures(batch.length, batch, 0);
    }

    /**
     * Rasterises the given tiles in parallel ahead of playback, so the render
     * loop never stalls on a first-use paint. The disk raster cache is filled
     * too, which makes repeat exports of the same route dramatically faster.
     * Call {@link #awaitPreRaster()} to block until every worker finished.
     */
    void preRaster(final List<long[]> targets, final int size, int threads, final AtomicInteger done) {
        if (targets == null || targets.isEmpty() || size <= 0) return;
        final AtomicInteger cursor = new AtomicInteger();
        int n = Math.max(1, Math.min(threads, targets.size()));
        Thread[] workers = new Thread[n];
        for (int w = 0; w < n; w += 1) {
            workers[w] = new Thread(new Runnable() {
                @Override
                public void run() {
                    while (true) {
                        int index = cursor.getAndIncrement();
                        if (index >= targets.size()) return;
                        long[] coord = targets.get(index);
                        String key = zoom + "/" + coord[0] + "/" + coord[1] + "@" + size;
                        synchronized (bitmaps) {
                            if (bitmaps.containsKey(key)) {
                                done.incrementAndGet();
                                continue;
                            }
                        }
                        bitmap((int) coord[0], (int) coord[1], size);
                        done.incrementAndGet();
                    }
                }
            }, "fitmotion-preraster-" + w);
            workers[w].start();
        }
        preRasterWorkers = workers;
    }

    void awaitPreRaster() {
        Thread[] workers = preRasterWorkers;
        if (workers == null) return;
        for (int i = 0; i < workers.length; i += 1) {
            try {
                workers[i].join();
            } catch (InterruptedException ignored) { }
        }
        preRasterWorkers = null;
    }

    private void paintTile(Canvas canvas, ParsedTile tile, int size, Tools t) {
        float scale = size / (float) tile.extent;
        // Terrain and land-use blocks, each class with its own tint so woods,
        // fields, housing and industry read apart at a glance.
        for (Mvt.Layer layer : tile.layers) {
            String name = layer.name;
            if ("landcover".equals(name) || "landuse".equals(name) || "park".equals(name)) {
                paintAreas(canvas, layer, scale, t);
            }
        }
        for (Mvt.Layer layer : tile.layers) {
            if (!"water".equals(layer.name)) continue;
            paintPolygons(canvas, layer, water, scale, 255, t);
        }
        for (Mvt.Layer layer : tile.layers) {
            if (!"building".equals(layer.name)) continue;
            // At city scale a footprint is a couple of pixels; hundreds of them
            // per tile only add speckle to the poster.
            if (sparse) continue;
            paintPolygons(canvas, layer, building, scale, 240, t);
        }

        for (Mvt.Layer layer : tile.layers) {
            if (!"waterway".equals(layer.name)) continue;
            float width = sparse ? 2.2f : 3f;
            for (Mvt.Feature feature : layer.features) {
                for (List<int[]> line : feature.lines) {
                    paintLine(canvas, line, scale, water, width, t);
                }
            }
        }

        // Two passes so the casing stays under every road fill, including the
        // roads of neighbouring tiles.
        for (Mvt.Layer layer : tile.layers) {
            if (!"transportation".equals(layer.name)) continue;
            for (Mvt.Feature feature : layer.features) {
                String kind = String.valueOf(feature.props.get("class"));
                float width = roadWidth(kind);
                if ("rail".equals(kind)) continue;
                if (sparse && !isArterial(kind)) continue;
                int casing = sparse ? alpha(roadEdge, 0.5f) : roadEdge;
                float casingWidth = sparse ? width + 1.4f : width + 2.4f;
                for (List<int[]> line : feature.lines) {
                    paintLine(canvas, line, scale, casing, casingWidth, t);
                }
            }
        }
        for (Mvt.Layer layer : tile.layers) {
            if (!"transportation".equals(layer.name)) continue;
            for (Mvt.Feature feature : layer.features) {
                String kind = String.valueOf(feature.props.get("class"));
                if (sparse && isLane(kind)) continue;
                float width = sparse ? roadWidth(kind) * 0.8f : roadWidth(kind);
                int color = roadColor(kind);
                if (sparse) color = alpha(color, sparseRoadAlpha(kind));
                for (List<int[]> line : feature.lines) {
                    paintLine(canvas, line, scale, color, width, t);
                }
            }
        }

        // National trunk roads (G ref): the transportation layer carries no ref,
        // so restroke the named geometry in the highway colour on top. This is
        // what makes 国道 legible on the map itself, not just via shields.
        for (Mvt.Layer layer : tile.layers) {
            if (!"transportation_name".equals(layer.name)) continue;
            for (Mvt.Feature feature : layer.features) {
                Object refValue = feature.props.get("ref");
                if (refValue == null) continue;
                String ref = String.valueOf(refValue).split(";")[0].trim();
                if (!isNationalRef(ref)) continue;
                String kind = String.valueOf(feature.props.get("class"));
                float width = Math.max(roadWidth(kind), sparse ? 4.4f : 5.2f);
                int color = sparse ? alpha(nationalRoad, 0.85f) : nationalRoad;
                for (List<int[]> line : feature.lines) {
                    paintLine(canvas, line, scale, color, width, t);
                }
            }
        }

        paintTerrain(canvas, tile, size, scale, t);
        paintPlaceLabels(canvas, tile, size);
    }

    private void tint(int wood, int grass, int scrub, int park) {
        areas.put("wood", wood);
        areas.put("forest", wood);
        areas.put("grass", grass);
        areas.put("meadow", grass);
        areas.put("scrub", scrub);
        areas.put("park", park);
    }

    /** Paints terrain / land-use polygons, one tint per MVT class or subclass. */
    private void paintAreas(Canvas canvas, Mvt.Layer layer, float scale, Tools t) {
        for (Mvt.Feature feature : layer.features) {
            Object subclass = feature.props.get("subclass");
            Object kind = feature.props.get("class");
            Integer color = subclass == null ? null : areas.get(subclass.toString());
            if (color == null && kind != null) color = areas.get(kind.toString());
            if (color == null) color = areas.get("default");
            t.fill.setColor(color == null ? park : color);
            t.fill.setAlpha(255);
            for (List<int[]> ring : feature.rings) {
                if (ring.size() < 3) continue;
                t.path.reset();
                for (int i = 0; i < ring.size(); i += 1) {
                    int[] point = ring.get(i);
                    float px = point[0] * scale;
                    float py = point[1] * scale;
                    if (i == 0) t.path.moveTo(px, py);
                    else t.path.lineTo(px, py);
                }
                t.path.close();
                canvas.drawPath(t.path, t.fill);
            }
        }
    }

    /**
     * Mountain relief: cliff bands are stroked as ridge texture, named peaks get
     * a triangle plus name and elevation. Vector tiles carry no DEM, so these
     * two layers are what make a range read as a range.
     */
    private void paintTerrain(Canvas canvas, ParsedTile tile, int size, float scale, Tools t) {
        Paint glyph = new Paint(Paint.ANTI_ALIAS_FLAG);
        glyph.setStyle(Paint.Style.STROKE);
        glyph.setStrokeJoin(Paint.Join.ROUND);
        glyph.setStrokeCap(Paint.Cap.ROUND);
        Paint ink = new Paint(Paint.ANTI_ALIAS_FLAG);
        ink.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        ink.setTextAlign(Paint.Align.CENTER);
        Paint halo = new Paint(Paint.ANTI_ALIAS_FLAG);
        halo.setStyle(Paint.Style.STROKE);
        halo.setStrokeJoin(Paint.Join.ROUND);
        halo.setTypeface(ink.getTypeface());
        halo.setTextAlign(Paint.Align.CENTER);

        for (Mvt.Layer layer : tile.layers) {
            if (!"mountain_peak".equals(layer.name)) continue;
            int peaks = 0;
            for (Mvt.Feature feature : layer.features) {
                String kind = String.valueOf(feature.props.get("class"));
                if ("cliff".equals(kind)) {
                    glyph.setColor(rock);
                    glyph.setAlpha(90);
                    glyph.setStrokeWidth(1.5f);
                    for (List<int[]> line : feature.lines) {
                        if (line.size() < 2) continue;
                        t.path.reset();
                        for (int i = 0; i < line.size(); i += 1) {
                            int[] point = line.get(i);
                            if (i == 0) t.path.moveTo(point[0] * scale, point[1] * scale);
                            else t.path.lineTo(point[0] * scale, point[1] * scale);
                        }
                        canvas.drawPath(t.path, glyph);
                    }
                    continue;
                }
                if (!"peak".equals(kind) || peaks >= (sparse ? 1 : 2)) continue;
                if (feature.lines.isEmpty() || feature.lines.get(0).isEmpty()) continue;
                int[] point = feature.lines.get(0).get(0);
                if (point[0] <= 0 || point[1] <= 0 || point[0] >= layer.extent || point[1] >= layer.extent) continue;
                float px = point[0] * scale;
                float py = point[1] * scale;
                if (px < 40 || px > size - 40 || py < 30 || py > size - 30) continue;

                t.path.reset();
                t.path.moveTo(px - 7.5f, py + 5f);
                t.path.lineTo(px, py - 8f);
                t.path.lineTo(px + 7.5f, py + 5f);
                t.path.close();
                ink.setStyle(Paint.Style.FILL);
                ink.setColor(rock);
                canvas.drawPath(t.path, ink);

                Object name = feature.props.get("name");
                if (name == null) continue;
                // Elevation is noise on a ride poster: the card already reports
                // the altitude that matters, and a name is what orients a rider.
                String text = name.toString();
                float textSize = 17f;
                ink.setTextSize(textSize);
                ink.setColor(labelColor);
                halo.setTextSize(textSize);
                halo.setStrokeWidth(textSize * 0.24f);
                halo.setColor(labelHalo);
                float tx = Math.max(90f, Math.min(size - 90f, px + 6f));
                float ty = Math.max(20f, py - 12f);
                canvas.drawText(text, tx, ty, halo);
                canvas.drawText(text, tx, ty, ink);
                peaks += 1;
            }
        }
    }

    /**
     * Bakes place names into the tile raster. Doing it here means a steady
     * frame stays a handful of textured quads, and the labels keep the crisp
     * stroke quality of Canvas text instead of upscaled glyph atlases.
     */
    private void paintPlaceLabels(Canvas canvas, ParsedTile tile, int size) {
        Mvt.Layer layer = null;
        for (Mvt.Layer candidate : tile.layers) {
            if ("place".equals(candidate.name)) {
                layer = candidate;
                break;
            }
        }
        if (layer == null) return;
        Paint label = new Paint(Paint.ANTI_ALIAS_FLAG);
        label.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
        label.setTextAlign(Paint.Align.CENTER);
        Paint halo = new Paint(Paint.ANTI_ALIAS_FLAG);
        halo.setStyle(Paint.Style.STROKE);
        halo.setStrokeJoin(Paint.Join.ROUND);
        halo.setTypeface(label.getTypeface());
        halo.setTextAlign(Paint.Align.CENTER);

        float scale = size / (float) layer.extent;
        int drawn = 0;
        int maxLabels = sparse ? 2 : 3;
        for (Mvt.Feature feature : layer.features) {
            if (drawn >= maxLabels) break;
            Object name = feature.props.get("name");
            if (name == null || name.toString().isEmpty()) continue;
            String kind = String.valueOf(feature.props.get("class"));
            // A city-scale poster only needs the towns that anchor the route;
            // every village name turns the map into a phone book.
            if (sparse && !"city".equals(kind) && !"town".equals(kind)) continue;
            float textSize;
            int maxRank;
            if ("city".equals(kind)) { textSize = 26f; maxRank = 24; }
            else if ("town".equals(kind)) { textSize = 22f; maxRank = 16; }
            else if ("village".equals(kind) || "suburb".equals(kind)
                    || "quarter".equals(kind) || "neighbourhood".equals(kind)) {
                textSize = 18f; maxRank = 12;
            } else continue;
            int rank = rankOf(feature.props.get("rank"));
            if (rank > maxRank) continue;
            if (feature.lines.isEmpty() || feature.lines.get(0).isEmpty()) continue;
            int[] point = feature.lines.get(0).get(0);
            // Features in the tile buffer belong to the neighbouring tile; keep
            // them out so a name is never drawn twice at a seam.
            if (point[0] <= 0 || point[1] <= 0 || point[0] >= layer.extent || point[1] >= layer.extent) continue;
            float px = point[0] * scale;
            float py = point[1] * scale;
            if (px < 30 || px > size - 30 || py < 24 || py > size - 24) continue;
            label.setTextSize(textSize);
            label.setColor(labelColor);
            halo.setTextSize(textSize);
            halo.setStrokeWidth(textSize * 0.22f);
            halo.setColor(labelHalo);
            String text = name.toString();
            float baseline = py + textSize * 0.36f;
            canvas.drawText(text, px, baseline, halo);
            canvas.drawText(text, px, baseline, label);
            drawn += 1;
        }
    }

    private static int rankOf(Object value) {
        if (value instanceof Number) return ((Number) value).intValue();
        try {
            return Integer.parseInt(String.valueOf(value));
        } catch (Exception error) {
            return 99;
        }
    }

    private static float roadWidth(String kind) {
        if ("motorway".equals(kind)) return 7f;
        if ("trunk".equals(kind)) return 6.5f;
        if ("primary".equals(kind)) return 5.5f;
        if ("secondary".equals(kind)) return 4.5f;
        if ("tertiary".equals(kind)) return 3.6f;
        if ("minor".equals(kind)) return 2.8f;
        if ("service".equals(kind)) return 1.7f;
        if ("path".equals(kind)) return 1.2f;
        if ("rail".equals(kind)) return 1.2f;
        return 1.5f;
    }

    /** Fast roads worth a casing once the whole city is in frame. */
    private static boolean isArterial(String kind) {
        return "motorway".equals(kind) || "trunk".equals(kind) || "primary".equals(kind)
                || "secondary".equals(kind);
    }

    /** Lanes that only add texture at street level. */
    private static boolean isLane(String kind) {
        return "minor".equals(kind) || "service".equals(kind) || "path".equals(kind);
    }

    /**
     * Overview opacity per class: the poster should read as a route over a city,
     * not as a wiring diagram, so only the through-routes keep full strength.
     */
    private static float sparseRoadAlpha(String kind) {
        if ("motorway".equals(kind) || "trunk".equals(kind)) return 0.9f;
        if ("primary".equals(kind)) return 0.62f;
        return 0.4f;
    }

    private static int alpha(int color, float value) {
        int a = Math.max(0, Math.min(255, Math.round(255 * value)));
        return (color & 0x00FFFFFF) | (a << 24);
    }

    private int roadColor(String kind) {
        if ("rail".equals(kind)) return transit;
        if ("motorway".equals(kind) || "trunk".equals(kind)) return roadMajor;
        if ("primary".equals(kind)) return roadPrimary;
        if ("secondary".equals(kind) || "tertiary".equals(kind)) return road;
        if ("minor".equals(kind) || "service".equals(kind) || "path".equals(kind)) return roadMinor;
        return road;
    }

    /** A numbered national road plus where it sits on the current frame. */
    static final class Shield {
        final String ref;
        final float x;
        final float y;
        final int priority;

        Shield(String ref, float x, float y, int priority) {
            this.ref = ref;
            this.x = x;
            this.y = y;
            this.priority = priority;
        }
    }

    /**
     * Collects the G-road shields visible on the current frame. Only the
     * overview shots ask for these, where motorways are the main thing that
     * makes a 200 km ride read as a journey rather than a scribble.
     */
    List<Shield> shields(float camX, float camY, float scale, int viewW, int viewH) {
        buildShieldAnchors();
        float worldOriginX = viewW / 2f;
        float worldOriginY = viewH / 2f;
        List<Shield> found = new ArrayList<>(shieldAnchors.size());
        for (Anchor anchor : shieldAnchors) {
            float sx = worldOriginX + (float) (anchor.wx - camX) * scale;
            float sy = worldOriginY + (float) (anchor.wy - camY) * scale;
            if (sx < 60 || sx > viewW - 60 || sy < 120 || sy > viewH - 420) continue;
            found.add(new Shield(anchor.ref, sx, sy, anchor.priority));
        }
        return found;
    }

    /** A G-road anchor in world pixels; the camera-independent part of a shield. */
    private static final class Anchor {
        final String ref;
        final double wx;
        final double wy;
        final int priority;

        Anchor(String ref, double wx, double wy, int priority) {
            this.ref = ref;
            this.wx = wx;
            this.wy = wy;
            this.priority = priority;
        }
    }

    private final List<Anchor> shieldAnchors = new ArrayList<>();
    private int shieldAnchorTileCount = -1;

    /**
     * Scans every tile once and keeps only the camera-independent anchor. The
     * raw scan copies the tile key set, splits keys and walks all
     * transportation_name features — hundreds of tiles per overview map — so it
     * must not run per frame. Rebuilt only when the tile set grows (playback
     * streams tiles in; export prefetches everything before the first frame).
     */
    private void buildShieldAnchors() {
        int tileCount = raw.size();
        if (shieldAnchorTileCount == tileCount) return;
        shieldAnchorTileCount = tileCount;
        shieldAnchors.clear();
        double worldScale = Math.pow(2, NativeVectorMap.FOLLOW_ZOOM - zoom);
        Set<String> seen = new HashSet<>();
        for (String key : new HashSet<String>(raw.keySet())) {
            String[] parts = key.split("/");
            if (parts.length != 3) continue;
            int tx;
            int ty;
            try {
                tx = Integer.parseInt(parts[1]);
                ty = Integer.parseInt(parts[2]);
            } catch (Exception error) {
                continue;
            }
            ParsedTile tile = tile(tx, ty);
            if (tile == null) continue;
            for (Mvt.Layer layer : tile.layers) {
                if (!"transportation_name".equals(layer.name)) continue;
                for (Mvt.Feature feature : layer.features) {
                    Object refValue = feature.props.get("ref");
                    if (refValue == null) continue;
                    String ref = String.valueOf(refValue).split(";")[0].trim();
                    if (!isNationalRef(ref) || seen.contains(ref)) continue;
                    List<int[]> best = null;
                    for (List<int[]> line : feature.lines) {
                        if (best == null || line.size() > best.size()) best = line;
                    }
                    if (best == null || best.size() < 2) continue;
                    int[] mid = best.get(best.size() / 2);
                    double wx = (tx * TILE + mid[0] * (double) TILE / tile.extent) * worldScale;
                    double wy = (ty * TILE + mid[1] * (double) TILE / tile.extent) * worldScale;
                    seen.add(ref);
                    String kind = String.valueOf(feature.props.get("class"));
                    int priority = "motorway".equals(kind) ? 0 : "trunk".equals(kind) ? 1
                            : "primary".equals(kind) ? 2 : 3;
                    shieldAnchors.add(new Anchor(ref, wx, wy, priority));
                }
            }
        }
        java.util.Collections.sort(shieldAnchors, new java.util.Comparator<Anchor>() {
            @Override
            public int compare(Anchor a, Anchor b) {
                return a.priority - b.priority;
            }
        });
    }

    private static boolean isNationalRef(String ref) {
        if (ref.length() < 2 || ref.charAt(0) != 'G') return false;
        if (ref.length() > 4) return false;
        for (int i = 1; i < ref.length(); i += 1) {
            if (ref.charAt(i) < '0' || ref.charAt(i) > '9') return false;
        }
        return true;
    }

    private void paintPolygons(Canvas canvas, Mvt.Layer layer, int color, float scale, int alpha, Tools t) {
        t.fill.setColor(color);
        t.fill.setAlpha(alpha);
        for (Mvt.Feature feature : layer.features) {
            for (List<int[]> ring : feature.rings) {
                if (ring.size() < 3) continue;
                t.path.reset();
                for (int i = 0; i < ring.size(); i += 1) {
                    int[] point = ring.get(i);
                    float px = point[0] * scale;
                    float py = point[1] * scale;
                    if (i == 0) t.path.moveTo(px, py);
                    else t.path.lineTo(px, py);
                }
                t.path.close();
                canvas.drawPath(t.path, t.fill);
            }
        }
    }

    private void paintLine(Canvas canvas, List<int[]> line, float scale, int color, float width, Tools t) {
        if (line.size() < 2) return;
        t.path.reset();
        for (int i = 0; i < line.size(); i += 1) {
            int[] point = line.get(i);
            float px = point[0] * scale;
            float py = point[1] * scale;
            if (i == 0) t.path.moveTo(px, py);
            else t.path.lineTo(px, py);
        }
        t.stroke.setColor(color);
        t.stroke.setStrokeWidth(width);
        canvas.drawPath(t.path, t.stroke);
    }

    int tileX(double lon) {
        return (int) Math.floor((lon + 180.0) / 360.0 * (1 << zoom));
    }

    int tileY(double lat) {
        double rad = Math.toRadians(lat);
        return (int) Math.floor((1.0 - Math.log(Math.tan(Math.PI / 4.0 + rad / 2.0)) / Math.PI) / 2.0 * (1 << zoom));
    }

    double worldX(double lon) {
        return (lon + 180.0) / 360.0 * TILE * (1 << zoom);
    }

    double worldY(double lat) {
        return (1.0 - Math.log(Math.tan(Math.PI / 4.0 + Math.toRadians(lat) / 2.0)) / Math.PI) / 2.0 * TILE * (1 << zoom);
    }

    private static byte[] readBytes(InputStream input) throws Exception {
        java.io.PushbackInputStream probe = new java.io.PushbackInputStream(input, 2);
        int b1 = probe.read();
        int b2 = probe.read();
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

    static final class TileBitmap {
        Bitmap bitmap;
        int texture;
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
