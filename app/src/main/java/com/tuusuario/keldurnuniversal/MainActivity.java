package com.tuusuario.keldurnuniversal;

import android.os.Bundle;
import androidx.appcompat.app.AppCompatActivity;
import org.mozilla.geckoview.GeckoRuntime;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoSessionSettings;
import org.mozilla.geckoview.GeckoView;

public class MainActivity extends AppCompatActivity {

    private GeckoView geckoView;
    private GeckoSession geckoSession;
    private GeckoRuntime geckoRuntime;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 1. Crear el contenedor de Mozilla directamente desde el código
        geckoView = new GeckoView(this);

        // 2. Configurar la sesión simulando Google Chrome de PC de escritorio
        GeckoSessionSettings settings = new GeckoSessionSettings.Builder()
                .userAgentMode(GeckoSessionSettings.USER_AGENT_MODE_DESKTOP)
                .userAgentOverride("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
                .build();

        geckoSession = new GeckoSession(settings);

        // 3. Encender el motor gráfico nativo de Firefox
        geckoRuntime = GeckoRuntime.create(this);
        geckoSession.open(geckoRuntime);

        // 4. Asignar la sesión al contenedor
        geckoView.setSession(geckoSession);

        // 5. OBLIGATORIO: Establecer GeckoView como la vista principal (reemplaza a setContentView(R.layout...))
        setContentView(geckoView);

        // 6. Cargar el servidor de Keldurn
        geckoSession.loadUri("https://play.keldurn.com");
    }

    @Override
    protected void onDestroy() {
        if (geckoSession != null) {
            geckoSession.close();
        }
        super.onDestroy();
    }
}
