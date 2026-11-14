package app.pocketpdf.scanner;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(IncomingFilesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
