package com.tuusuario.keldurnuniversal;

import android.app.Activity;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {

    private WebView keldurnView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Forzar el comportamiento nativo de pantalla completa y mantenerla encendida
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN,
            WindowManager.LayoutParams.FLAG_FULLSCREEN
        );
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Construir e integrar el contenedor Web del juego
        keldurnView = new WebView(this);
        setContentView(keldurnView);

        // FORZAR ACELERACIÓN POR HARDWARE DIRECTA (Arreglo crítico para Snapdragon 695)
        keldurnView.setLayerType(View.LAYER_TYPE_HARDWARE, null);

        // Configurar los parámetros del motor web para WebGL / WebGPU
        WebSettings settings = keldurnView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);    // Esencial para almacenar la caché del juego
        settings.setDatabaseEnabled(true);      // Necesario para los índices de mallas 3D
        settings.setLoadsImagesAutomatically(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        // Prevenir que el juego intente abrirse en el navegador externo del celular
        keldurnView.setWebViewClient(new WebViewClient());

        // Cargar el servidor oficial de Keldurn con los parámetros de hardware forzados
        keldurnView.loadUrl("https://keldurn.com");
    }

    @Override
    public void onBackPressed() {
        // Permitir la navegación interna antes de cerrar la aplicación por error
        if (keldurnView != null && keldurnView.canGoBack()) {
            keldurnView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
