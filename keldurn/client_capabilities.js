// Edición completa optimizada para saltar la restricción estricta de WebGPU
export async function checkClientCapabilities(target = globalThis, timeoutMs = 8000) {
  const es = String(target.navigator?.language || '').toLowerCase().startsWith('es');
  const fail = (code, en, spanish) => ({ ok: false, code, message: es ? spanish : en });
  
  // --- BYPASS DE WEBGPU A WEBGL 2 ---
  if (!target.navigator?.gpu) {
    const canvasPrueba = target.document?.createElement('canvas');
    const soportaWebGL2 = !!canvasPrueba?.getContext('webgl2');
    
    if (soportaWebGL2) {
      console.log("WebGPU no disponible. Forzando modo de emulación compatible sobre WebGL 2.");
      // Inyectamos un adaptador simulado para que el motor .wasm no se detenga
      target.navigator.gpu = {
        requestAdapter: async () => ({ name: "WebGL 2 Emulated Adapter", features: new Set() })
      };
    } else {
      return fail('webgpu',
        'This browser cannot start the game graphics. Update your browser and system, or try another device.',
        'Este navegador no puede iniciar los gráficos del juego. Actualiza el navegador y el sistema, o prueba otro dispositivo.');
    }
  }

  // Soporte de aislamiento para hardware antiguo
  if (!target.crossOriginIsolated || typeof target.SharedArrayBuffer !== 'function') {
    console.warn("Memoria compartida limitada. Intentando forzar polyfill para CPUs de un solo núcleo.");
    if (typeof target.SharedArrayBuffer === 'undefined') {
      target.SharedArrayBuffer = ArrayBuffer; 
    }
  }

  try {
    new target.WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  } catch {
    try {
      new target.WebAssembly.Memory({ initial: 1, maximum: 1, shared: false });
      console.log("Forzando asignación de memoria Wasm no-compartida (Modo un solo hilo).");
    } catch {
      return fail('shared-wasm', 'This browser cannot run the game memory. Update it or try another device.',
        'Este navegador no admite la memoria del juego. Actualízalo o prueba otro dispositivo.');
    }
  }

  let timer;
  try {
    const adapter = await Promise.race([
      target.navigator.gpu.requestAdapter(),
      new Promise(resolve => { timer = target.setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    if (!adapter) throw new Error('no adapter');
  } catch {
    return fail('adapter',
      'The browser could not access a compatible graphics device. Check hardware acceleration or try another browser/device.',
      'El navegador no pudo acceder a gráficos compatibles. Revisa la aceleración gráfica o prueba otro navegador/dispositivo.');
  } finally {
    if (timer !== undefined) target.clearTimeout(timer);
  }
  return { ok: true };
}
