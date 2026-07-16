# MCP Draft — Federación del catálogo gobernado hacia agentes de IA

**Estado: DRAFT v0 · no implementado aún.** Este documento especifica el servidor MCP que expone el catálogo de gobernanza a cualquier agente/LLM compatible con Model Context Protocol (Claude, y el ecosistema MCP en general).

## Tesis de producto

La adopción de IA en empresas se frena por el mismo motivo de siempre: los agentes no saben **qué significan los datos, cuál es la fuente oficial ni quién responde por ellos**. Este catálogo captura exactamente eso desde el lenguaje operativo. Exponerlo vía MCP convierte la gobernanza en **infraestructura para IA**: cada respuesta del agente puede citar la definición oficial, la fuente correcta (p. ej. la transacción VA05 y no un Excel pirata) y el responsable.

## Arquitectura POC

```
App (React) ──export──▶ catalogo-gobernanza.json ──lee──▶ Servidor MCP (Node, stdio)
                                                             │
                                                             ▼
                                                     Agente / LLM (host MCP)
```

- **Single-tenant, solo lectura** en POC. El JSON exportado desde Administración → Integraciones (IA) es la fuente de verdad.
- Transporte `stdio` para uso local; `HTTP/SSE` en fase piloto.
- Sin credenciales en POC (archivo local). En piloto: API multi-tenant con auth y scopes por rol.

## Herramientas (tools) v0

### `catalog.list_areas`
Sin parámetros. Devuelve las áreas con conteo de procesos.

### `catalog.get_process`
`{ query: string }` — nombre o id del proceso.
Devuelve: disparador (lenguaje natural), ejecutores, pasos ordenados con su transacción/fuente, y roles asignados.

### `catalog.search_fields`
`{ query: string, only_sensitive?: boolean }`
Busca campos por nombre/significado. Devuelve por campo: significado de negocio, ejemplo, sensibilidad, fuente (código + sistema), proceso y área.

### `catalog.get_lineage`
`{ field: string }`
Devuelve la cadena campo → fuente/transacción → paso → proceso → área, con los responsables de cada nivel. Es la herramienta clave para respuestas trazables ("este dato viene de VA05, del proceso Reporte de venta diaria, y su owner es X").

### `governance.get_glossary_term`
`{ term: string }`
Devuelve la definición de negocio oficial del término si existe en el catálogo, con su fuente. Diseñada para que el agente la cite textual.

### `governance.check_access` *(draft conceptual)*
`{ field: string, purpose: string }`
POC: devuelve owner, sensibilidad y una recomendación no vinculante ("dato sensible: requiere aprobación del owner"). Futuro: motor de políticas real (allow/deny + workflow de aprobación).

## Resources (v0)

- `catalog://areas` — listado navegable.
- `catalog://process/{id}` — documento del proceso.
- `catalog://glossary` — diccionario completo (para RAG barato).

## Esbozo del servidor (Node)

```js
// mcp-server/index.js — esqueleto ilustrativo (no incluido en la POC)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "fs";
import { z } from "zod";

const cat = JSON.parse(readFileSync(process.env.CATALOG || "./catalogo-gobernanza.json", "utf8"));
const server = new McpServer({ name: "gobernanza-catalogo", version: "0.1.0" });

server.tool("catalog_search_fields", { query: z.string() }, async ({ query }) => {
  const q = query.toLowerCase();
  const hits = cat.fields.filter(f =>
    f.name.toLowerCase().includes(q) || (f.description || "").toLowerCase().includes(q));
  return { content: [{ type: "text", text: JSON.stringify(hits.slice(0, 20), null, 2) }] };
});

// ... resto de tools según esta especificación

await server.connect(new StdioServerTransport());
```

## Decisiones abiertas (para la siguiente sesión de diseño)

1. **Identidad de términos**: ¿el glosario indexa por campo (columna) o por concepto de negocio (que agrupa columnas)? Recomendación: concepto en v1; en POC, campo.
2. **Multi-tenant**: el JSON por cliente funciona en piloto; v1 requiere API + aislamiento por tenant.
3. **Enforcement**: `check_access` empieza informativo. Convertirlo en gate real implica integrarse con los sistemas fuente — decisión de roadmap, no de POC.
4. **Telemetría**: registrar qué preguntan los agentes al catálogo es oro de producto (revela qué datos importan). Diseñar desde el piloto con consentimiento del cliente.
