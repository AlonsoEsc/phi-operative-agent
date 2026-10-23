import { State, type LlmRequest, type LlmResponse } from '@google/adk';
import { GeminiResiliente, interpretarErrorModelo } from './modelo_resiliente.js';
import {
  consultar_politica_reabastecimiento,
  consultar_stock_sku,
  enviar_alerta_distribucion,
  ESTADO_ALERTAS,
  type AlertaDistribucion,
} from './agent.js';

console.log('===============================================================');
console.log('🧪 SUITE DE PRUEBAS AUTOMATIZADAS - PHI OPERATIVE AGENT');
console.log('===============================================================\n');

let passedTests = 0;
let totalTests = 0;

function assert(condition: boolean, testName: string, details?: unknown) {
  totalTests++;
  if (condition) {
    console.log(`✅ [PASS] ${testName}`);
    passedTests++;
  } else {
    console.error(`❌ [FAIL] ${testName}`);
    if (details) {
      console.error('Detalles:', details);
    }
  }
}

// Estado de sesión de ADK simulado para las herramientas que lo usan
const sesion = new State();
const historial = () => sesion.get<AlertaDistribucion[]>(ESTADO_ALERTAS, []) ?? [];

// -------------------------------------------------------------
// CASO 1: SKU-1024 en Región Norte (Caso Crítico con Riesgo)
// -------------------------------------------------------------
console.log('📌 Test 1: Flujo de Desabastecimiento para SKU-1024 (Aceite Industrial X)');
const pol1 = consultar_politica_reabastecimiento('region_norte', 'SKU-1024');
assert(
  pol1.encontrado === true && pol1.minimo_requerido === 15,
  'Paso 1 (RAG): Consulta de política retorna mínimo_requerido = 15',
  pol1
);

const stock1 = consultar_stock_sku('norte', 'SKU-1024');
assert(
  stock1.encontrado === true && stock1.stock === 4 && stock1.almacen_id === 'ALM-NORTE-01',
  'Paso 2 (Stock Tool): Consulta de inventario retorna 4 unidades en ALM-NORTE-01',
  stock1
);
assert(
  !('minimo_requerido' in stock1),
  'Paso 2 (Stock Tool): El inventario no expone mínimo requerido (fuente única = política)',
  stock1
);

const alerta1 = enviar_alerta_distribucion(
  'ALM-NORTE-01',
  'Riesgo crítico de desabastecimiento: 4 unidades vs mínimo de 15 unidades para SKU-1024.',
  sesion
);
assert(
  alerta1.status === 'success' && 'folio' in alerta1 && alerta1.folio?.startsWith('#ALT-') === true,
  'Paso 3 (Alerta Tool): La regla se valida en código y se despacha alerta con folio',
  alerta1
);
assert(
  historial().length === 1 && 'folio' in alerta1 && historial()[0].folio === alerta1.folio,
  'Paso 4 (Estado / Memoria): La alerta queda registrada en el estado de la sesión',
  historial()
);

const alertaDuplicada = enviar_alerta_distribucion(
  'ALM-NORTE-01',
  'Reintento de alerta para SKU-1024 con 4 unidades.',
  sesion
);
assert(
  alertaDuplicada.status === 'duplicada' &&
    'folio' in alertaDuplicada &&
    'folio' in alerta1 &&
    alertaDuplicada.folio === alerta1.folio &&
    historial().length === 1,
  'Paso 5 (Estado / Memoria): Una segunda alerta para el mismo SKU devuelve el folio existente',
  alertaDuplicada
);

console.log('');

// -------------------------------------------------------------
// CASO 2: SKU-2048 en Región Norte (Caso Saludable sin Riesgo)
// -------------------------------------------------------------
console.log('📌 Test 2: Flujo Saludable para SKU-2048 (Filtro Hidráulico Y)');
const pol2 = consultar_politica_reabastecimiento('norte', 'SKU-2048');
assert(
  pol2.encontrado === true && pol2.minimo_requerido === 10,
  'Paso 1 (RAG): Consulta de política retorna mínimo_requerido = 10',
  pol2
);

const stock2 = consultar_stock_sku('region_norte', 'SKU-2048');
assert(
  stock2.encontrado === true && stock2.stock === 50,
  'Paso 2 (Stock Tool): Consulta de inventario retorna 50 unidades',
  stock2
);

const alerta2 = enviar_alerta_distribucion(
  'ALM-NORTE-01',
  'Solicitud de reabastecimiento para SKU-2048.',
  sesion
);
assert(
  alerta2.status === 'rechazada' && historial().length === 1,
  'Paso 3 (Regla de Negocio): Si el LLM intenta alertar con 50 >= 10, el código rechaza la orden',
  alerta2
);

console.log('');

// -------------------------------------------------------------
// CASO 3: Normalización de región
// -------------------------------------------------------------
console.log('📌 Test 3: Normalización de región consistente entre herramientas');
for (const region of ['Norte', 'NORTE', 'Región Norte', 'region norte', 'region_norte']) {
  const pol = consultar_politica_reabastecimiento(region, 'SKU-1024');
  const stock = consultar_stock_sku(region, 'SKU-1024');
  assert(
    pol.encontrado === true && stock.encontrado === true,
    `Región "${region}" resuelve tanto en política como en inventario`,
    { pol, stock }
  );
}

console.log('');

// -------------------------------------------------------------
// CASO 4: Manejo de Errores y Graceful Fallbacks
// -------------------------------------------------------------
console.log('📌 Test 4: Casos de Borde y Graceful Fallbacks (SKUs o Regiones Inexistentes)');
const falloSKU = consultar_stock_sku('norte', 'SKU-9999');
assert(
  falloSKU.encontrado === false,
  'Fallback 1: SKU inexistente es manejado limpiamente sin romper ejecución',
  falloSKU
);

const falloRegion = consultar_politica_reabastecimiento('region_sur', 'SKU-1024');
assert(
  falloRegion.encontrado === false,
  'Fallback 2: Región sin política documentada responde limpiamente',
  falloRegion
);

const alertaSinSku = enviar_alerta_distribucion('ALM-NORTE-01', 'Stock bajo, reabastecer.', sesion);
assert(
  alertaSinSku.status === 'rechazada',
  'Fallback 3: Una alerta sin SKU identificable es rechazada',
  alertaSinSku
);

const alertaAlmacenErroneo = enviar_alerta_distribucion('ALM-SUR-09', 'Riesgo en SKU-1024.', sesion);
assert(
  alertaAlmacenErroneo.status === 'rechazada',
  'Fallback 4: Una alerta a un almacén que no tiene el SKU es rechazada',
  alertaAlmacenErroneo
);

console.log('');

// -------------------------------------------------------------
// CASO 5: Graceful Fallback ante errores de cuota (429) de Gemini
// -------------------------------------------------------------
console.log('📌 Test 5: Manejo de errores de cuota / disponibilidad de Gemini');

const error429 = JSON.stringify({
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message:
      'Quota exceeded for metric: generate_content_free_tier_requests, limit: 5. Please retry in 34.1s.',
  },
});
const error429Diario = JSON.stringify({
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'Quota exceeded for metric: GenerateRequestsPerDayPerProjectPerModel-FreeTier.',
  },
});

const interpretado = interpretarErrorModelo(new Error(error429));
assert(
  interpretado.codigo === 429 && interpretado.reintentable && interpretado.esperaSugeridaSeg === 35,
  'Interpreta 429 por minuto como reintentable con espera sugerida de 35s',
  interpretado
);
assert(
  interpretarErrorModelo(new Error(error429Diario)).reintentable === false,
  'Interpreta 429 de cuota diaria como NO reintentable'
);

/** Modelo de prueba: falla con los errores indicados y luego responde, sin llamar a la API. */
class GeminiSimulado extends GeminiResiliente {
  llamadas = 0;
  esperas: number[] = [];
  constructor(private readonly errores: string[], maxEsperaSeg = 20) {
    super({ model: 'gemini-test', apiKey: 'test' }, { maxReintentos: 2, maxEsperaSeg });
  }
  protected async *llamarModelo(): AsyncGenerator<LlmResponse, void> {
    const error = this.errores[this.llamadas++];
    if (error) throw new Error(error);
    yield { content: { role: 'model', parts: [{ text: 'respuesta del modelo' }] } };
  }
  protected async esperar(segundos: number) {
    this.esperas.push(segundos);
  }
}

async function recolectar(modelo: GeminiResiliente, request: LlmRequest) {
  const respuestas: LlmResponse[] = [];
  for await (const r of modelo.generateContentAsync(request)) respuestas.push(r);
  return respuestas.map((r) => r.content?.parts?.map((p) => p.text).join('') ?? '').join('');
}

const requestBase = {
  contents: [{ role: 'user', parts: [{ text: '¿Hay riesgo de SKU-1024 en el Norte?' }] }],
} as unknown as LlmRequest;

const errorCorto = error429.replace('34.1s', '3s');
const modeloReintento = new GeminiSimulado([errorCorto]);
const textoReintento = await recolectar(modeloReintento, requestBase);
assert(
  textoReintento === 'respuesta del modelo' &&
    modeloReintento.llamadas === 2 &&
    modeloReintento.esperas[0] === 3,
  'Reintenta un 429 con espera corta y entrega la respuesta del modelo',
  { textoReintento, modeloReintento }
);

const modeloEsperaLarga = new GeminiSimulado([error429]);
const textoEsperaLarga = await recolectar(modeloEsperaLarga, requestBase);
assert(
  modeloEsperaLarga.llamadas === 1 &&
    textoEsperaLarga.includes('límite de solicitudes') &&
    textoEsperaLarga.includes('35 segundos'),
  'Con espera sugerida larga no bloquea la demo: responde de inmediato indicando cuánto esperar',
  textoEsperaLarga
);

const requestConHerramientas = {
  contents: [
    ...requestBase.contents,
    { role: 'model', parts: [{ functionCall: { name: 'consultar_politica_reabastecimiento', args: {} } }] },
    {
      role: 'user',
      parts: [{ functionResponse: { name: 'consultar_politica_reabastecimiento', response: pol1 } }],
    },
    { role: 'model', parts: [{ functionCall: { name: 'consultar_stock_sku', args: {} } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'consultar_stock_sku', response: stock1 } }] },
    { role: 'model', parts: [{ functionCall: { name: 'enviar_alerta_distribucion', args: {} } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'enviar_alerta_distribucion', response: alerta1 } }] },
  ],
} as unknown as LlmRequest;

const textoConHerramientas = await recolectar(new GeminiSimulado([error429Diario]), requestConHerramientas);
assert(
  'folio' in alerta1 &&
    textoConHerramientas.includes('cuota diaria') &&
    textoConHerramientas.includes('15 unidades') &&
    textoConHerramientas.includes('4 unidades') &&
    textoConHerramientas.includes(String(alerta1.folio)),
  'Si Gemini falla después de emitir la alerta, el fallback conserva política, stock y folio',
  textoConHerramientas
);

console.log('\n===============================================================');
console.log(`🏁 RESULTADOS: ${passedTests}/${totalTests} pruebas pasadas exitosamente.`);
console.log('===============================================================\n');

if (passedTests !== totalTests) {
  process.exit(1);
}
