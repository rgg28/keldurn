package com.keldurn.browser;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.WindowManager;
import androidx.browser.customtabs.CustomTabsIntent;

public class MainActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // Mantener pantalla completa nativa
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN,
            WindowManager.LayoutParams.FLAG_FULLSCREEN
        );
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Crear el configurador de pestañas de Chrome
        CustomTabsIntent.Builder builder = new CustomTabsIntent.Builder();
        builder.setUrlBarHidingEnabled(true);
        builder.setShowTitle(false);

        CustomTabsIntent customTabsIntent = builder.build();
        
        // --- TRUCO GRÁFICO: FORZAR ACELERACIÓN DE HARDWARE EN EL PROCESO ---
        customTabsIntent.intent.putExtra(Intent.EXTRA_REFERRER, Uri.parse("android-app://" + getPackageName()));
        customTabsIntent.intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        
        // Abrir Keldurn con la GPU del celular activa
        customTabsIntent.launchUrl(this, Uri.parse("https://keldurn.com"));
        
        finish();
    }
}
