import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FunctionTool, LlmAgent, State } from '@google/adk';
import { z } from 'zod';
import { GeminiResiliente } from './modelo_resiliente.js';

// Aseguramos la compatibilidad del API Key de Gemini desde .env sin exponer su valor
if (process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENAI_API_KEY) {
  process.env.GOOGLE_GENAI_API_KEY = process.env.GEMINI_API_KEY;
}

// Mock de inventario local según la Sección 5 del PDF de evaluación técnica.
// El mínimo requerido NO vive aquí: su única fuente de verdad es el documento de políticas.
const INVENTARIO_MOCK: Record<
  string,
  Record<string, { producto: string; stock: number; almacen_id: string }>
> = {
  region_norte: {
    'SKU-1024': {
      producto: 'Aceite Industrial X',
      stock: 4,
      almacen_id: 'ALM-NORTE-01',
    },
    'SKU-2048': {
      producto: 'Filtro Hidráulico Y',
      stock: 50,
      almacen_id: 'ALM-NORTE-01',
    },
  },
};

/**
 * Normaliza la región a una clave canónica (ej: "Región Norte", "region_norte", "NORTE" -> "norte")
 * para que todas las herramientas interpreten la región de la misma forma.
 */
export function normalizarRegion(region: string): string {
  return region
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, '_')
    .replace(/^region_?/, '');
}

/**
 * Función local que simula la consulta de stock para un SKU y región determinados.
 */
export function consultar_stock_sku(region: string, sku: string) {
  const regionKey = `region_${normalizarRegion(region)}`;
  const skuKey = sku.trim().toUpperCase();

  const item = INVENTARIO_MOCK[regionKey]?.[skuKey];

  if (!item) {
    return {
      encontrado: false,
      sku: skuKey,
      region: regionKey,
      error: `SKU '${sku}' no encontrado en la región '${region}'.`,
    };
  }

  return {
    encontrado: true,
    sku: skuKey,
    region: regionKey,
    almacen_id: item.almacen_id,
    producto: item.producto,
    stock: item.stock,
  };
}

/**
 * Ruta al archivo local de políticas de reabastecimiento.
 */
const agentFilePath = fileURLToPath(import.meta.url);
const agentDirectoryPath = path.dirname(agentFilePath);

function getPolicyFilePath(): string {
  const localDataPath = path.resolve(agentDirectoryPath, 'data', 'politicas_reabastecimiento.md');
  if (fs.existsSync(localDataPath)) {
    return localDataPath;
  }
  return path.resolve(process.cwd(), 'data', 'politicas_reabastecimiento.md');
}

function escapeRegex(str: string): string {
  return str.replace(/[\^$*+?.()|[\]{}\\]/g, '\\$&');
}

/**
 * Función local que consulta el archivo local de políticas de reabastecimiento
 * y devuelve la regla relevante para la región y el SKU dinámicamente desde el documento.
 */
export function consultar_politica_reabastecimiento(region: string, sku: string) {
  const policyFile = getPolicyFilePath();
  if (!fs.existsSync(policyFile)) {
    return {
      encontrado: false,
      region,
      sku,
      error: `Archivo de políticas no encontrado en ${policyFile}`,
    };
  }

  const contenido = fs.readFileSync(policyFile, 'utf-8');
  const regClean = normalizarRegion(region);
  const skuNorm = sku.trim().toUpperCase();

  if (!regClean) {
    return {
      encontrado: false,
      region,
      sku: skuNorm,
      mensaje: 'Debe indicarse una región para consultar la política.',
    };
  }

  // 1. Extraer la sección de la región en el documento markdown usando límites válidos en JavaScript
  const regionRegex = new RegExp(
    `###[^\\r\\n]*\\b(${escapeRegex(regClean)})\\b[^\\r\\n]*\\r?\\n([\\s\\S]*?)(?=(?:\\r?\\n###|\\r?\\n##|\\r?\\n---|$))`,
    'i'
  );
  const regionMatch = contenido.match(regionRegex);

  if (!regionMatch) {
    return {
      encontrado: false,
      region,
      sku: skuNorm,
      mensaje: `No existe política documentada para la región '${region}' en ${path.basename(policyFile)}.`,
    };
  }

  const regionContent = regionMatch[2];

  // 2. Extraer el bloque correspondiente al SKU dentro de la sección de la región
  const skuRegex = new RegExp(
    `- \\*\\*${escapeRegex(skuNorm)}\\*\\*(?:\\s*\\((.*?)\\))?:?\\s*\\r?\\n([\\s\\S]*?)(?=(?:\\r?\\n- \\*\\*SKU-|\\r?\\n---|\\r?\\n##|\\r?\\n###|$))`,
    'i'
  );
  const skuMatch = regionContent.match(skuRegex);

  if (!skuMatch) {
    return {
      encontrado: false,
      region,
      sku: skuNorm,
      mensaje: `No se encontró una regla de política de reabastecimiento para el SKU '${sku}' en la región '${region}' dentro de ${path.basename(policyFile)}.`,
    };
  }

  // 3. Obtener dinámicamente producto, mínimo requerido, condición y fragmento
  const producto = skuMatch[1] ? skuMatch[1].replace(/[*_]/g, '').trim() : undefined;
  const fragmentoPolitica = skuMatch[0].trim();

  const minMatch = fragmentoPolitica.match(/m[íi]nimo[^\d\n]*[:=]\s*(\d+)/i);
  const minimoRequerido = minMatch ? parseInt(minMatch[1], 10) : undefined;

  // Si no se puede extraer el mínimo requerido, no se devuelve una política incompleta
  if (minimoRequerido === undefined || Number.isNaN(minimoRequerido)) {
    return {
      encontrado: false,
      region,
      sku: skuNorm,
      mensaje: `No se pudo determinar el mínimo requerido para el SKU '${sku}' en la región '${region}' desde ${path.basename(policyFile)}.`,
    };
  }

  const condMatch = fragmentoPolitica.match(/condici[óo]n[^\n:]*[:=]\s*([^\r\n]+)/i);
  const condicion = condMatch ? condMatch[1].trim() : undefined;

  // 4. Extraer el criterio general de evaluación de riesgo del documento
  const generalMatch = contenido.match(/### Regla General[^\r\n]*\r?\n([\s\S]*?)(?=(?:\r?\n---|\r?\n##|$))/i);
  const criterioGeneral = generalMatch ? generalMatch[1].trim() : '';

  return {
    encontrado: true,
    region,
    sku: skuNorm,
    producto,
    minimo_requerido: minimoRequerido,
    criterio_riesgo: condicion || criterioGeneral,
    criterio_general: criterioGeneral || undefined,
    fragmento_politica: fragmentoPolitica,
    fuente: `data/${path.basename(policyFile)}`,
  };
}

/**
 * Herramienta para consultar políticas de reabastecimiento basada en FunctionTool.
 */
export const consultarPoliticaReabastecimientoTool = new FunctionTool({
  name: 'consultar_politica_reabastecimiento',
  description:
    'Consulta el archivo de políticas de reabastecimiento para obtener el nivel mínimo de stock requerido y los criterios de riesgo para una región y SKU específicos.',
  parameters: z.object({
    region: z.string().describe('Región geográfica o almacén a consultar (por ejemplo: "region_norte" o "norte").'),
    sku: z.string().describe('Código SKU del producto (por ejemplo: "SKU-1024", "SKU-2048").'),
  }),
  execute: async ({ region, sku }) => {
    return consultar_politica_reabastecimiento(region, sku);
  },
});

/**
 * Herramienta para el modelo basada en FunctionTool.
 */
export const consultarStockSkuTool = new FunctionTool({
  name: 'consultar_stock_sku',
  description:
    'Consulta el stock disponible y el almacén asociado de un SKU para una región o centro de distribución específico.',
  parameters: z.object({
    region: z.string().describe('Región geográfica o almacén a consultar (por ejemplo: "norte", "sur", "centro").'),
    sku: z.string().describe('Código identificador SKU del producto (por ejemplo: "SKU-1024", "SKU-2048").'),
  }),
  execute: async ({ region, sku }) => {
    return consultar_stock_sku(region, sku);
  },
});

/**
 * Alerta de distribución registrada en el estado de la sesión de ADK.
 */
export interface AlertaDistribucion {
  folio: string;
  almacen_id: string;
  sku: string;
  region: string;
  stock_detectado: number;
  minimo_requerido: number;
  motivo: string;
  fecha_emision: string;
  estado: 'EMITIDA' | 'EN_TRANSITO' | 'PENDIENTE';
}

/**
 * Clave del estado de sesión donde se guarda el historial de alertas emitidas.
 */
export const ESTADO_ALERTAS = 'alertas_emitidas';

/**
 * Valida en código la regla de negocio antes de disparar una orden, recalculando el riesgo
 * desde las fuentes de verdad (documento de políticas + inventario) en vez de confiar en el LLM.
 * El SKU se toma del motivo, que la descripción de la herramienta exige que lo incluya.
 */
export function validar_regla_alerta(almacen_id: string, motivo: string) {
  const almacenNorm = almacen_id.trim().toUpperCase();
  const skus = [...new Set((motivo.toUpperCase().match(/SKU-\d+/g) ?? []))];

  if (skus.length !== 1) {
    return {
      valida: false as const,
      motivo_rechazo:
        skus.length === 0
          ? 'El motivo debe indicar el SKU afectado (ej: "SKU-1024") para validar la regla de negocio.'
          : `El motivo menciona varios SKUs (${skus.join(', ')}); emita una alerta por SKU.`,
    };
  }

  const sku = skus[0];
  const regionKey = Object.keys(INVENTARIO_MOCK).find(
    (r) => INVENTARIO_MOCK[r][sku]?.almacen_id === almacenNorm
  );

  if (!regionKey) {
    return {
      valida: false as const,
      motivo_rechazo: `El SKU '${sku}' no está registrado en el almacén '${almacenNorm}'.`,
    };
  }

  const stock = consultar_stock_sku(regionKey, sku);
  const politica = consultar_politica_reabastecimiento(regionKey, sku);

  if (
    stock.stock === undefined ||
    !politica.encontrado ||
    politica.minimo_requerido === undefined
  ) {
    return {
      valida: false as const,
      motivo_rechazo: `No existe política documentada para '${sku}' en '${regionKey}'; no se puede justificar la orden.`,
    };
  }

  if (stock.stock >= politica.minimo_requerido) {
    return {
      valida: false as const,
      motivo_rechazo: `Regla de negocio no cumplida: stock actual ${stock.stock} >= mínimo requerido ${politica.minimo_requerido} para '${sku}'. No hay riesgo de desabastecimiento.`,
    };
  }

  return {
    valida: true as const,
    sku,
    region: regionKey,
    almacen_id: almacenNorm,
    stock: stock.stock,
    minimo_requerido: politica.minimo_requerido,
  };
}

function generarFolio(existentes: AlertaDistribucion[]): string {
  let folio: string;
  do {
    folio = `#ALT-${Math.floor(1000 + Math.random() * 9000)}`;
  } while (existentes.some((a) => a.folio === folio));
  return folio;
}

/**
 * Función local que simula el envío de una orden o alerta al centro de distribución
 * y retorna un folio de seguimiento (#ALT-XXXX) según la Sección 2 y 5 del examen técnico.
 * Solo emite la orden si la regla de negocio se cumple y no existe ya una alerta activa
 * para el mismo SKU y almacén en la sesión.
 */
export function enviar_alerta_distribucion(almacen_id: string, motivo: string, state: State) {
  const validacion = validar_regla_alerta(almacen_id, motivo);

  if (!validacion.valida) {
    return {
      status: 'rechazada',
      almacen_id: almacen_id.trim().toUpperCase(),
      motivo_rechazo: validacion.motivo_rechazo,
    };
  }

  const historial = state.get<AlertaDistribucion[]>(ESTADO_ALERTAS, []) ?? [];
  const existente = historial.find(
    (a) => a.sku === validacion.sku && a.almacen_id === validacion.almacen_id && a.estado === 'EMITIDA'
  );

  if (existente) {
    return {
      status: 'duplicada',
      mensaje: `Ya existe una alerta activa para ${existente.sku} en ${existente.almacen_id}; no se emite una nueva orden.`,
      folio: existente.folio,
      fecha_emision: existente.fecha_emision,
    };
  }

  const nuevaAlerta: AlertaDistribucion = {
    folio: generarFolio(historial),
    almacen_id: validacion.almacen_id,
    sku: validacion.sku,
    region: validacion.region,
    stock_detectado: validacion.stock,
    minimo_requerido: validacion.minimo_requerido,
    motivo: motivo.trim(),
    fecha_emision: new Date().toISOString(),
    estado: 'EMITIDA',
  };

  // Se asigna un arreglo nuevo para que ADK registre el cambio como delta de estado de la sesión
  state.set(ESTADO_ALERTAS, [...historial, nuevaAlerta]);

  return {
    status: 'success',
    mensaje: `Alerta de distribución enviada con éxito al centro de distribución para el almacén ${nuevaAlerta.almacen_id}.`,
    ...nuevaAlerta,
    instrucciones_seguimiento: `Orden registrada bajo el folio ${nuevaAlerta.folio}. Proceder con el despacho logístico.`,
  };
}

/**
 * Herramienta para enviar alertas a centros de distribución basada en FunctionTool.
 */
export const enviarAlertaDistribucionTool = new FunctionTool({
  name: 'enviar_alerta_distribucion',
  description:
    'Simula el envío de una orden o alerta al centro de distribución cuando se confirma riesgo de desabastecimiento (stock actual < mínimo requerido según la política). El sistema revalida la regla de negocio y rechaza la orden si no se cumple o si ya existe una alerta activa. Retorna un folio de seguimiento (#ALT-XXXX).',
  parameters: z.object({
    almacen_id: z
      .string()
      .describe(
        'Identificador del almacén obtenido al consultar el stock (por ejemplo: "ALM-NORTE-01").'
      ),
    motivo: z
      .string()
      .describe(
        'Justificación de la alerta. DEBE incluir el código SKU (ej: "SKU-1024"), el stock detectado y el mínimo requerido por la política.'
      ),
  }),
  execute: async ({ almacen_id, motivo }, toolContext) => {
    if (!toolContext) {
      return { status: 'error', motivo_rechazo: 'Contexto de sesión no disponible.' };
    }
    return enviar_alerta_distribucion(almacen_id, motivo, toolContext.state);
  },
});

/**
 * Herramienta para consultar la memoria de la sesión: alertas emitidas en la conversación.
 */
export const consultarHistorialAlertasTool = new FunctionTool({
  name: 'consultar_historial_alertas',
  description:
    'Devuelve las alertas de distribución emitidas durante la sesión actual (folio, SKU, almacén, stock y mínimo).',
  execute: async (_input, toolContext) => {
    const alertas = toolContext?.state.get<AlertaDistribucion[]>(ESTADO_ALERTAS, []) ?? [];
    return { total: alertas.length, alertas };
  },
});

/**
 * Agente principal exportado como rootAgent para el ADK CLI / Web UI.
 */
export const rootAgent = new LlmAgent({
  name: 'phi_operative_agent',
  // Gemini con reintentos y respuesta de respaldo ante errores de cuota (429) o indisponibilidad (5xx)
  model: new GeminiResiliente(
    { model: process.env.GEMINI_MODEL || 'gemini-3.6-flash' },
    {
      maxReintentos: Number(process.env.GEMINI_MAX_REINTENTOS ?? 2),
      maxEsperaSeg: Number(process.env.GEMINI_MAX_ESPERA_SEG ?? 20),
    }
  ),
  description:
    'Agente operativo de inventario y cadena de suministro para monitoreo de desabastecimiento regional y despacho de alertas automáticas.',
  instruction:
    'Eres "Phi Operative Agent", un agente operativo especializado en Retail y Cadena de Suministro dentro de la metodología Constraint-First de Phi Analytics Group.\n\n' +
    'Tu responsabilidad es resolver cuellos de botella operativos: monitorear desabastecimiento de inventario regional y ejecutar alertas/acciones automáticas conectando las políticas internas con sistemas operativos.\n\n' +
    '### Flujo de Ejecución Obligatorio (Paso a Paso):\n' +
    'Cuando el usuario pregunte por el inventario, existencia o riesgo de desabastecimiento de un SKU en una región (por ejemplo: "¿Hay riesgo de desabastecimiento de SKU-1024 en el Norte?") debes seguir estrictamente este flujo:\n\n' +
    '1. **Paso 1: Consulta de Políticas (Grounding / RAG)**:\n' +
    '   - Invoca primero la herramienta `consultar_politica_reabastecimiento` pasando `region` y `sku`.\n' +
    '   - Extrae el mínimo requerido oficial y el criterio de riesgo documentado.\n\n' +
    '2. **Paso 2: Consulta de Stock Operativo (Function Calling / Tool 1)**:\n' +
    '   - Invoca la herramienta `consultar_stock_sku` pasando `region` y `sku` para obtener las unidades físicas disponibles y el `almacen_id`.\n\n' +
    '3. **Paso 3: Evaluación de Regla de Negocio y Ejecución de Acciones**:\n' +
    '   - **SI HAY RIESGO DE DESABASTECIMIENTO (`stock < minimo_requerido`)**:\n' +
    '     a) Confirma claramente que SÍ existe riesgo de desabastecimiento, contrastando el stock actual frente al mínimo requerido según la política (ej: "4 unidades actuales frente a un mínimo requerido de 15").\n' +
    '     b) **ACCIÓN OBLIGATORIA**: Invoca inmediatamente la herramienta `enviar_alerta_distribucion` pasando el `almacen_id` (ej: "ALM-NORTE-01" o el devuelto por la consulta) y un `motivo` claro y justificado.\n' +
    '     c) Presenta en tu respuesta final la confirmación del riesgo, los valores de inventario y el **Folio de seguimiento generado** (ej: `#ALT-XXXX`).\n' +
    '     d) Si la herramienta responde `status: "duplicada"`, informa el folio ya existente en lugar de uno nuevo. Si responde `status: "rechazada"`, explica el `motivo_rechazo` y no inventes un folio.\n\n' +
    '   - **SI NO HAY RIESGO DE DESABASTECIMIENTO (`stock >= minimo_requerido`)**:\n' +
    '     a) Confirma que NO existe riesgo de desabastecimiento, explicando que el stock actual cubre o supera el umbral mínimo operativo.\n' +
    '     b) **NO invoques** la herramienta `enviar_alerta_distribucion`.\n\n' +
    '   - **MANEJO DE EXCEPCIONES Y CASOS NO REGISTRADOS (Graceful Fallback)**:\n' +
    '     a) Si el SKU o la región no están en la política o no existen en el inventario, explica amablemente la situación con precisión y sin alucinar datos.\n' +
    '     b) No dispares ninguna orden ni alerta en caso de datos no encontrados.\n\n' +
    '### Memoria de la Sesión:\n' +
    '- Si el usuario pregunta qué alertas o folios se han emitido, invoca `consultar_historial_alertas`.\n' +
    '- El mínimo requerido proviene SOLO de `consultar_politica_reabastecimiento`; nunca lo supongas.',
  tools: [
    consultarPoliticaReabastecimientoTool,
    consultarStockSkuTool,
    enviarAlertaDistribucionTool,
    consultarHistorialAlertasTool,
  ],
});

