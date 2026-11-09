package com.fitmotion.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;

/**
 * 极简分享 Provider（没有 AndroidX，手写 FileProvider 的最小子集）。
 *
 * 只暴露 `getExternalFilesDir()/share/` 目录下的文件：
 * content://com.fitmotion.app.share/share/<name> → 应用私有外部目录里的同名文件。
 * 微信 / 抖音等通过 ACTION_SEND + FLAG_GRANT_READ_URI_PERMISSION 临时读这份文件，
 * 别的应用拿不到 App 私有数据的任何其他部分。
 */
public class ShareProvider extends ContentProvider {

    @Override
    public boolean onCreate() {
        File dir = shareDir();
        if (dir != null && !dir.exists()) dir.mkdirs();
        return true;
    }

    private File shareDir() {
        File external = getContext() == null ? null : getContext().getExternalFilesDir(null);
        return external == null ? null : new File(external, "share");
    }

    private File fileFor(Uri uri) throws FileNotFoundException {
        String name = uri.getLastPathSegment();
        if (name == null || name.contains("..") || name.contains("/")) {
            throw new FileNotFoundException("Invalid share path");
        }
        File dir = shareDir();
        File file = dir == null ? null : new File(dir, name);
        if (file == null || !file.exists()) throw new FileNotFoundException(name);
        return file;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        try {
            return ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.MODE_READ_ONLY);
        } catch (IOException error) {
            throw new FileNotFoundException(error.getMessage());
        }
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File file;
        try {
            file = fileFor(uri);
        } catch (FileNotFoundException error) {
            return null;
        }
        if (projection == null) {
            projection = new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        }
        MatrixCursor cursor = new MatrixCursor(projection, 1);
        Object[] row = new Object[projection.length];
        for (int i = 0; i < projection.length; i += 1) {
            if (OpenableColumns.DISPLAY_NAME.equals(projection[i])) row[i] = file.getName();
            else if (OpenableColumns.SIZE.equals(projection[i])) row[i] = file.length();
            else row[i] = null;
        }
        cursor.addRow(row);
        return cursor;
    }

    @Override
    public String getType(Uri uri) {
        String name = uri.getLastPathSegment() == null ? "" : uri.getLastPathSegment().toLowerCase();
        if (name.endsWith(".mp4")) return "video/mp4";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".gpx")) return "application/gpx+xml";
        if (name.endsWith(".tcx")) return "application/vnd.garmin.tcx+xml";
        if (name.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
