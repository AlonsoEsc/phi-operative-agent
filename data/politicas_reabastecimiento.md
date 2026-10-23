# Políticas de Reabastecimiento de Inventario

## 1. Objetivo y Criterios Generales
El objetivo de estas políticas es asegurar la continuidad operativa de la cadena de suministro regional evitando quiebres de inventario o desabastecimiento.

### Regla General de Evaluación de Riesgo:
- **Existe Riesgo de Desabastecimiento**: Si el stock actual es estrictamente inferior al umbral mínimo requerido (`stock < minimo_requerido`). En este escenario se clasifica en estado crítico y requiere reposición.
- **Sin Riesgo de Desabastecimiento**: Si el stock actual es igual o mayor al mínimo requerido (`stock >= minimo_requerido`). El inventario se encuentra en niveles operativos seguros y no requiere acción correctiva inmediata.

---

## 2. Umbrales Mínimos por Región y SKU

### Región Norte (`region_norte`)

- **SKU-1024** (*Aceite Industrial X*):
  - **Mínimo requerido**: 15 unidades.
  - **Condición**: Todo inventario registrado menor a 15 unidades implica riesgo de desabastecimiento.

- **SKU-2048** (*Filtro Hidráulico Y*):
  - **Mínimo requerido**: 10 unidades.
  - **Condición**: Todo inventario registrado menor a 10 unidades implica riesgo de desabastecimiento.

---

## 3. Disposiciones Adicionales
- Para SKUs o regiones no listados expresamente en esta política, se debe reportar que no existe una política registrada en el sistema.
