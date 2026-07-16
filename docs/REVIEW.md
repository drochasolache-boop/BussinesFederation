# Revisión de producto — Frontend + Marketing

Fecha: 2026-07-08 · Alcance: POC v0.1.0 · Revisores: equipo Disruptive (rol frontend senior + consultor de marketing)

---

## A. Revisión frontend (nivel profesional)

### Corregido en esta iteración
- **[FIX] Crash del grafo por links huérfanos** — filtro de integridad referencial antes de d3.forceLink + error boundary local del render (try/catch): un fallo del mapa ya no tumba la app.
- **[FIX] Persistencia portable** — `window.storage` (Claude) → `localStorage` (navegador) → memoria. El POC corre standalone.
- **[FIX] Build reproducible** — proyecto Vite verificado con `npm run build` (2067 módulos, OK).

### Deuda técnica priorizada (backlog)
| Prioridad | Ítem | Nota |
|---|---|---|
| P0 | **Dividir `App.jsx` (~2,000 líneas) en módulos** (`components/`, `views/`, `lib/`) | Mantenibilidad; hacerlo antes de sumar features |
| P0 | **Editar/actualizar procesos existentes** | Hoy solo alta y borrado; sin edición el piloto va a doler |
| P1 | Bundle 746 KB → code-splitting (`d3`, `xlsx` como chunks lazy) | Vite `manualChunks` o import dinámico |
| P1 | Accesibilidad: navegación por teclado, `aria-*`, foco visible, contraste AA en modo claro | Los divs clicables deben ser `<button>` |
| P1 | Estados de error visibles en import Excel (hoy falla silenciosa en cabeceras) | Toast/banner con detalle de filas rechazadas |
| P2 | Undo / papelera al borrar (hoy el borrado es destructivo e inmediato) | Al menos confirmación |
| P2 | Virtualizar el catálogo para >1,000 campos | `react-window` |
| P2 | Tests: unit del parser Excel y del builder de nodos/links; smoke E2E | Vitest + Playwright |
| P3 | i18n (es/en) | El mercado LatAm primero; en inglés se abre el techo |
| P3 | Responsive móvil (hoy pensado para desktop) | El capturista de piso podría usar tablet |

### Riesgos técnicos a vigilar
- **Grafo con >300 nodos**: la vista "Todo" se satura; el lente por defecto debería volverse "Áreas + procesos" a partir de cierto umbral.
- **localStorage tiene límite (~5 MB)**: con catálogos grandes migrar a IndexedDB o backend (ya en roadmap).

---

## B. Revisión de marketing / producto

### Posicionamiento (propuesta)
> **"La gobernanza de datos que empieza donde tu gente ya está: en su forma de trabajar."**
> Categoría: *Data governance & AI-readiness para mid-market* · Contra-posicionamiento: Collibra/Alation son para equipos de datos maduros a $170K+/año; nosotros somos la capa que convierte la operación real (ERP + Excel) en contexto gobernado para IA, en semanas y no en trimestres.

### ICP (perfil de cliente ideal)
Empresa LatAm 200–2,000 empleados, ERP en producción (SAP ECC/S4, Dynamics, Odoo), caos de Excel reconocido, presión de dirección por "hacer algo con IA", sin Chief Data Officer. Comprador: CFO/CIO/Dir. de Operaciones. Usuario: analistas y coordinadores de área.

### Nombre (propuestas para decidir)
1. **Datlas** — data + atlas; abraza la metáfora de mapas (red/globo/metro) que ya es la firma visual del producto. *Recomendado.*
2. **Urdimbre** — el tejido base del telar; español, memorable, habla de federación.
3. **Cardex.ai** — familiar para operaciones (kardex), giro a datos.
El dominio y registro de marca se validan antes de decidir.

### Mensajes por audiencia
- **Dirección**: "En 4 semanas sabes qué datos tienes, quién responde por ellos y qué tan listo estás para IA — con un número (índice de madurez)."
- **TI**: "No es otro sistema que administrar: white-label, se alimenta de lo que la gente ya sabe y expone un MCP estándar."
- **Usuario de área**: "Documentas tu proceso como lo cuentas, no como lo pide un manual."

### Motor de crecimiento propuesto
1. **Piloto Dacomsa → caso de estudio** con métricas duras (n.º de procesos, datos catalogados, índice de madurez inicial vs. final).
2. **Demo pública con datos ficticios** (el globo y el metro son extremadamente demostrables; el "wow" está en el mapa).
3. Contenido LinkedIn: "gobernanza para la agenda de IA" en español — el espacio en LatAm está casi vacío.
4. Precio hipótesis para validar: SaaS por dominio de datos o por área (~USD $500–1,500/mes mid-market), setup de levantamiento como servicio de Disruptive (ancla de ingresos temprana).

### Qué falta para vender (gap de producto)
- [ ] Edición de procesos (bloqueante de piloto serio).
- [ ] Multiusuario (bloqueante de venta; no de demo).
- [ ] Exportar el catálogo a PDF/Word "entregable de consultoría" — monetiza al día 1 vía Disruptive.
- [ ] Captura por voz (diferenciador de demo brutal; validar con Web Speech API antes de invertir en Whisper).
- [ ] Landing page con el globo como hero animado.

---

## C. Estado del proyecto

| Workstream | Estado |
|---|---|
| POC funcional distribuible (repo Vite) | ✅ Hecho y build verificado |
| Vistas Globo y Metro | ✅ Hecho |
| Guía + quiz de roles | ✅ Hecho |
| Panel ejecutivo (madurez, IA-readiness, señales) | ✅ Hecho |
| MCP | 📝 Draft especificado (docs/MCP-DRAFT.md) — implementación en fase piloto |
| Multiusuario / backend | ⏳ Roadmap piloto |
| Captura por voz | ⏳ Análisis entregado; pendiente decisión |
