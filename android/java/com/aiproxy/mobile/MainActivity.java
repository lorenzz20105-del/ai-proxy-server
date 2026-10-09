package com.aiproxy.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/**
 * The whole app: start the proxy in-process, then show its dashboard.
 *
 * <p>Open the icon and the server is already listening on loopback with the bundled
 * console at {@code /app/} — nothing to configure, no Termux, no companion process.
 * The master key is injected into the page so the console's key gate clears itself
 * on first launch.
 */
public class MainActivity extends Activity {

    private Server server;
    private WebView web;
    private LinearLayout boot;
    private TextView bootStatus;
    private final Handler handler = new Handler(Looper.getMainLooper());

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(build());

        server = new Server(this);
        try {
            server.start();
        } catch (Exception exc) {
            bootStatus.setText("server failed to start: " + exc.getMessage());
            return;
        }

        // Seed the bundled console's key store, then load the dashboard.
        final String origin = "http://127.0.0.1:" + server.port();
        web.evaluateJavascript(
                "try{localStorage.setItem('aiproxy.api_key'," + jsString(server.masterKey())
                        + ");}catch(e){}", null);
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                web.loadUrl(origin + "/app/");
            }
        }, 120);
    }

    private View build() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0B0F14"));

        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setTextZoom(100);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url != null && url.startsWith("http://127.0.0.1:")) {
                    return false;
                }
                if (url != null && (url.startsWith("http://") || url.startsWith("https://"))) {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                boot.setVisibility(View.GONE);
            }
        });
        web.setBackgroundColor(Color.parseColor("#0B0F14"));
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // boot screen, shown until the dashboard paints
        boot = new LinearLayout(this);
        boot.setOrientation(LinearLayout.VERTICAL);
        boot.setGravity(Gravity.CENTER);
        boot.setBackgroundColor(Color.parseColor("#0B0F14"));
        boot.setPadding(48, 48, 48, 48);

        TextView title = new TextView(this);
        title.setText("AI Proxy");
        title.setTextColor(Color.parseColor("#E6EDF3"));
        title.setTextSize(24f);
        title.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        boot.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText("multi-account provider proxy");
        subtitle.setTextColor(Color.parseColor("#8B98A5"));
        subtitle.setTextSize(13f);
        subtitle.setGravity(Gravity.CENTER);
        subtitle.setPadding(0, 24, 0, 24);
        boot.addView(subtitle);

        boot.addView(new ProgressBar(this));

        bootStatus = new TextView(this);
        bootStatus.setText("starting the local proxy…");
        bootStatus.setTextColor(Color.parseColor("#8B98A5"));
        bootStatus.setTextSize(12f);
        bootStatus.setGravity(Gravity.CENTER);
        bootStatus.setPadding(0, 24, 0, 0);
        boot.addView(bootStatus);

        root.addView(boot, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return root;
    }

    /** JSON-escape a value for direct interpolation into a script literal. */
    private static String jsString(String value) {
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) {
            web.onPause();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.onResume();
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (server != null) {
            server.stop();
        }
        if (web != null) {
            web.destroy();
        }
    }
}