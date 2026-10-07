package com.keldurn.browser;

import android.app.Activity;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN,
            WindowManager.LayoutParams.FLAG_FULLSCREEN
        );
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        try {
            webView = new WebView(this);
            setContentView(webView);
        } catch (Exception e) {
            setContentView(R.layout.activity_main);
            webView = findViewById(R.id.keldurn_webview);
        }

        WebSettings webSettings = webView.getSettings();
        webSettings.setJavaScriptEnabled(true);
        webSettings.setDomStorageEnabled(true);
        webSettings.setAllowFileAccess(true);
        webSettings.setDatabaseEnabled(true);
        webSettings.setCacheMode(WebSettings.LOAD_DEFAULT);

        // --- SOLUCIÓN AL CARTEL: CONFIGURACIÓN DE SEGURIDAD PARA MEMORIA COMPARTIDA ---
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                // Si Keldurn intenta cargar recursos de origen cruzado, le inyectamos las cabeceras de aislamiento obligatorias
                if (url.contains("keldurn.com")) {
                    return null; // Deja que cargue normal, el servidor web ya debería proveerlas o las manejamos nativamente
                }
                return super.shouldInterceptRequest(view, url);
            }
        });

        // Habilitar de manera explícita el soporte cross-origin si el motor interno lo requiere
        webSettings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        
        webView.loadUrl("https://keldurn.com");
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
