import { Gemini, type GeminiParams, type LlmRequest, type LlmResponse } from '@google/adk';
import type { Content } from '@google/genai';

/**
 * Error de Gemini interpretado: código HTTP, si es reintentable y cuánto sugiere esperar la API.
 */
export interface ErrorModelo {
  codigo: number | undefined;
  mensaje: string;
  reintentable: boolean;
  cuotaDiaria: boolean;
  esperaSugeridaSeg: number | undefined;
}

/**
 * Interpreta el error lanzado por el SDK de Gemini (el mensaje suele ser el JSON de la API).
 */
export function interpretarErrorModelo(error: unknown): ErrorModelo {
  const texto = error instanceof Error ? error.message : String(error);
  let codigo: number | undefined;
  let mensaje = texto;
  let estado = '';

  try {
    const json = JSON.parse(texto);
    codigo = Number(json?.error?.code) || undefined;
    mensaje = json?.error?.message ?? texto;
    estado = json?.error?.status ?? '';
  } catch {
    const codigoMatch = texto.match(/\b(4\d\d|5\d\d)\b/);
    codigo = codigoMatch ? Number(codigoMatch[1]) : undefined;
  }

  const esperaMatch =
    texto.match(/retry in ([\d.]+)s/i) ?? texto.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i);
  const esperaSugeridaSeg = esperaMatch ? Math.ceil(Number(esperaMatch[1])) : undefined;
  const cuota = codigo === 429 || /RESOURCE_EXHAUSTED/i.test(estado + texto);
  const cuotaDiaria = cuota && /per ?day|PerDay/i.test(texto);

  return {
    codigo: cuota ? 429 : codigo,
    mensaje,
    reintentable: (cuota && !cuotaDiaria) || [500, 502, 503, 504].includes(codigo ?? 0),
    cuotaDiaria,
    esperaSugeridaSeg,
  };
}

/**
 * Resultados de herramientas ya ejecutadas en el turno actual (después del último mensaje del usuario).
 */
function respuestasDeHerramientasDelTurno(contents: Content[]) {
  let inicioTurno = 0;
  contents.forEach((c, i) => {
    if (c.role === 'user' && c.parts?.some((p) => p.text)) {
      inicioTurno = i;
    }
  });

  return contents
    .slice(inicioTurno)
    .flatMap((c) => c.parts ?? [])
    .filter((p) => p.functionResponse)
    .map((p) => ({
      nombre: p.functionResponse!.name ?? '',
      respuesta: (p.functionResponse!.response ?? {}) as Record<string, any>,
    }));
}

function describirResultado(nombre: string, r: Record<string, any>): string | undefined {
  switch (nombre) {
    case 'consultar_politica_reabastecimiento':
      return r.encontrado
        ? `Política: el mínimo requerido para ${r.sku} es de ${r.minimo_requerido} unidades (fuente: ${r.fuente}).`
        : `Política: ${r.mensaje ?? r.error}`;
    case 'consultar_stock_sku':
      return r.encontrado
        ? `Inventario: ${r.stock} unidades de ${r.sku} (${r.producto}) en ${r.almacen_id}.`
        : `Inventario: ${r.error}`;
    case 'enviar_alerta_distribucion':
      if (r.status === 'success') return `Alerta emitida a ${r.almacen_id} con folio **${r.folio}**.`;
      if (r.status === 'duplicada') return `Ya existía una alerta activa con folio **${r.folio}**; no se emitió una nueva.`;
      return `Alerta no emitida: ${r.motivo_rechazo}`;
    case 'consultar_historial_alertas':
      return `Historial: ${r.total} alerta(s) emitida(s) en la sesión${r.total ? ` (${r.alertas.map((a: any) => a.folio).join(', ')})` : ''}.`;
    default:
      return undefined;
  }
}

/**
 * Construye una respuesta útil sin LLM: explica la falla y conserva los resultados deterministas
 * de las herramientas ya ejecutadas (por ejemplo, un folio ya emitido no se pierde).
 */
export function construirRespuestaFallback(error: ErrorModelo, contents: Content[]): string {
  const encabezado = error.cuotaDiaria
    ? '⚠️ Se agotó la cuota diaria gratuita de Gemini, así que no puedo redactar la respuesta en este momento.'
    : error.codigo === 429
      ? `⚠️ Gemini alcanzó el límite de solicitudes por minuto del plan gratuito.${error.esperaSugeridaSeg ? ` Intenta de nuevo en unos ${error.esperaSugeridaSeg} segundos.` : ' Intenta de nuevo en un minuto.'}`
      : error.reintentable
        ? '⚠️ El servicio de Gemini no está disponible en este momento. Intenta de nuevo en unos segundos.'
        : `⚠️ No pude contactar a Gemini (error ${error.codigo ?? 'desconocido'}). Revisa la configuración del modelo y la API key en el archivo .env.`;

  const resultados = respuestasDeHerramientasDelTurno(contents);
  const lineas = resultados
    .map((r) => describirResultado(r.nombre, r.respuesta))
    .filter((l): l is string => Boolean(l));

  if (lineas.length === 0) {
    return `${encabezado}\n\nNo se ejecutó ninguna consulta ni se emitió ninguna orden con tu última solicitud.`;
  }

  const politica = resultados.find((r) => r.nombre === 'consultar_politica_reabastecimiento')?.respuesta;
  const stock = resultados.find((r) => r.nombre === 'consultar_stock_sku')?.respuesta;
  const alerta = resultados.find((r) => r.nombre === 'enviar_alerta_distribucion');
  if (politica?.encontrado && stock?.encontrado && !alerta) {
    lineas.push(
      stock.stock < politica.minimo_requerido
        ? `Evaluación: ${stock.stock} < ${politica.minimo_requerido}, hay riesgo de desabastecimiento, pero la alerta aún no se emitió. Repite la pregunta para completarla.`
        : `Evaluación: ${stock.stock} >= ${politica.minimo_requerido}, no hay riesgo de desabastecimiento.`
    );
  }

  return `${encabezado}\n\nEsto es lo que ya se completó antes de la falla:\n${lineas.map((l) => `- ${l}`).join('\n')}`;
}

export interface OpcionesResiliencia {
  maxReintentos?: number;
  maxEsperaSeg?: number;
}

/**
 * Modelo Gemini con manejo elegante de errores (graceful fallback):
 * 1. Reintenta errores transitorios (429 por minuto, 5xx) si la espera sugerida es corta.
 * 2. Si no se puede recuperar, responde con un mensaje útil en lugar de dejar la conversación en silencio.
 */
export class GeminiResiliente extends Gemini {
  private readonly maxReintentos: number;
  private readonly maxEsperaSeg: number;

  constructor(params: GeminiParams, opciones: OpcionesResiliencia = {}) {
    super(params);
    this.maxReintentos = opciones.maxReintentos ?? 2;
    this.maxEsperaSeg = opciones.maxEsperaSeg ?? 20;
  }

  protected llamarModelo(llmRequest: LlmRequest, stream?: boolean, abortSignal?: AbortSignal) {
    return super.generateContentAsync(llmRequest, stream, abortSignal);
  }

  protected esperar(segundos: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, segundos * 1000));
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
    abortSignal?: AbortSignal
  ): AsyncGenerator<LlmResponse, void> {
    for (let intento = 0; ; intento++) {
      let emitioRespuesta = false;
      try {
        for await (const respuesta of this.llamarModelo(llmRequest, stream, abortSignal)) {
          emitioRespuesta = true;
          yield respuesta;
        }
        return;
      } catch (e) {
        const error = interpretarErrorModelo(e);
        const espera = error.esperaSugeridaSeg ?? 2 ** (intento + 1);
        const puedeReintentar =
          error.reintentable &&
          !emitioRespuesta &&
          !abortSignal?.aborted &&
          intento < this.maxReintentos &&
          espera <= this.maxEsperaSeg;

        if (puedeReintentar) {
          console.warn(
            `[GeminiResiliente] Error ${error.codigo ?? 'desconocido'}; reintento ${intento + 1}/${this.maxReintentos} en ${espera}s.`
          );
          await this.esperar(espera);
          continue;
        }

        console.warn(`[GeminiResiliente] Fallback sin LLM tras error ${error.codigo ?? 'desconocido'}: ${error.mensaje}`);
        yield {
          content: {
            role: 'model',
            parts: [{ text: construirRespuestaFallback(error, llmRequest.contents) }],
          },
          turnComplete: true,
        };
        return;
      }
    }
  }
}
