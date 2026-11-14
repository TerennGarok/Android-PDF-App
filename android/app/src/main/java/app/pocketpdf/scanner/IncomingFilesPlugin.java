package app.pocketpdf.scanner;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Receives documents that other apps hand to PocketPDF ("Open with", "Share"),
 * copies them into the app cache and tells the web layer about them.
 */
@CapacitorPlugin(name = "IncomingFiles")
public class IncomingFilesPlugin extends Plugin {

    @Override
    public void load() {
        handleIntent(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handleIntent(intent);
    }

    @SuppressWarnings("deprecation")
    private void handleIntent(Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            uris.add(intent.getData());
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }
        if (uris.isEmpty()) return;
        // Mark as handled so an activity re-creation doesn't import the same files again.
        intent.setAction(null);

        File dir = new File(getContext().getCacheDir(), "incoming");
        if (!dir.exists()) dir.mkdirs();
        ContentResolver cr = getContext().getContentResolver();
        JSArray files = new JSArray();
        int i = 0;
        for (Uri uri : uris) {
            try {
                String name = displayName(cr, uri);
                if (name == null || name.isEmpty()) name = "document-" + System.currentTimeMillis();
                File out = new File(dir, (i++) + "-" + name.replaceAll("[\\\\/:*?\"<>|]", "_"));
                try (InputStream in = cr.openInputStream(uri); OutputStream os = new FileOutputStream(out)) {
                    if (in == null) continue;
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
                }
                JSObject f = new JSObject();
                f.put("path", out.getAbsolutePath());
                f.put("name", name);
                f.put("mimeType", cr.getType(uri));
                files.put(f);
            } catch (Exception e) {
                android.util.Log.w("IncomingFiles", "Could not read " + uri, e);
            }
        }
        if (files.length() == 0) return;
        JSObject ret = new JSObject();
        ret.put("files", files);
        // retainUntilConsumed: delivered even if the web app hasn't registered its listener yet
        notifyListeners("files", ret, true);
    }

    private String displayName(ContentResolver cr, Uri uri) {
        if ("file".equals(uri.getScheme())) return new File(uri.getPath()).getName();
        try (Cursor c = cr.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {}
        return uri.getLastPathSegment();
    }
}
