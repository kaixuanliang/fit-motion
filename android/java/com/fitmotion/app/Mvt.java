package com.fitmotion.app;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Small Mapbox Vector Tile reader for the layers used by the native map. */
final class Mvt {
    private Mvt() { }

    static final class Layer {
        String name = "";
        int extent = 4096;
        final List<Feature> features = new ArrayList<>();
    }

    static final class Feature {
        int type;
        final Map<String, Object> props = new HashMap<>();
        final List<List<int[]>> lines = new ArrayList<>();
        final List<List<int[]>> rings = new ArrayList<>();
    }

    static NativeVectorMap.ParsedTile parse(byte[] data, int z, int x, int y) {
        List<Layer> layers = new ArrayList<>();
        Reader reader = new Reader(data);
        while (!reader.eof()) {
            int tag = reader.varint();
            int field = tag >>> 3;
            int wire = tag & 7;
            if ((field == 1 || field == 3) && wire == 2) {
                byte[] layerData = reader.bytes();
                Layer layer = parseLayer(layerData);
                if (layer != null) layers.add(layer);
            } else {
                reader.skip(wire);
            }
        }
        Intersection extent = new Intersection(4096);
        for (Layer layer : layers) extent.value = layer.extent;
        return new NativeVectorMap.ParsedTile(z, x, y, extent.value, layers);
    }

    private static Layer parseLayer(byte[] data) {
        Layer layer = new Layer();
        List<byte[]> rawFeatures = new ArrayList<>();
        List<String> keys = new ArrayList<>();
        List<Object> values = new ArrayList<>();
        Reader reader = new Reader(data);
        while (!reader.eof()) {
            int tag = reader.varint();
            int field = tag >>> 3;
            int wire = tag & 7;
            if (field == 1 && wire == 2) layer.name = reader.string();
            else if (field == 2 && wire == 2) rawFeatures.add(reader.bytes());
            else if (field == 3 && wire == 2) keys.add(reader.string());
            else if (field == 4 && wire == 2) values.add(parseValue(reader.bytes()));
            else if (field == 5 && wire == 0) layer.extent = reader.varint();
            else reader.skip(wire);
        }
        for (byte[] raw : rawFeatures) {
            Feature feature = parseFeature(raw);
            if (feature == null) continue;
            // Tags are stored on a separate pass because keys/values can follow
            // features in the protobuf. parseFeature keeps the packed tag data
            // in props under a temporary key.
            @SuppressWarnings("unchecked")
            int[] tags = (int[]) feature.props.remove("__tags");
            if (tags != null) {
                for (int i = 0; i + 1 < tags.length; i += 2) {
                    if (tags[i] < keys.size() && tags[i + 1] < values.size()) {
                        feature.props.put(keys.get(tags[i]), values.get(tags[i + 1]));
                    }
                }
            }
            layer.features.add(feature);
        }
        return layer;
    }

    private static Object parseValue(byte[] data) {
        Reader reader = new Reader(data);
        while (!reader.eof()) {
            int tag = reader.varint();
            int field = tag >>> 3;
            int wire = tag & 7;
            if (field == 1 && wire == 2) return reader.string();
            if (field == 4 && wire == 0) return reader.varint();
            if (field == 5 && wire == 0) return reader.varint();
            if (field == 6 && wire == 0) return reader.svarint();
            if (field == 7 && wire == 0) return reader.varint() != 0;
            if (field == 2 && wire == 5) return reader.float32();
            if (field == 3 && wire == 1) return reader.float64();
            reader.skip(wire);
        }
        return null;
    }

    private static Feature parseFeature(byte[] data) {
        Feature feature = new Feature();
        int[] tags = null;
        int[] geometry = null;
        Reader reader = new Reader(data);
        while (!reader.eof()) {
            int tag = reader.varint();
            int field = tag >>> 3;
            int wire = tag & 7;
            if (field == 2 && wire == 2) tags = reader.packedInts();
            else if (field == 3 && wire == 0) feature.type = reader.varint();
            else if (field == 4 && wire == 2) geometry = reader.packedInts();
            else reader.skip(wire);
        }
        if (tags != null) feature.props.put("__tags", tags);
        if (geometry == null) return null;
        decodeGeometry(feature, geometry);
        return feature;
    }

    private static void decodeGeometry(Feature feature, int[] geometry) {
        int x = 0;
        int y = 0;
        List<int[]> line = new ArrayList<>();
        int index = 0;
        while (index < geometry.length) {
            int command = geometry[index++];
            int id = command & 7;
            int count = command >>> 3;
            if (id == 7) {
                if (!line.isEmpty()) {
                    if (feature.type == 3) feature.rings.add(line);
                    else feature.lines.add(line);
                    line = new ArrayList<>();
                }
                continue;
            }
            for (int i = 0; i < count && index + 1 < geometry.length; i += 1) {
                int dx = zigzag(geometry[index++]);
                int dy = zigzag(geometry[index++]);
                x += dx;
                y += dy;
                line.add(new int[]{x, y});
            }
            if (id == 2 && feature.type != 3 && !line.isEmpty()) {
                feature.lines.add(line);
                line = new ArrayList<>();
            }
        }
        if (!line.isEmpty()) {
            if (feature.type == 3) feature.rings.add(line);
            else feature.lines.add(line);
        }
    }

    private static int zigzag(int value) {
        return (value >>> 1) ^ -(value & 1);
    }

    private static final class Intersection {
        int value;
        Intersection(int value) { this.value = value; }
    }

    private static final class Reader {
        private final byte[] data;
        private int position;
        Reader(byte[] data) { this.data = data; }

        boolean eof() { return position >= data.length; }

        int varint() {
            int result = 0;
            int shift = 0;
            while (position < data.length && shift < 64) {
                int b = data[position++] & 0xff;
                result |= (b & 0x7f) << shift;
                if ((b & 0x80) == 0) return result;
                shift += 7;
            }
            return result;
        }

        int svarint() {
            int value = varint();
            return (value >>> 1) ^ -(value & 1);
        }

        float float32() {
            int bits = (data[position] & 0xff) | ((data[position + 1] & 0xff) << 8)
                    | ((data[position + 2] & 0xff) << 16) | ((data[position + 3] & 0xff) << 24);
            position += 4;
            return Float.intBitsToFloat(bits);
        }

        double float64() {
            long bits = 0;
            for (int i = 0; i < 8; i += 1) bits |= (long) (data[position + i] & 0xff) << (8 * i);
            position += 8;
            return Double.longBitsToDouble(bits);
        }

        String string() {
            int length = varint();
            String value = new String(data, position, length, StandardCharsets.UTF_8);
            position += length;
            return value;
        }

        byte[] bytes() {
            int length = varint();
            byte[] value = new byte[length];
            System.arraycopy(data, position, value, 0, length);
            position += length;
            return value;
        }

        int[] packedInts() {
            byte[] packed = bytes();
            Reader reader = new Reader(packed);
            List<Integer> values = new ArrayList<>();
            while (!reader.eof()) values.add(reader.varint());
            int[] result = new int[values.size()];
            for (int i = 0; i < values.size(); i += 1) result[i] = values.get(i);
            return result;
        }

        void skip(int wire) {
            if (wire == 0) varint();
            else if (wire == 1) position += 8;
            else if (wire == 2) { int length = varint(); position += length; }
            else if (wire == 5) position += 4;
            else position = data.length;
        }
    }
}
