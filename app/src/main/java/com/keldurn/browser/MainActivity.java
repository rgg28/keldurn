package com.keldurn.browser;

import android.app.Activity;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // Pantalla completa directa por hardware nativo
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN,
            WindowManager.LayoutParams.FLAG_FULLSCREEN
        );
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Forzar inicialización segura del WebView
        try {
            webView = new WebView(this);
            setContentView(webView);
        } catch (Exception e) {
            // Si el motor por defecto falla, carga el contenedor alternativo
            setContentView(R.layout.activity_main);
            webView = findViewById(R.id.keldurn_webview);
        }

        WebSettings webSettings = webView.getSettings();

        // Configuración de compatibilidad total para videojuegos HTML5/WebGL
        webSettings.setJavaScriptEnabled(true);
        webSettings.setDomStorageEnabled(true);
        webSettings.setAllowFileAccess(true);
        webSettings.setDatabaseEnabled(true);
        
        // Evita cierres si el motor Webview del teléfono no soporta la caché por defecto
        webSettings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setWebViewClient(new WebViewClient());
        
        // Carga directa del portal de WoW
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
