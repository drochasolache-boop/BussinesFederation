# Gobernanza de datos para la agenda de IA · POC

Plataforma **white-label** de gobernanza y federación de datos que parte de donde nadie más parte: **el lenguaje operativo del usuario de negocio**.

> "Cuando me piden el reporte de ventas, lo saco de la VA05."

Esa frase — tácita, cotidiana, no técnica — es el punto de entrada. La plataforma la convierte en un catálogo gobernado: proceso → pasos → transacciones/fuentes → datos con significado de negocio → responsables (Owner / Steward / Custodian). Y ese catálogo se federa hacia agentes de IA vía **MCP** (draft), para que cualquier LLM consuma contexto confiable y trazable de tu operación.

## ¿Por qué existe?

Las plataformas líderes (Collibra, Alation, Atlan, Informatica) están diseñadas para equipos de datos maduros y cuestan USD $150–200K/año. El mid-market — con su ERP y su caos de Excel — quedó huérfano, justo cuando la adopción de IA exige catálogos con contexto semántico. Este producto ataca ese hueco: **captura sin fricción, gobernanza entendible por gente de negocio, y salida directa a agentes de IA.**

## Funcionalidades (POC)

- **Onboarding white-label**: nombre, logo, banner, color, tema claro/oscuro. La marca es del cliente.
- **Panel ejecutivo**: índice de madurez de gobernanza (0–100), preparación para IA, señales de riesgo accionables, salud por área, composición de fuentes.
- **Documentar en un solo lienzo**: proceso con pasos ordenados, transacción por paso, datos por transacción, disparador en lenguaje natural, ejecutores; con vista previa en vivo del nodo. Soporta **subir la cabecera de una tabla (Excel/CSV)** para autollenar los campos.
- **Mapa de relaciones con 3 tipos de vista**:
  - **Red** — grafo de fuerzas con 6 lentes (todo, áreas, procesos, flujo de pasos, transacciones, por usuario), flotación sutil y glow.
  - **Globo** — los nodos mapeados sobre una esfera geodésica giratoria (arrastra para rotar).
  - **Metro** — cada proceso es una línea, cada paso una estación, y las transacciones compartidas son correspondencias.
- **Catálogo de datos** con buscador y marcado de datos sensibles.
- **Roles y responsables**: guía profesional de Data Owner / Steward / Custodian en lenguaje llano, **quiz de escenarios** para aprender quién decide qué, y matriz de asignación por proceso.
- **Administración**: pre-carga de estructura (áreas/procesos), **carga masiva por Excel** con template descargable, y pestaña de **Integraciones (IA)** con exportación del catálogo a JSON — el insumo del servidor MCP.

## Quick start

```bash
npm install
npm run dev      # desarrollo → http://localhost:5173
npm run build    # producción → dist/
```

Requisitos: Node 18+.

## Modelo de datos

```
Área ─┬─ Proceso ─┬─ Paso (ordenado) ── Fuente/Transacción ── Campo (dato + significado)
      │           ├─ Disparador (lenguaje natural)
      │           ├─ Ejecutores (personas que lo operan)
      │           └─ Roles (Owner / Steward / Custodian)
      └─ Color de dominio (identidad visual en todos los mapas)
```

Persistencia POC: `localStorage` (o `window.storage` cuando corre embebido en Claude). Para multiusuario ver Roadmap.

## Federación hacia IA (MCP)

El draft de servidor MCP vive en [`docs/MCP-DRAFT.md`](docs/MCP-DRAFT.md). Resumen: la app exporta `catalogo-gobernanza.json` (Administración → Integraciones), y un servidor MCP lo expone con herramientas como `catalog.search_fields`, `catalog.get_lineage` o `governance.get_glossary_term`, de modo que un agente pueda responder *"¿qué significa importe neto y quién es su dueño?"* con la verdad gobernada de la empresa.

## Roadmap

| Fase | Alcance |
|---|---|
| POC (este repo) | Captura, catálogo, mapas, roles, export JSON, MCP draft |
| Piloto | Backend + BD + cuentas de usuario, captura colaborativa, catálogo compartido |
| v1 | Servidor MCP en producción, captura por voz (STT + estructuración LLM), conectores de lectura (SAP, SQL), políticas de acceso |

Revisión técnica y de producto: [`docs/REVIEW.md`](docs/REVIEW.md).

## Licencia

MIT © 2026 Disruptive Technology Consulting
