package com.keldurn.browser;

import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.view.WindowManager;
import androidx.browser.customtabs.CustomTabsIntent;

public class MainActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // Forzar pantalla completa nativa
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN,
            WindowManager.LayoutParams.FLAG_FULLSCREEN
        );
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Configurar el diseño de la pestaña personalizada de Chrome
        CustomTabsIntent.Builder builder = new CustomTabsIntent.Builder();
        
        // Ocultar la barra de URL al deslizar para dar máxima inmersión de juego
        builder.setUrlBarHidingEnabled(true);
        
        // Mostrar el título del sitio web (opcional, ayuda a la estabilidad)
        builder.setShowTitle(false);

        CustomTabsIntent customTabsIntent = builder.build();
        
        // Forzar a que abra Keldurn usando el motor hererado de Chrome con memoria compartida activa
        customTabsIntent.launchUrl(this, Uri.parse("https://keldurn.com"));
        
        // Cerrar la actividad base para que al salir del juego con el botón "Atrás" no quede una pantalla negra
        finish();
    }
}
