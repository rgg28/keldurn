package com.keldurn.browser;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // Mantener la pantalla siempre encendida mientras juegas
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        
        // Ocultar barras de sistema para pantalla completa (Modo Inmersivo)
        hideSystemUI();

        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.keldurn_webview);
        WebSettings webSettings = webView.getSettings();

        // --- OPTIMIZACIONES CRÍTICAS PARA JUEGOS WEBGL/WEB ---
        webSettings.setJavaScriptEnabled(true); // Requerido por Keldurn
        webSettings.setDomStorageEnabled(true);  // Permite guardar texturas, mapas y caché del WoW Classic
        webSettings.setAllowFileAccess(true);
        webSettings.setCacheMode(WebSettings.LOAD_DEFAULT);
        
        // Forzar aceleración de hardware por GPU para Three.js/WebGL2
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);

        // Evitar que el navegador abra enlaces fuera de la aplicación
        webView.setWebViewClient(new WebViewClient());

        // Cargar el portal oficial de Keldurn
        webView.loadUrl("https://keldurn.com");
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            hideSystemUI(); // Vuelve a ocultar las barras si el usuario desliza la pantalla
        }
    }

    private void hideSystemUI() {
        View decorView = getWindow().getDecorView();
        decorView.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN);
    }

    @Override
    public void onBackPressed() {
        // Si estás en medio del juego, evita salir accidentalmente al pulsar "atrás"
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
