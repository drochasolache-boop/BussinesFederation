import React, { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from "react";
import * as d3 from "d3";
import * as XLSX from "xlsx";
import {
  LayoutDashboard, Network, Database, Users, Plus, Upload, Check,
  ChevronRight, ChevronDown, X, Settings, Search, FileText, Boxes, Layers,
  Trash2, Building2, GitBranch, Palette, ShieldCheck, Download,
  FileSpreadsheet, Eye, Waypoints, GraduationCap,
  RotateCcw, Sparkles, Target, Circle, Flag, AlertTriangle, Pencil, Moon, Sun,   Lock, RefreshCw, LogOut, UserCog,
  Play, Pause, ChevronLeft, LayoutGrid,
} from "lucide-react";

// ============================================================================
// PERSISTENCIA — portable: window.storage (Claude) → localStorage → memoria
// ============================================================================
const memStore = {};
const backend = {
  async get(key) {
    if (typeof window !== "undefined" && window.storage && window.storage.get) return window.storage.get(key);
    if (typeof window !== "undefined" && window.localStorage) {
      const v = window.localStorage.getItem(key);
      return v == null ? null : { value: v };
    }
    return key in memStore ? { value: memStore[key] } : null;
  },
  async set(key, value) {
    if (typeof window !== "undefined" && window.storage && window.storage.set) return window.storage.set(key, value);
    if (typeof window !== "undefined" && window.localStorage) { window.localStorage.setItem(key, value); return; }
    memStore[key] = value;
  },
};
const store = {
  async get(key) {
    try { const r = await backend.get(key); return r ? JSON.parse(r.value) : null; }
    catch (e) { return null; }
  },
  async set(key, value) {
    try { await backend.set(key, JSON.stringify(value)); } catch (e) { /* noop */ }
  },
};


function captureDraftKey(tenantId, userEmail = "") {
  const scope = (userEmail || "anon").toLowerCase().replace(/[^a-z0-9@._-]/g, "_");
  return `gov:${tenantId}:captureDraft:${scope}`;
}

function tenantStoreKey(tenantId, key) {
  return `gov:${tenantId}:${key}`;
}

const REMOVED_TENANT_IDS = ["demo"];

async function purgeRemovedTenants() {
  for (const tenantId of REMOVED_TENANT_IDS) {
    await store.set(tenantStoreKey(tenantId, "data"), null);
    await store.set(tenantStoreKey(tenantId, "areaColors"), null);
    await store.set(tenantStoreKey(tenantId, "theme"), null);
  }
  const savedTenant = await store.get(ACTIVE_TENANT_KEY);
  if (savedTenant && REMOVED_TENANT_IDS.includes(savedTenant)) {
    await store.set(ACTIVE_TENANT_KEY, "dacomsa");
  }
}

const ACTIVE_TENANT_KEY = "gov:activeTenant";

function captureDraftHasContent(draft) {
  if (!draft) return false;
  return !!(
    draft.areaId || draft.subArea?.trim() || draft.procName?.trim() || draft.trigger?.trim()
    || draft.steps?.length || draft.fields?.length || draft.stepRoles?.length
    || draft.versionComment?.trim()
  );
}

async function loadCaptureDraft(tenantId, userEmail = "") {
  return store.get(captureDraftKey(tenantId, userEmail));
}

async function saveCaptureDraft(tenantId, draft, userEmail = "") {
  const key = captureDraftKey(tenantId, userEmail);
  if (!captureDraftHasContent(draft)) {
    await store.set(key, null);
    return;
  }
  await store.set(key, { ...draft, savedAt: new Date().toISOString() });
}

async function clearCaptureDraft(tenantId, userEmail = "") {
  await store.set(captureDraftKey(tenantId, userEmail), null);
}

function catalogIsLocalNewer(localData, remoteData) {
  const localMax = maxProcessLastModified(localData?.processes);
  const remoteMax = maxProcessLastModified(remoteData?.processes);
  return !!(localMax && remoteMax && localMax > remoteMax);
}

// ¿El remoto trae pasos o procesos que localmente no existen (contenido aditivo)?
// Ignora ids ya borrados localmente para no resucitar tombstones. Un cambio aditivo
// se puede reconciliar siempre sin destruir trabajo local (reconcile hace union),
// por eso rompe el empate de timestamps entre dos usuarios editando el mismo flujo.
function remoteHasNewContent(localData, remoteData) {
  if (!remoteData) return false;
  const localDeleted = new Set((localData?.deletedIds || []).map((d) => d.id));
  const localStepIds = new Set((localData?.steps || []).map((s) => s.id));
  const hasNewStep = (remoteData.steps || []).some(
    (s) => s.id && !localStepIds.has(s.id) && !localDeleted.has(s.id),
  );
  if (hasNewStep) return true;
  const localProcIds = new Set((localData?.processes || []).map((p) => p.id));
  return (remoteData.processes || []).some(
    (p) => p.id && !localProcIds.has(p.id) && !localDeleted.has(p.id),
  );
}

// ¿El remoto marcó como borrado (tombstone) algo que localmente todavía se muestra?
// Señal confiable de eliminación remota: no se dispara con adiciones locales pendientes
// (esas no están en el deletedIds remoto). Fuerza jalar para que el borrado se vea.
function remoteDroppedLocalContent(localData, remoteData) {
  if (!remoteData) return false;
  const remoteDeleted = new Set((remoteData.deletedIds || []).map((d) => d.id));
  if (!remoteDeleted.size) return false;
  const localStepHit = (localData?.steps || []).some((s) => remoteDeleted.has(s.id));
  if (localStepHit) return true;
  return (localData?.processes || []).some((p) => remoteDeleted.has(p.id));
}

function formatDraftTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("es-MX", { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

function formatRelativeTime(iso) {
  if (!iso) return "";
  try {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 15000) return "hace un momento";
    if (diff < 3600000) return `hace ${Math.floor(diff / 60000)} min`;
    if (diff < 86400000) return `hace ${Math.floor(diff / 3600000)} h`;
    return formatDraftTime(iso);
  } catch { return ""; }
}

// ============================================================================
// MODELO
// Área → Proceso → Paso (ordenado) → cada Paso usa una Fuente/transacción
// Campo (dato con descripción) cuelga de una Fuente. Roles por Proceso.
// ============================================================================
const ROLE_TYPES = [
  { id: "owner",     label: "Data Owner",     hint: "Responsable del dato. Decide y aprueba accesos." },
  { id: "steward",   label: "Data Steward",   hint: "Cuida la calidad y define el significado del dato." },
  { id: "custodian", label: "Data Custodian", hint: "Administra el almacenamiento técnico y la seguridad." },
];

// Guía profesional de roles — para usuarios sin contexto de gobernanza
const ROLE_INFO = {
  owner: {
    title: "Data Owner (Dueño del dato)",
    what: "Es la persona de negocio que responde por el dato. No lo teclea ni lo administra técnicamente: es quien rinde cuentas por él ante la organización.",
    duties: [
      "Decide quién puede acceder al dato y para qué usos lo aprueba.",
      "Define qué tan crítico o sensible es (p. ej. datos personales, financieros).",
      "Aprueba cambios de fondo: nuevas fuentes, eliminación, compartir con terceros.",
      "Responde ante auditoría o dirección si el dato se usa mal.",
    ],
    profile: "Gerente o director del área que origina el dato (Comercial, Finanzas, RH…).",
    example: "El Gerente Comercial es owner del dato “cliente”: si Marketing quiere la base con correos para una campaña, él autoriza (o no).",
    isNot: "No es quien opera el sistema ni quien corrige los registros uno a uno.",
  },
  steward: {
    title: "Data Steward (Guardián del dato)",
    what: "Es quien cuida el significado y la calidad del dato en el día a día. Es el traductor entre el negocio y los sistemas: sabe qué significa cada campo y detecta cuando algo está mal.",
    duties: [
      "Define y mantiene el diccionario: qué significa cada dato en términos de negocio.",
      "Vigila la calidad: duplicados, formatos mezclados, campos vacíos.",
      "Resuelve dudas de significado (“¿venta neta incluye devoluciones?”).",
      "Propone estándares y reglas de captura al owner.",
    ],
    profile: "Analista senior o coordinador del área; la persona que “se sabe” la operación.",
    example: "La analista de Ventas define que “importe neto” es el monto sin IVA después de descuentos, y detecta que hay clientes duplicados con RFC distinto.",
    isNot: "No es el dueño que autoriza accesos, ni el técnico que administra servidores.",
  },
  custodian: {
    title: "Data Custodian (Custodio del dato)",
    what: "Es el responsable técnico del dato: lo resguarda, lo respalda y aplica en los sistemas las reglas de acceso que el owner aprobó.",
    duties: [
      "Implementa los permisos y accesos que autoriza el owner.",
      "Administra respaldos, cifrado y retención del dato.",
      "Mantiene la infraestructura donde vive el dato (BD, ERP, archivos).",
      "Atiende incidentes técnicos: caídas, accesos indebidos, recuperación.",
    ],
    profile: "TI, DBA, administrador del ERP o ingeniero de datos.",
    example: "El administrador de SAP crea el rol de acceso a VA05 para el nuevo analista, después de que el owner lo aprobó.",
    isNot: "No define qué significa el dato ni decide quién debería usarlo.",
  },
};

// Quiz de escenarios: ¿quién debe actuar?
const ROLE_QUIZ = [
  { q: "Marketing pide la base de clientes con correos para una campaña. ¿Quién debe autorizar el acceso?",
    correct: "owner", why: "Autorizar usos y accesos es una decisión de negocio: le toca al Data Owner. El custodio solo implementa el permiso una vez aprobado." },
  { q: "Dos reportes muestran cifras de venta distintas y hay que definir el cálculo oficial de “venta neta”.",
    correct: "steward", why: "Definir el significado y el cálculo oficial de un dato es trabajo del Data Steward, que domina la operación y mantiene el diccionario." },
  { q: "Hay que configurar el respaldo automático y el cifrado de la tabla de facturas.",
    correct: "custodian", why: "Respaldos, cifrado e infraestructura son responsabilidad técnica: Data Custodian." },
  { q: "El campo “RFC” aparece con formatos mezclados y hay que estandarizarlo y documentar la regla.",
    correct: "steward", why: "Calidad del dato y estándares de captura: Data Steward. Si la regla impacta accesos o sistemas, coordina con owner y custodio." },
  { q: "Auditoría pregunta quién responde por el mal uso del dato de nómina.",
    correct: "owner", why: "El que rinde cuentas por el dato ante la organización es el Data Owner, aunque la falla haya sido operativa o técnica." },
  { q: "Se detecta un acceso indebido y hay que revocar los permisos técnicos hoy mismo.",
    correct: "custodian", why: "Revocar accesos en el sistema es ejecución técnica inmediata: Data Custodian, notificando al owner." },
];
const SOURCE_KINDS = [
  { id: "erp", label: "Transacción ERP", hint: "Ej. VA05, MB52, FBL3N" },
  { id: "file", label: "Archivo no gobernado", hint: "Ej. Excel, CSV compartido" },
  { id: "db", label: "Base de datos / Tabla", hint: "Ej. tabla SQL, vista" },
  { id: "report", label: "Reporte / BI", hint: "Ej. dashboard, tablero" },
];

const CATALOG_DATA_TYPES = [
  { id: "text", label: "Texto" },
  { id: "number", label: "Número" },
  { id: "date", label: "Fecha" },
  { id: "boolean", label: "Sí / No" },
  { id: "email", label: "Email" },
  { id: "enum", label: "Lista predefinida" },
];

// Base de datos de transacciones SAP estándar — autocomplete en captura
const SAP_TXNS = [
  // SD — Ventas y distribución
  { code: "VA01", mod: "SD", desc: "Crear pedido de venta" },
  { code: "VA02", mod: "SD", desc: "Modificar pedido de venta" },
  { code: "VA03", mod: "SD", desc: "Visualizar pedido de venta" },
  { code: "VA05", mod: "SD", desc: "Lista de pedidos de venta" },
  { code: "VF01", mod: "SD", desc: "Crear factura" },
  { code: "VF02", mod: "SD", desc: "Modificar factura" },
  { code: "VF03", mod: "SD", desc: "Visualizar factura" },
  { code: "VL01N", mod: "SD", desc: "Crear entrega" },
  { code: "VL02N", mod: "SD", desc: "Modificar entrega" },
  { code: "VL06O", mod: "SD", desc: "Monitor de entregas salientes" },
  { code: "VKM1", mod: "SD", desc: "Gestión de créditos — lista bloqueados" },
  { code: "VA21", mod: "SD", desc: "Crear cotización" },
  { code: "VA22", mod: "SD", desc: "Modificar cotización" },
  { code: "VA45", mod: "SD", desc: "Lista de contratos" },
  // MM — Gestión de materiales
  { code: "ME21N", mod: "MM", desc: "Crear orden de compra" },
  { code: "ME22N", mod: "MM", desc: "Modificar orden de compra" },
  { code: "ME23N", mod: "MM", desc: "Visualizar orden de compra" },
  { code: "ME51N", mod: "MM", desc: "Crear solicitud de pedido (requisición)" },
  { code: "ME52N", mod: "MM", desc: "Modificar solicitud de pedido" },
  { code: "ME5A", mod: "MM", desc: "Lista de solicitudes de pedido" },
  { code: "MIGO", mod: "MM", desc: "Movimiento de mercancías (entrada/salida)" },
  { code: "MIRO", mod: "MM", desc: "Verificación de facturas de proveedor" },
  { code: "MB52", mod: "MM", desc: "Stock por almacén y material" },
  { code: "MB51", mod: "MM", desc: "Historial de documentos de material" },
  { code: "MB1B", mod: "MM", desc: "Transferencia de stock entre almacenes" },
  { code: "MI01", mod: "MM", desc: "Crear documento de inventario físico" },
  { code: "MI04", mod: "MM", desc: "Conteo de inventario físico" },
  { code: "MI07", mod: "MM", desc: "Contabilizar diferencias de inventario" },
  { code: "MM60", mod: "MM", desc: "Análisis de consumo de materiales" },
  { code: "ME2M", mod: "MM", desc: "Pedidos por material" },
  { code: "ME2N", mod: "MM", desc: "Pedidos por número de pedido" },
  // FI — Finanzas
  { code: "FBL3N", mod: "FI", desc: "Partidas individuales de cuenta mayor" },
  { code: "FBL5N", mod: "FI", desc: "Partidas individuales de deudores" },
  { code: "FBL1N", mod: "FI", desc: "Partidas individuales de acreedores" },
  { code: "FS10N", mod: "FI", desc: "Balance de cuenta mayor" },
  { code: "FK10N", mod: "FI", desc: "Balance de acreedor" },
  { code: "FD10N", mod: "FI", desc: "Balance de deudor" },
  { code: "F-02", mod: "FI", desc: "Contabilizar documento — póliza manual" },
  { code: "F-28", mod: "FI", desc: "Entrada de pago" },
  { code: "F-53", mod: "FI", desc: "Compensación de proveedor" },
  { code: "F110", mod: "FI", desc: "Programa de pagos automáticos" },
  { code: "FF7A", mod: "FI", desc: "Posición de tesorería (cash flow)" },
  { code: "FAGLL03", mod: "FI", desc: "Partidas de libro mayor (nuevo GL)" },
  // CO — Controlling
  { code: "CO01", mod: "CO", desc: "Crear orden de producción" },
  { code: "CO02", mod: "CO", desc: "Modificar orden de producción" },
  { code: "CO03", mod: "CO", desc: "Visualizar orden de producción" },
  { code: "KSB1", mod: "CO", desc: "Partidas individuales de órdenes CO" },
  { code: "CJ20N", mod: "CO", desc: "Estructura de proyecto" },
  // QM — Calidad
  { code: "QA01", mod: "QM", desc: "Crear lote de inspección" },
  { code: "QA02", mod: "QM", desc: "Modificar lote de inspección" },
  { code: "QA03", mod: "QM", desc: "Visualizar lote de inspección" },
  // PP — Producción
  { code: "MD04", mod: "PP", desc: "Lista de necesidades / MRP" },
  { code: "CS01", mod: "PP", desc: "Crear lista de materiales (BOM)" },
  { code: "CR01", mod: "PP", desc: "Crear puesto de trabajo" },
  { code: "CA01", mod: "PP", desc: "Crear hoja de ruta" },
  // HR / HCM
  { code: "PA30", mod: "HR", desc: "Actualización de datos maestros de personal" },
  { code: "PA20", mod: "HR", desc: "Visualizar datos maestros de personal" },
  { code: "PT01", mod: "HR", desc: "Crear horario de trabajo" },
  { code: "PT60", mod: "HR", desc: "Evaluación de tiempos" },
  { code: "PC00_M99_CALC", mod: "HR", desc: "Cálculo de nómina" },
  // Basis / TI
  { code: "SU01", mod: "BC", desc: "Crear / gestionar usuario" },
  { code: "DB13", mod: "BC", desc: "Planificación de calendario DBA (respaldos)" },
  { code: "SM37", mod: "BC", desc: "Monitor de jobs en background" },
  { code: "SM21", mod: "BC", desc: "Log del sistema" },
  { code: "ST22", mod: "BC", desc: "Dumps ABAP" },
  { code: "SE16", mod: "BC", desc: "Visor de contenido de tabla" },
  { code: "SPRO", mod: "BC", desc: "Customizing — IMG" },
];

const LIFECYCLE = ["Creación", "Almacenamiento", "Uso", "Compartición", "Archivo", "Destrucción"];
const SEED_AREA_COLORS = ["#4285F4", "#34A853", "#FBBC04", "#EA4335", "#A142F4", "#24C1E0", "#FF6D01", "#46BDC6"];

// ============================================================================
// ENTORNOS — cada empresa con su Google Sheet y branding
// ============================================================================
// Backend intercambiable: por defecto Google Sheets/Apps Script.
// Para migrar a Databricks/Unity Catalog, define VITE_BACKEND_URL en un .env
// (p. ej. https://<app>.databricksapps.com/api) — el resto del cliente no cambia.
const DACOMSA_SHEETS_URL =
  import.meta.env.VITE_BACKEND_URL ||
  "https://script.google.com/macros/s/AKfycbzp-NY7PnftUfhByWRds5QVYYH7IP8Ax2lvBWs8BdURQOaVpiwAkUjw5S7qcMZeFlW33A/exec";

const TENANTS = [
  {
    id: "dacomsa",
    label: "Dacomsa",
    sheetsUrl: DACOMSA_SHEETS_URL,
    defaultTheme: {
      companyName: "Frasle Mobility",
      logo: "/tenants/frasle/logo.png",
      banner: null,
      primary: "#6B7280",
      mode: "light",
    },
  },
];

function getTenant(tenantId) {
  return TENANTS.find((t) => t.id === tenantId) || TENANTS[0];
}

function themeFromConfigRows(configRows, fallback) {
  const map = {};
  (configRows || []).forEach((r) => {
    const key = String(r.clave || r.key || "").trim();
    if (key) map[key] = String(r.valor ?? r.value ?? "");
  });
  const banner = map.banner?.trim();
  return {
    // Nombre y logo fijos por código (marca Frasle). Se ignora lo guardado en el Sheet.
    companyName: fallback.companyName,
    logo: fallback.logo || null,
    banner: banner || fallback.banner || null,
    // Migra el azul heredado (#4285F4) al acento silver; respeta colores custom.
    primary: (map.primary && map.primary.toLowerCase() !== "#4285f4") ? map.primary : fallback.primary,
    mode: map.mode === "light" ? "light" : (map.mode || fallback.mode),
  };
}

function themeToConfigRows(theme) {
  return [
    { clave: "companyName", valor: theme.companyName || "" },
    { clave: "logo", valor: theme.logo || "" },
    { clave: "banner", valor: theme.banner || "" },
    { clave: "primary", valor: theme.primary || "#4285F4" },
    { clave: "mode", valor: theme.mode || "dark" },
  ];
}

const DEFAULT_THEME = TENANTS[0].defaultTheme;
const uid = () => Math.random().toString(36).slice(2, 9);
const isProcessDocumented = (processId, data) => data.steps.some((s) => s.processId === processId);

const USER_ROLE_COLORS = { owner: "#4285F4", steward: "#34A853", custodian: "#A142F4", executor: "#FF6D01" };
const USER_ROLE_LABELS = { owner: "Owner", steward: "Steward", custodian: "Custodian", executor: "Ejecutor" };

function buildKeyUsers(data) {
  const map = new Map();
  const touch = (raw, processId, roleType) => {
    const email = String(raw || "").trim().toLowerCase();
    if (!email) return;
    if (!map.has(email)) {
      map.set(email, {
        id: email,
        label: email.includes("@") ? email.split("@")[0] : email,
        email,
        roles: new Set(),
        processIds: new Set(),
      });
    }
    const u = map.get(email);
    u.roles.add(roleType);
    u.processIds.add(processId);
  };
  data.roles.forEach((r) => touch(r.email || r.person, r.processId, r.type));
  data.processes.forEach((p) => (p.executors || []).forEach((e) => touch(e, p.id, "executor")));
  return [...map.values()].map((u) => ({ ...u, roles: [...u.roles] }));
}

function AreaColorPicker({ color, onChange, t, swatchSize = 16 }) {
  const current = color || t.primary;
  const inPalette = SEED_AREA_COLORS.includes(current);
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
      {SEED_AREA_COLORS.map((c) => (
        <div key={c} onClick={() => onChange(c)} title={c} style={{
          width: swatchSize, height: swatchSize, borderRadius: 5, background: c, cursor: "pointer",
          border: current === c ? `2px solid ${t.text}` : "2px solid transparent",
        }} />
      ))}
      <label title="Color personalizado" style={{
        width: swatchSize + 6, height: swatchSize + 6, borderRadius: 6, cursor: "pointer",
        border: !inPalette ? `2px solid ${t.text}` : `1px solid ${t.border}`,
        overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center",
        background: t.surfaceSolid, position: "relative",
      }}>
        <Palette size={swatchSize - 4} color={!inPalette ? current : t.textFaint} />
        <input type="color" value={current} onChange={(e) => onChange(e.target.value)}
          style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%", height: "100%" }} />
      </label>
    </div>
  );
}

function dedupeById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function dedupeAreas(items) {
  const seenId = new Set();
  const seenName = new Set();
  return items.filter((item) => {
    if (!item?.id) return false;
    const nameKey = (item.name || "").trim().toLowerCase();
    if (seenId.has(item.id) || (nameKey && seenName.has(nameKey))) return false;
    seenId.add(item.id);
    if (nameKey) seenName.add(nameKey);
    return true;
  });
}

function catalogHasContent(catalog) {
  if (!catalog) return false;
  return !!(
    catalog.areas?.length || catalog.processes?.length || catalog.steps?.length
    || catalog.sources?.length || catalog.fields?.length || catalog.roles?.length
    || catalog.dataCatalogs?.length
  );
}

function safeParseDate(str) {
  if (!str) return 0;
  let parsed = Date.parse(str);
  if (!Number.isNaN(parsed)) return parsed;
  // Soporte para DD/MM/YYYY HH:MM:SS
  const ddmmyyyyMatch = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})\s*(\d{1,2})?:?(\d{2})?:?(\d{2})?$/);
  if (ddmmyyyyMatch) {
    const [, d, m, y, hr = 0, min = 0, sec = 0] = ddmmyyyyMatch;
    return new Date(y, m - 1, d, hr, min, sec).getTime();
  }
  // Soporte para YYYY-MM-DD HH:MM:SS
  const yyyymmddMatch = str.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s*(\d{1,2})?:?(\d{2})?:?(\d{2})?$/);
  if (yyyymmddMatch) {
    const [, y, m, d, hr = 0, min = 0, sec = 0] = yyyymmddMatch;
    return new Date(y, m - 1, d, hr, min, sec).getTime();
  }
  return 0;
}

function maxProcessLastModified(processes) {
  let max = 0;
  (processes || []).forEach((p) => {
    const ts = safeParseDate(p.lastModified || "");
    if (ts > max) max = ts;
  });
  return max || null;
}

function processLastModifiedTs(catalogData, processId) {
  const proc = catalogData?.processes?.find((p) => p.id === processId);
  return safeParseDate(proc?.lastModified || "");
}

function mergeAreaColors(...maps) {
  return Object.assign({}, ...maps.filter(Boolean));
}

function mergeCatalogOnBoot(remote, local, remoteColors, localColors, remoteLoaded = false) {
  const empty = {
    areas: [], processes: [], steps: [], sources: [], fields: [], roles: [],
    dataCatalogs: [], catalogColumns: [], catalogRows: [],
  };
  const remoteData = remote ? normalizeCatalogData(remote) : empty;
  const localData = local ? normalizeCatalogData({ ...empty, ...local }) : empty;
  const localHas = catalogHasContent(localData);

  // Si la carga remota respondió, Sheets manda en conflictos — PERO no perdemos
  // flujos locales que el remoto no tiene y que no están borrados (tombstone). Así,
  // si el Sheet quedó vacío o incompleto, el flujo en caché se conserva y se re-sube
  // en vez de desaparecer. Los borrados (deletedIds remoto) sí se respetan.
  if (remoteLoaded) {
    const remoteProcIds = new Set(remoteData.processes.map((p) => p.id));
    const remoteDeleted = new Set((remoteData.deletedIds || []).map((d) => d.id));
    const localExtraProcs = localData.processes.filter(
      (p) => !remoteProcIds.has(p.id) && !remoteDeleted.has(p.id),
    );
    if (!localExtraProcs.length) {
      return {
        data: remoteData,
        areaColors: mergeAreaColors(remoteColors, localColors),
        restoredLocal: false,
      };
    }
    const extraProcIds = new Set(localExtraProcs.map((p) => p.id));
    const localExtraSources = localData.sources.filter((s) => extraProcIds.has(s.processId));
    const extraSourceIds = new Set(localExtraSources.map((s) => s.id));
    const unioned = normalizeCatalogData({
      areas: [...remoteData.areas, ...localData.areas],
      processes: [...remoteData.processes, ...localExtraProcs],
      steps: [...remoteData.steps, ...localData.steps.filter((s) => extraProcIds.has(s.processId))],
      sources: [...remoteData.sources, ...localExtraSources],
      fields: [...remoteData.fields, ...localData.fields.filter((f) => extraSourceIds.has(f.sourceId))],
      roles: [...remoteData.roles, ...localData.roles.filter((r) => extraProcIds.has(r.processId))],
      dataCatalogs: remoteData.dataCatalogs,
      catalogColumns: remoteData.catalogColumns,
      catalogRows: remoteData.catalogRows,
      deletedIds: remoteData.deletedIds || [],
    });
    return {
      data: unioned,
      areaColors: mergeAreaColors(remoteColors, localColors),
      restoredLocal: true,
    };
  }
  if (localHas) {
    return {
      data: localData,
      areaColors: localColors || {},
      restoredLocal: false,
    };
  }
  return { data: remoteData, areaColors: remoteColors || {}, restoredLocal: false };
}

// PARADIGMA: el push NO sobrescribe el catálogo remoto. Fusiona: los procesos que
// tiene el cliente local mandan (él los edita), pero los procesos que solo existen en
// remoto (de otros usuarios) se conservan. Los borrados (deletedIds) se unen. Así dos
// usuarios editando flujos distintos no se pisan y ambos coexisten en el Sheet.
function mergeCatalogsForPush(local, remote) {
  const l = normalizeCatalogData(local || {});
  const r = normalizeCatalogData(remote || {});
  const localProcIds = new Set(l.processes.map((p) => p.id));
  const localDeleted = new Set((l.deletedIds || []).map((d) => d.id));

  // Procesos que solo existen en remoto (de otros) y que localmente NO se borraron.
  const remoteExtraProcs = r.processes.filter(
    (p) => !localProcIds.has(p.id) && !localDeleted.has(p.id),
  );
  const extraProcIds = new Set(remoteExtraProcs.map((p) => p.id));
  const remoteExtraSources = r.sources.filter((s) => extraProcIds.has(s.processId));
  const extraSourceIds = new Set(remoteExtraSources.map((s) => s.id));

  return normalizeCatalogData({
    areas: [...l.areas, ...r.areas], // dedupe conserva la primera (local manda)
    processes: [...l.processes, ...remoteExtraProcs],
    steps: [...l.steps, ...r.steps.filter((s) => extraProcIds.has(s.processId))],
    sources: [...l.sources, ...remoteExtraSources],
    fields: [...l.fields, ...r.fields.filter((f) => extraSourceIds.has(f.sourceId))],
    roles: [...l.roles, ...r.roles.filter((rr) => extraProcIds.has(rr.processId))],
    dataCatalogs: [...l.dataCatalogs, ...r.dataCatalogs],
    catalogColumns: [...l.catalogColumns, ...r.catalogColumns],
    catalogRows: [...l.catalogRows, ...r.catalogRows],
    people: [...r.people, ...l.people],
    deletedIds: [...(l.deletedIds || []), ...(r.deletedIds || [])],
  });
}

// Al APLICAR lo remoto (poll), lo remoto manda para lo compartido, pero conservamos
// las CREACIONES locales que aún no están en remoto (áreas/procesos nuevos no borrados),
// para que no desaparezcan por una actualización de otro usuario. Se re-suben después.
function mergeRemoteKeepingLocalExtras(local, remote) {
  const l = normalizeCatalogData(local || {});
  const r = normalizeCatalogData(remote || {});
  const remoteAreaIds = new Set(r.areas.map((a) => a.id));
  const remoteProcIds = new Set(r.processes.map((p) => p.id));
  const remoteDeleted = new Set((r.deletedIds || []).map((d) => d.id));
  const extraAreas = l.areas.filter((a) => !remoteAreaIds.has(a.id) && !remoteDeleted.has(a.id));
  const extraProcs = l.processes.filter((p) => !remoteProcIds.has(p.id) && !remoteDeleted.has(p.id));
  const extraProcIds = new Set(extraProcs.map((p) => p.id));
  const extraSources = l.sources.filter((s) => extraProcIds.has(s.processId));
  const extraSourceIds = new Set(extraSources.map((s) => s.id));
  const merged = normalizeCatalogData({
    areas: [...r.areas, ...extraAreas],
    processes: [...r.processes, ...extraProcs],
    steps: [...r.steps, ...l.steps.filter((s) => extraProcIds.has(s.processId))],
    sources: [...r.sources, ...extraSources],
    fields: [...r.fields, ...l.fields.filter((f) => extraSourceIds.has(f.sourceId))],
    roles: [...r.roles, ...l.roles.filter((rr) => extraProcIds.has(rr.processId))],
    dataCatalogs: r.dataCatalogs,
    catalogColumns: r.catalogColumns,
    catalogRows: r.catalogRows,
    people: [...r.people, ...l.people],
    deletedIds: [...(l.deletedIds || []), ...(r.deletedIds || [])],
  });
  return { merged, hasExtras: extraAreas.length > 0 || extraProcs.length > 0, extraAreaIds: extraAreas.map((a) => a.id) };
}

function normalizeCatalogData(raw) {
  const deletedIds = dedupeById(raw.deletedIds || []).map((d) => ({ id: String(d.id || "") }));
  const deletedSet = new Set(deletedIds.map((d) => d.id).filter(Boolean));

  const areas = dedupeAreas(raw.areas || []).filter((a) => !deletedSet.has(a.id));
  const areaIds = new Set(areas.map((a) => a.id));
  const processes = dedupeById(raw.processes || [])
    .filter((p) => (!p.areaId || areaIds.has(p.areaId)) && !deletedSet.has(p.id));
  const processIds = new Set(processes.map((p) => p.id));
  const steps = dedupeById(raw.steps || []).filter((s) => processIds.has(s.processId) && !deletedSet.has(s.id));
  const sources = dedupeById(raw.sources || []).filter((s) => processIds.has(s.processId) && !deletedSet.has(s.id));
  const sourceIds = new Set(sources.map((s) => s.id));
  const fields = dedupeById(raw.fields || []).filter((f) => sourceIds.has(f.sourceId) && !deletedSet.has(f.id));
  const roles = dedupeById(raw.roles || []).filter((r) => processIds.has(r.processId) && !deletedSet.has(r.id));
  const dataCatalogs = dedupeById(raw.dataCatalogs || []).map((c) => ({
    ...c,
    version: Number(c.version) || 1,
    versionHistory: Array.isArray(c.versionHistory) ? c.versionHistory : [],
  }));
  const catalogIds = new Set(dataCatalogs.map((c) => c.id));
  const catalogColumns = dedupeById(raw.catalogColumns || []).filter((c) => catalogIds.has(c.catalogId))
    .map((col) => ({
      ...col,
      predefinedValues: Array.isArray(col.predefinedValues)
        ? col.predefinedValues
        : String(col.predefinedValues || "").split(/[|\n]/).map((v) => v.trim()).filter(Boolean),
    }));
  const catalogRows = dedupeById(raw.catalogRows || []).filter((r) => catalogIds.has(r.catalogId))
    .map((r) => ({ ...r, values: r.values && typeof r.values === "object" ? r.values : {} }));
  // Personas: directorio de email → nombre + foto. Dedupe por email (última gana).
  const peopleMap = {};
  (raw.people || []).forEach((p) => {
    const email = String(p.email || "").trim().toLowerCase();
    if (!email) return;
    peopleMap[email] = {
      email,
      name: String(p.name || peopleMap[email]?.name || "").trim(),
      photoUrl: String(p.photoUrl || peopleMap[email]?.photoUrl || "").trim(),
    };
  });
  const people = Object.values(peopleMap);
  return { areas, processes, steps, sources, fields, roles, dataCatalogs, catalogColumns, catalogRows, deletedIds, people };
}

function parseSheetsToData(rows) {
  if (!rows || !rows.areas) return null;

  const areas = (rows.areas || []).map((a) => ({
    id: String(a.id || ""),
    name: String(a.nombre || a.name || ""),
  })).filter((a) => a.id && a.name);

  const areaByName = Object.fromEntries(areas.map((a) => [a.name, a.id]));

  const processes = (rows.processes || []).map((p) => ({
    id: String(p.id || ""),
    areaId: areaByName[String(p.area || "")] || areas[0]?.id || "",
    subArea: String(p.subArea || ""),
    name: String(p.nombre || p.name || ""),
    trigger: String(p.disparador || p.trigger || ""),
    executors: String(p.ejecutores || "").split(/,\s*/).filter(Boolean),
    version: Number(p.version) || 1,
    lastModified: String(p.ultimaModificacion || p.lastModified || ""),
    versionHistory: [],
  })).filter((p) => p.id && p.name);

  const procByName = Object.fromEntries(processes.map((p) => [p.name, p.id]));

  const sources = (rows.sources || []).map((s) => ({
    id: String(s.id || ""),
    processId: procByName[String(s.proceso || "")] || "",
    kind: String(s.tipo || s.kind || "erp"),
    code: String(s.codigo || s.code || ""),
    where: String(s.sistema || s.where || ""),
  })).filter((s) => s.id);

  const srcByProcCode = Object.fromEntries(
    sources.filter((s) => s.code).map((s) => [`${s.processId}|${s.code}`, s.id]),
  );

  const steps = (rows.steps || []).map((st) => {
    const processId = procByName[String(st.proceso || "")] || "";
    let sourceId = st.sourceId ? String(st.sourceId) : null;
    if (!sourceId && st.transaccion && processId) {
      sourceId = srcByProcCode[`${processId}|${String(st.transaccion)}`] || null;
    }
    return {
      id: String(st.id || ""),
      processId,
      name: String(st.nombre || st.name || ""),
      order: Number(st.orden ?? st.order ?? 0),
      sourceId,
      stepAreaId: areaByName[String(st.areaResponsable || "")] || "",
      isJoinPoint: /^s[ií]/i.test(String(st.esUnion || "")) || isJoinStepRecord({ name: String(st.nombre || st.name || "") }),
      parentStepId: String(st.parentStepId || st.pasoPadre || "").trim() || null,
      joinStepId: String(st.joinStepId || st.pasoUnion || "").trim() || null,
      pathLabel: String(st.etiquetaRama || st.pathLabel || "").trim(),
    };
  }).filter((s) => s.id);

  const firstStepByProc = {};
  steps.forEach((s) => { if (!firstStepByProc[s.processId]) firstStepByProc[s.processId] = s.id; });

  const fields = (rows.fields || []).map((f) => {
    let sourceId = f.sourceId ? String(f.sourceId) : null;
    if (!sourceId && f.transaccion) {
      const procId = procByName[String(f.proceso || "")];
      if (procId) sourceId = srcByProcCode[`${procId}|${String(f.transaccion)}`] || null;
    }
    return {
      id: String(f.id || ""),
      sourceId: sourceId || "",
      name: String(f.dato || f.name || ""),
      description: String(f.significado || f.description || ""),
      example: String(f.ejemplo || f.example || ""),
      sensitive: /^s[ií]/i.test(String(f.sensible || "")),
    };
  }).filter((f) => f.id && f.sourceId);

  const roles = (rows.roles || []).map((r) => {
    const processId = procByName[String(r.proceso || "")] || "";
    let stepId = r.stepId ? String(r.stepId) : null;
    if (!stepId && processId) stepId = firstStepByProc[processId] || null;
    return {
      id: String(r.id || uid()),
      processId,
      stepId,
      type: String(r.tipo || r.type || "owner"),
      person: String(r.persona || r.person || ""),
      email: String(r.email || ""),
    };
  }).filter((r) => r.processId);

  const catalogByName = Object.fromEntries(
    (rows.dataCatalogs || []).map((c) => [String(c.nombre || c.name || ""), String(c.id || "")]),
  );

  const dataCatalogs = (rows.dataCatalogs || []).map((c) => {
    let versionHistory = [];
    try {
      const rawHist = c.historialVersiones || c.versionHistory || "[]";
      versionHistory = typeof rawHist === "string" ? JSON.parse(rawHist) : rawHist;
    } catch (_) { versionHistory = []; }
    return {
      id: String(c.id || ""),
      name: String(c.nombre || c.name || ""),
      description: String(c.descripcion || c.description || ""),
      areaId: areaByName[String(c.area || "")] || "",
      lastModified: String(c.ultimaModificacion || c.lastModified || ""),
      version: Number(c.version) || 1,
      versionHistory: Array.isArray(versionHistory) ? versionHistory : [],
    };
  }).filter((c) => c.id && c.name);

  const catalogColumns = (rows.catalogColumns || []).map((col) => ({
    id: String(col.id || ""),
    catalogId: catalogByName[String(col.catalogo || col.catalog || "")] || String(col.catalogId || ""),
    name: String(col.nombre || col.name || ""),
    dataType: String(col.tipo || col.dataType || "text"),
    description: String(col.descripcion || col.description || ""),
    productOwner: String(col.productOwner || col.owner || ""),
    context: String(col.contexto || col.context || ""),
    predefinedValues: String(col.valoresPredefinidos || col.predefinedValues || "")
      .split(/[|\n]/).map((v) => v.trim()).filter(Boolean),
    order: Number(col.orden ?? col.order ?? 0),
    required: /^s[ií]/i.test(String(col.requerido || col.required || "")),
  })).filter((c) => c.id && c.catalogId);

  const catalogRows = (rows.catalogRows || []).map((r) => {
    let values = {};
    try {
      const rawVals = r.valores || r.values || "{}";
      values = typeof rawVals === "string" ? JSON.parse(rawVals) : rawVals;
    } catch (_) { values = {}; }
    return {
      id: String(r.id || ""),
      catalogId: catalogByName[String(r.catalogo || r.catalog || "")] || String(r.catalogId || ""),
      order: Number(r.orden ?? r.order ?? 0),
      values: values && typeof values === "object" ? values : {},
    };
  }).filter((r) => r.id && r.catalogId);

  const deletedIds = (rows.deletedIds || []).map((d) => ({
    id: String(d.id || ""),
  })).filter((d) => d.id);

  const people = (rows.people || []).map((p) => ({
    email: String(p.email || p.correo || "").trim().toLowerCase(),
    name: String(p.nombre || p.name || "").trim(),
    photoUrl: String(p.foto || p.photoUrl || "").trim(),
  })).filter((p) => p.email);

  return normalizeCatalogData({
    areas, processes,
    steps: resolveStepTreeMetadata(steps),
    sources, fields, roles, dataCatalogs, catalogColumns, catalogRows,
    deletedIds, people,
  });
}

const DUMMY_PROCESS_NAME = "Proceso dummy";
const DUMMY_AREA_NAME = "Pruebas";

const DUMMY_STEP_BLUEPRINT = [
  { name: "Inicio del flujo", code: "DUMMY-01", assign: true },
  { name: "Validar camino A", code: "DUMMY-02A", assign: true },
  { name: "Procesar camino A", code: "DUMMY-03A", assign: true },
  { name: "Validar camino B", code: "DUMMY-02B", assign: false },
  { name: "Unión de ramas", code: "DUMMY-JOIN-1", join: true },
  { name: "Consolidar resultados", code: "DUMMY-04", assign: true },
  { name: "Revisión paralela A", code: "DUMMY-05A", assign: true },
  { name: "Revisión paralela B", code: "DUMMY-05B", assign: false },
  { name: "Unión de ramas", code: "DUMMY-JOIN-2", join: true },
  { name: "Cierre y notificación", code: "DUMMY-06", assign: true },
];

function buildDummyProcessPayload(areaId) {
  const processId = uid();
  const steps = [];
  const sources = [];
  const fields = [];
  const roles = [];
  let order = 0;

  DUMMY_STEP_BLUEPRINT.forEach((st) => {
    const stepId = uid();
    const sourceId = uid();
    steps.push({
      id: stepId, processId, name: st.name, order: order++,
      sourceId, stepAreaId: "", isJoinPoint: !!st.join,
    });
    sources.push({
      id: sourceId, processId, kind: "erp", code: st.code, where: "POC",
    });
    fields.push({
      id: uid(), sourceId, name: "Estado",
      description: `Indicador del paso ${st.name}`,
      example: st.join ? "Convergido" : "OK", sensitive: false,
    });
    if (st.assign) {
      roles.push({
        id: uid(), processId, stepId, type: "owner",
        person: "Owner Dummy", email: "dummy.owner@empresa.com",
      });
    }
  });

  return {
    process: {
      id: processId, areaId, name: DUMMY_PROCESS_NAME,
      trigger: "Proceso de prueba con bifurcaciones y uniones para el mapa de relaciones",
      subArea: "POC", executors: ["Owner Dummy"], version: 1,
      lastModified: new Date().toISOString(), versionHistory: [],
    },
    steps, sources, fields, roles,
  };
}

async function loadFromSheets(sheetsUrl, tenantDefaultTheme = DEFAULT_THEME) {
  if (!sheetsUrl) return null;

  const parseResponse = (json) => {
    if (json.status === "error") return null;
    const payload = json.data || json;
    const parsed = parseSheetsToData(payload);
    if (!parsed) return null;
    const areaColors = {};
    (payload.areas || []).forEach((a) => {
      if (a.id && a.color) areaColors[String(a.id)] = String(a.color);
    });
    const theme = themeFromConfigRows(payload.configuracion, tenantDefaultTheme);
    const activeEditions = payload.edicionesActivas !== undefined
      ? parseActiveEditions(payload.edicionesActivas)
      : undefined;
    return { data: parsed, areaColors, theme, activeEditions };
  };

  const attempts = [
    () => fetch(sheetsUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "load" }),
      redirect: "follow",
    }),
    () => fetch(`${sheetsUrl}${sheetsUrl.includes("?") ? "&" : "?"}action=load`, { redirect: "follow" }),
  ];

  for (const attempt of attempts) {
    try {
      const response = await attempt();
      const json = await response.json();
      const parsed = parseResponse(json);
      if (parsed) return parsed;
    } catch (err) {
      console.warn("Carga remota falló:", err);
    }
  }
  return null;
}

// ============================================================================
// COLABORACIÓN — bloqueos de paso + revisiones remotas (vía Sheets)
// ============================================================================
const COLLAB_SESSION_KEY = "gov:collabSession";
const COLLAB_POLL_MS = 5000;
const WORKING_COPY_SYNC_MS = 1000;
const LOCK_HEARTBEAT_MS = 25000;

function catalogRevisionFingerprint(catalog) {
  const data = normalizeCatalogData(catalog || {});
  const maxMod = maxProcessLastModified(data.processes);
  return [
    data.areas.length,
    data.processes.length,
    data.steps.length,
    maxMod || 0,
  ].join(":");
}

function parseActiveEditions(rows) {
  return (rows || []).map((r) => ({
    id: String(r.id || ""),
    sessionId: String(r.sessionId || ""),
    usuario: String(r.usuario || r.user || ""),
    email: String(r.email || ""),
    processId: String(r.processId || ""),
    stepId: String(r.stepId || ""),
    lockedAt: String(r.bloqueadoEn || r.lockedAt || ""),
    heartbeatAt: String(r.latido || r.heartbeatAt || ""),
  })).filter((r) => r.processId && r.stepId && r.sessionId);
}

function stepLocksMapFromEditions(editions) {
  const map = {};
  parseActiveEditions(editions).forEach((e) => {
    map[`${e.processId}:${e.stepId}`] = e;
  });
  return map;
}

function stepLockStorageId(st) {
  if (st?.persistedId) return st.persistedId;
  return `draft:${st?.tmpId || ""}`;
}

function lockEditorLabel(lock) {
  if (!lock) return "";
  return (lock.usuario || lock.email || "Otro usuario").trim();
}

function buildProcessLockByTmpId(processId, stepLocks, treeSteps) {
  const map = {};
  if (!processId || !stepLocks) return map;
  (treeSteps || []).forEach((st) => {
    if (st.isJoinPoint) return;
    const stepId = stepLockStorageId(st);
    const lock = stepLocks[`${processId}:${stepId}`];
    if (lock) map[st.tmpId] = lock;
  });
  return map;
}

function summarizeProcessCollab(processId, stepLocks, treeSteps, sessionId) {
  const lockByTmp = buildProcessLockByTmpId(processId, stepLocks, treeSteps);
  const others = [];
  let selfTmpId = null;
  Object.entries(lockByTmp).forEach(([tmpId, lock]) => {
    const st = treeSteps.find((s) => s.tmpId === tmpId);
    const entry = {
      tmpId,
      stepName: st?.name || "Paso",
      who: lockEditorLabel(lock),
      email: lock.email || "",
    };
    if (lock.sessionId === sessionId) selfTmpId = tmpId;
    else others.push(entry);
  });
  return { lockByTmp, others, selfTmpId, totalActive: Object.keys(lockByTmp).length };
}

async function saveCollabSession(session) {
  await store.set(COLLAB_SESSION_KEY, session);
}

// ============================================================================
// AUTENTICACIÓN — login, super usuario, registro de editores
// ============================================================================
const AUTH_SESSION_KEY = "gov:authSession";
const LOCAL_USERS_KEY = "gov:localUsers";

/** Respaldo local si el Apps Script aún no tiene login configurado. */
const LOCAL_AUTH_SEED = {
  id: "super-local-seed",
  nombre: "Super Admin",
  email: "admin@dacomsa.com",
  password: "Gobernanza2026!",
  rol: "super",
  activo: true,
};

/** Editor de prueba — se agrega automáticamente en auth local. */
const LOCAL_TEST_EDITOR = {
  id: "editor-test",
  nombre: "María Editora",
  email: "editor@dacomsa.com",
  password: "Editor2026!",
  rol: "editor",
  activo: true,
};

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadLocalUsers() {
  let users = await store.get(LOCAL_USERS_KEY);
  if (!users?.length) {
    const hash = await sha256Hex(LOCAL_AUTH_SEED.password);
    users = [{
      id: LOCAL_AUTH_SEED.id,
      nombre: LOCAL_AUTH_SEED.nombre,
      email: LOCAL_AUTH_SEED.email.toLowerCase(),
      passwordHash: hash,
      rol: "super",
      activo: true,
      creadoEn: new Date().toISOString(),
    }];
  }
  const editorEmail = LOCAL_TEST_EDITOR.email.toLowerCase();
  if (!users.some((u) => u.email === editorEmail)) {
    const editorHash = await sha256Hex(LOCAL_TEST_EDITOR.password);
    users.push({
      id: LOCAL_TEST_EDITOR.id,
      nombre: LOCAL_TEST_EDITOR.nombre,
      email: editorEmail,
      passwordHash: editorHash,
      rol: "editor",
      activo: true,
      creadoEn: new Date().toISOString(),
      creadoPor: "seed",
    });
  }
  await store.set(LOCAL_USERS_KEY, users);
  return users;
}

async function saveLocalUsers(users) {
  await store.set(LOCAL_USERS_KEY, users);
}

async function localLogin(email, password) {
  const users = await loadLocalUsers();
  const hash = await sha256Hex(password);
  const user = users.find((u) =>
    u.email === email.trim().toLowerCase() && u.passwordHash === hash && u.activo !== false);
  if (!user) return { ok: false, error: "Correo o contraseña incorrectos" };
  const session = {
    token: uid() + uid(),
    user: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol },
    savedAt: new Date().toISOString(),
  };
  await store.set(AUTH_SESSION_KEY, session);
  return { ok: true, ...session };
}

async function localRegisterUser(superToken, { nombre, email, password, rol = "editor" }) {
  const session = await store.get(AUTH_SESSION_KEY);
  if (!session || session.token !== superToken || session.user?.rol !== "super") {
    return { ok: false, error: "Sin permiso" };
  }
  const users = await loadLocalUsers();
  const lower = email.trim().toLowerCase();
  if (users.some((u) => u.email === lower)) return { ok: false, error: "Ese correo ya existe" };
  const hash = await sha256Hex(password);
  users.push({
    id: uid(),
    nombre: nombre.trim(),
    email: lower,
    passwordHash: hash,
    rol: rol === "super" ? "super" : "editor",
    activo: true,
    creadoEn: new Date().toISOString(),
    creadoPor: session.user.email,
  });
  await saveLocalUsers(users);
  return { ok: true };
}

async function localListUsers(superToken) {
  const session = await store.get(AUTH_SESSION_KEY);
  if (!session || session.token !== superToken || session.user?.rol !== "super") return [];
  const users = await loadLocalUsers();
  return users.map(({ passwordHash, ...u }) => u);
}

async function remoteLogin(sheetsUrl, email, password) {
  const json = await postSheetsAction(sheetsUrl, { action: "login", email, password });
  if (!json || json.status !== "ok" || !json.token || !json.user) {
    return localLogin(email, password);
  }
  const session = {
    token: json.token,
    user: json.user,
    savedAt: new Date().toISOString(),
  };
  await store.set(AUTH_SESSION_KEY, session);
  return { ok: true, ...session };
}

async function remoteRegisterUser(sheetsUrl, token, payload) {
  const json = await postSheetsAction(sheetsUrl, {
    action: "registerUser", token, ...payload,
  });
  if (!json || json.status !== "ok") {
    return { ok: false, error: json?.message || "No se pudo registrar" };
  }
  return { ok: true };
}

async function remoteListUsers(sheetsUrl, token) {
  const json = await postSheetsAction(sheetsUrl, { action: "listUsers", token });
  if (!json || json.status !== "ok") return [];
  return json.users || [];
}

async function remoteValidateSession(sheetsUrl, token) {
  const json = await postSheetsAction(sheetsUrl, { action: "validateSession", token });
  if (!json || json.status !== "ok") return null;
  return json.user;
}

const remoteAuthCache = { url: null, available: null };

async function isRemoteAuthAvailable(sheetsUrl) {
  if (!sheetsUrl) return false;
  if (remoteAuthCache.url === sheetsUrl && remoteAuthCache.available !== null) {
    return remoteAuthCache.available;
  }
  const check = await postSheetsAction(sheetsUrl, { action: "checkAuth" });
  const available = !!(check && typeof check.needsBootstrap === "boolean");
  remoteAuthCache.url = sheetsUrl;
  remoteAuthCache.available = available;
  return available;
}

async function localBootstrapSuper({ nombre, email, password }) {
  const lower = String(email || "").trim().toLowerCase();
  const name = String(nombre || "").trim();
  if (!name || !lower || !password) {
    return { ok: false, error: "Completa nombre, correo y contraseña" };
  }
  const hash = await sha256Hex(password);
  const user = {
    id: uid(),
    nombre: name,
    email: lower,
    passwordHash: hash,
    rol: "super",
    activo: true,
    creadoEn: new Date().toISOString(),
    creadoPor: "bootstrap",
  };
  await saveLocalUsers([user]);
  return localLogin(email, password);
}

async function remoteBootstrapSuper(sheetsUrl, { nombre, email, password }) {
  const json = await postSheetsAction(sheetsUrl, {
    action: "bootstrapSuper", nombre, email, password,
  });
  if (json?.status === "ok" && json.token && json.user) {
    const session = {
      token: json.token,
      user: json.user,
      savedAt: new Date().toISOString(),
    };
    await store.set(AUTH_SESSION_KEY, session);
    return { ok: true, ...session, authMode: "remote" };
  }
  // Script sin login todavía: crear super en este navegador para desbloquear la app
  const local = await localBootstrapSuper({ nombre, email, password });
  if (local.ok) return { ...local, authMode: "local", localFallback: true };
  return {
    ok: false,
    error: json?.message || "No se pudo crear super usuario. Verifica nombre, correo y contraseña.",
  };
}

async function bootstrapSuperUser(sheetsUrl, payload) {
  if (sheetsUrl) return remoteBootstrapSuper(sheetsUrl, payload);
  const users = await loadLocalUsers();
  const lower = payload.email.trim().toLowerCase();
  const existing = users.find((u) => u.email === lower);
  if (existing) return localLogin(payload.email, payload.password);
  if (users.length > 0 && !existing) {
    return { ok: false, error: "Ya existe un super usuario en este navegador. Inicia sesión con ese correo." };
  }
  return localBootstrapSuper(payload);
}

async function checkAuthNeedsBootstrap(sheetsUrl) {
  if (!sheetsUrl) return false;
  if (!(await isRemoteAuthAvailable(sheetsUrl))) {
    const saved = await loadAuthSession();
    return !saved?.user?.email;
  }
  const check = await postSheetsAction(sheetsUrl, { action: "checkAuth" });
  return check?.needsBootstrap === true;
}

async function loginUser(sheetsUrl, email, password) {
  if (sheetsUrl && await isRemoteAuthAvailable(sheetsUrl)) {
    return remoteLogin(sheetsUrl, email, password);
  }
  return localLogin(email, password);
}

async function registerAppUser(sheetsUrl, token, payload) {
  if (sheetsUrl) return remoteRegisterUser(sheetsUrl, token, payload);
  return localRegisterUser(token, payload);
}

async function listAppUsers(sheetsUrl, token) {
  if (sheetsUrl) return remoteListUsers(sheetsUrl, token);
  return localListUsers(token);
}

async function loadAuthSession() {
  return store.get(AUTH_SESSION_KEY);
}

async function clearAuthSession() {
  await store.set(AUTH_SESSION_KEY, null);
}

function authUserToCollabSession(authUser, existingSession) {
  return {
    sessionId: existingSession?.sessionId || uid() + uid(),
    usuario: authUser.nombre,
    email: authUser.email,
    userId: authUser.id,
    rol: authUser.rol,
  };
}

function isSuperUser(user) {
  return user?.rol === "super";
}

async function postSheetsAction(sheetsUrl, body) {
  if (!sheetsUrl || !body?.action) return null;
  try {
    const response = await fetch(sheetsUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
      redirect: "follow",
    });
    const text = await response.text();
    try { return JSON.parse(text); } catch (_) { return null; }
  } catch (err) {
    console.warn("Acción remota falló:", err);
    return null;
  }
}

async function acquireStepLockRemote(sheetsUrl, { sessionId, email, usuario, processId, stepId }) {
  return postSheetsAction(sheetsUrl, {
    action: "acquireLock",
    sessionId,
    email,
    usuario,
    processId,
    stepId,
  });
}

async function releaseStepLockRemote(sheetsUrl, { sessionId, processId, stepId }) {
  return postSheetsAction(sheetsUrl, {
    action: "releaseLock",
    sessionId,
    processId,
    stepId,
  });
}

async function releaseSessionLocksRemote(sheetsUrl, sessionId) {
  return postSheetsAction(sheetsUrl, { action: "releaseSession", sessionId });
}

async function heartbeatLocksRemote(sheetsUrl, sessionId) {
  return postSheetsAction(sheetsUrl, { action: "heartbeat", sessionId });
}

// Sync a Google Sheets vía Google Apps Script webhook
async function syncToSheets(data, areaColors, theme, sheetsUrl) {
  if (!sheetsUrl) return { ok: false, error: "Sin URL de Sheets para este entorno" };
  const clean = normalizeCatalogData(data);
  const rows = {
    areas: [], processes: [], steps: [], sources: [], fields: [], roles: [],
    dataCatalogs: [], catalogColumns: [], catalogRows: [],
    configuracion: themeToConfigRows(theme || DEFAULT_THEME),
    deletedIds: [], people: [],
  };

  clean.areas.forEach((a) => rows.areas.push({
    id: a.id, nombre: a.name, color: areaColors[a.id] || "",
  }));
  clean.processes.forEach((p) => {
    const area = clean.areas.find((a) => a.id === p.areaId);
    rows.processes.push({
      id: p.id, area: area ? area.name : "", subArea: p.subArea || "",
      nombre: p.name, disparador: p.trigger || "",
      ejecutores: (p.executors || []).join(", "),
      version: p.version || 1, ultimaModificacion: p.lastModified || "",
    });
  });
  clean.steps.forEach((st) => {
    const proc = clean.processes.find((p) => p.id === st.processId);
    const area = proc ? clean.areas.find((a) => a.id === proc.areaId) : null;
    const stepArea = st.stepAreaId ? clean.areas.find((a) => a.id === st.stepAreaId) : null;
    const src = st.sourceId ? clean.sources.find((s) => s.id === st.sourceId) : null;
    rows.steps.push({
      id: st.id, proceso: proc ? proc.name : "", area: area ? area.name : "",
      orden: st.order, nombre: st.name,
      areaResponsable: stepArea ? stepArea.name : "",
      sourceId: st.sourceId || "", transaccion: src ? src.code : "",
      parentStepId: st.parentStepId || "", joinStepId: st.joinStepId || "",
      etiquetaRama: st.pathLabel || "", esUnion: st.isJoinPoint ? "Sí" : "No",
    });
  });
  clean.sources.forEach((s) => {
    const proc = clean.processes.find((p) => p.id === s.processId);
    rows.sources.push({
      id: s.id, proceso: proc ? proc.name : "",
      tipo: s.kind, codigo: s.code, sistema: s.where || "",
    });
  });
  clean.fields.forEach((f) => {
    const src = clean.sources.find((s) => s.id === f.sourceId);
    const proc = src ? clean.processes.find((p) => p.id === src.processId) : null;
    const area = proc ? clean.areas.find((a) => a.id === proc.areaId) : null;
    rows.fields.push({
      id: f.id, sourceId: f.sourceId, dato: f.name, significado: f.description || "",
      ejemplo: f.example || "", sensible: f.sensitive ? "Sí" : "No",
      transaccion: src ? src.code : "", proceso: proc ? proc.name : "",
      area: area ? area.name : "",
    });
  });
  clean.roles.forEach((r) => {
    const proc = clean.processes.find((p) => p.id === r.processId);
    rows.roles.push({
      id: r.id, proceso: proc ? proc.name : "", stepId: r.stepId || "",
      tipo: r.type, email: r.email || "", persona: r.person || "",
    });
  });
  clean.dataCatalogs.forEach((c) => {
    const area = clean.areas.find((a) => a.id === c.areaId);
    rows.dataCatalogs.push({
      id: c.id, nombre: c.name, descripcion: c.description || "",
      area: area ? area.name : "", ultimaModificacion: c.lastModified || "",
      version: c.version || 1,
      historialVersiones: JSON.stringify(c.versionHistory || []),
    });
  });
  const catalogById = Object.fromEntries(clean.dataCatalogs.map((c) => [c.id, c.name]));
  clean.catalogColumns.forEach((col) => {
    rows.catalogColumns.push({
      id: col.id, catalogo: catalogById[col.catalogId] || "",
      nombre: col.name, tipo: col.dataType || "text",
      descripcion: col.description || "", productOwner: col.productOwner || "",
      contexto: col.context || "",
      valoresPredefinidos: (col.predefinedValues || []).join("|"),
      orden: col.order ?? 0, requerido: col.required ? "Sí" : "No",
    });
  });
  clean.catalogRows.forEach((r) => {
    rows.catalogRows.push({
      id: r.id, catalogo: catalogById[r.catalogId] || "",
      orden: r.order ?? 0, valores: JSON.stringify(r.values || {}),
    });
  });
  clean.deletedIds.forEach((d) => {
    rows.deletedIds.push({ id: d.id });
  });
  (clean.people || []).forEach((p) => {
    rows.people.push({ email: p.email, nombre: p.name || "", foto: p.photoUrl || "" });
  });

  const body = JSON.stringify(rows);

  try {
    const response = await fetch(sheetsUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body,
      redirect: "follow",
    });
    const text = await response.text();
    let json = {};
    try { json = JSON.parse(text); } catch (_) { /* noop */ }
    if (json.status === "error") return { ok: false, error: json.message || "Error en Sheets" };
    if (json.status === "ok" || text.includes('"status":"ok"') || text.includes('"status": "ok"')) {
      return { ok: true };
    }
    if (response.ok) return { ok: true };
    return { ok: false, error: `HTTP ${response.status}` };
  } catch (err) {
    try {
      await fetch(sheetsUrl, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body,
      });
      return { ok: true, uncertain: true };
    } catch (err2) {
      console.warn("Sync a Sheets falló:", err2);
      return { ok: false, error: String(err?.message || err2?.message || "Sin conexión") };
    }
  }
}

function useTheme(theme) {
  return useMemo(() => {
    const dark = theme.mode === "dark";
    return {
      primary: theme.primary,
      bg: dark ? "#0F1114" : "#F5F6F8",
      surfaceSolid: dark ? "#181B20" : "#FCFCFD",
      surfaceAlt: dark ? "#20242B" : "#EDEFF3",
      border: dark ? "#2B303A" : "#DCDFE6",
      text: dark ? "#E9EBEF" : "#1F2329",
      textDim: dark ? "#9BA1AC" : "#5C6270",
      textFaint: dark ? "#5C626D" : "#9AA0AB",
      dark,
    };
  }, [theme]);
}

const FONT = "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

// Utilidad: variaciones tonales por proceso dentro de un área
// Convierte hex a HSL, varía lightness y hue sutilmente, devuelve hex
function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s * 100, l * 100];
}
function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(100, s)); l = Math.max(0, Math.min(100, l));
  const a = s / 100 * Math.min(l / 100, 1 - l / 100);
  const f = (n) => { const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * Math.max(0, Math.min(1, c))).toString(16).padStart(2, "0"); };
  return "#" + f(0) + f(8) + f(4);
}
// processColor(baseHex, index, total) → hex con variación tonal
function processColor(baseHex, index, total) {
  if (total <= 1) return baseHex;
  const [h, s, l] = hexToHsl(baseHex);
  // Rango de variación: lightness ±18, hue ±12°
  const t = total > 1 ? index / (total - 1) : 0.5; // 0..1
  const newL = l + (t - 0.5) * 36; // más claro → más oscuro
  const newH = h + (t - 0.5) * 24; // giro sutil de matiz
  const newS = Math.min(100, s + (0.5 - Math.abs(t - 0.5)) * 15); // más saturado al centro
  return hslToHex(newH, newS, Math.max(25, Math.min(82, newL)));
}
const fontImport = "";

// ============================================================================
// UI PRIMITIVES
// ============================================================================
const inputStyle = (t) => ({
  width: "100%",
  boxSizing: "border-box",
  background: t.surfaceAlt,
  border: `1px solid ${t.border}`,
  borderRadius: 8,
  padding: "7px 10px",
  color: t.text,
  fontSize: 12.5,
  fontFamily: "var(--font-main)",
  outline: "none",
  transition: "border-color 0.2s, box-shadow 0.2s",
});
function Btn({ children, onClick, variant = "primary", t, style, disabled, ...rest }) {
  const classNames = `btn-premium ${variant === "primary" ? "btn-premium-primary" : ""}`;
  let inlineStyle = { ...style };
  
  if (variant === "danger") {
    inlineStyle = { 
      borderColor: "rgba(234, 67, 53, 0.3)", 
      color: "#EA4335", 
      backgroundColor: "rgba(234, 67, 53, 0.05)",
      ...style 
    };
  } else if (variant === "ghost") {
    inlineStyle = {
      backgroundColor: "transparent",
      borderColor: "var(--border-color)",
      color: "var(--text-dim)",
      ...style
    };
  } else if (variant === "soft") {
    inlineStyle = {
      backgroundColor: "var(--surface-alt)",
      borderColor: "var(--border-color)",
      color: "var(--text-main)",
      ...style
    };
  }
  
  return (
    <button 
      type="button"
      onClick={disabled ? undefined : onClick} 
      disabled={disabled} 
      className={classNames}
      style={inlineStyle} 
      {...rest}
    >
      {children}
    </button>
  );
}
function Field({ label, hint, children, t }) {
  return (
    <div style={{ marginBottom: 10 }}>
      {label && <label style={{ display: "block", fontSize: 10.5, fontWeight: 600, letterSpacing: "0.05em",
        textTransform: "uppercase", color: "var(--text-dim)", marginBottom: 4, fontFamily: "var(--font-display)" }}>{label}</label>}
      {children}
      {hint && <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 4 }}>{hint}</div>}
    </div>
  );
}
function Input({ t, style, ...rest }) {
  return <input {...rest} className="input-premium" style={style} />;
}
function Select({ t, children, style, ...rest }) {
  return <select {...rest} className="input-premium" style={{ cursor: "pointer", ...style }}>{children}</select>;
}
function Textarea({ t, style, ...rest }) {
  return <textarea {...rest} className="input-premium" style={{ minHeight: 60, resize: "vertical", lineHeight: 1.4, ...style }} />;
}

// ============================================================================
// ONBOARDING
// ============================================================================
function Onboarding({ onDone }) {
  const [theme, setTheme] = useState(DEFAULT_THEME);
  const t = useTheme(theme);
  const logoRef = useRef(); const bannerRef = useRef();
  const readImg = (file, key) => { const r = new FileReader();
    r.onload = () => setTheme((s) => ({ ...s, [key]: r.result })); r.readAsDataURL(file); };
  const palette = SEED_AREA_COLORS.slice(0, 7);

  return (
    <div style={{ minHeight: "100vh", background: t.bg, color: t.text, fontFamily: FONT,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <style>{fontImport}</style>
      <div style={{ width: "100%", maxWidth: 560 }}>
        <div style={{ marginBottom: 26 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "5px 11px",
            border: `1px solid ${t.border}`, borderRadius: 999, fontSize: 11.5, color: t.textDim,
            fontWeight: 500, marginBottom: 18 }}>
            <span style={{ width: 6, height: 6, borderRadius: 99, background: theme.primary }} /> Configuración inicial
          </div>
          <h1 style={{ fontSize: 32, fontWeight: 600, margin: 0, letterSpacing: -1, lineHeight: 1.1 }}>
            Haz esta plataforma <span style={{ color: theme.primary }}>tuya</span>.
          </h1>
          <p style={{ color: t.textDim, fontSize: 15, marginTop: 10, lineHeight: 1.5 }}>
            Personaliza la identidad antes de empezar. Lo verá todo tu equipo y puedes cambiarlo después.
          </p>
        </div>
        <div style={{ background: t.surfaceSolid, border: `1px solid ${t.border}`, borderRadius: 14, padding: 24 }}>
          <Field label="Nombre de la empresa" t={t}>
            <Input t={t} placeholder="Ej. Dacomsa" value={theme.companyName}
              onChange={(e) => setTheme((s) => ({ ...s, companyName: e.target.value }))} />
          </Field>
          <Field label="Color principal" t={t}>
            <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
              {palette.map((c) => (
                <div key={c} onClick={() => setTheme((s) => ({ ...s, primary: c }))} style={{ width: 32, height: 32,
                  borderRadius: 8, background: c, cursor: "pointer",
                  border: theme.primary === c ? `2px solid ${t.text}` : "2px solid transparent",
                  display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {theme.primary === c && <Check size={15} color="#fff" />}</div>
              ))}
              <input type="color" value={theme.primary} onChange={(e) => setTheme((s) => ({ ...s, primary: e.target.value }))}
                style={{ width: 32, height: 32, borderRadius: 8, border: `1px solid ${t.border}`, cursor: "pointer",
                  background: "transparent", padding: 2 }} />
            </div>
          </Field>
          <Field label="Tema" t={t}>
            <div style={{ display: "flex", gap: 10 }}>
              {[{ id: "dark", label: "Oscuro" }, { id: "light", label: "Claro" }].map((m) => (
                <div key={m.id} onClick={() => setTheme((s) => ({ ...s, mode: m.id }))} style={{ flex: 1,
                  padding: "11px", borderRadius: 8, cursor: "pointer", textAlign: "center", fontWeight: 500, fontSize: 14,
                  border: theme.mode === m.id ? `1.5px solid ${theme.primary}` : `1px solid ${t.border}`,
                  background: theme.mode === m.id ? theme.primary + "18" : t.surfaceAlt,
                  color: theme.mode === m.id ? t.text : t.textDim }}>{m.label}</div>
              ))}
            </div>
          </Field>
          <Btn t={{ primary: theme.primary }} onClick={() => onDone(theme)} disabled={!theme.companyName}
            style={{ width: "100%", justifyContent: "center", marginTop: 6, padding: "12px" }}>
            Entrar a la plataforma <ChevronRight size={17} />
          </Btn>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// GRAFO — múltiples lentes + flotación + glow
// ============================================================================
const UNGOVERNED_SOURCE_KINDS = new Set(["file"]);
const RISK_COLOR = "#EA4335";
const WARN_COLOR = "#FBBC04";
const RISK_RULES = [
  {
    id: "ungoverned_source",
    label: "Origen no gobernado",
    sublabel: "Excel, CSV u otro archivo compartido",
    color: RISK_COLOR,
    blinkClass: "risk-blink-red",
  },
  {
    id: "no_user_assigned",
    label: "Sin usuario asignado",
    sublabel: "Paso sin owner, steward ni ejecutor",
    color: WARN_COLOR,
    blinkClass: "risk-blink-yellow",
  },
];

function stepHasAssignedUser(stepId, roles) {
  return roles.some((r) => r.stepId === stepId && String(r.person || r.email || "").trim());
}

function resolveStepRiskType(stepId, riskSteps, noUserSteps) {
  if (riskSteps.has(stepId)) return "ungoverned";
  if (noUserSteps.has(stepId)) return "no_user";
  return null;
}

function resolveProcRiskType(procId, riskProcs, noUserProcs) {
  if (riskProcs.has(procId)) return "ungoverned";
  if (noUserProcs.has(procId)) return "no_user";
  return null;
}

function riskColorForType(riskType) {
  if (riskType === "ungoverned") return RISK_COLOR;
  if (riskType === "no_user") return WARN_COLOR;
  return null;
}

function riskDetailForType(riskType, ctx = {}) {
  if (riskType === "ungoverned") {
    return `Origen no gobernado: ${ctx.sourceCode || "archivo"}`;
  }
  if (riskType === "no_user") {
    return "Sin usuario asignado a este paso";
  }
  return "";
}

function isUngovernedSource(source) {
  return source && UNGOVERNED_SOURCE_KINDS.has(source.kind);
}

function UngovernedSourceAlert({ t, sourceCode, compact }) {
  const label = sourceCode || "archivo compartido";
  if (compact) {
    return (
      <div className="ungoverned-alert-pulse" style={{
        padding: "8px 10px", marginBottom: 8, borderRadius: 8,
        background: RISK_COLOR + "14", border: `1px solid ${RISK_COLOR}`,
        fontSize: 10.5, color: t.textDim, lineHeight: 1.45,
      }}>
        <div style={{ fontWeight: 700, color: RISK_COLOR, marginBottom: 3, fontSize: 11 }}>
          Origen no gobernado
        </div>
        <strong style={{ color: t.text }}>{label}</strong> está fuera del ERP. Sin control de versiones ni linaje.
      </div>
    );
  }
  return (
    <div className="ungoverned-alert-pulse" style={{
      display: "flex", gap: 10, alignItems: "flex-start",
      padding: "12px 14px", marginBottom: 12, borderRadius: 10,
      background: RISK_COLOR + "14", border: `1.5px solid ${RISK_COLOR}`,
      boxShadow: `0 0 14px ${RISK_COLOR}33`,
    }}>
      <AlertTriangle size={18} color={RISK_COLOR} style={{ flexShrink: 0, marginTop: 1 }} />
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: RISK_COLOR, marginBottom: 4 }}>
          Origen no gobernado
        </div>
        <div style={{ fontSize: 12.5, color: t.textDim, lineHeight: 1.55 }}>
          Este paso usa <strong style={{ color: t.text, fontWeight: 600 }}>{label}</strong>, un archivo
          (Excel, CSV u otro) fuera del ERP. No hay control central de versiones, accesos ni linaje del dato,
          lo que dificulta auditar quién lo modificó y garantizar una sola versión oficial.
          Prioriza migrarlo a una transacción o tabla gobernada.
        </div>
      </div>
    </div>
  );
}

function getUserInitials(person, email) {
  const raw = String(person || email || "?").trim();
  if (!raw || raw === "?") return "?";
  if (raw.includes("@")) {
    const local = raw.split("@")[0];
    const parts = local.split(/[._-]/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return local.slice(0, 2).toUpperCase();
  }
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return raw.slice(0, 2).toUpperCase();
}

function avatarColorForUser(person, email, fallback) {
  const seed = String(email || person || "").toLowerCase();
  if (!seed) return fallback;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  const hues = [215, 165, 280, 28, 340, 195, 45, 120];
  return `hsl(${hues[Math.abs(hash) % hues.length]}, 52%, 46%)`;
}

function UserAvatar({ person, email, roleType, size = 34, t, title, photoUrl }) {
  const initials = getUserInitials(person, email);
  const bg = USER_ROLE_COLORS[roleType] || avatarColorForUser(person, email, t.primary);
  const tip = title || `${roleType || ""}${person || email ? `: ${person || email}` : ""}`;
  const common = {
    width: size, height: size, borderRadius: 99, flexShrink: 0,
    border: `2px solid ${t.surfaceSolid}`, boxShadow: "0 2px 6px #00000018",
  };
  if (photoUrl) {
    return <img src={photoUrl} alt={tip} title={tip}
      style={{ ...common, objectFit: "cover", background: t.surfaceAlt }} />;
  }
  return (
    <div title={tip} style={{
      ...common, background: bg, color: "#fff",
      fontSize: Math.max(10, size * 0.34), fontWeight: 700, display: "flex",
      alignItems: "center", justifyContent: "center",
    }}>{initials}</div>
  );
}

function resolveStepFlowColor(step, stepArea, areaColors, procColor, src) {
  if (isUngovernedSource(src)) return RISK_COLOR;
  if (stepArea) return areaColors[stepArea.id] || procColor;
  return procColor;
}

function flattenStepsTree(steps, idKey = "tmpId", parentKey = "parentTmpId") {
  const roots = steps.filter((s) => !s[parentKey]);
  const childrenOf = (id) => steps.filter((s) => s[parentKey] === id);
  const result = [];
  const walk = (st) => {
    result.push(st);
    childrenOf(st[idKey]).forEach(walk);
  };
  roots.forEach(walk);
  return result;
}

function isJoinStepRecord(st) {
  if (st?.isJoinPoint) return true;
  const name = (st?.name || "").trim().toLowerCase();
  return name === "unión de ramas" || name === "unión" || name.startsWith("unión ");
}

function processHasBranching(steps) {
  if (!steps?.length) return false;
  if (steps.some((s) => s.isJoinPoint || isJoinStepRecord(s) || s.joinStepId)) return true;
  const childCount = {};
  steps.forEach((s) => {
    if (!s.parentStepId) return;
    childCount[s.parentStepId] = (childCount[s.parentStepId] || 0) + 1;
  });
  if (Object.values(childCount).some((n) => n > 1)) return true;
  const branchLabels = steps.filter((s) => s.pathLabel && !s.isJoinPoint && !isJoinStepRecord(s));
  return branchLabels.length >= 2;
}

function repairStepTreeReferences(steps) {
  const ids = new Set(steps.map((s) => s.id));
  return steps.map((s) => ({
    ...s,
    parentStepId: s.parentStepId && ids.has(s.parentStepId) ? s.parentStepId : null,
    joinStepId: s.joinStepId && ids.has(s.joinStepId) ? s.joinStepId : null,
  }));
}

function inferLinearParentChain(steps) {
  const sorted = [...steps].sort((a, b) => a.order - b.order);
  return sorted.map((st, i) => ({
    ...st,
    parentStepId: i > 0 ? sorted[i - 1].id : null,
    joinStepId: null,
    pathLabel: st.pathLabel || "",
  }));
}

/** Reconstruye ramas paralelas desde orden de guardado + etiquetas Camino A/B + paso unión */
function inferParallelFromSaveOrder(steps) {
  const sorted = [...steps].sort((a, b) => a.order - b.order);
  const joinIdx = sorted.findIndex((s) => s.isJoinPoint || isJoinStepRecord(s));
  const firstBranchIdx = sorted.findIndex((s) => s.pathLabel && !s.isJoinPoint && !isJoinStepRecord(s));
  if (firstBranchIdx < 1) return inferLinearParentChain(sorted);

  const forkIdx = firstBranchIdx - 1;
  const forkId = sorted[forkIdx].id;
  const joinEnd = joinIdx >= 0 ? joinIdx : sorted.length;
  const middle = sorted.slice(forkIdx + 1, joinEnd);
  const laneRoots = middle.filter((s) => s.pathLabel);
  if (laneRoots.length < 2 && middle.length < 2) return inferLinearParentChain(sorted);

  const out = sorted.map((s) => ({
    ...s,
    parentStepId: null,
    joinStepId: null,
  }));
  const byId = Object.fromEntries(out.map((s) => [s.id, s]));

  for (let i = 1; i <= forkIdx; i += 1) {
    out[i].parentStepId = out[i - 1].id;
  }

  if (joinIdx >= 0) {
    byId[forkId].joinStepId = sorted[joinIdx].id;
    byId[sorted[joinIdx].id].parentStepId = forkId;
  }

  let lastInLane = null;
  middle.forEach((src) => {
    const step = byId[src.id];
    if (step.pathLabel) {
      step.parentStepId = forkId;
      lastInLane = step.id;
    } else {
      step.parentStepId = lastInLane || forkId;
      lastInLane = step.id;
    }
  });

  if (joinIdx >= 0 && joinIdx + 1 < sorted.length) {
    let prevId = sorted[joinIdx].id;
    for (let i = joinIdx + 1; i < sorted.length; i += 1) {
      out[i].parentStepId = prevId;
      prevId = out[i].id;
    }
  } else if (joinIdx < 0 && joinEnd < sorted.length) {
    let prevId = forkId;
    for (let i = joinEnd; i < sorted.length; i += 1) {
      out[i].parentStepId = prevId;
      prevId = out[i].id;
    }
  }

  return out;
}

function resolveProcessStepTree(steps) {
  if (!steps?.length) return [];
  const hasExplicitTree = steps.some((s) => s.parentStepId || s.joinStepId);
  if (hasExplicitTree) {
    const repaired = repairStepTreeReferences(steps);
    if (processHasBranching(repaired)) return repaired;
  }
  const hasBranchHints = steps.some((s) =>
    (s.pathLabel && !s.isJoinPoint && !isJoinStepRecord(s))
    || s.isJoinPoint || isJoinStepRecord(s));
  if (hasBranchHints) return inferParallelFromSaveOrder(steps);
  return inferLinearParentChain(steps);
}

function resolveStepTreeMetadata(steps) {
  if (!steps?.length) return [];
  const byProcess = {};
  steps.forEach((s) => {
    if (!byProcess[s.processId]) byProcess[s.processId] = [];
    byProcess[s.processId].push(s);
  });
  return Object.values(byProcess).flatMap((procSteps) => resolveProcessStepTree(procSteps));
}

function persistedStepsToFlowTree(steps) {
  return steps.map((st) => ({
    tmpId: st.id,
    parentTmpId: st.parentStepId || null,
    joinTmpId: st.joinStepId || null,
    isJoinPoint: !!st.isJoinPoint || isJoinStepRecord(st),
    name: st.name || "",
    pathLabel: st.pathLabel || "",
    stepAreaId: st.stepAreaId || "",
    persistedOrder: st.order ?? 0,
  }));
}

function buildStepOrderMap(treeSteps) {
  const map = {};
  let idx = 0;
  const roots = treeSteps
    .filter((s) => !s.parentTmpId && !s.isJoinPoint)
    .sort((a, b) => {
      const oa = a.persistedOrder ?? a.order ?? 0;
      const ob = b.persistedOrder ?? b.order ?? 0;
      return oa - ob;
    });
  const walk = (st) => {
    map[st.tmpId] = idx++;
    const children = treeChildrenOf(treeSteps, st.tmpId);
    if (children.length > 1) {
      children.forEach(walk);
      if (st.joinTmpId) {
        const join = treeSteps.find((s) => s.tmpId === st.joinTmpId);
        if (join) walk(join);
      }
    } else if (children.length === 1) {
      walk(children[0]);
    }
  };
  roots.forEach(walk);
  return map;
}

function compactStepsForGraph(steps, maxVisible = 7) {
  const sorted = [...steps].sort((a, b) => a.order - b.order);
  const filtered = sorted.filter((st) => !isJoinStepRecord(st));
  if (filtered.length <= maxVisible) return filtered;

  const headCount = Math.max(3, Math.floor(maxVisible / 2));
  const tailCount = Math.max(2, maxVisible - headCount - 1);
  const head = filtered.slice(0, headCount);
  const tail = filtered.slice(-tailCount);
  const hidden = filtered.length - head.length - tail.length;
  const meta = {
    id: `collapsed:${filtered[0]?.processId || "x"}`,
    processId: filtered[0]?.processId,
    name: `+${hidden} pasos en ramas`,
    order: (head[head.length - 1]?.order ?? 0) + 0.5,
    sourceId: null,
    stepAreaId: "",
    _collapsed: true,
  };
  return [...head, meta, ...tail];
}

/** Pasos de un proceso en el mapa radial, respetando ramas paralelas y uniones */
function appendRadialProcessStepTree(ctx) {
  const {
    treeSteps, procSteps, data, processNodeId, px, py, branchAngle,
    stepR, stepSeg, srcR, showSources, activeSteps,
    riskSteps, noUserSteps, riskSources, visibleAreaIds, areaColors, pc, p,
    addNode, addLink, stepOrderMap,
  } = ctx;

  const roots = sortFlowRoots(treeSteps);
  if (!roots.length) return;

  const placeStep = (st, parentId, angle, depth) => {
    const stepRec = procSteps.find((s) => s.id === st.tmpId);
    if (!stepRec) return null;
    if (activeSteps && !activeSteps.includes(st.tmpId)) return null;

    const dist = stepR + 18 + depth * stepSeg;
    const stx = px + dist * Math.cos(angle);
    const sty = py + dist * Math.sin(angle);
    const isJoin = st.isJoinPoint || isJoinStepRecord(stepRec);
    const src = !isJoin && stepRec.sourceId
      ? data.sources.find((s) => s.id === stepRec.sourceId) : null;
    const crossAreaId = !isJoin && stepRec.stepAreaId && stepRec.stepAreaId !== p.areaId
      ? stepRec.stepAreaId : null;
    const crossArea = crossAreaId ? data.areas.find((ar) => ar.id === crossAreaId) : null;
    const stepColor = crossArea ? (areaColors[crossArea.id] || pc) : pc;
    const stepNodeId = isJoin ? `join:${st.tmpId}` : `st:${st.tmpId}`;
    const orderIdx = stepOrderMap[st.tmpId] ?? depth;
    const stepRiskType = !isJoin ? resolveStepRiskType(st.tmpId, riskSteps, noUserSteps) : null;

    addNode({
      id: stepNodeId,
      label: stepRec.name || (isJoin ? "Unión" : `Paso ${orderIdx + 1}`),
      type: "step",
      x: stx, y: sty,
      r: isJoin ? 4.5 : 5,
      color: stepColor,
      stepOrder: orderIdx + 1,
      sourceCode: src ? src.code : "",
      labelAngle: angle,
      crossAreaId: crossArea?.id || null,
      crossAreaName: crossArea?.name || "",
      ownerAreaId: p.areaId,
      pathLabel: st.pathLabel || "",
      isJoin,
      riskType: stepRiskType,
      atRisk: !!stepRiskType,
      riskDetail: stepRiskType ? riskDetailForType(stepRiskType, { sourceCode: src?.code }) : "",
      sourceKind: src?.kind || "",
    });
    addLink({
      from: parentId,
      to: stepNodeId,
      color: stepColor + (isJoin ? "66" : "44"),
      dashed: isJoin,
    });

    if (!isJoin && crossAreaId && visibleAreaIds.has(crossAreaId)) {
      addLink({
        from: stepNodeId,
        to: "a:" + crossAreaId,
        color: (areaColors[crossAreaId] || stepColor) + "99",
        dashed: true,
        crossArea: true,
      });
    }

    if (showSources && src) {
      const srcAngle = angle + Math.PI / 5;
      const sx = stx + srcR * Math.cos(srcAngle);
      const sy = sty + srcR * Math.sin(srcAngle);
      const hasSensitive = data.fields.some((f) => f.sourceId === src.id && f.sensitive);
      const srcNodeId = "s:" + src.id + ":" + st.tmpId;
      const srcAtRisk = riskSources.has(src.id);
      addNode({
        id: srcNodeId, label: src.code, type: "source", x: sx, y: sy,
        r: 7.5, color: stepColor, sensitive: hasSensitive,
        riskType: srcAtRisk ? "ungoverned" : null,
        atRisk: srcAtRisk,
        riskDetail: srcAtRisk ? riskDetailForType("ungoverned", { sourceCode: src.code }) : "",
      });
      addLink({ from: stepNodeId, to: srcNodeId, color: stepColor + "28" });
    }

    return { stepNodeId, depth };
  };

  const walk = (st, parentId, angle, depth) => {
    const placed = placeStep(st, parentId, angle, depth);
    if (!placed) return depth;
    const { stepNodeId } = placed;

    const children = treeChildrenOf(treeSteps, st.tmpId);
    if (children.length > 1) {
      const fan = Math.min(Math.PI * 0.34, Math.max(0.14, (children.length - 1) * 0.13));
      let maxDepth = depth;
      children.forEach((ch, ci) => {
        const chAngle = angle + (children.length > 1 ? (ci / (children.length - 1) - 0.5) * fan : 0);
        maxDepth = Math.max(maxDepth, walk(ch, stepNodeId, chAngle, depth + 1));
      });
      const join = st.joinTmpId ? treeSteps.find((s) => s.tmpId === st.joinTmpId) : null;
      if (join) {
        return walk(join, stepNodeId, angle, maxDepth + 1);
      }
      return maxDepth;
    }
    if (children.length === 1) {
      return walk(children[0], stepNodeId, angle, depth + 1);
    }
    return depth;
  };

  roots.forEach((root, ri) => {
    const rootAngle = branchAngle + (roots.length > 1 ? (ri - (roots.length - 1) / 2) * 0.08 : 0);
    walk(root, processNodeId, rootAngle, 0);
  });
}

function tmpStepColor(st, processAreaId, areaColors, procColor, areas) {
  const stepArea = st.stepAreaId ? areas.find((a) => a.id === st.stepAreaId) : null;
  const processArea = areas.find((a) => a.id === processAreaId);
  if (st.kind === "file") return RISK_COLOR;
  if (stepArea) return areaColors[stepArea.id] || procColor;
  return procColor;
}

const FLOW_CONNECTOR_PAD = 8;
const FLOW_FORK_RUNWAY = 36;
const FLOW_MERGE_RUNWAY = 44;
const FLOW_MERGE_HUB_RATIO = 0.5;
const FLOW_CURVE_MIN_PULL = 28;
const FLOW_DELETE_CONFIRM_MS = 4000;

function FlowDeleteButton({ onConfirm, t }) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(false), FLOW_DELETE_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        if (!armed) {
          setArmed(true);
          return;
        }
        onConfirm();
        setArmed(false);
      }}
      title={armed ? "Pulsa de nuevo para confirmar la eliminación" : "Eliminar paso del flujo"}
      style={{
        height: 16,
        minWidth: armed ? 48 : 16,
        padding: armed ? "0 5px" : 0,
        borderRadius: 6,
        background: armed ? "#EA433518" : t.surfaceSolid,
        border: `1px solid ${armed ? "#EA4335" : t.border}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 3,
        cursor: "pointer",
        color: armed ? "#EA4335" : t.textFaint,
        fontSize: 8,
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      {armed ? (
        <>
          <AlertTriangle size={10} />
          <span>¿Eliminar?</span>
        </>
      ) : (
        <Trash2 size={11} />
      )}
    </div>
  );
}

function treeChildrenOf(steps, parentId, parentKey = "parentTmpId") {
  return steps
    .filter((s) => s[parentKey] === parentId && !s.isJoinPoint)
    .sort((a, b) => {
      const oa = a.persistedOrder ?? a.order ?? 0;
      const ob = b.persistedOrder ?? b.order ?? 0;
      if (oa !== ob) return oa - ob;
      return (a.pathLabel || "").localeCompare(b.pathLabel || "", "es");
    });
}

function sortFlowRoots(treeSteps) {
  return treeSteps
    .filter((s) => !s.parentTmpId && !s.isJoinPoint)
    .sort((a, b) => (a.persistedOrder ?? a.order ?? 0) - (b.persistedOrder ?? b.order ?? 0));
}

function flowCurveD(x1, y1, x2, y2) {
  const span = x2 - x1;
  const pull = Math.max(Math.abs(span) * 0.45, FLOW_CURVE_MIN_PULL);
  const sign = span >= 0 ? 1 : -1;
  return `M ${x1},${y1} C ${x1 + pull * sign},${y1} ${x2 - pull * sign},${y2} ${x2},${y2}`;
}

function relBox(el, sectionRect) {
  const r = el.getBoundingClientRect();
  const round = (n) => Math.round(n);
  return {
    left: round(r.left - sectionRect.left),
    right: round(r.right - sectionRect.left),
    top: round(r.top - sectionRect.top),
    bottom: round(r.bottom - sectionRect.top),
    cx: round(r.left - sectionRect.left + r.width / 2),
    cy: round(r.top - sectionRect.top + r.height / 2),
  };
}

function laneEndpoint(laneEl, side, sectionRect) {
  const cards = laneEl.querySelectorAll("[data-flow-step-card]");
  if (!cards.length) {
    const b = relBox(laneEl, sectionRect);
    return { x: side === "out" ? b.right : b.left, y: b.cy };
  }
  const card = side === "out" ? cards[cards.length - 1] : cards[0];
  const r = card.getBoundingClientRect();
  const round = (n) => Math.round(n);
  return {
    x: round((side === "out" ? r.right : r.left) - sectionRect.left),
    y: round(r.top - sectionRect.top + r.height / 2),
  };
}

function FlowLaserPathGroup({ paths, svgId }) {
  if (!paths?.length) return null;
  return (
    <g>
      <defs>
        <filter id={`${svgId}-glow`} x="-80%" y="-40%" width="260%" height="180%">
          <feGaussianBlur stdDeviation="2.5" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        {paths.map((p, i) => (
          <linearGradient key={`g${i}`} id={`${svgId}-grad-${i}`} gradientUnits="userSpaceOnUse"
            x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2}>
            <stop offset="0%" stopColor={p.fromColor} stopOpacity="0.35" />
            <stop offset="45%" stopColor={p.fromColor} stopOpacity="0.85" />
            <stop offset="100%" stopColor={p.toColor} stopOpacity="1" />
          </linearGradient>
        ))}
      </defs>
      {paths.map((p, i) => (
        <g key={i}>
          <path d={p.d} fill="none" stroke={p.fromColor} strokeWidth="5" strokeLinecap="round" opacity="0.1" />
          <path d={p.d} fill="none" stroke={`url(#${svgId}-grad-${i})`} strokeWidth="2.4"
            strokeLinecap="round" opacity="0.5" filter={`url(#${svgId}-glow)`} />
          <path d={p.d} fill="none" stroke={`url(#${svgId}-grad-${i})`} strokeWidth="1.4"
            strokeLinecap="round" strokeDasharray="7 32" className="laser-beam-pulse" opacity="0.95"
            style={{ animationDelay: `${(p.delay || 0) + i * 0.18}s` }} />
          <path d={p.d} fill="none" stroke="#ffffff" strokeWidth="0.8" strokeLinecap="round"
            strokeDasharray="3 36" className="laser-beam-core" opacity="0.75"
            style={{ animationDelay: `${(p.delay || 0) + i * 0.12}s` }} />
          {p.tip && (
            <circle cx={p.tip.x} cy={p.tip.y} r="2.5" fill={p.tip.color} className="laser-node-pulse"
              style={{ animationDelay: `${(p.delay || 0) + i * 0.18}s` }} />
          )}
        </g>
      ))}
    </g>
  );
}

function ProcessFlowParallelOverlay({ layout, svgId, forkColor, laneColors, joinColor }) {
  if (!layout?.w || !layout.paths?.length) return null;
  const { w, h, paths, hub, forkOrigin } = layout;
  return (
    <svg
      width={w} height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{
        position: "absolute", top: 0, left: 0, pointerEvents: "none",
        overflow: "visible", zIndex: 0,
      }}
    >
      <FlowLaserPathGroup paths={paths} svgId={svgId} />
      {forkOrigin && (
        <>
          <circle cx={forkOrigin.x} cy={forkOrigin.y} r="3.2" fill={forkColor} opacity="0.9" />
          <circle cx={forkOrigin.x} cy={forkOrigin.y} r="1.3" fill="#ffffff" opacity="0.95" />
        </>
      )}
      {hub && (
        <>
          <circle cx={hub.x} cy={hub.y} r="3.2" fill={forkColor} opacity="0.9" />
          <circle cx={hub.x} cy={hub.y} r="1.3" fill="#ffffff" opacity="0.95" />
        </>
      )}
      {layout.exitTip && (
        <>
          <circle cx={layout.exitTip.x} cy={layout.exitTip.y} r="2.8" fill={joinColor || forkColor}
            className="laser-node-pulse" />
          <circle cx={layout.exitTip.x} cy={layout.exitTip.y} r="1.2" fill="#ffffff" opacity="0.95" />
        </>
      )}
    </svg>
  );
}

function buildParallelConnectorLayout({
  sectionEl, forkEl, joinEl, laneEls, laneColors, forkColor, joinColor,
}) {
  if (!sectionEl || !forkEl || laneEls.length === 0) return null;
  const sRect = sectionEl.getBoundingClientRect();
  const w = Math.round(sectionEl.offsetWidth);
  const h = Math.round(sectionEl.offsetHeight);
  if (!w || !h) return null;

  const fork = relBox(forkEl, sRect);
  const laneElsValid = laneEls.filter(Boolean);
  if (laneElsValid.length === 0) return null;

  const forkPt = { x: fork.right, y: fork.cy };
  const laneIns = laneElsValid.map((el) => laneEndpoint(el, "in", sRect));
  const laneOuts = laneElsValid.map((el) => laneEndpoint(el, "out", sRect));
  const paths = [];

  laneIns.forEach((inPt, i) => {
    const d = flowCurveD(forkPt.x, forkPt.y, inPt.x, inPt.y);
    paths.push({
      d, fromColor: forkColor, toColor: laneColors[i] || forkColor,
      x1: forkPt.x, y1: forkPt.y, x2: inPt.x, y2: inPt.y,
      tip: { x: inPt.x, y: inPt.y, color: laneColors[i] || forkColor },
      delay: 0,
    });
  });

  let hub = null;
  let exitTip = null;

  if (joinEl) {
    const join = relBox(joinEl, sRect);
    const joinPt = { x: join.left, y: join.cy };
    const maxOutX = Math.max(...laneOuts.map((p) => p.x));
    hub = {
      x: maxOutX + (joinPt.x - maxOutX) * FLOW_MERGE_HUB_RATIO,
      y: joinPt.y,
    };

    laneOuts.forEach((outPt, i) => {
      const d = flowCurveD(outPt.x, outPt.y, hub.x, hub.y);
      paths.push({
        d, fromColor: laneColors[i] || forkColor, toColor: forkColor,
        x1: outPt.x, y1: outPt.y, x2: hub.x, y2: hub.y,
        tip: { x: outPt.x, y: outPt.y, color: laneColors[i] || forkColor },
        delay: 0.1,
      });
    });

    const exitD = flowCurveD(hub.x, hub.y, joinPt.x, joinPt.y);
    paths.push({
      d: exitD, fromColor: forkColor, toColor: joinColor || forkColor,
      x1: hub.x, y1: hub.y, x2: joinPt.x, y2: joinPt.y,
      delay: 0.2,
    });
    exitTip = { x: joinPt.x, y: joinPt.y };
  }

  return { w, h, paths, hub, exitTip, forkOrigin: { x: forkPt.x, y: forkPt.y } };
}

function parallelLayoutSignature(layout) {
  if (!layout) return "";
  const pathKey = layout.paths.map((p) => p.d).join("|");
  const hubKey = layout.hub ? `${layout.hub.x},${layout.hub.y}` : "";
  const exitKey = layout.exitTip ? `${layout.exitTip.x},${layout.exitTip.y}` : "";
  const forkKey = layout.forkOrigin ? `${layout.forkOrigin.x},${layout.forkOrigin.y}` : "";
  return `${layout.w}x${layout.h}|${pathKey}|${hubKey}|${exitKey}|${forkKey}`;
}

function ProcessFlowParallelSection({
  forkStep, card, children, joinStep, buildCard, renderNode, renderFlowCard, renderStepTail,
  forkColor, procColor, mode, onAddConvergence,
}) {
  const sectionRef = useRef(null);
  const forkCardRef = useRef(null);
  const joinCardRef = useRef(null);
  const laneFlowRefs = useRef([]);
  const layoutSigRef = useRef("");
  const laneColorsRef = useRef([]);
  const forkColorRef = useRef(forkColor);
  const joinColorRef = useRef(null);
  const measureRafRef = useRef(0);
  const [layout, setLayout] = useState(null);

  const childKey = children.map((c) => c.tmpId).join(",");
  const laneColors = useMemo(
    () => children.map((ch) => buildCard(ch).stepColor),
    [children, childKey, buildCard],
  );
  const joinColor = joinStep ? buildCard(joinStep).stepColor : null;

  laneColorsRef.current = laneColors;
  forkColorRef.current = forkColor;
  joinColorRef.current = joinColor;

  const measure = useCallback(() => {
    const next = buildParallelConnectorLayout({
      sectionEl: sectionRef.current,
      forkEl: forkCardRef.current,
      joinEl: joinCardRef.current,
      laneEls: laneFlowRefs.current,
      laneColors: laneColorsRef.current,
      forkColor: forkColorRef.current,
      joinColor: joinColorRef.current,
    });
    if (!next) return;
    const sig = parallelLayoutSignature(next);
    if (sig === layoutSigRef.current) return;
    layoutSigRef.current = sig;
    setLayout(next);
  }, []);

  const scheduleMeasure = useCallback(() => {
    if (measureRafRef.current) return;
    measureRafRef.current = requestAnimationFrame(() => {
      measureRafRef.current = 0;
      measure();
    });
  }, [measure]);

  useEffect(() => {
    laneFlowRefs.current = laneFlowRefs.current.slice(0, children.length);
  }, [children.length, childKey]);

  useLayoutEffect(() => {
    layoutSigRef.current = "";
    scheduleMeasure();
    const ro = new ResizeObserver(scheduleMeasure);
    const section = sectionRef.current;
    if (section) {
      ro.observe(section);
      if (forkCardRef.current) ro.observe(forkCardRef.current);
      if (joinCardRef.current) ro.observe(joinCardRef.current);
      laneFlowRefs.current.forEach((el) => el && ro.observe(el));
    }
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      if (measureRafRef.current) cancelAnimationFrame(measureRafRef.current);
      measureRafRef.current = 0;
      ro.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [children.length, joinStep?.tmpId, childKey, scheduleMeasure]);

  const setLaneFlowRef = useCallback((index) => (el) => {
    const prev = laneFlowRefs.current[index];
    laneFlowRefs.current[index] = el;
    if (el && el !== prev) scheduleMeasure();
  }, [scheduleMeasure]);

  const overlayId = `parallel-${forkStep.tmpId}`;

  return (
    <div ref={sectionRef} style={{
      position: "relative", display: "flex", alignItems: "center", flexShrink: 0,
      padding: "8px 0", overflow: "visible",
    }}>
      <ProcessFlowParallelOverlay layout={layout} svgId={overlayId}
        forkColor={forkColor} laneColors={laneColors} joinColor={joinColor} />
      <div ref={forkCardRef} style={{ position: "relative", zIndex: 1, flexShrink: 0 }}>
        {renderFlowCard(forkStep, card)}
      </div>
      <div aria-hidden style={{ width: FLOW_FORK_RUNWAY, flexShrink: 0 }} />
      <div style={{
        display: "flex", flexDirection: "column", justifyContent: "center",
        overflow: "visible", padding: "6px 0", position: "relative", zIndex: 1,
      }}>
        {children.map((ch, li) => {
          const chCard = buildCard(ch);
          return (
            <div key={ch.tmpId} data-flow-lane style={{
              display: "flex", alignItems: "center", padding: "4px 0",
              borderBottom: li < children.length - 1 ? "1px solid var(--border-color)" : "none",
            }}>
              <div
                ref={setLaneFlowRef(li)}
                data-flow-lane-flow
                style={{ display: "flex", alignItems: "center", overflow: "visible" }}
              >
                {renderNode(ch, forkColor)}
              </div>
            </div>
          );
        })}
      </div>
      {joinStep ? (
        <>
          <div aria-hidden style={{ width: FLOW_MERGE_RUNWAY, flexShrink: 0 }} />
          <div style={{ display: "flex", alignItems: "center", flexShrink: 0, position: "relative", zIndex: 1 }}>
          <div ref={joinCardRef} style={{ flexShrink: 0 }}>
            {renderFlowCard(joinStep, buildCard(joinStep))}
          </div>
          {renderStepTail?.(joinStep)}
          </div>
        </>
      ) : mode === "edit" && onAddConvergence ? (
        <div onClick={() => onAddConvergence(forkStep.tmpId)} title="Unir ramas"
          style={{
            marginLeft: 8, padding: "5px 8px", borderRadius: 6, cursor: "pointer",
            border: "1px dashed var(--border-color)", color: "var(--text-dim)",
            fontSize: 10, fontWeight: 500, display: "flex", alignItems: "center", gap: 4,
            flexShrink: 0, position: "relative", zIndex: 1,
          }}>
          <GitBranch size={11} style={{ transform: "rotate(90deg)" }} /> Unir
        </div>
      ) : null}
    </div>
  );
}

function ProcessFlowCanvas({
  treeSteps, buildCard, t, areaColors, procColor, processArea, mode = "edit",
  selectedKey, onSelectCard, onAddAfter, onAddBranch, onRemoveCard, onAddFirst, onAddConvergence,
  processId, sessionId, stepLocks,
}) {
  const connRef = useRef(0);
  const nextConn = () => { connRef.current += 1; return connRef.current; };

  const lockForStep = (st) => {
    if (!processId || !stepLocks || st.isJoinPoint) return null;
    const stepId = stepLockStorageId(st);
    return stepLocks[`${processId}:${stepId}`] || null;
  };

  const liveEditorForStep = (st, lock) => {
    if (!lock) return null;
    const isSelf = lock.sessionId === sessionId;
    return {
      name: lockEditorLabel(lock),
      email: lock.email || "",
      isSelf,
    };
  };

  const renderFlowCard = (st, card) => {
    const lock = lockForStep(st);
    const lockedByOther = !!(lock && lock.sessionId !== sessionId);
    const lockedBySelf = !!(lock && lock.sessionId === sessionId);
    const liveEditor = liveEditorForStep(st, lock);
    return (
    <div data-flow-step-card className="flow-card-wrap" style={{ position: "relative", flexShrink: 0 }}>
      <div onClick={mode === "edit" && onSelectCard ? () => onSelectCard(st.tmpId) : undefined}
        style={{ cursor: mode === "edit" ? "pointer" : "default",
          opacity: lockedByOther ? 0.88 : 1 }}>
        <ProcessStepCard
          step={card.step} index={card.index} src={card.src}
          stepArea={card.stepArea} processArea={processArea} color={card.stepColor}
          stepRoles={card.stepRoles}
          isUngoverned={card.isUngoverned}
          pathLabel={card.pathLabel} isJoin={!!st.isJoinPoint}
          selected={selectedKey === st.tmpId}
          lockedByOther={lockedByOther}
          lockedBySelf={lockedBySelf}
          liveEditor={liveEditor}
        />
      </div>
      {mode === "edit" && !st.isJoinPoint && !lockedByOther && (
        <div className="flow-card-actions" style={{
          position: "absolute", top: -2, right: -2, display: "flex", gap: 1, zIndex: 3,
        }}>
          {onAddBranch && (
            <div onClick={(e) => { e.stopPropagation(); onAddBranch(st.tmpId); }} title="Rama"
              style={{
                width: 16, height: 16, borderRadius: 3, background: "var(--surface-solid)",
                border: "1px solid var(--border-color)", display: "flex", alignItems: "center",
                justifyContent: "center", cursor: "pointer", color: "var(--text-faint)",
              }}>
              <GitBranch size={9} />
            </div>
          )}
          {onRemoveCard && (
            <FlowDeleteButton t={t} onConfirm={() => onRemoveCard(st.tmpId)} />
          )}
        </div>
      )}
    </div>
    );
  };

  const renderConnector = (fromColor, toColor) => {
    const idx = nextConn();
    return (
      <div style={{ position: "relative", display: "flex", alignItems: "center", flexShrink: 0, alignSelf: "center" }}>
        <ProcessFlowConnector fromColor={fromColor} toColor={toColor} index={idx} />
        {mode === "edit" && onAddAfter && (
          <div onClick={() => onAddAfter(fromColor === toColor ? selectedKey : null)}
            style={{ display: "none" }} />
        )}
      </div>
    );
  };

  const renderStepTail = (st) => {
    const card = buildCard(st);
    const children = treeChildrenOf(treeSteps, st.tmpId);
    if (children.length > 1) return renderNode(st, card.stepColor);
    const child = children[0];
    if (!child) {
      return mode === "edit" && onAddAfter ? (
        <div onClick={() => onAddAfter(st.tmpId)} title="Siguiente paso"
          style={{
            marginLeft: 6, width: 22, height: 22, borderRadius: 99, flexShrink: 0,
            border: "1px dashed var(--border-color)", display: "flex", alignItems: "center",
            justifyContent: "center", cursor: "pointer", color: "var(--text-faint)",
          }}>
          <Plus size={12} />
        </div>
      ) : null;
    }
    return (
      <>
        <div style={{ position: "relative", display: "flex", alignItems: "center", flexShrink: 0, alignSelf: "center" }}>
          <ProcessFlowConnector fromColor={card.stepColor} toColor={buildCard(child).stepColor}
            index={nextConn()} />
          {mode === "edit" && onAddAfter && (
            <div onClick={() => onAddAfter(st.tmpId)} title="Insertar paso"
              style={{
                position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
                width: 18, height: 18, borderRadius: 99, background: "var(--surface-solid)",
                border: "1px dashed var(--border-color)", display: "flex", alignItems: "center",
                justifyContent: "center", cursor: "pointer", color: "var(--text-faint)", zIndex: 2,
              }}>
              <Plus size={10} strokeWidth={2.5} />
            </div>
          )}
        </div>
        {renderNode(child, card.stepColor)}
      </>
    );
  };

  const renderNode = (st, prevColor) => {
    const card = buildCard(st);
    const children = treeChildrenOf(treeSteps, st.tmpId);
    const joinStep = st.joinTmpId ? treeSteps.find((s) => s.tmpId === st.joinTmpId) : null;

    if (children.length > 1) {
      return (
        <ProcessFlowParallelSection
          forkStep={st} card={card} children={children} joinStep={joinStep}
          buildCard={buildCard} renderNode={renderNode} renderFlowCard={renderFlowCard}
          renderStepTail={renderStepTail} forkColor={card.stepColor} procColor={procColor}
          mode={mode} onAddConvergence={onAddConvergence}
        />
      );
    }

    const child = children[0];
    return (
      <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
        {renderFlowCard(st, card)}
        {child && (
          <>
            <div style={{ position: "relative", display: "flex", alignItems: "center", flexShrink: 0, alignSelf: "center" }}>
              <ProcessFlowConnector fromColor={card.stepColor} toColor={buildCard(child).stepColor}
                index={nextConn()} />
              {mode === "edit" && onAddAfter && (
                <div onClick={() => onAddAfter(st.tmpId)} title="Insertar paso"
                  style={{
                    position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
                    width: 18, height: 18, borderRadius: 99, background: "var(--surface-solid)",
                    border: "1px dashed var(--border-color)", display: "flex", alignItems: "center",
                    justifyContent: "center", cursor: "pointer", color: "var(--text-faint)", zIndex: 2,
                  }}>
                  <Plus size={10} strokeWidth={2.5} />
                </div>
              )}
            </div>
            {renderNode(child, card.stepColor)}
          </>
        )}
        {!child && mode === "edit" && onAddAfter && (
          <div onClick={() => onAddAfter(st.tmpId)} title="Siguiente paso"
            style={{
              marginLeft: 6, width: 22, height: 22, borderRadius: 99, flexShrink: 0,
              border: "1px dashed var(--border-color)", display: "flex", alignItems: "center",
              justifyContent: "center", cursor: "pointer", color: "var(--text-faint)",
            }}>
            <Plus size={12} />
          </div>
        )}
      </div>
    );
  };

  const roots = sortFlowRoots(treeSteps);

  return (
    <>
      <style>{`
        @keyframes laser-beam-flow {
          0% { stroke-dashoffset: 60; opacity: 0.55; }
          50% { opacity: 1; }
          100% { stroke-dashoffset: 0; opacity: 0.55; }
        }
        @keyframes laser-core-flow {
          0% { stroke-dashoffset: 60; }
          100% { stroke-dashoffset: 0; }
        }
        @keyframes laser-node-glow {
          0%, 100% { opacity: 0.45; transform: scale(0.9); }
          50% { opacity: 1; transform: scale(1.15); }
        }
        .laser-beam-pulse { animation: laser-beam-flow 1.6s ease-in-out infinite; }
        .laser-beam-core { animation: laser-core-flow 1.1s linear infinite; }
        .laser-node-pulse { animation: laser-node-glow 1.6s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
      `}</style>
      <div style={{
        overflowX: "auto", overflowY: "visible",
        padding: mode === "edit" ? "8px 4px" : "12px 8px",
        minHeight: mode === "edit" ? 48 : 80,
      }}>
        {roots.length === 0 ? (
          <div style={{ textAlign: "center", color: t.textFaint, fontSize: 13, padding: "24px 16px" }}>
            {mode === "edit" ? (
              <div onClick={onAddFirst} style={{ cursor: "pointer", color: t.primary, fontWeight: 600,
                display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Plus size={16} /> Agregar primer paso
              </div>
            ) : "Sin pasos documentados."}
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", minWidth: "min-content", overflow: "visible" }}>
            {roots.map((root, ri) => (
              <React.Fragment key={root.tmpId}>
                {ri > 0 && <div style={{ width: 24 }} />}
                {renderNode(root, procColor)}
              </React.Fragment>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function ProcessFlowStrip({
  t, areaColors, procColor, processArea, mode = "view",
  cards, selectedKey, onSelectCard, onAddAfter, onAddBranch, onRemoveCard, onAddFirst,
}) {
  return (
    <>
      <style>{`
        @keyframes laser-beam-flow {
          0% { stroke-dashoffset: 60; opacity: 0.55; }
          50% { opacity: 1; }
          100% { stroke-dashoffset: 0; opacity: 0.55; }
        }
        @keyframes laser-core-flow {
          0% { stroke-dashoffset: 60; }
          100% { stroke-dashoffset: 0; }
        }
        @keyframes laser-node-glow {
          0%, 100% { opacity: 0.45; transform: scale(0.9); }
          50% { opacity: 1; transform: scale(1.15); }
        }
        .laser-beam-pulse { animation: laser-beam-flow 1.6s ease-in-out infinite; }
        .laser-beam-core { animation: laser-core-flow 1.1s linear infinite; }
        .laser-node-pulse { animation: laser-node-glow 1.6s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
      `}</style>
      <div style={{
        display: "flex", alignItems: "center", overflowX: "auto", overflowY: "hidden",
        padding: mode === "edit" ? "8px 4px" : "12px 8px", gap: 0,
        minHeight: mode === "edit" ? 48 : 80,
      }}>
        {cards.length === 0 ? (
          <div style={{ flex: 1, textAlign: "center", color: t.textFaint, fontSize: 13, padding: "24px 16px" }}>
            {mode === "edit" ? (
              <div onClick={onAddFirst} style={{ cursor: "pointer", color: t.primary, fontWeight: 600,
                display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Plus size={16} /> Agregar primer paso
              </div>
            ) : "Este proceso aún no tiene pasos documentados."}
          </div>
        ) : cards.map((card, i) => (
          <React.Fragment key={card.key}>
            {i > 0 && (
              <div style={{ position: "relative", display: "flex", alignItems: "center", flexShrink: 0 }}>
                <ProcessFlowConnector fromColor={cards[i - 1].stepColor} toColor={card.stepColor}
                  index={i} />
                {mode === "edit" && onAddAfter && (
                  <div onClick={() => onAddAfter(cards[i - 1].key)} title="Insertar paso"
                    style={{
                      position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
                      width: 18, height: 18, borderRadius: 99, background: t.surfaceSolid,
                      border: "1px dashed var(--border-color)", display: "flex", alignItems: "center",
                      justifyContent: "center", cursor: "pointer", color: t.textFaint, zIndex: 2,
                    }}>
                    <Plus size={10} strokeWidth={2.5} />
                  </div>
                )}
              </div>
            )}
            <div className="flow-card-wrap" style={{ position: "relative", flexShrink: 0 }}>
              <div onClick={mode === "edit" && onSelectCard ? () => onSelectCard(card.key) : undefined}
                style={{ cursor: mode === "edit" ? "pointer" : "default" }}>
                <ProcessStepCard
                  step={card.step} index={card.index} src={card.src}
                  stepArea={card.stepArea} processArea={processArea} color={card.stepColor}
                  stepRoles={card.stepRoles}
                  isUngoverned={card.isUngoverned}
                  pathLabel={card.pathLabel} selected={selectedKey === card.key}
                />
              </div>
              {mode === "edit" && (
                <div className="flow-card-actions" style={{
                  position: "absolute", top: -2, right: -2, display: "flex", gap: 1, zIndex: 3,
                }}>
                  {onAddBranch && (
                    <div onClick={(e) => { e.stopPropagation(); onAddBranch(card.key); }} title="Rama"
                      style={{
                        width: 16, height: 16, borderRadius: 3, background: t.surfaceSolid,
                        border: `1px solid ${t.border}`, display: "flex", alignItems: "center",
                        justifyContent: "center", cursor: "pointer", color: t.textFaint,
                      }}>
                      <GitBranch size={9} />
                    </div>
                  )}
                  {onRemoveCard && (
                    <FlowDeleteButton t={t} onConfirm={() => onRemoveCard(card.key)} />
                  )}
                </div>
              )}
            </div>
          </React.Fragment>
        ))}
        {mode === "edit" && cards.length > 0 && onAddAfter && (
          <div onClick={() => onAddAfter(cards[cards.length - 1].key)} title="Siguiente paso"
            style={{
              marginLeft: 6, width: 22, height: 22, borderRadius: 99, flexShrink: 0,
              border: "1px dashed var(--border-color)", display: "flex", alignItems: "center",
              justifyContent: "center", cursor: "pointer", color: t.textFaint,
            }}>
            <Plus size={12} />
          </div>
        )}
      </div>
    </>
  );
}

function ProcessFlowConnector({ fromColor, toColor, index, minimal }) {
  if (minimal) {
    return (
      <div style={{
        width: 14, minWidth: 14, flexShrink: 0, alignSelf: "center",
        display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-faint)",
      }}>
        <ChevronRight size={11} strokeWidth={2} />
      </div>
    );
  }
  return <ProcessLaserConnector fromColor={fromColor} toColor={toColor} index={index} />;
}

function ProcessLaserConnector({ fromColor, toColor, index }) {
  const gid = `lf${index}`;
  const curveUp = index % 2 === 0;
  const y1 = curveUp ? 30 : 12;
  const y2 = curveUp ? 12 : 30;
  const cy = curveUp ? 2 : 40;
  const pathD = `M 2,${y1} Q 30,${cy} 58,${y2}`;

  return (
    <div style={{ width: 60, minWidth: 60, height: 42, flexShrink: 0, alignSelf: "center" }}>
      <svg width="60" height="42" viewBox="0 0 60 42" style={{ overflow: "visible", display: "block" }}>
        <defs>
          <filter id={`${gid}-glow`} x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="2.8" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id={`${gid}-glow-strong`} x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="4.5" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <linearGradient id={`${gid}-flow`} gradientUnits="userSpaceOnUse" x1="2" y1={y1} x2="58" y2={y2}>
            <stop offset="0%" stopColor={fromColor} stopOpacity="1" />
            <stop offset="40%" stopColor={fromColor} stopOpacity="0.75" />
            <stop offset="100%" stopColor={toColor} stopOpacity="1" />
          </linearGradient>
          <linearGradient id={`${gid}-beam`} gradientUnits="userSpaceOnUse" x1="2" y1={y1} x2="58" y2={y2}>
            <stop offset="0%" stopColor={fromColor} stopOpacity="0.15" />
            <stop offset="25%" stopColor={fromColor} stopOpacity="0.55" />
            <stop offset="50%" stopColor="#ffffff" stopOpacity="1" />
            <stop offset="75%" stopColor={toColor} stopOpacity="0.55" />
            <stop offset="100%" stopColor={toColor} stopOpacity="0.15" />
          </linearGradient>
        </defs>
        <path d={pathD} fill="none" stroke={`url(#${gid}-flow)`} strokeWidth="6" strokeLinecap="round" opacity="0.14" />
        <path d={pathD} fill="none" stroke={`url(#${gid}-flow)`} strokeWidth="2.2" strokeLinecap="round" opacity="0.42"
          filter={`url(#${gid}-glow)`} />
        <path d={pathD} fill="none" stroke={`url(#${gid}-beam)`} strokeWidth="2.8" strokeLinecap="round"
          strokeDasharray="10 50" className="laser-beam-pulse" filter={`url(#${gid}-glow-strong)`} />
        <path d={pathD} fill="none" stroke={`url(#${gid}-beam)`} strokeWidth="1" strokeLinecap="round"
          strokeDasharray="4 56" className="laser-beam-core" opacity="0.9" />
        <circle cx="2" cy={y1} r="2.2" fill={fromColor} opacity="0.85" />
        <circle cx="58" cy={y2} r="2.8" fill={toColor} className="laser-node-pulse" />
        <circle cx="58" cy={y2} r="1.2" fill="#ffffff" opacity="0.95" />
      </svg>
    </div>
  );
}

function ProcessStepCard({
  step, index, src, stepArea, processArea, color, stepRoles = [],
  isUngoverned, pathLabel, isJoin, selected, lockedByOther, lockedBySelf, liveEditor,
}) {
  const displayArea = stepArea || processArea;
  const title = step.name || (isJoin ? "Unión" : `Paso ${index + 1}`);
  const assignedRoles = stepRoles.filter((r) => (r.email || r.person || "").trim());
  const roleLabel = (type) => USER_ROLE_LABELS[type]
    || ROLE_TYPES.find((rt) => rt.id === type)?.label
    || type;
  const userLabel = (r) => {
    const email = (r.email || "").trim();
    const person = (r.person || "").trim();
    if (person) return person;
    if (email) return email.includes("@") ? email.split("@")[0] : email;
    return "";
  };

  const cardClass = [
    "flow-step-card",
    selected ? "flow-step-card-selected" : "",
    lockedByOther ? "flow-step-card-locked" : "",
    lockedBySelf ? "flow-step-card-self-editing" : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      data-step-chip
      className={cardClass}
      style={{ "--step-accent": color || "var(--primary)" }}
    >
      {lockedByOther && (
        <div className="flow-step-lock-badge flow-step-lock-badge-other" title={`Editando: ${liveEditor?.name || "otro usuario"}`}>
          <Lock size={10} />
        </div>
      )}
      {lockedBySelf && (
        <div className="flow-step-lock-badge flow-step-lock-badge-self" title="Lo estás editando tú">
          <Pencil size={9} />
        </div>
      )}
      <div className="flow-step-num">{index + 1}</div>
      <div className="flow-step-body">
        {pathLabel && (
          <div className="flow-step-branch">{pathLabel}</div>
        )}
        <div className="flow-step-title">
          {isUngoverned && <span className="flow-step-warn">! </span>}
          {title}
        </div>
        {displayArea?.name && (
          <div className="flow-step-line">{displayArea.name}</div>
        )}
        {src?.code && (
          <div className="flow-step-line flow-step-muted">{src.code}</div>
        )}
        {!isJoin && liveEditor && (
          <div className={`flow-step-live ${liveEditor.isSelf ? "flow-step-live-self" : "flow-step-live-other"}`}>
            <div className="flow-step-live-label">
              {liveEditor.isSelf ? "Tú editando" : "Editando ahora"}
            </div>
            <div className="flow-step-live-name">{liveEditor.name || "Tú"}</div>
          </div>
        )}
        {!isJoin && (
          <div className="flow-step-users">
            <div className="flow-step-users-label">Usuarios clave</div>
            {assignedRoles.length === 0 ? (
              <div className="flow-step-users-empty">Sin asignar</div>
            ) : (
              assignedRoles.slice(0, 2).map((r, i) => (
                <div key={r.tmpId || r.id || `${r.type}-${i}`} className="flow-step-user">
                  {roleLabel(r.type)} · {userLabel(r)}
                </div>
              ))
            )}
            {assignedRoles.length > 2 && (
              <div className="flow-step-users-more">+{assignedRoles.length - 2} más</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function evaluateGovernanceRisks(data, activeTypes = { ungoverned_source: true, no_user_assigned: true }) {
  const sourceById = Object.fromEntries(data.sources.map((s) => [s.id, s]));
  const procById = Object.fromEntries(data.processes.map((p) => [p.id, p]));
  const riskProcs = new Set();
  const riskSteps = new Set();
  const riskSources = new Set();
  const noUserProcs = new Set();
  const noUserSteps = new Set();
  const items = [];

  if (activeTypes.ungoverned_source) {
    data.steps.forEach((st) => {
      const src = st.sourceId ? sourceById[st.sourceId] : null;
      if (!isUngovernedSource(src)) return;
      riskSteps.add(st.id);
      riskProcs.add(st.processId);
      riskSources.add(src.id);
      const proc = procById[st.processId];
      items.push({
        riskId: "ungoverned_source",
        type: "step",
        processId: st.processId,
        stepId: st.id,
        label: `${proc?.name || "Proceso"} · ${st.name || "Paso"}`,
        detail: `Archivo no gobernado: ${src.code || "sin nombre"}`,
        sourceCode: src.code,
      });
    });

    data.sources.forEach((src) => {
      if (!isUngovernedSource(src)) return;
      riskSources.add(src.id);
      riskProcs.add(src.processId);
      if (!data.steps.some((st) => st.sourceId === src.id)) {
        const proc = procById[src.processId];
        items.push({
          riskId: "ungoverned_source",
          type: "process",
          processId: src.processId,
          label: proc?.name || "Proceso",
          detail: `Archivo no gobernado: ${src.code || "sin nombre"}`,
          sourceCode: src.code,
        });
      }
    });
  }

  if (activeTypes.no_user_assigned) {
    data.steps.forEach((st) => {
      if (stepHasAssignedUser(st.id, data.roles)) return;
      noUserSteps.add(st.id);
      noUserProcs.add(st.processId);
      const proc = procById[st.processId];
      items.push({
        riskId: "no_user_assigned",
        type: "step",
        processId: st.processId,
        stepId: st.id,
        label: `${proc?.name || "Proceso"} · ${st.name || "Paso"}`,
        detail: "Ningún responsable asignado a este paso",
      });
    });
  }

  return { riskProcs, riskSteps, riskSources, noUserProcs, noUserSteps, items };
}

const PRIORITY_SEVERITY = { critical: 0, high: 1, medium: 2, low: 3 };
const PRIORITY_COLORS = { critical: "#EA4335", high: "#E65100", medium: "#FBBC04", low: "#7A8494" };
const PRIORITY_LABELS = { critical: "Crítico", high: "Alto", medium: "Medio", low: "Bajo" };

function buildGovernancePriorities(data) {
  const withOwner = new Set(data.roles.filter((r) => r.type === "owner").map((r) => r.processId));
  const withSteward = new Set(data.roles.filter((r) => r.type === "steward").map((r) => r.processId));
  const procById = Object.fromEntries(data.processes.map((p) => [p.id, p]));
  const { riskProcs, items: riskItems } = evaluateGovernanceRisks(data);
  const priorities = [];

  const sensitiveUndoc = data.fields.filter((f) => f.sensitive && !(f.description || "").trim());
  if (sensitiveUndoc.length > 0) {
    priorities.push({
      id: "sensitive_undoc",
      severity: "critical",
      title: "Datos sensibles sin significado",
      description: "Campos marcados como sensibles que aún no tienen descripción de negocio.",
      count: sensitiveUndoc.length,
      unit: "dato",
      action: "capture",
      actionLabel: "Documentar datos",
    });
  }

  if (riskProcs.size > 0) {
    const examples = [...riskProcs].slice(0, 3).map((id) => procById[id]?.name).filter(Boolean);
    priorities.push({
      id: "ungoverned_source",
      severity: "high",
      title: "Orígenes no gobernados (Excel / archivo)",
      description: examples.length
        ? `Procesos con pasos que dependen de archivos compartidos: ${examples.join(", ")}${riskProcs.size > 3 ? "…" : ""}.`
        : "Procesos o pasos que dependen de archivos compartidos sin gobernar.",
      count: riskProcs.size,
      unit: "proceso",
      action: "graph",
      actionLabel: "Ver mapa de riesgos",
    });
  }

  const noOwner = data.processes.filter((p) => !withOwner.has(p.id));
  if (noOwner.length > 0) {
    priorities.push({
      id: "no_owner",
      severity: "medium",
      title: "Procesos sin Data Owner",
      description: "Sin responsable de negocio que apruebe accesos y uso del dato.",
      count: noOwner.length,
      unit: "proceso",
      action: "roles",
      actionLabel: "Asignar responsables",
    });
  }

  const noSteward = data.processes.filter((p) => !withSteward.has(p.id));
  if (noSteward.length > 0) {
    priorities.push({
      id: "no_steward",
      severity: "medium",
      title: "Procesos sin Data Steward",
      description: "Falta quien defina el significado y la calidad del dato.",
      count: noSteward.length,
      unit: "proceso",
      action: "roles",
      actionLabel: "Completar directorio",
    });
  }

  const undocumented = data.processes.filter((p) => !isProcessDocumented(p.id, data));
  if (undocumented.length > 0) {
    priorities.push({
      id: "undocumented",
      severity: "low",
      title: "Metas de documentación pendientes",
      description: "Procesos declarados que aún no tienen al menos un paso documentado.",
      count: undocumented.length,
      unit: "proceso",
      action: "capture",
      actionLabel: "Documentar procesos",
    });
  }

  const fieldsUndoc = data.fields.filter((f) => !(f.description || "").trim() && !f.sensitive);
  if (fieldsUndoc.length > 0) {
    priorities.push({
      id: "fields_undoc",
      severity: "low",
      title: "Datos sin significado de negocio",
      description: "Campos catalogados que aún no tienen descripción ni ejemplo documentado.",
      count: fieldsUndoc.length,
      unit: "dato",
      action: "capture",
      actionLabel: "Completar catálogo",
    });
  }

  return priorities.sort((a, b) => PRIORITY_SEVERITY[a.severity] - PRIORITY_SEVERITY[b.severity]);
}

function GovernancePriorities({ data, t, setView }) {
  const priorities = useMemo(() => buildGovernancePriorities(data), [data]);
  const openCount = priorities.length;
  const topSeverity = priorities[0]?.severity;

  return (
    <div style={{ background: t.surfaceSolid, border: `1px solid ${t.border}`, borderRadius: 14,
      padding: 22, marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 16 }}>
        <div style={{ width: 44, height: 44, borderRadius: 12,
          background: (topSeverity ? PRIORITY_COLORS[topSeverity] : "#34A853") + "18",
          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Flag size={22} color={topSeverity ? PRIORITY_COLORS[topSeverity] : "#34A853"} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: -0.3 }}>Prioridades de gobierno</div>
          <div style={{ fontSize: 13, color: t.textDim, marginTop: 3 }}>
            {openCount === 0
              ? "No hay brechas críticas. Mantén el catálogo actualizado."
              : `${openCount} frente${openCount !== 1 ? "s" : ""} de acción ordenados por impacto`}
          </div>
        </div>
        {openCount > 0 && (
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 11, color: t.textFaint, fontWeight: 600, letterSpacing: 0.4 }}>MÁXIMA</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: PRIORITY_COLORS[topSeverity], marginTop: 2 }}>
              {PRIORITY_LABELS[topSeverity]}
            </div>
          </div>
        )}
      </div>

      {openCount === 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 9, color: "#34A853", fontSize: 14,
          padding: "10px 12px", background: "#34A85312", borderRadius: 10 }}>
          <Check size={17} /> Gobernanza al día en las dimensiones evaluadas.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {priorities.map((p, i) => {
            const color = PRIORITY_COLORS[p.severity];
            return (
              <div key={p.id} onClick={() => setView(p.action)}
                style={{ display: "grid", gridTemplateColumns: "28px 1fr auto", gap: 12, alignItems: "center",
                  padding: "13px 14px", background: t.surfaceAlt, borderRadius: 11, cursor: "pointer",
                  border: `1px solid ${t.border}`, borderLeft: `4px solid ${color}` }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = color + "66"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = t.border; }}>
                <div style={{ width: 28, height: 28, borderRadius: 8, background: color + "18",
                  color, fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center",
                  justifyContent: "center" }}>{i + 1}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 3 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: t.text }}>{p.title}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 99,
                      background: color + "18", color }}>{PRIORITY_LABELS[p.severity]}</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: t.textDim, lineHeight: 1.45 }}>{p.description}</div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color, lineHeight: 1 }}>{p.count}</div>
                  <div style={{ fontSize: 10.5, color: t.textFaint, marginTop: 2 }}>
                    {p.unit}{p.count !== 1 ? "s" : ""}
                  </div>
                  <div style={{ fontSize: 11, color: t.primary, fontWeight: 600, marginTop: 6,
                    display: "flex", alignItems: "center", gap: 3, justifyContent: "flex-end" }}>
                    {p.actionLabel} <ChevronRight size={13} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// EXPLORADOR DE ECOSISTEMA — visualización interactiva multinivel
// ============================================================================
function toggleGraphFilter(setter, id, allIds) {
  setter((prev) => {
    if (prev === null) return [id];
    if (prev.length === 1 && prev[0] === id) return null;
    if (prev.includes(id)) {
      const next = prev.filter((x) => x !== id);
      return next.length === 0 ? null : next;
    }
    const next = [...prev, id];
    return next.length === allIds.length ? null : next;
  });
}

function GraphFilterMenuItem({ label, sublabel, color, checked, onClick, t }) {
  return (
    <div onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
      cursor: "pointer", fontSize: 12, color: checked ? t.text : t.textDim,
      background: checked ? (color || t.primary) + "12" : "transparent" }}
      onMouseEnter={(e) => { if (!checked) e.currentTarget.style.background = t.surfaceAlt; }}
      onMouseLeave={(e) => { if (!checked) e.currentTarget.style.background = "transparent"; }}>
      <span style={{ width: 14, height: 14, borderRadius: 4, flexShrink: 0, display: "flex",
        alignItems: "center", justifyContent: "center",
        border: `1.5px solid ${checked ? (color || t.primary) : t.border}`,
        background: checked ? (color || t.primary) : "transparent" }}>
        {checked && <Check size={10} color="#fff" strokeWidth={3} />}
      </span>
      {color && <span style={{ width: 7, height: 7, borderRadius: 99, background: color, flexShrink: 0 }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: checked ? 600 : 500 }}>
          {label}
        </div>
        {sublabel && <div style={{ fontSize: 10.5, color: t.textFaint, overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sublabel}</div>}
      </div>
    </div>
  );
}

function GraphFilterMenu({ label, activeCount, totalCount, open, onOpenChange, search, onSearchChange,
  searchPlaceholder, onClear, children, t }) {
  const ref = useRef();
  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onOpenChange(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open, onOpenChange]);

  const hasFilter = activeCount > 0 && activeCount < totalCount;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <div onClick={() => onOpenChange(!open)} style={{
        display: "flex", alignItems: "center", gap: 6, padding: "5px 11px",
        borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 600,
        border: `1px solid ${hasFilter || open ? t.primary : t.border}`,
        background: hasFilter || open ? t.primary + "14" : t.surfaceAlt,
        color: hasFilter || open ? t.primary : t.textDim,
      }}>
        {label}
        {hasFilter && (
          <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 99,
            background: t.primary, color: "#fff" }}>{activeCount}</span>
        )}
        <ChevronDown size={13} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }} />
      </div>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 30, minWidth: 260,
          maxWidth: 320, background: t.surfaceSolid, border: "1px solid " + t.border,
          borderRadius: 10, boxShadow: t.dark ? "0 12px 32px #00000066" : "0 12px 32px #00000018",
          overflow: "hidden" }}>
          <div style={{ padding: "10px 10px 8px", borderBottom: "1px solid " + t.border }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
              borderRadius: 8, border: "1px solid " + t.border, background: t.surfaceAlt }}>
              <Search size={14} color={t.textFaint} />
              <input value={search} onChange={(e) => onSearchChange(e.target.value)}
                placeholder={searchPlaceholder}
                style={{ flex: 1, border: "none", outline: "none", background: "transparent",
                  fontSize: 12, color: t.text, fontFamily: "inherit" }} />
              {search && (
                <X size={13} color={t.textFaint} style={{ cursor: "pointer" }}
                  onClick={() => onSearchChange("")} />
              )}
            </div>
            {onClear && hasFilter && (
              <div onClick={onClear} style={{ marginTop: 8, fontSize: 11, color: t.primary,
                fontWeight: 500, cursor: "pointer", textAlign: "right" }}>Mostrar todas</div>
            )}
          </div>
          <div style={{ maxHeight: 240, overflowY: "auto" }}>{children}</div>
        </div>
      )}
    </div>
  );
}

function EcosystemExplorer({ data, t, areaColors, procColors, onEditProcess }) {
  const [selectedArea, setSelectedArea] = useState(null);
  const [selectedProc, setSelectedProc] = useState(null);
  const [level, setLevel] = useState("overview");
  const [filter, setFilter] = useState("procs");
  const [openMenu, setOpenMenu] = useState(null);
  const [activeAreas, setActiveAreas] = useState(null);
  const [activeProcesses, setActiveProcesses] = useState(null);
  const [activeSteps, setActiveSteps] = useState(null);
  const [searchAreas, setSearchAreas] = useState("");
  const [searchProcesses, setSearchProcesses] = useState("");
  const [searchSteps, setSearchSteps] = useState("");

  const allAreaIds = useMemo(() => data.areas.map((a) => a.id), [data.areas]);
  const allProcIds = useMemo(() => data.processes.map((p) => p.id), [data.processes]);
  const allStepIds = useMemo(() => data.steps.map((s) => s.id), [data.steps]);

  const graphFilters = useMemo(() => ({
    areas: activeAreas,
    processes: activeProcesses,
    steps: activeSteps,
  }), [activeAreas, activeProcesses, activeSteps]);

  const activeFilterCount = [activeAreas, activeProcesses, activeSteps].filter(Boolean).length;

  const goToArea = (areaId) => { setSelectedArea(areaId); setSelectedProc(null); setLevel("area"); };
  const goToProcess = (procId) => { setSelectedProc(procId); setLevel("process"); };
  const goBack = () => {
    if (level === "process") { setSelectedProc(null); setLevel("area"); }
    else { setSelectedArea(null); setLevel("overview"); }
  };

  const visibleAreas = useMemo(() => {
    let areas = data.areas;
    if (activeAreas) areas = areas.filter((a) => activeAreas.includes(a.id));
    if (activeProcesses) {
      const areaIds = new Set(data.processes.filter((p) => activeProcesses.includes(p.id)).map((p) => p.areaId));
      areas = areas.filter((a) => areaIds.has(a.id));
    }
    if (activeSteps) {
      const procIds = new Set(data.steps.filter((s) => activeSteps.includes(s.id)).map((s) => s.processId));
      const areaIds = new Set(data.processes.filter((p) => procIds.has(p.id)).map((p) => p.areaId));
      areas = areas.filter((a) => areaIds.has(a.id));
    }
    const visibleIds = new Set(areas.map((a) => a.id));
    data.steps.forEach((st) => {
      if (!st.stepAreaId) return;
      const proc = data.processes.find((p) => p.id === st.processId);
      if (!proc || proc.areaId === st.stepAreaId) return;
      if (visibleIds.has(proc.areaId)) visibleIds.add(st.stepAreaId);
    });
    return data.areas.filter((a) => visibleIds.has(a.id));
  }, [data, activeAreas, activeProcesses, activeSteps]);

  const clearAllFilters = () => {
    setActiveAreas(null);
    setActiveProcesses(null);
    setActiveSteps(null);
  };

  const matchSearch = (q, ...parts) => {
    const lower = q.trim().toLowerCase();
    if (!lower) return true;
    return parts.some((p) => String(p || "").toLowerCase().includes(lower));
  };

  const filteredAreaItems = useMemo(() => data.areas.filter((a) =>
    matchSearch(searchAreas, a.name)), [data.areas, searchAreas]);

  const filteredProcessItems = useMemo(() => data.processes.filter((p) => {
    const area = data.areas.find((a) => a.id === p.areaId);
    return matchSearch(searchProcesses, p.name, area?.name);
  }), [data.processes, data.areas, searchProcesses]);

  const filteredStepItems = useMemo(() => data.steps.filter((st) => {
    const proc = data.processes.find((p) => p.id === st.processId);
    const area = proc ? data.areas.find((a) => a.id === proc.areaId) : null;
    return matchSearch(searchSteps, st.name, proc?.name, area?.name);
  }), [data.steps, data.processes, data.areas, searchSteps]);

  const areaStats = useMemo(() => {
    const map = {};
    data.areas.forEach((a) => {
      const procs = data.processes.filter((p) => p.areaId === a.id);
      const srcIds = data.sources.filter((s) => procs.some((p) => p.id === s.processId)).map((s) => s.id);
      map[a.id] = {
        procs: procs.length,
        fields: data.fields.filter((f) => srcIds.includes(f.sourceId)).length,
        sensitive: data.fields.filter((f) => srcIds.includes(f.sourceId) && f.sensitive).length,
      };
    });
    return map;
  }, [data]);

  const breadcrumb = [{ label: "Ecosistema", onClick: () => { setLevel("overview"); setSelectedArea(null); setSelectedProc(null); } }];
  if (selectedArea) {
    const area = data.areas.find((a) => a.id === selectedArea);
    breadcrumb.push({ label: area ? area.name : "", onClick: () => goToArea(selectedArea) });
  }
  if (selectedProc) {
    const proc = data.processes.find((p) => p.id === selectedProc);
    breadcrumb.push({ label: proc ? proc.name : "" });
  }

  const viewFilters = [
    { id: "areas", label: "Solo áreas" },
    { id: "procs", label: "Procesos" },
    { id: "risks", label: "Riesgos" },
  ];

  return (
    <div style={{ height: "calc(100vh - 52px)", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
        {breadcrumb.map((b, i) => (
          <React.Fragment key={i}>
            {i > 0 && <ChevronRight size={14} color={t.textFaint} />}
            <span onClick={b.onClick} style={{ fontSize: 14, fontWeight: i === breadcrumb.length - 1 ? 600 : 500,
              color: i === breadcrumb.length - 1 ? t.text : t.primary,
              cursor: b.onClick ? "pointer" : "default" }}>{b.label}</span>
          </React.Fragment>
        ))}
        <div style={{ flex: 1 }} />
        {level === "overview" && (
          <div style={{ display: "flex", gap: 4, background: t.surfaceAlt, borderRadius: 8, padding: 3,
            border: "1px solid " + t.border }}>
            {viewFilters.map((f) => (
              <div key={f.id} onClick={() => setFilter(f.id)} style={{ padding: "5px 12px", borderRadius: 6,
                cursor: "pointer", fontSize: 12, fontWeight: 500,
                background: filter === f.id ? (f.id === "risks" ? RISK_COLOR : t.primary) : "transparent",
                color: filter === f.id ? "#fff" : t.textDim }}>{f.label}</div>
            ))}
          </div>
        )}
      </div>

      {level === "overview" && data.areas.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <GraphFilterMenu label="Áreas" activeCount={activeAreas?.length || 0} totalCount={data.areas.length}
            open={openMenu === "areas"} onOpenChange={(o) => setOpenMenu(o ? "areas" : null)}
            search={searchAreas} onSearchChange={setSearchAreas} searchPlaceholder="Buscar área…"
            onClear={() => setActiveAreas(null)} t={t}>
            {filteredAreaItems.length === 0 ? (
              <div style={{ padding: "14px 12px", fontSize: 12, color: t.textFaint }}>Sin resultados</div>
            ) : filteredAreaItems.map((a) => {
              const checked = !activeAreas || activeAreas.includes(a.id);
              const ac = areaColors[a.id] || t.primary;
              const procCount = data.processes.filter((p) => p.areaId === a.id).length;
              return (
                <GraphFilterMenuItem key={a.id} label={a.name} sublabel={`${procCount} procesos`}
                  color={ac} checked={checked} t={t}
                  onClick={() => toggleGraphFilter(setActiveAreas, a.id, allAreaIds)} />
              );
            })}
          </GraphFilterMenu>

          {data.processes.length > 0 && (
            <GraphFilterMenu label="Procesos" activeCount={activeProcesses?.length || 0} totalCount={data.processes.length}
              open={openMenu === "processes"} onOpenChange={(o) => setOpenMenu(o ? "processes" : null)}
              search={searchProcesses} onSearchChange={setSearchProcesses} searchPlaceholder="Buscar proceso…"
              onClear={() => setActiveProcesses(null)} t={t}>
              {filteredProcessItems.length === 0 ? (
                <div style={{ padding: "14px 12px", fontSize: 12, color: t.textFaint }}>Sin resultados</div>
              ) : filteredProcessItems.map((p) => {
                const checked = !activeProcesses || activeProcesses.includes(p.id);
                const area = data.areas.find((a) => a.id === p.areaId);
                const ac = area ? (areaColors[area.id] || t.primary) : t.primary;
                const stepCount = data.steps.filter((s) => s.processId === p.id).length;
                return (
                  <GraphFilterMenuItem key={p.id} label={p.name}
                    sublabel={area ? `${area.name}${stepCount ? ` · ${stepCount} pasos` : ""}` : undefined}
                    color={ac} checked={checked} t={t}
                    onClick={() => toggleGraphFilter(setActiveProcesses, p.id, allProcIds)} />
                );
              })}
            </GraphFilterMenu>
          )}

          {data.steps.length > 0 && (
            <GraphFilterMenu label="Pasos" activeCount={activeSteps?.length || 0} totalCount={data.steps.length}
              open={openMenu === "steps"} onOpenChange={(o) => setOpenMenu(o ? "steps" : null)}
              search={searchSteps} onSearchChange={setSearchSteps} searchPlaceholder="Buscar paso…"
              onClear={() => setActiveSteps(null)} t={t}>
              {filteredStepItems.length === 0 ? (
                <div style={{ padding: "14px 12px", fontSize: 12, color: t.textFaint }}>Sin resultados</div>
              ) : filteredStepItems.map((st) => {
                const checked = !activeSteps || activeSteps.includes(st.id);
                const proc = data.processes.find((p) => p.id === st.processId);
                const area = proc ? data.areas.find((a) => a.id === proc.areaId) : null;
                const ac = area ? (areaColors[area.id] || t.primary) : t.primary;
                const order = data.steps.filter((s) => s.processId === st.processId).sort((a, b) => a.order - b.order);
                const idx = order.findIndex((s) => s.id === st.id);
                return (
                  <GraphFilterMenuItem key={st.id}
                    label={st.name || `Paso ${idx + 1}`}
                    sublabel={proc ? proc.name : undefined}
                    color={ac} checked={checked} t={t}
                    onClick={() => toggleGraphFilter(setActiveSteps, st.id, allStepIds)} />
                );
              })}
            </GraphFilterMenu>
          )}

          {activeFilterCount > 0 && (
            <span onClick={clearAllFilters} style={{ fontSize: 11.5, color: t.primary,
              fontWeight: 500, cursor: "pointer", marginLeft: 4 }}>Limpiar filtros</span>
          )}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, background: t.dark ? "#08090C" : "#FAFBFC",
        borderRadius: 14, border: "1px solid " + t.border, overflow: "hidden" }}>
        {level === "overview" && <RadialTree data={data} t={t} areaColors={areaColors}
          procColors={procColors} filter={filter} visibleAreas={visibleAreas} graphFilters={graphFilters}
          goToArea={goToArea} goToProcess={goToProcess} areaStats={areaStats} />}
        {level === "area" && selectedArea && <AreaLevel data={data} t={t} areaColors={areaColors}
          procColors={procColors} areaId={selectedArea} areaStats={areaStats}
          goToProcess={goToProcess} goBack={goBack} />}
        {level === "process" && selectedProc && <ProcessLevel data={data} t={t}
          areaColors={areaColors} procColors={procColors} procId={selectedProc} goBack={goBack}
          onEditProcess={onEditProcess} />}
      </div>
    </div>
  );
}

function RadialTree({ data, t, areaColors, procColors, filter, visibleAreas, graphFilters, goToArea, goToProcess, areaStats }) {
  const svgRef = useRef();
  const containerRef = useRef();
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [hovered, setHovered] = useState(null);
  const riskView = filter === "risks";
  const showSteps = riskView || filter === "steps";
  const showSources = riskView || filter === "steps";
  const { processes: activeProcesses, steps: activeSteps } = graphFilters;
  const governanceRisks = useMemo(() => evaluateGovernanceRisks(data), [data]);
  const { riskProcs, riskSteps, riskSources, noUserProcs, noUserSteps, items: riskItems } = governanceRisks;
  const riskGray = t.dark ? "#5C6370" : "#9CA3AF";
  const riskGrayFill = t.dark ? "#2A2E36" : "#E5E7EB";
  const riskGrayLink = t.dark ? "#3A3F4A" : "#D1D5DB";

  useEffect(() => {
    if (!containerRef.current) return;
    const measure = () => {
      const r = containerRef.current.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setDims({ w: r.width, h: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // D3 zoom
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    const g = svg.select("g.tree-root");
    if (g.empty()) return;
    const zoom = d3.zoom().scaleExtent([0.2, 4]).on("zoom", (e) => g.attr("transform", e.transform));
    svg.call(zoom);
    if (dims.w > 0) {
      const s = Math.min(dims.w, dims.h) / 700;
      svg.call(zoom.transform, d3.zoomIdentity.translate(dims.w / 2, dims.h / 2).scale(Math.max(0.4, Math.min(s, 1.2))));
    }
    return () => svg.on(".zoom", null);
  }, [dims, visibleAreas.length, filter, graphFilters]);

  const { w, h } = dims;
  const areas = visibleAreas;
  const n = areas.length;
  const visibleAreaIds = useMemo(() => new Set(areas.map((a) => a.id)), [areas]);

  // Layout radial
  const tree = useMemo(() => {
    const nodes = [];
    const links = [];
    const nodeIds = new Set();

    const addNode = (node) => {
      if (nodeIds.has(node.id)) return false;
      nodeIds.add(node.id);
      nodes.push(node);
      return true;
    };
    const addLink = (link) => links.push(link);

    // Centro
    addNode({ id: "center", label: "", type: "center", x: 0, y: 0, r: 14, color: t.textFaint });

    const areaR = 130;
    const procR = 95;
    const stepR = 58;
    const srcR = 42;
    const stepSeg = 38;

    areas.forEach((a, ai) => {
      const angle = (ai / Math.max(n, 1)) * Math.PI * 2 - Math.PI / 2;
      const ax = areaR * Math.cos(angle);
      const ay = areaR * Math.sin(angle);
      const color = areaColors[a.id] || t.primary;
      const stats = areaStats[a.id] || { procs: 0, fields: 0 };
      const size = 13 + Math.min(stats.procs * 2, 12);

      addNode({ id: "a:" + a.id, label: a.name, type: "area", x: ax, y: ay,
        r: size, color, areaId: a.id, stats });
      addLink({ from: "center", to: "a:" + a.id, color: color + "44" });

      if (filter === "areas") return;

      let procs = data.processes.filter((p) => p.areaId === a.id);
      if (activeProcesses) procs = procs.filter((p) => activeProcesses.includes(p.id));
      const fanAngle = Math.min(Math.PI * 0.45, procs.length * 0.18);
      procs.forEach((p, pi) => {
        const offset = procs.length > 1 ? (pi / (procs.length - 1) - 0.5) * fanAngle : 0;
        const branchAngle = angle + offset;
        const px = ax + procR * Math.cos(branchAngle);
        const py = ay + procR * Math.sin(branchAngle);
        const pc = procColors[p.id] || color;
        let procSteps = data.steps.filter((s) => s.processId === p.id).sort((a, b) => a.order - b.order);
        if (activeSteps) procSteps = procSteps.filter((s) => activeSteps.includes(s.id));

        const procRiskType = resolveProcRiskType(p.id, riskProcs, noUserProcs);

        addNode({ id: "p:" + p.id, label: p.name, type: "process", x: px, y: py,
          r: 7 + Math.min(procSteps.length, 5), color: pc, procId: p.id, areaColor: color,
          stepCount: procSteps.length, ownerAreaId: a.id,
          riskType: procRiskType,
          atRisk: !!procRiskType,
          riskDetail: procRiskType ? riskDetailForType(procRiskType, {
            sourceCode: procRiskType === "ungoverned" ? "archivo" : undefined,
          }) : "" });
        addLink({ from: "a:" + a.id, to: "p:" + p.id, color: pc + "44" });

        if (showSteps && procSteps.length > 0) {
          const resolvedSteps = resolveProcessStepTree(procSteps);
          const treeSteps = persistedStepsToFlowTree(resolvedSteps);
          const stepOrderMap = buildStepOrderMap(treeSteps);
          appendRadialProcessStepTree({
            treeSteps,
            procSteps: resolvedSteps,
            data,
            processNodeId: "p:" + p.id,
            px, py, branchAngle,
            stepR, stepSeg, srcR,
            showSources,
            activeSteps,
            riskSteps, noUserSteps, riskSources,
            visibleAreaIds, areaColors, pc, p,
            addNode, addLink,
            stepOrderMap,
          });
        } else if (showSources) {
          const sources = data.sources.filter((s) => s.processId === p.id);
          const srcFan = Math.min(Math.PI * 0.3, sources.length * 0.15);
          sources.forEach((s, si) => {
            const srcOffset = sources.length > 1 ? (si / (sources.length - 1) - 0.5) * srcFan : 0;
            const srcAngle = branchAngle + srcOffset;
            const sx = px + stepR * Math.cos(srcAngle);
            const sy = py + stepR * Math.sin(srcAngle);
            const hasSensitive = data.fields.some((f) => f.sourceId === s.id && f.sensitive);
            const srcAtRisk = riskSources.has(s.id);
            const srcRiskType = srcAtRisk ? "ungoverned" : null;
            addNode({ id: "s:" + s.id, label: s.code, type: "source", x: sx, y: sy,
              r: 7.5, color: pc, sensitive: hasSensitive,
              riskType: srcRiskType,
              atRisk: !!srcRiskType,
              riskDetail: srcRiskType ? riskDetailForType(srcRiskType, { sourceCode: s.code }) : "" });
            addLink({ from: "p:" + p.id, to: "s:" + s.id, color: pc + "22" });
          });
        }
      });

      let participating = data.processes.filter((p) => p.areaId !== a.id
        && data.steps.some((s) => s.processId === p.id && s.stepAreaId === a.id));
      if (activeProcesses) participating = participating.filter((p) => activeProcesses.includes(p.id));
      if (activeSteps) {
        participating = participating.filter((p) =>
          data.steps.some((s) => s.processId === p.id && s.stepAreaId === a.id
            && activeSteps.includes(s.id)));
      }
      const partFan = Math.min(Math.PI * 0.35, participating.length * 0.16);
      participating.forEach((p, pi) => {
        const offset = participating.length > 1 ? (pi / (participating.length - 1) - 0.5) * partFan : 0;
        const partAngle = angle - Math.PI / 2.8 + offset;
        const partX = ax + (procR * 0.82) * Math.cos(partAngle);
        const partY = ay + (procR * 0.82) * Math.sin(partAngle);
        const ownerArea = data.areas.find((ar) => ar.id === p.areaId);
        const ownerColor = ownerArea ? (areaColors[ownerArea.id] || color) : color;
        const partId = "part:" + p.id + ":" + a.id;

        addNode({
          id: partId, label: p.name, type: "participant", x: partX, y: partY,
          r: 5.5, color: ownerColor, procId: p.id, ownerAreaId: p.areaId,
          ownerAreaName: ownerArea?.name || "", hostAreaId: a.id,
        });
        addLink({ from: "a:" + a.id, to: partId, color: color + "55", dashed: true });
        if (visibleAreaIds.has(p.areaId) && nodeIds.has("p:" + p.id)) {
          addLink({
            from: partId, to: "p:" + p.id, color: ownerColor + "77",
            dashed: true, crossArea: true,
          });
        }
      });
    });

    return { nodes, links };
  }, [data, areas, areaColors, procColors, filter, n, t.primary, areaStats, showSteps, showSources, activeProcesses, activeSteps, visibleAreaIds, riskProcs, riskSteps, riskSources, noUserProcs, noUserSteps]);

  if (w === 0 || n === 0) {
    return (
      <div ref={containerRef} style={{ width: "100%", height: "100%", display: "flex",
        alignItems: "center", justifyContent: "center", color: t.textFaint }}>
        <div style={{ textAlign: "center" }}>
          <Network size={40} strokeWidth={1.2} />
          <div style={{ fontSize: 15, marginTop: 12 }}>
            {data.areas.length === 0
              ? "Documenta procesos para ver el ecosistema."
              : "Ajusta los filtros para ver elementos en el mapa."}
          </div>
        </div>
      </div>
    );
  }

  const hoveredNode = hovered ? tree.nodes.find((n) => n.id === hovered) : null;

  // Qué nodos atenuar
  const connectedToHover = new Set();
  if (hovered) {
    connectedToHover.add(hovered);
    tree.links.forEach((l) => {
      if (l.from === hovered) connectedToHover.add(l.to);
      if (l.to === hovered) connectedToHover.add(l.from);
    });
    // Si es área, incluir sus procesos y sus fuentes
    if (hovered.startsWith("a:")) {
      tree.links.forEach((l) => {
        if (l.from === hovered) {
          connectedToHover.add(l.to);
          tree.links.forEach((l2) => { if (l2.from === l.to) connectedToHover.add(l2.to); });
        }
      });
    }
    if (hovered.startsWith("p:") || hovered.startsWith("part:")) {
      const collect = (nodeId) => {
        connectedToHover.add(nodeId);
        tree.links.forEach((l) => {
          if (l.from === nodeId && !connectedToHover.has(l.to)) collect(l.to);
          if (l.to === nodeId && !connectedToHover.has(l.from)) collect(l.from);
        });
      };
      collect(hovered);
    }
    if (hovered.startsWith("st:") || hovered.startsWith("join:")) {
      const collectUp = (nodeId) => {
        connectedToHover.add(nodeId);
        tree.links.forEach((l) => {
          if (l.to === nodeId && !connectedToHover.has(l.from)) collectUp(l.from);
        });
      };
      const collectDown = (nodeId) => {
        connectedToHover.add(nodeId);
        tree.links.forEach((l) => {
          if (l.from === nodeId && !connectedToHover.has(l.to)) collectDown(l.to);
        });
      };
      collectUp(hovered);
      collectDown(hovered);
    }
    if (hovered.startsWith("u:")) {
      const collectUp = (nodeId) => {
        connectedToHover.add(nodeId);
        tree.links.forEach((l) => {
          if (l.to === nodeId && !connectedToHover.has(l.from)) collectUp(l.from);
        });
      };
      const collectDown = (nodeId) => {
        connectedToHover.add(nodeId);
        tree.links.forEach((l) => {
          if (l.from === nodeId && !connectedToHover.has(l.to)) collectDown(l.to);
        });
      };
      collectUp(hovered);
      collectDown(hovered);
    }
  }

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%", position: "relative" }}>
      {riskView && (
        <style>{`
          @keyframes risk-blink-red-kf {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.38; }
          }
          @keyframes risk-blink-yellow-kf {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.42; }
          }
          .risk-blink-red {
            animation: risk-blink-red-kf 1.15s ease-in-out infinite;
          }
          .risk-blink-yellow {
            animation: risk-blink-yellow-kf 1.35s ease-in-out infinite;
          }
        `}</style>
      )}
      <svg ref={svgRef} style={{ width: "100%", height: "100%", cursor: "grab" }}>
        <defs>
          <filter id="tree-glow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="node-glow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="6" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="node-glow-strong" x="-120%" y="-120%" width="340%" height="340%">
            <feGaussianBlur stdDeviation="10" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <g className="tree-root">
          {/* Links */}
          {tree.links.map((l, i) => {
            const from = tree.nodes.find((n) => n.id === l.from);
            const to = tree.nodes.find((n) => n.id === l.to);
            if (!from || !to) return null;
            const hoverDimmed = hovered && !connectedToHover.has(l.from) && !connectedToHover.has(l.to);
            const linkColor = riskView ? riskGrayLink : l.color;
            const linkOpacity = riskView ? (hoverDimmed ? 0.12 : 0.35) : (hoverDimmed ? 0.1 : l.crossArea ? 0.45 : 0.6);
            return (
              <line key={"l" + i} x1={from.x} y1={from.y} x2={to.x} y2={to.y}
                stroke={linkColor} strokeWidth={hoverDimmed ? 0.5 : l.crossArea ? 1.2 : 1.5}
                opacity={linkOpacity}
                strokeDasharray={!riskView && l.dashed ? "5 4" : undefined}
                strokeLinecap="round" />
            );
          })}

          {/* Nodes */}
          {tree.nodes.map((nd) => {
            const hoverDimmed = hovered && !connectedToHover.has(nd.id);
            const isHov = hovered === nd.id;
            const clickable = nd.type === "area" || nd.type === "process" || nd.type === "participant";
            const riskType = nd.riskType || null;
            const atRisk = !!riskType;
            const riskColor = riskColorForType(riskType);
            const riskBlinkClass = riskType === "ungoverned" ? "risk-blink-red-neon"
              : riskType === "no_user" ? "risk-blink-yellow-neon" : undefined;
            const strokeColor = riskView ? (atRisk ? riskColor : riskGray) : nd.color;
            const fillColor = riskView
              ? (nd.type === "center" || nd.type === "area"
                ? riskGray
                : atRisk ? riskColor : riskGrayFill)
              : (nd.type === "center" || nd.type === "area" ? nd.color
                : nd.type === "user" ? nd.color + "44"
                : nd.type === "participant" ? (t.dark ? "#12141A" : "#FFFFFF")
                : (t.dark ? "#12141A" : "#FFFFFF"));
            const labelColor = riskView ? (atRisk ? riskColor : riskGray) : (hoverDimmed ? t.textFaint : t.text);
            const dimmed = hoverDimmed && !riskView;

            // Determinar Icono Lucide
            let NodeIcon = null;
            if (nd.type === "area") NodeIcon = Boxes;
            else if (nd.type === "process") NodeIcon = Layers;
            else if (nd.type === "user") NodeIcon = Users;
            else if (nd.type === "source") NodeIcon = Database;
            else if (nd.type === "participant") NodeIcon = GitBranch;

            const showIcon = NodeIcon && (nd.type === "area" || nd.type === "process" || nd.type === "user" || nd.type === "source" || nd.type === "participant") && !dimmed;
            const iconSize = nd.type === "area" ? 14 : nd.type === "process" ? 10 : nd.type === "user" ? 8 : 8;

            return (
              <g key={nd.id} className={riskView ? riskBlinkClass : undefined}
                style={{ cursor: clickable ? "pointer" : "default" }}
                onClick={() => {
                  if (nd.type === "area") goToArea(nd.areaId);
                  if (nd.type === "process" || nd.type === "participant") goToProcess(nd.procId);
                }}
                onMouseEnter={() => setHovered(nd.id)}
                onMouseLeave={() => setHovered(null)}>
                {/* Resplandor */}
                {nd.type !== "center" && (!dimmed || riskView) && (
                  <circle cx={nd.x} cy={nd.y} r={nd.r + (isHov ? 12 : atRisk && riskView ? 11 : 8)}
                    fill={strokeColor} opacity={isHov ? 0.28 : atRisk && riskView ? 0.4 : riskView ? 0.08 : 0.14}
                    filter={isHov || (atRisk && riskView) ? "url(#node-glow-strong)" : "url(#node-glow)"}
                    style={{ transition: "opacity .2s" }} />
                )}
                {/* Halo anillo */}
                {(nd.type === "area" || nd.type === "process" || nd.type === "user" || nd.type === "participant")
                  && (!dimmed || riskView) && (
                  <circle cx={nd.x} cy={nd.y} r={nd.r + 5} fill="none" stroke={strokeColor}
                    strokeWidth={isHov ? 2 : 1.2} opacity={isHov ? 0.55 : riskView ? 0.18 : 0.22}
                    strokeDasharray={nd.type === "participant" && !riskView ? "4 3" : undefined}
                    filter={atRisk && riskView ? "url(#node-glow-strong)" : "url(#tree-glow)"} />
                )}
                {/* Nodo */}
                {nd.type === "step" && (!dimmed || riskView) && !nd.isJoin && (
                  <text x={nd.x} y={nd.y + 1} textAnchor="middle" dominantBaseline="middle"
                    fill={riskView ? (atRisk ? (riskType === "no_user" ? "#1A1A1A" : "#fff") : riskGray) : (t.dark ? "#fff" : t.text)}
                    fontFamily={FONT} fontSize={7} fontWeight={700}
                    style={{ pointerEvents: "none" }}>{nd.stepOrder}</text>
                )}
                <circle cx={nd.x} cy={nd.y} r={isHov ? nd.r + 2 : nd.r}
                  fill={fillColor}
                  fillOpacity={riskView
                    ? (nd.type === "center" || nd.type === "area" ? 0.75 : atRisk ? 0.95 : 0.9)
                    : (nd.type === "center" || nd.type === "area" ? (dimmed ? 0.15 : 0.9)
                      : nd.type === "user" ? (dimmed ? 0.15 : 1)
                      : nd.type === "participant" ? (dimmed ? 0.2 : 0.92)
                      : (dimmed ? 0.2 : 1))}
                  stroke={strokeColor}
                  strokeWidth={nd.type === "source" ? 1.5 : nd.type === "step" ? 1.8
                    : nd.type === "participant" && !riskView ? 2 : 2.2}
                  strokeDasharray={nd.isJoin ? "3 2"
                    : nd.type === "participant" && !riskView ? "3 2" : undefined}
                  opacity={dimmed ? 0.2 : 1}
                  filter={!dimmed && (isHov || (atRisk && riskView)) ? "url(#node-glow-strong)"
                    : !dimmed && !riskView ? "url(#node-glow)" : undefined}
                  style={{ transition: "r .15s, opacity .15s" }} />
                {/* Icono embebido en el nodo (Lucide) */}
                {showIcon && (
                  <foreignObject
                    width={iconSize * 2}
                    height={iconSize * 2}
                    x={nd.x - iconSize}
                    y={nd.y - iconSize}
                    style={{ pointerEvents: "none", opacity: dimmed ? 0.25 : 1 }}
                  >
                    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", width: "100%", height: "100%" }}>
                      <NodeIcon
                        size={iconSize}
                        color={nd.type === "area" ? "#ffffff" : strokeColor}
                        strokeWidth={2.5}
                      />
                    </div>
                  </foreignObject>
                )}
                {/* Badge sensible */}
                {nd.sensitive && !dimmed && !atRisk && !riskView && (
                  <circle cx={nd.x + nd.r} cy={nd.y - nd.r} r={4} fill="#EA4335" />
                )}
                {/* Label */}
                {(nd.type !== "center") && (() => {
                  const isChain = nd.type === "user" || nd.type === "step";
                  const ang = nd.labelAngle || 0;
                  const lx = isChain ? nd.x + Math.cos(ang) * 10 : nd.x;
                  const ly = isChain
                    ? nd.y + nd.r + 11 + Math.sin(ang) * 4
                    : nd.y + nd.r + 13;
                  return (
                  <text x={lx} y={ly} textAnchor={isChain ? "start" : "middle"}
                    fill={labelColor} fontFamily={FONT}
                    fontSize={nd.type === "area" ? 12 : nd.type === "process" ? 10
                      : nd.type === "participant" ? 9
                      : nd.type === "step" ? 9 : nd.type === "user" ? 8.5 : 8.5}
                    fontWeight={nd.type === "area" ? 600 : nd.type === "user" || nd.type === "step" ? 600
                      : atRisk && riskView ? 700 : 500}
                    opacity={riskView ? (atRisk ? 1 : 0.55) : (dimmed ? 0.15 : nd.type === "source" ? 0.65 : 0.9)}
                    style={{ pointerEvents: "none" }}>
                    {nd.label.length > (nd.type === "step" ? 14 : nd.type === "user" ? 12 : 18)
                      ? nd.label.slice(0, nd.type === "step" ? 12 : nd.type === "user" ? 10 : 16) + "…"
                      : nd.label}</text>
                  );
                })()}
                {nd.type === "step" && nd.sourceCode && !dimmed && (
                  <text x={nd.x + Math.cos(nd.labelAngle || 0) * 10}
                    y={nd.y + nd.r + 22 + Math.sin(nd.labelAngle || 0) * 4}
                    textAnchor="start"
                    fill={t.textFaint} fontFamily="monospace" fontSize={7.5} opacity={0.7}>
                    {nd.sourceCode}</text>
                )}
                {nd.type === "participant" && !dimmed && (
                  <text x={nd.x} y={nd.y + nd.r + 24} textAnchor="middle"
                    fill={nd.color} fontFamily={FONT} fontSize={8} fontWeight={600} opacity={0.75}>
                    participa</text>
                )}
                {nd.type === "area" && nd.stats && !dimmed && (
                  <text x={nd.x} y={nd.y + nd.r + 25} textAnchor="middle"
                    fill={nd.color} fontFamily={FONT} fontSize={9} fontWeight={500} opacity={0.6}>
                    {nd.stats.procs}p · {nd.stats.fields}d</text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {/* Leyenda */}
      <div style={{ position: "absolute", bottom: 14, left: 14, display: "flex", gap: 14, flexWrap: "wrap",
        background: t.dark ? "#0E1013DD" : "#FFFFFFEE", backdropFilter: "blur(6px)", padding: "8px 14px",
        borderRadius: 9, border: "1px solid " + t.border, fontSize: 11, color: t.textDim }}>
        {riskView ? (
          <>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 10, height: 10, borderRadius: 99, background: riskGray }} /> Sin riesgo</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 10, height: 10, borderRadius: 99, background: RISK_COLOR,
                boxShadow: `0 0 8px ${RISK_COLOR}`, animation: "risk-blink-red-kf 1.15s ease-in-out infinite" }} />
              Origen no gobernado ({riskItems.filter((i) => i.riskId === "ungoverned_source").length})</span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 10, height: 10, borderRadius: 99, background: WARN_COLOR,
                boxShadow: `0 0 8px ${WARN_COLOR}`, animation: "risk-blink-yellow-kf 1.35s ease-in-out infinite" }} />
              Sin usuario ({riskItems.filter((i) => i.riskId === "no_user_assigned").length})</span>
          </>
        ) : (
          <>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 12, height: 12, borderRadius: 99, background: t.primary }} /> Área</span>
        {filter !== "areas" && <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 9, height: 9, borderRadius: 99, border: "2px solid " + t.textDim }} /> Proceso</span>}
        {showSteps && <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 8, height: 8, borderRadius: 99, border: "1.8px solid " + t.textDim,
            display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 6, fontWeight: 700 }}>1</span> Paso</span>}
        {showSteps && <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 7, height: 7, borderRadius: 99, border: "1.5px dashed " + t.textDim }} /> Unión de ramas</span>}
        {showSources && <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 6, height: 6, borderRadius: 99, border: "1.5px solid " + t.textDim }} /> Fuente</span>}
        {filter !== "areas" && <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 9, height: 9, borderRadius: 99, border: "2px dashed " + t.textDim }} /> Colaboración entre áreas</span>}
          </>
        )}
        <span style={{ color: t.textFaint }}>Scroll zoom · arrastra mover · click explora</span>
      </div>

      {/* Tooltip */}
      {hoveredNode && hoveredNode.type !== "center" && (() => {
        const tipRiskColor = riskView && hoveredNode.riskType
          ? riskColorForType(hoveredNode.riskType)
          : hoveredNode.color;
        return (
        <div style={{ position: "absolute", top: 14, right: 14, background: t.dark ? "#0E1013EE" : "#FFFFFFEE",
          backdropFilter: "blur(8px)", padding: "12px 16px", borderRadius: 10,
          border: "1px solid " + (hoveredNode.riskType && riskView ? tipRiskColor : hoveredNode.color), maxWidth: 280 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: hoveredNode.riskType && riskView ? tipRiskColor : hoveredNode.color,
            textTransform: "uppercase", marginBottom: 4 }}>
            {hoveredNode.type === "area" ? "Área"
              : hoveredNode.type === "process" ? "Proceso"
              : hoveredNode.type === "participant" ? "Participación"
              : hoveredNode.type === "step" ? (hoveredNode.isJoin ? "Unión de ramas" : `Paso ${hoveredNode.stepOrder || ""}`)
              : hoveredNode.type === "user" ? "Usuario clave"
              : "Fuente de datos"}</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: t.text }}>{hoveredNode.label}</div>
          {hoveredNode.riskType && hoveredNode.riskDetail && (
            <div style={{ fontSize: 12, color: tipRiskColor, marginTop: 4, fontWeight: 600 }}>
              Riesgo: {hoveredNode.riskDetail}
            </div>
          )}
          {hoveredNode.type === "participant" && hoveredNode.ownerAreaName && (
            <div style={{ fontSize: 12, color: t.textDim, marginTop: 4 }}>
              Proceso de {hoveredNode.ownerAreaName} · esta área interviene en un paso
            </div>
          )}
          {hoveredNode.type === "process" && hoveredNode.stepCount != null && (
            <div style={{ fontSize: 12, color: t.textDim, marginTop: 4 }}>
              {hoveredNode.stepCount} paso{hoveredNode.stepCount !== 1 ? "s" : ""} documentado{hoveredNode.stepCount !== 1 ? "s" : ""}
            </div>
          )}
          {hoveredNode.type === "step" && hoveredNode.pathLabel && (
            <div style={{ fontSize: 12, color: t.textDim, marginTop: 4 }}>{hoveredNode.pathLabel}</div>
          )}
          {hoveredNode.type === "step" && hoveredNode.crossAreaName && (
            <div style={{ fontSize: 12, color: hoveredNode.color, marginTop: 4, fontWeight: 600 }}>
              Ejecuta: {hoveredNode.crossAreaName}
            </div>
          )}
          {hoveredNode.type === "step" && hoveredNode.sourceCode && (
            <div style={{ fontSize: 12, color: t.textDim, marginTop: 4, fontFamily: "monospace" }}>
              Fuente: {hoveredNode.sourceCode}</div>
          )}
          {hoveredNode.type === "user" && (
            <div style={{ fontSize: 12, color: t.textDim, marginTop: 4 }}>
              {hoveredNode.email}
              <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 4 }}>
                {(hoveredNode.roles || []).map((r) => (
                  <span key={r} style={{ fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 99,
                    background: (USER_ROLE_COLORS[r] || t.primary) + "22",
                    color: USER_ROLE_COLORS[r] || t.primary }}>
                    {r === "owner" ? "Owner" : r === "steward" ? "Steward" : r === "custodian" ? "Custodian" : "Ejecutor"}
                  </span>
                ))}
              </div>
            </div>
          )}
          {hoveredNode.stats && (
            <div style={{ fontSize: 12, color: t.textDim, marginTop: 4 }}>
              {hoveredNode.stats.procs} procesos · {hoveredNode.stats.fields} datos
              {hoveredNode.stats.sensitive > 0 && <span style={{ color: "#EA4335" }}> · {hoveredNode.stats.sensitive} sensibles</span>}
            </div>
          )}
          {hoveredNode.sensitive && (
            <div style={{ fontSize: 11, color: "#EA4335", fontWeight: 600, marginTop: 4 }}>Contiene datos sensibles</div>
          )}
          {(hoveredNode.type === "area" || hoveredNode.type === "process" || hoveredNode.type === "participant") && (
            <div style={{ fontSize: 11, color: t.primary, marginTop: 6, fontWeight: 500 }}>Click para explorar →</div>
          )}
        </div>
        );
      })()}
    </div>
  );
}


function AreaLevel({ data, t, areaColors, procColors, areaId, areaStats, goToProcess, goBack }) {
  const area = data.areas.find((a) => a.id === areaId);
  const procs = data.processes.filter((p) => p.areaId === areaId);
  const color = areaColors[areaId] || t.primary;
  const stats = areaStats[areaId] || {};

  return (
    <div style={{ padding: "16px 20px", height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexShrink: 0 }}>
        <div onClick={goBack} style={{ width: 34, height: 34, borderRadius: 99, border: "1.5px solid " + t.border,
          display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: t.textDim }}>
          <ChevronRight size={17} style={{ transform: "rotate(180deg)" }} />
        </div>
        <div style={{ width: 40, height: 40, borderRadius: 11, background: color + "22",
          border: "2px solid " + color, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Boxes size={20} color={color} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{area ? area.name : ""}</div>
          <div style={{ fontSize: 12, color: t.textDim }}>
            {stats.procs || 0} procesos · {stats.fields || 0} datos · {stats.sensitive || 0} sensibles
          </div>
        </div>
      </div>

      {procs.length === 0 ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", color: t.textFaint }}>
          <Layers size={36} strokeWidth={1.2} />
          <div style={{ fontSize: 14, marginTop: 10 }}>Aún no hay procesos en esta área.</div>
        </div>
      ) : (
        <div style={{
          flex: 1, minHeight: 0, overflowY: "auto",
          display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10,
        }}>
          {procs.map((p) => {
            const pc = procColors[p.id] || color;
            const steps = data.steps.filter((s) => s.processId === p.id);
            const sources = data.sources.filter((s) => s.processId === p.id);
            const fieldCount = sources.reduce((sum, s) =>
              sum + data.fields.filter((f) => f.sourceId === s.id).length, 0);
            const sensitiveCount = sources.reduce((sum, s) =>
              sum + data.fields.filter((f) => f.sourceId === s.id && f.sensitive).length, 0);
            const roles = data.roles.filter((r) => r.processId === p.id);
            const hasOwner = roles.some((r) => r.type === "owner");
            const keyRoles = roles.filter((r) => r.type === "owner" || r.type === "steward").slice(0, 3);

            return (
              <div key={p.id} onClick={() => goToProcess(p.id)}
                style={{
                  background: t.surfaceSolid, border: "1px solid " + t.border, borderRadius: 12,
                  padding: "14px 14px 12px", cursor: "pointer", borderTop: "4px solid " + pc,
                  transition: "transform .15s, box-shadow .15s", display: "flex", flexDirection: "column",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = "translateY(-2px)";
                  e.currentTarget.style.boxShadow = "0 8px 24px " + pc + "22";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "none";
                  e.currentTarget.style.boxShadow = "none";
                }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                  <div style={{
                    fontSize: 13.5, fontWeight: 600, flex: 1, lineHeight: 1.35,
                    display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
                  }}>{p.name}</div>
                  {p.version > 1 && (
                    <span style={{ fontSize: 9, fontWeight: 600, color: t.textFaint,
                      background: t.surfaceAlt, padding: "2px 5px", borderRadius: 4, marginLeft: 6, flexShrink: 0 }}>
                      v{p.version}
                    </span>
                  )}
                </div>
                {p.subArea && (
                  <div style={{ fontSize: 11, color: pc, fontWeight: 500, marginBottom: 4 }}>{p.subArea}</div>
                )}

                <div style={{ display: "flex", gap: 8, fontSize: 11, color: t.textDim, marginBottom: 8 }}>
                  <span>{steps.length} pasos</span>
                  <span>{fieldCount} datos</span>
                  {sensitiveCount > 0 && (
                    <span style={{ color: "#EA4335", fontWeight: 600 }}>{sensitiveCount} sens.</span>
                  )}
                </div>

                {sources.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
                    {sources.slice(0, 3).map((s, i) => (
                      <span key={i} style={{
                        fontSize: 10, fontFamily: "monospace", background: t.surfaceAlt,
                        padding: "2px 6px", borderRadius: 4, color: t.textDim,
                      }}>{s.code}</span>
                    ))}
                    {sources.length > 3 && (
                      <span style={{ fontSize: 10, color: t.textFaint }}>+{sources.length - 3}</span>
                    )}
                  </div>
                )}

                <div style={{ marginTop: "auto", display: "flex", alignItems: "center", gap: 6, paddingTop: 8,
                  borderTop: `1px solid ${t.border}55` }}>
                  {!hasOwner && (
                    <span style={{ fontSize: 9, fontWeight: 600, color: "#EA4335",
                      background: "#EA433514", padding: "2px 6px", borderRadius: 4 }}>Sin owner</span>
                  )}
                  {keyRoles.map((r, i) => (
                    <UserAvatar key={i} person={r.person} email={r.email} roleType={r.type} size={26} t={t} />
                  ))}
                  {roles.length > keyRoles.length && (
                    <span style={{ fontSize: 10, color: t.textFaint }}>+{roles.length - keyRoles.length}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// --- Nivel 3: Detalle de un proceso (horizontal) ---
function ProcessLevel({ data, t, areaColors, procColors, procId, goBack, onEditProcess }) {
  const proc = data.processes.find((p) => p.id === procId);
  const area = proc ? data.areas.find((a) => a.id === proc.areaId) : null;
  const color = proc ? (procColors[procId] || areaColors[proc.areaId] || t.primary) : t.primary;
  const procStepsRaw = proc
    ? data.steps.filter((s) => s.processId === procId).sort((a, b) => a.order - b.order)
    : [];
  const procSteps = resolveStepTreeMetadata(procStepsRaw);
  const treeSteps = useMemo(() => persistedStepsToFlowTree(procSteps), [procSteps]);
  const stepOrderMap = useMemo(
    () => buildStepOrderMap(treeSteps),
    [treeSteps],
  );
  const sources = proc ? data.sources.filter((s) => s.processId === procId) : [];
  const roles = proc ? data.roles.filter((r) => r.processId === procId) : [];
  const allFields = sources.reduce((arr, s) =>
    arr.concat(data.fields.filter((f) => f.sourceId === s.id)), []);
  const globalRoles = roles.filter((r) => !r.stepId);

  if (!proc) return null;
  const ungovernedStepCount = procSteps.filter((st) => {
    const src = sources.find((s) => s.id === st.sourceId);
    return isUngovernedSource(src);
  }).length;
  const sensitiveCount = allFields.filter((f) => f.sensitive).length;

  const buildViewCard = (st) => {
    const stepRec = procSteps.find((s) => s.id === st.tmpId);
    const src = sources.find((s) => s.id === stepRec?.sourceId);
    const stepFields = src ? data.fields.filter((f) => f.sourceId === src.id) : [];
    const stepRoles = roles.filter((r) => r.stepId === st.tmpId);
    const stepArea = st.stepAreaId ? data.areas.find((a) => a.id === st.stepAreaId) : null;
    const stepColor = resolveStepFlowColor(stepRec || st, stepArea, areaColors, color, src);
    const siblings = st.parentTmpId
      ? treeChildrenOf(treeSteps, st.parentTmpId)
      : treeSteps.filter((s) => !s.parentTmpId && !s.isJoinPoint);
    return {
      step: { name: st.name || (st.isJoinPoint ? "Unión" : `Paso ${(stepOrderMap[st.tmpId] || 0) + 1}`) },
      src,
      stepFields,
      stepRoles,
      stepArea,
      stepColor,
      isUngoverned: isUngovernedSource(src),
      pathLabel: siblings.length > 1 && !st.isJoinPoint
        ? (st.pathLabel || `Camino ${String.fromCharCode(65 + siblings.indexOf(st))}`) : null,
      index: stepOrderMap[st.tmpId] || 0,
    };
  };

  return (
    <div style={{ padding: "16px 20px", height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {ungovernedStepCount > 0 && (
        <style>{`
          @keyframes risk-blink-kf {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.42; }
          }
          .ungoverned-alert-pulse {
            animation: risk-blink-kf 1.15s ease-in-out infinite;
          }
        `}</style>
      )}

      {/* Cabecera compacta */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10, flexShrink: 0 }}>
        <div onClick={goBack} style={{ width: 34, height: 34, borderRadius: 99, border: "1.5px solid " + t.border,
          display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: t.textDim }}>
          <ChevronRight size={17} style={{ transform: "rotate(180deg)" }} />
        </div>
        <div style={{ width: 40, height: 40, borderRadius: 11, background: color + "22",
          border: "2px solid " + color, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Layers size={20} color={color} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {proc.name}
            {proc.version > 1 && (
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: t.textFaint,
                background: t.surfaceAlt, padding: "2px 7px", borderRadius: 4 }}>v{proc.version}</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: t.textDim, marginTop: 2 }}>
            {area ? area.name : ""}{proc.subArea ? " / " + proc.subArea : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
          {[
            { label: "Pasos", value: procSteps.length },
            { label: "Datos", value: allFields.length },
            { label: "Sensibles", value: sensitiveCount, warn: sensitiveCount > 0 },
          ].map((s) => (
            <div key={s.label} style={{ padding: "6px 10px", borderRadius: 8, background: t.surfaceAlt,
              border: "1px solid " + t.border, textAlign: "center", minWidth: 52 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: s.warn ? "#EA4335" : color, lineHeight: 1 }}>{s.value}</div>
              <div style={{ fontSize: 9, color: t.textFaint, marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
          {onEditProcess && (
            <div onClick={() => onEditProcess(procId)} title="Editar proceso"
              style={{
                marginLeft: 4, padding: "7px 12px", borderRadius: 8, cursor: "pointer",
                background: color + "14", border: `1px solid ${color}44`, color,
                display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600,
              }}>
              <Pencil size={14} /> Editar
            </div>
          )}
        </div>
      </div>

      {(proc.trigger || ungovernedStepCount > 0 || globalRoles.length > 0) && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexShrink: 0, flexWrap: "wrap" }}>
          {proc.trigger && (
            <div style={{ fontSize: 12, color: t.textDim, fontStyle: "italic", flex: "1 1 200px", minWidth: 0,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              "{proc.trigger}"
            </div>
          )}
          {ungovernedStepCount > 0 && (
            <span className="ungoverned-alert-pulse" style={{
              fontSize: 11, fontWeight: 600, padding: "5px 10px", borderRadius: 8,
              background: RISK_COLOR + "14", color: RISK_COLOR, border: `1px solid ${RISK_COLOR}55`,
            }}>
              {ungovernedStepCount} paso{ungovernedStepCount !== 1 ? "s" : ""} no gobernado{ungovernedStepCount !== 1 ? "s" : ""}
            </span>
          )}
          {globalRoles.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {globalRoles.slice(0, 4).map((r, i) => (
                <UserAvatar key={i} person={r.person} email={r.email} roleType={r.type} size={28} t={t} />
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        {procSteps.length > 0 ? (
          <ProcessFlowCanvas mode="view" t={t} areaColors={areaColors} procColor={color}
            processArea={area} treeSteps={treeSteps} buildCard={buildViewCard} />
        ) : null}
      </div>
    </div>
  );
}


const EMPTY_DATA = {
  areas: [], processes: [], steps: [], sources: [], fields: [], roles: [],
  dataCatalogs: [], catalogColumns: [], catalogRows: [], people: [],
};

function ThemeToggleButton({ theme, t, onToggle }) {
  const isDark = theme?.mode === "dark";
  const Icon = isDark ? Sun : Moon;
  const label = isDark ? "Tema claro" : "Tema oscuro";

  return (
    <button
      type="button"
      onClick={onToggle}
      title={label}
      aria-label={label}
      style={{
        position: "fixed", top: 14, right: 14, zIndex: 40,
        width: 34, height: 34, borderRadius: 99, border: `1px solid ${t.border}`,
        background: t.surfaceSolid, display: "flex", alignItems: "center", justifyContent: "center",
        cursor: "pointer", padding: 0, boxShadow: "0 2px 8px #0002",
        color: t.textDim,
      }}
    >
      <Icon size={16} />
    </button>
  );
}

// ============================================================================
// LOGIN + GESTIÓN DE USUARIOS
// ============================================================================
function LoginScreen({ tenant, t, onLogin, needsBootstrap }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nombre, setNombre] = useState("");
  const [mode, setMode] = useState(needsBootstrap ? "bootstrap" : "login");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (needsBootstrap) setMode("bootstrap");
  }, [needsBootstrap]);

  const submitLogin = async () => {
    setError("");
    setBusy(true);
    const result = await loginUser(tenant.sheetsUrl, email, password);
    setBusy(false);
    if (!result.ok) {
      setError(result.error + (tenant.sheetsUrl ? " Si es la primera vez, usa «Crear cuenta de administrador» abajo." : ""));
      return;
    }
    onLogin(result.user, result.token);
  };

  const submitBootstrap = async () => {
    setError("");
    setBusy(true);
    const result = await bootstrapSuperUser(tenant.sheetsUrl, { nombre, email, password });
    setBusy(false);
    if (!result.ok || !result.user?.email) {
      setError(result.error || "No se pudo crear la cuenta. Revisa los datos e intenta de nuevo.");
      return;
    }
    onLogin(result.user, result.token, result.localFallback);
  };

  return (
    <div className="gov-theme-dark" style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "linear-gradient(145deg, #0a0c10 0%, #12151c 50%, #0d1117 100%)",
      padding: 20, fontFamily: FONT,
    }}>
      <style>{fontImport}</style>
      <div style={{
        width: "100%", maxWidth: 400, background: "#14171e", borderRadius: 16,
        border: "1px solid #2a2f3a", padding: "32px 28px", boxShadow: "0 24px 64px rgba(0,0,0,0.45)",
      }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          {tenant.defaultTheme.logo ? (
            <img src={tenant.defaultTheme.logo} alt="" style={{ height: 36, marginBottom: 12 }} />
          ) : (
            <Building2 size={36} color="#4285F4" style={{ marginBottom: 12 }} />
          )}
          <div style={{ fontSize: 20, fontWeight: 600, color: "#e8eaed" }}>{tenant.defaultTheme.companyName}</div>
          <div style={{ fontSize: 13, color: "#9aa0a6", marginTop: 4 }}>Gobernanza de datos</div>
        </div>

        {mode === "bootstrap" ? (
          <>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#e8eaed", marginBottom: 6 }}>Configuración inicial</div>
            <div style={{ fontSize: 12, color: "#9aa0a6", marginBottom: 18, lineHeight: 1.45 }}>
              Crea la cuenta de super usuario. Solo tú podrás registrar a los demás.
            </div>
            <Field label="Tu nombre" t={t}>
              <Input t={t} value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Ej. Alejandro" />
            </Field>
            <Field label="Correo" t={t}>
              <Input t={t} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu@empresa.com" />
            </Field>
            <Field label="Contraseña" t={t}>
              <Input t={t} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Btn t={t} onClick={submitBootstrap} disabled={busy || !nombre.trim() || !email.trim() || !password}
              style={{ width: "100%", marginTop: 16, justifyContent: "center" }}>
              {busy ? "Creando…" : "Crear super usuario"}
            </Btn>
            <div onClick={() => { setMode("login"); setError(""); }} style={{
              marginTop: 14, textAlign: "center", fontSize: 12, color: "#9aa0a6", cursor: "pointer",
            }}>
              Ya tengo cuenta → Iniciar sesión
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#e8eaed", marginBottom: 18 }}>Iniciar sesión</div>
            <Field label="Correo" t={t}>
              <Input t={t} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tu@empresa.com"
                onKeyDown={(e) => e.key === "Enter" && submitLogin()} />
            </Field>
            <Field label="Contraseña" t={t}>
              <Input t={t} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitLogin()} />
            </Field>
            <Btn t={t} onClick={submitLogin} disabled={busy || !email.trim() || !password}
              style={{ width: "100%", marginTop: 16, justifyContent: "center" }}>
              {busy ? "Entrando…" : "Entrar"}
            </Btn>
            {tenant.sheetsUrl && (
              <div onClick={() => { setMode("bootstrap"); setError(""); }} style={{
                marginTop: 16, textAlign: "center", fontSize: 12, color: "#8ab4f8",
                cursor: "pointer", fontWeight: 500,
              }}>
                ¿Primera vez? Crear cuenta de administrador
              </div>
            )}
          </>
        )}

        {error && (
          <div style={{ marginTop: 14, padding: "10px 12px", borderRadius: 8, background: "#EA433518",
            border: "1px solid #EA433544", color: "#f28b82", fontSize: 13 }}>{error}</div>
        )}
      </div>
    </div>
  );
}

function UserManagementPanel({ t, sheetsUrl, authToken, authUser }) {
  const [users, setUsers] = useState([]);
  const [nombre, setNombre] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const list = await listAppUsers(sheetsUrl, authToken);
    setUsers(list);
    setLoading(false);
  }, [sheetsUrl, authToken]);

  useEffect(() => { reload(); }, [reload]);

  const register = async () => {
    setMsg(null);
    const result = await registerAppUser(sheetsUrl, authToken, {
      nombre, email, password, rol: "editor",
    });
    if (!result.ok) { setMsg({ ok: false, text: result.error }); return; }
    setMsg({ ok: true, text: `Usuario ${email} registrado.` });
    setNombre(""); setEmail(""); setPassword("");
    reload();
  };

  return (
    <div style={{ maxWidth: 560 }}>
      <div style={{ background: t.surfaceSolid, border: `1px solid ${t.border}`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
          <UserCog size={18} color={t.primary} /> Registrar editor
        </div>
        <div style={{ fontSize: 13, color: t.textDim, marginBottom: 14, lineHeight: 1.5 }}>
          Solo tú como super usuario puedes dar de alta cuentas. Cada editor inicia sesión con su correo y contraseña;
          sus cambios quedan registrados en el historial de versiones.
        </div>
        <Field label="Nombre completo" t={t}>
          <Input t={t} value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Ej. María López" />
        </Field>
        <Field label="Correo" t={t}>
          <Input t={t} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="maria@empresa.com" />
        </Field>
        <Field label="Contraseña temporal" t={t}>
          <Input t={t} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Btn t={t} onClick={register} disabled={!nombre.trim() || !email.trim() || !password}
          style={{ marginTop: 8 }}>
          <Plus size={15} /> Dar de alta
        </Btn>
        {msg && (
          <div style={{ marginTop: 12, fontSize: 13, color: msg.ok ? t.primary : "#EA4335" }}>{msg.text}</div>
        )}
      </div>

      <div style={{ background: t.surfaceSolid, border: `1px solid ${t.border}`, borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Usuarios registrados</div>
        {loading ? (
          <div style={{ color: t.textFaint, fontSize: 13 }}>Cargando…</div>
        ) : users.length === 0 ? (
          <div style={{ color: t.textFaint, fontSize: 13 }}>Sin usuarios.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {users.map((u) => (
              <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                background: t.surfaceAlt, borderRadius: 8 }}>
                <UserAvatar person={u.nombre} email={u.email} roleType={u.rol === "super" ? "owner" : "executor"} size={32} t={t} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{u.nombre}</div>
                  <div style={{ fontSize: 12, color: t.textDim }}>{u.email}</div>
                </div>
                <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 99,
                  background: u.rol === "super" ? t.primary + "22" : t.surfaceSolid,
                  color: u.rol === "super" ? t.primary : t.textDim, textTransform: "uppercase" }}>
                  {u.rol === "super" ? "Super" : "Editor"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// SEED — genera 50 procesos demo realistas para demostración
// ============================================================================

export default function App() {
  const [booted, setBooted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeTenantId, setActiveTenantId] = useState(TENANTS[0].id);
  const [theme, setThemeState] = useState(null);
  const [data, setData] = useState(EMPTY_DATA);
  const [areaColors, setAreaColors] = useState({});
  // Deep link a Modo cine: /cine  (o ?cine=1). Requiere login; abre el cine al entrar.
  const cineRoute = typeof window !== "undefined" &&
    (/\/cine\/?$/.test(window.location.pathname) || new URLSearchParams(window.location.search).has("cine"));
  const [cineDeepLink, setCineDeepLink] = useState(cineRoute);
  const [view, setView] = useState(cineRoute ? "flows" : "dashboard");
  const [captureProcId, setCaptureProcId] = useState(null);
  // Se incrementa cada vez que se entra a Documentar desde el menú, para volver
  // siempre a la pantalla de selección (nuevo vs. editar existente).
  const [captureEntryNonce, setCaptureEntryNonce] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [switchingTenant, setSwitchingTenant] = useState(false);
  const allowRemotePushRef = useRef(false);
  const remoteHydratedRef = useRef(false);
  const lastRemoteModifiedRef = useRef(null);
  const pendingSyncRef = useRef(false);
  const syncTimerRef = useRef(null);
  const syncInFlightRef = useRef(false);
  const dataRef = useRef(EMPTY_DATA);
  const areaColorsRef = useRef({});
  const themeRef = useRef(DEFAULT_THEME);
  const activeTenantRef = useRef(TENANTS[0].id);
  const lastVisibilityRefreshRef = useRef(0);
  const authUserRef = useRef(null);
  const captureCollabRef = useRef({ editingId: null, pendingLocal: false, localPublishTs: 0 });

  dataRef.current = data;
  areaColorsRef.current = areaColors;
  themeRef.current = theme || DEFAULT_THEME;
  activeTenantRef.current = activeTenantId;

  const activeTenant = getTenant(activeTenantId);

  const markCatalogEdited = useCallback(() => {
    allowRemotePushRef.current = true;
  }, []);

  const cancelPendingRemotePush = useCallback(() => {
    pendingSyncRef.current = false;
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
  }, []);

  const persistTenantSnapshot = useCallback(async (tenantId, snapshot) => {
    await store.set(tenantStoreKey(tenantId, "data"), snapshot.data);
    await store.set(tenantStoreKey(tenantId, "areaColors"), snapshot.areaColors);
    await store.set(tenantStoreKey(tenantId, "theme"), snapshot.theme);
  }, []);

  const applyRemoteCatalog = useCallback((fromSheets, tenantId, tenantDefaultTheme) => {
    cancelPendingRemotePush();
    // Conservar creaciones locales aún no subidas (áreas/procesos nuevos) para que no
    // desaparezcan al aplicar un cambio remoto; se marcan para re-subirse.
    const { merged, hasExtras, extraAreaIds } = mergeRemoteKeepingLocalExtras(dataRef.current, fromSheets.data);
    allowRemotePushRef.current = hasExtras;
    remoteHydratedRef.current = true;
    lastRemoteModifiedRef.current = maxProcessLastModified(merged.processes);
    catalogRevisionRef.current = catalogRevisionFingerprint(merged);
    const mergedColors = { ...fromSheets.areaColors };
    extraAreaIds.forEach((id) => {
      if (areaColorsRef.current[id]) mergedColors[id] = areaColorsRef.current[id];
    });
    setData(merged);
    setAreaColors(mergedColors);
    const resolvedTheme = fromSheets.theme || tenantDefaultTheme;
    setThemeState(resolvedTheme);
    themeRef.current = resolvedTheme;
    persistTenantSnapshot(tenantId, {
      data: merged,
      areaColors: mergedColors,
      theme: resolvedTheme,
    });
  }, [cancelPendingRemotePush, persistTenantSnapshot]);

  const runSyncPush = useCallback(async (force = false) => {
    const tenant = getTenant(activeTenantRef.current);
    if (!tenant.sheetsUrl) return;
    if (!force && !allowRemotePushRef.current) return;
    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;

    // FUSIÓN no destructiva: mezclamos lo local con lo remoto (conservando procesos
    // de otros usuarios) antes de escribir. Así ningún push borra el flujo del otro.
    const remote = await loadFromSheets(tenant.sheetsUrl, tenant.defaultTheme);
    const merged = remote ? mergeCatalogsForPush(dataRef.current, remote.data) : normalizeCatalogData(dataRef.current);

    const result = await syncToSheets(
      merged, areaColorsRef.current, themeRef.current, tenant.sheetsUrl,
    );
    syncInFlightRef.current = false;
    if (result?.ok) {
      pendingSyncRef.current = false;
      allowRemotePushRef.current = false;
      // El local ahora refleja la fusión (incluye los flujos de otros usuarios).
      const revision = catalogRevisionFingerprint(merged);
      if (revision !== catalogRevisionRef.current) {
        catalogRevisionRef.current = revision;
        setData(merged);
        persistTenantSnapshot(activeTenantRef.current, {
          data: merged, areaColors: areaColorsRef.current, theme: themeRef.current,
        });
      }
      lastRemoteModifiedRef.current = maxProcessLastModified(merged.processes);
    }
    if (pendingSyncRef.current) runSyncPush();
  }, [applyRemoteCatalog, persistTenantSnapshot]);

  const scheduleSyncPush = useCallback(() => {
    if (!allowRemotePushRef.current) return;
    pendingSyncRef.current = true;
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      runSyncPush();
    }, 600);
  }, [runSyncPush]);

  const refreshRemoteCatalog = useCallback(async ({ force = false } = {}) => {
    const tenant = getTenant(activeTenantRef.current);
    if (!tenant.sheetsUrl) return false;

    if (!force) {
      const draft = await loadCaptureDraft(activeTenantRef.current, authUserRef.current?.email);
      if (captureDraftHasContent(draft)) return false;
      if (pendingSyncRef.current || syncInFlightRef.current) return false;
    }

    const fromSheets = await loadFromSheets(tenant.sheetsUrl, tenant.defaultTheme);
    if (!fromSheets) return false;
    if (catalogIsLocalNewer(dataRef.current, fromSheets.data)) return false;

    applyRemoteCatalog(fromSheets, tenant.id, tenant.defaultTheme);
    return true;
  }, [applyRemoteCatalog]);

  const [collabSession, setCollabSession] = useState(null);
  const [stepLocks, setStepLocks] = useState({});
  const [collabApiSupported, setCollabApiSupported] = useState(false);
  const [remoteUpdateNotice, setRemoteUpdateNotice] = useState(null);
  const [authUser, setAuthUser] = useState(null);
  const [authToken, setAuthToken] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const catalogRevisionRef = useRef(null);
  const collabPollRef = useRef(null);

  authUserRef.current = authUser;

  const handleCaptureCollabState = useCallback((state) => {
    captureCollabRef.current = state || { editingId: null, pendingLocal: false, localPublishTs: 0 };
  }, []);

  const refreshCollaboration = useCallback(async () => {
    const tenant = getTenant(activeTenantRef.current);
    if (!tenant.sheetsUrl || document.visibilityState !== "visible") return;

    const fromSheets = await loadFromSheets(tenant.sheetsUrl, tenant.defaultTheme);
    if (!fromSheets) return;

    if (fromSheets.activeEditions !== undefined) {
      setCollabApiSupported(true);
      setStepLocks(stepLocksMapFromEditions(fromSheets.activeEditions));
    }

    const revision = catalogRevisionFingerprint(fromSheets.data);
    const prevRevision = catalogRevisionRef.current;

    if (prevRevision && revision !== prevRevision) {
      // Si el remoto trae pasos/procesos nuevos, reconciliamos siempre (union seguro):
      // así el empate de timestamps entre dos editores del mismo flujo no impide ver
      // los pasos que agregó el otro. Solo esperamos si hay un push literalmente en curso.
      const additive = remoteHasNewContent(dataRef.current, fromSheets.data)
        || remoteDroppedLocalContent(dataRef.current, fromSheets.data);
      if (!additive) {
        const pushPending = pendingSyncRef.current || syncInFlightRef.current || allowRemotePushRef.current;
        if (pushPending) return;
        if (catalogIsLocalNewer(dataRef.current, fromSheets.data)) return;
        if (captureCollabRef.current.pendingLocal) return;
      } else if (syncInFlightRef.current) {
        // Solo esperamos si hay un request de push literalmente en vuelo (para no leer
        // un estado a medio escribir). NO bloqueamos por push encolado: el autosave se
        // re-arma solo y dejaría pendingSync casi siempre activo, impidiendo ver
        // adiciones/eliminaciones del otro usuario. Reconcile + efecto dedicado +
        // filtro de tombstones en publishWorkingCopy preservan el trabajo local.
        return;
      }
      catalogRevisionRef.current = revision;
      applyRemoteCatalog(fromSheets, tenant.id, tenant.defaultTheme);
      setRemoteUpdateNotice(null);
    } else if (!prevRevision) {
      catalogRevisionRef.current = revision;
    }
  }, [applyRemoteCatalog]);

  const applyRemoteUpdateNotice = useCallback(() => {
    if (!remoteUpdateNotice?.payload) return;
    const tenant = getTenant(activeTenantRef.current);
    applyRemoteCatalog(remoteUpdateNotice.payload, tenant.id, tenant.defaultTheme);
    setRemoteUpdateNotice(null);
  }, [remoteUpdateNotice, applyRemoteCatalog]);

  useEffect(() => {
    if (!booted || !activeTenant.sheetsUrl) return;
    refreshCollaboration();
    collabPollRef.current = setInterval(refreshCollaboration, COLLAB_POLL_MS);
    return () => {
      if (collabPollRef.current) clearInterval(collabPollRef.current);
    };
  }, [booted, activeTenantId, activeTenant.sheetsUrl, refreshCollaboration]);

  useEffect(() => {
    if (!booted) return;
    const flush = () => {
      if (!pendingSyncRef.current || !allowRemotePushRef.current) return;
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      runSyncPush();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [booted, runSyncPush]);

  const bootstrapTenant = useCallback(async (tenantId) => {
    const tenant = getTenant(tenantId);
    cancelPendingRemotePush();
    allowRemotePushRef.current = false;
    remoteHydratedRef.current = false;
    lastRemoteModifiedRef.current = null;
    const localData = await store.get(tenantStoreKey(tenantId, "data"));
    const localColors = await store.get(tenantStoreKey(tenantId, "areaColors"));
    const localTheme = await store.get(tenantStoreKey(tenantId, "theme"));

    let fromSheets = null;
    if (tenant.sheetsUrl) {
      fromSheets = await loadFromSheets(tenant.sheetsUrl, tenant.defaultTheme);
      if (!fromSheets) {
        await new Promise((r) => setTimeout(r, 400));
        fromSheets = await loadFromSheets(tenant.sheetsUrl, tenant.defaultTheme);
      }
    }

    const remoteLoaded = !!fromSheets;
    const merged = mergeCatalogOnBoot(
      fromSheets?.data || null,
      localData,
      fromSheets?.areaColors || {},
      localColors || {},
      remoteLoaded,
    );
    if (remoteLoaded) {
      lastRemoteModifiedRef.current = maxProcessLastModified(merged.data.processes);
      remoteHydratedRef.current = true;
      catalogRevisionRef.current = catalogRevisionFingerprint(merged.data);
    }
    // Si el arranque restauró flujos locales que faltaban en el remoto, hay que
    // re-subirlos para que el otro usuario los vea (si no, quedan solo en caché).
    allowRemotePushRef.current = !!merged.restoredLocal;
    const resolvedTheme = fromSheets?.theme || localTheme || tenant.defaultTheme;
    setData(merged.data);
    setAreaColors(merged.areaColors);
    setThemeState(resolvedTheme);
    themeRef.current = resolvedTheme;
    await persistTenantSnapshot(tenantId, {
      data: merged.data,
      areaColors: merged.areaColors,
      theme: resolvedTheme,
    });
    return tenant;
  }, [persistTenantSnapshot, cancelPendingRemotePush]);

  const handleLogin = useCallback(async (user, token) => {
    if (!user?.email || !token) return;
    setAuthUser(user);
    setAuthToken(token);
    setNeedsBootstrap(false);
    const collab = authUserToCollabSession(user, null);
    await saveCollabSession(collab);
    setCollabSession(collab);
    setLoading(true);
    setBooted(false);
    await bootstrapTenant(activeTenantRef.current);
    setBooted(true);
    setLoading(false);
  }, [bootstrapTenant]);

  const handleLogout = useCallback(async () => {
    const tenant = getTenant(activeTenantRef.current);
    if (tenant.sheetsUrl && authToken) {
      await postSheetsAction(tenant.sheetsUrl, { action: "logout", token: authToken });
    }
    if (tenant.sheetsUrl && collabSession?.sessionId) {
      await releaseSessionLocksRemote(tenant.sheetsUrl, collabSession.sessionId);
    }
    await clearAuthSession();
    setAuthUser(null);
    setAuthToken(null);
    setCollabSession(null);
    setBooted(false);
    setLoading(true);
    setView("dashboard");
  }, [authToken, collabSession]);

  useEffect(() => {
    (async () => {
      await purgeRemovedTenants();
      const savedTenant = await store.get(ACTIVE_TENANT_KEY);
      const tenantId = TENANTS.some((t) => t.id === savedTenant) ? savedTenant : TENANTS[0].id;
      setActiveTenantId(tenantId);
      activeTenantRef.current = tenantId;
      const tenant = getTenant(tenantId);

      await loadLocalUsers();

      if (tenant.sheetsUrl) {
        const bootstrap = await checkAuthNeedsBootstrap(tenant.sheetsUrl);
        if (bootstrap) setNeedsBootstrap(true);
      }

      const saved = await loadAuthSession();
      if (saved?.token && saved?.user?.email) {
        let user = saved.user;
        if (tenant.sheetsUrl && await isRemoteAuthAvailable(tenant.sheetsUrl)) {
          const remoteUser = await remoteValidateSession(tenant.sheetsUrl, saved.token);
          if (remoteUser) user = remoteUser;
          else {
            await clearAuthSession();
            user = null;
          }
        }
        if (user) {
          setAuthUser(user);
          setAuthToken(saved.token);
          const collab = authUserToCollabSession(user, await store.get(COLLAB_SESSION_KEY));
          await saveCollabSession(collab);
          setCollabSession(collab);
          await bootstrapTenant(tenantId);
          setBooted(true);
          setLoading(false);
        }
      }
      setAuthReady(true);
      if (!saved?.user?.email) setLoading(false);
    })();
  }, [bootstrapTenant]);

  const switchTenant = useCallback(async (newTenantId) => {
    if (newTenantId === activeTenantId) return;
    setSwitchingTenant(true);
    await persistTenantSnapshot(activeTenantId, {
      data: dataRef.current,
      areaColors: areaColorsRef.current,
      theme: themeRef.current,
    });
    if (allowRemotePushRef.current && (pendingSyncRef.current || syncInFlightRef.current)) {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      await runSyncPush();
    }
    await store.set(ACTIVE_TENANT_KEY, newTenantId);
    setActiveTenantId(newTenantId);
    activeTenantRef.current = newTenantId;
    setView("dashboard");
    setCaptureProcId(null);
    setSettingsOpen(false);
    await bootstrapTenant(newTenantId);
    setSwitchingTenant(false);
  }, [activeTenantId, bootstrapTenant, persistTenantSnapshot, runSyncPush]);

  useEffect(() => {
    if (!booted) return;
    refreshRemoteCatalog({ force: true });
  }, [booted, activeTenantId, refreshRemoteCatalog]);

  useEffect(() => {
    if (!booted) return;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastVisibilityRefreshRef.current < 8000) return;
      lastVisibilityRefreshRef.current = now;
      refreshRemoteCatalog();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [booted, refreshRemoteCatalog]);

  useEffect(() => {
    if (!booted || !theme) return;
    store.set(tenantStoreKey(activeTenantId, "theme"), theme);
    themeRef.current = theme;
  }, [theme, booted, activeTenantId]);

  useEffect(() => {
    if (!booted) return;
    store.set(tenantStoreKey(activeTenantId, "data"), data);
    store.set(tenantStoreKey(activeTenantId, "areaColors"), areaColors);
    if (!activeTenant.sheetsUrl || !allowRemotePushRef.current) return;
    scheduleSyncPush();
    return () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, [data, areaColors, theme, booted, activeTenantId, activeTenant.sheetsUrl, scheduleSyncPush]);

  const t = useTheme(theme || activeTenant.defaultTheme || DEFAULT_THEME);

  // Mapa de colores por proceso: variación tonal del color de su área
  const procColors = useMemo(() => {
    const map = {};
    data.areas.forEach((a) => {
      const baseColor = areaColors[a.id] || t.primary;
      const procs = data.processes.filter((p) => p.areaId === a.id);
      procs.forEach((p, i) => { map[p.id] = processColor(baseColor, i, procs.length); });
    });
    return map;
  }, [data.areas, data.processes, areaColors, t.primary]);

  const setCatalogData = useCallback((update) => {
    markCatalogEdited();
    setData(update);
  }, [markCatalogEdited]);

  if (!authReady) {
    return (
      <div style={{ minHeight: "100vh", background: "#0E1013", color: "#9AA0A6",
        display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT }}>
        <style>{fontImport}</style>
        Cargando…
      </div>
    );
  }

  if (!authUser) {
    return (
      <LoginScreen
        tenant={activeTenant}
        t={t}
        needsBootstrap={needsBootstrap && !!activeTenant.sheetsUrl}
        onLogin={handleLogin}
      />
    );
  }

  if (!booted || loading || switchingTenant) {
    return (
      <div style={{ minHeight: "100vh", background: "#0E1013", color: "#9AA0A6",
        display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT }}>
        <style>{fontImport}</style>
        {switchingTenant ? "Cambiando de empresa…" : "Cargando universo de datos…"}
      </div>
    );
  }

  const saveProcessCapture = (payload, replaceProcessId, deletedIds = []) => {
    markCatalogEdited();
    setData((d) => {
      let base = d;
      if (replaceProcessId) {
        const oldSourceIds = new Set(
          base.sources.filter((s) => s.processId === replaceProcessId).map((s) => s.id),
        );
        base = {
          ...base,
          processes: base.processes.filter((p) => p.id !== replaceProcessId),
          steps: base.steps.filter((s) => s.processId !== replaceProcessId),
          sources: base.sources.filter((s) => s.processId !== replaceProcessId),
          fields: base.fields.filter((f) => !oldSourceIds.has(f.sourceId)),
          roles: base.roles.filter((r) => r.processId !== replaceProcessId),
        };
      }
      const newDeletedIds = [
        ...(base.deletedIds || []),
        ...deletedIds.map((id) => ({ id })),
      ];
      return {
        ...base,
        processes: [...base.processes, payload.process],
        steps: [...base.steps, ...payload.steps],
        sources: [...base.sources, ...payload.sources],
        fields: [...base.fields, ...payload.fields],
        roles: [...base.roles, ...payload.roles],
        deletedIds: newDeletedIds,
      };
    });
  };

  const addArea = (name) => {
    const trimmed = name.trim();
    const exists = data.areas.find((a) => a.name.toLowerCase() === trimmed.toLowerCase());
    if (exists) return exists.id;
    markCatalogEdited();
    const id = uid();
    const color = SEED_AREA_COLORS[data.areas.length % SEED_AREA_COLORS.length];
    setData((d) => ({ ...d, areas: [...d.areas, { id, name: trimmed }] }));
    setAreaColors((c) => ({ ...c, [id]: color }));
    return id;
  };
  const setAreaColor = (id, color) => { markCatalogEdited(); setAreaColors((c) => ({ ...c, [id]: color })); };
  // Actualiza foto/nombre de una persona (directorio Equipos), por email.
  const setPersonInfo = (email, patch) => {
    const key = String(email || "").trim().toLowerCase();
    if (!key) return;
    markCatalogEdited();
    setData((d) => {
      const people = [...(d.people || [])];
      const idx = people.findIndex((p) => p.email === key);
      const base = idx >= 0 ? people[idx] : { email: key, name: "", photoUrl: "" };
      const next = { ...base, ...patch, email: key };
      if (idx >= 0) people[idx] = next; else people.push(next);
      return { ...d, people };
    });
  };
  const addProcess = (p) => { markCatalogEdited(); const id = uid(); setData((d) => ({ ...d, processes: [...d.processes, { id, ...p }] })); return id; };
  const addStep = (s) => { markCatalogEdited(); const id = uid(); setData((d) => ({ ...d, steps: [...d.steps, { id, ...s }] })); return id; };
  const addSource = (s) => { markCatalogEdited(); const id = uid(); setData((d) => ({ ...d, sources: [...d.sources, { id, ...s }] })); return id; };
  const addField = (f) => { markCatalogEdited(); setData((d) => ({ ...d, fields: [...d.fields, { id: uid(), ...f }] })); };
  const addRole = (r) => { markCatalogEdited(); setData((d) => ({ ...d, roles: [...d.roles, { id: uid(), ...r }] })); };
  const del = (coll, id) => {
    markCatalogEdited();
    setData((d) => {
      // Tombstone: registra el id borrado (y su cascada) en deletedIds para que
      // la eliminación se sincronice y NO reaparezca desde otra sesión.
      const tombstones = new Set([id]);
      if (coll === "processes") {
        d.steps.forEach((s) => { if (s.processId === id) tombstones.add(s.id); });
        const procSourceIds = new Set(
          d.sources.filter((s) => s.processId === id).map((s) => s.id),
        );
        procSourceIds.forEach((sid) => tombstones.add(sid));
        d.fields.forEach((f) => { if (procSourceIds.has(f.sourceId)) tombstones.add(f.id); });
        d.roles.forEach((r) => { if (r.processId === id) tombstones.add(r.id); });
      }
      const existing = new Set((d.deletedIds || []).map((x) => x.id));
      const newDeleted = [
        ...(d.deletedIds || []),
        ...[...tombstones].filter((tid) => tid && !existing.has(tid)).map((tid) => ({ id: tid })),
      ];
      return { ...d, [coll]: d[coll].filter((x) => x.id !== id), deletedIds: newDeleted };
    });
  };
  const bulkMerge = (payload) => { markCatalogEdited(); setData((d) => normalizeCatalogData({
    ...d,
    areas: [...d.areas, ...payload.areas],
    processes: [...d.processes, ...payload.processes],
    steps: [...d.steps, ...payload.steps],
    sources: [...d.sources, ...payload.sources],
    fields: [...d.fields, ...payload.fields],
  })); };

  const restoreDummyProcess = () => {
    let area = data.areas.find((a) => a.name.toLowerCase() === DUMMY_AREA_NAME.toLowerCase());
    let areaId = area?.id;
    if (!areaId) areaId = addArea(DUMMY_AREA_NAME);
    const existing = data.processes.find((p) => p.name.toLowerCase() === DUMMY_PROCESS_NAME.toLowerCase());
    const payload = buildDummyProcessPayload(areaId);
    saveProcessCapture(payload, existing?.id || null);
    setCaptureProcId(payload.process.id);
    setView("capture");
  };

  const nav = [
    { id: "dashboard", label: "Estatus", icon: LayoutDashboard },
    { id: "flows", label: "Flujos", icon: GitBranch },
    { id: "graph", label: "Mapa de relaciones", icon: Network },
    { id: "capture", label: "Documentar", icon: Plus },
    { id: "catalogs", label: "Catálogos", icon: FileSpreadsheet },
    { id: "roles", label: "Directorio", icon: Users },
    { id: "admin", label: "Administración", icon: ShieldCheck },
  ];

  const toggleThemeMode = () => {
    markCatalogEdited();
    setThemeState((th) => ({ ...th, mode: th.mode === "dark" ? "light" : "dark" }));
  };

  const themeClass = theme?.mode === "dark" ? "gov-theme-dark" : "gov-theme-light";
  
  return (
    <div className={`${themeClass} app-grid-bg`} style={{ minHeight: "100vh", background: "var(--bg-app)", color: "var(--text-main)", display: "flex", transition: "background var(--transition-normal), color var(--transition-normal)", position: "relative", "--primary": theme?.primary || "var(--primary-glow)" }}>
      <aside className="glass-panel" style={{ width: 196, borderRight: "1px solid var(--border-color)",
        display: "flex", flexDirection: "column", position: "sticky", top: 0, height: "100vh", zIndex: 10 }}>
        <div style={{ padding: "12px 12px", borderBottom: "1px solid var(--border-color)" }}>
          {theme?.logo ? <img src={theme.logo} alt="" style={{ height: 24, maxWidth: 120, objectFit: "contain" }} />
            : <div style={{ width: 28, height: 28, borderRadius: 8, background: "var(--primary)", display: "flex",
                alignItems: "center", justifyContent: "center", boxShadow: "var(--shadow-primary-glow)" }}><Building2 size={15} color="#fff" /></div>}
          <div style={{ fontSize: 13, fontWeight: 600, marginTop: 8, fontFamily: "var(--font-display)", letterSpacing: "-0.02em" }}>{theme?.companyName}</div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 400, marginTop: 1 }}>Gobernanza de datos</div>
        </div>
        <nav style={{ flex: 1, padding: 8 }}>
          {nav.map((n) => { const Icon = n.icon; const active = view === n.id;
            return (
              <div key={n.id} onClick={() => {
                  if (n.id === "capture") { setCaptureProcId(null); setCaptureEntryNonce((x) => x + 1); }
                  setView(n.id);
                }} className={`sidebar-link ${active ? "sidebar-link-active" : ""}`}>
                <Icon size={15} /> <span>{n.label}</span></div>
            ); })}
        </nav>
        {authUser && (
          <div style={{ padding: "8px 10px", borderTop: "1px solid var(--border-color)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", marginBottom: 4 }}>
              <UserAvatar person={authUser.nombre} email={authUser.email}
                roleType={isSuperUser(authUser) ? "owner" : "executor"} size={28} t={t} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-main)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {authUser.nombre}
                </div>
                <div style={{ fontSize: 10, color: "var(--text-dim)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {isSuperUser(authUser) ? "Super usuario" : "Editor"}
                </div>
              </div>
            </div>
            <div onClick={handleLogout} className="interactive-hover" style={{
              display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", borderRadius: 8,
              cursor: "pointer", fontSize: 12, color: "var(--text-dim)", border: "1px solid transparent",
            }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--border-color)"; e.currentTarget.style.backgroundColor = "var(--surface-alt)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.backgroundColor = "transparent"; }}>
              <LogOut size={14} /> Cerrar sesión
            </div>
          </div>
        )}
        <div style={{ padding: 8, borderTop: "1px solid var(--border-color)" }}>
          {TENANTS.length > 1 && (
            <>
              <div style={{ fontSize: 9, fontWeight: 600, color: "var(--text-dim)", letterSpacing: "0.07em",
                padding: "2px 8px 6px", textTransform: "uppercase", fontFamily: "var(--font-display)" }}>Entorno</div>
              {TENANTS.map((tenant) => {
                const active = tenant.id === activeTenantId;
                const thumb = tenant.defaultTheme.logo;
                return (
                  <div key={tenant.id} onClick={() => switchTenant(tenant.id)} className="interactive-hover" style={{
                    display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
                    borderRadius: 8, cursor: "pointer", marginBottom: 4,
                    border: active ? "1.5px solid var(--primary)" : "1px solid var(--border-color)",
                    background: active ? "var(--shadow-primary-glow)" : "var(--surface-alt)",
                    transition: "all var(--transition-fast)"
                  }}>
                    {thumb ? (
                      <img src={thumb} alt="" style={{ width: 18, height: 18, objectFit: "contain" }} />
                    ) : (
                      <Building2 size={14} color={active ? "var(--primary)" : "var(--text-faint)"} />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11.5, fontWeight: active ? 600 : 500, color: active ? "var(--text-main)" : "var(--text-dim)" }}>
                        {tenant.label}
                      </div>
                    </div>
                    {active && <Check size={12} color="var(--primary)" />}
                  </div>
                );
              })}
            </>
          )}
          <div onClick={() => setSettingsOpen(true)} className="interactive-hover" style={{ display: "flex", alignItems: "center", gap: 8,
            padding: "7px 8px", borderRadius: 8, cursor: "pointer", fontSize: 12.5, color: "var(--text-dim)", marginTop: 4,
            border: "1px solid transparent" }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--border-color)"; e.currentTarget.style.backgroundColor = "var(--surface-alt)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.backgroundColor = "transparent"; }}>
            <Palette size={15} /> Personalización</div>
        </div>
      </aside>

      <main style={{ flex: 1, minWidth: 0, height: "100vh", overflow: "auto" }}>
        {theme?.banner && view === "dashboard" && (
          <div style={{ height: 72, backgroundImage: `url(${theme.banner})`, backgroundSize: "cover",
            backgroundPosition: "center", position: "relative" }}>
            <div style={{ position: "absolute", inset: 0, background: theme?.mode === "dark"
              ? "linear-gradient(180deg, rgba(7, 9, 14, 0.28), var(--bg-app))" : "linear-gradient(180deg, rgba(255, 255, 255, 0.28), var(--bg-app))" }} /></div>
        )}
        <div style={{ padding: "14px 18px" }}>
          {view === "dashboard" && <Dashboard data={data} t={t} theme={theme} areaColors={areaColors} procColors={procColors} setView={setView} />}
          {view === "flows" && <FlowsView data={data} t={t} areaColors={areaColors}
            initialCinema={cineDeepLink} onCinemaConsumed={() => setCineDeepLink(false)}
            onOpen={(procId) => { setCaptureProcId(procId); setView("capture"); }}
            onNew={() => { setCaptureProcId(null); setCaptureEntryNonce((x) => x + 1); setView("capture"); }} />}
          {view === "graph" && (
            <EcosystemExplorer data={data} t={t} areaColors={areaColors} procColors={procColors}
              onEditProcess={(procId) => { setCaptureProcId(procId); setView("capture"); }} />
          )}
          <div style={{ display: view === "capture" ? "block" : "none" }}>
            <Capture key={activeTenantId} tenantId={activeTenantId} data={data} t={t} areaColors={areaColors}
              addArea={addArea} setAreaColor={setAreaColor} saveProcessCapture={saveProcessCapture}
              initialProcId={captureProcId} onInitialConsumed={() => setCaptureProcId(null)}
              entryNonce={captureEntryNonce}
              sheetsUrl={activeTenant.sheetsUrl}
              collabApiSupported={collabApiSupported}
              collabSession={collabSession}
              authUser={authUser}
              stepLocks={stepLocks}
              onRefreshLocks={refreshCollaboration}
              remoteUpdateNotice={view === "capture" ? remoteUpdateNotice : null}
              onApplyRemoteUpdate={applyRemoteUpdateNotice}
              onDismissRemoteUpdate={() => setRemoteUpdateNotice(null)}
              onCaptureCollabState={handleCaptureCollabState}
            />
          </div>
          {view === "roles" && <OrgDirectory data={data} t={t} areaColors={areaColors} procColors={procColors} setPersonInfo={setPersonInfo} />}
          {view === "catalogs" && <DataCatalogsSection data={data} t={t} areaColors={areaColors} setData={setCatalogData} />}
          {view === "admin" && <Admin data={data} t={t} areaColors={areaColors} addArea={addArea}
            addProcess={addProcess} setAreaColor={setAreaColor} del={del} bulkMerge={bulkMerge}
            restoreDummyProcess={restoreDummyProcess}
            authUser={authUser} authToken={authToken} sheetsUrl={activeTenant.sheetsUrl} />}
        </div>
      </main>

      {settingsOpen && <SettingsModal theme={theme} t={t} data={data} areaColors={areaColors}
        setAreaColor={setAreaColor}
        onSave={(th) => { markCatalogEdited(); setThemeState(th); setSettingsOpen(false); }}
        onClose={() => setSettingsOpen(false)} />}

      <ThemeToggleButton theme={theme} t={t} onToggle={toggleThemeMode} />
    </div>
  );
}

function Header({ title, sub, t, action }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 14,
      borderBottom: "1px solid var(--border-color)", paddingBottom: 10 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0, letterSpacing: "-0.03em", fontFamily: "var(--font-display)", color: "var(--text-main)" }}>
          {title}
        </h1>
        {sub && <p style={{ color: "var(--text-dim)", fontSize: 12, margin: "4px 0 0", fontWeight: 400 }}>{sub}</p>}
      </div>
      {action}
    </div>
  );
}

// ============================================================================
// DASHBOARD
// ============================================================================
function Ring({ pct, t, size = 108, stroke = 10, color }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - pct / 100);
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-alt)" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
        strokeDasharray={c} strokeDashoffset={off} strokeLinecap="round"
        style={{ transition: "stroke-dashoffset .6s ease" }} />
    </svg>
  );
}

function Dashboard({ data, t, theme, areaColors, setView }) {
  return (
    <div>
      <Header title="Estatus de documentación"
        sub={`${theme?.companyName || "Empresa"} · avance por área hacia las metas`}
        t={t}
        action={<Btn t={t} onClick={() => setView("capture")}><Plus size={16} /> Documentar</Btn>} />

      <DocProgress data={data} t={t} areaColors={areaColors} setView={setView} />
    </div>
  );
}

// ============================================================================
// FLUJOS — portafolio ejecutivo (qué procesos existen y cómo crecen)
// ============================================================================
function processFlowStats(processId, data) {
  const steps = data.steps.filter((s) => s.processId === processId);
  const childrenByParent = {};
  steps.forEach((s) => {
    if (s.isJoinPoint || isJoinStepRecord(s)) return;
    const key = s.parentStepId || "__root__";
    (childrenByParent[key] = childrenByParent[key] || []).push(s);
  });
  const forks = Object.values(childrenByParent).filter((arr) => arr.length > 1).length;
  const joins = steps.filter((s) => s.isJoinPoint || isJoinStepRecord(s)).length;
  return { total: steps.length, forks, joins, branched: forks > 0 };
}

function flowDaysSince(iso) {
  const ts = Date.parse(iso || "");
  if (Number.isNaN(ts)) return Infinity;
  return (Date.now() - ts) / 86400000;
}

// Calcula el layout real del flujo (mismo formato de ramas que arma el usuario):
// columnas = avance del paso, filas = ramas paralelas; los forks abren carriles y
// convergen en el nodo de unión (joinTmpId) exactamente donde el usuario lo puso.
function computeFlowLayout(procSteps) {
  const tree = persistedStepsToFlowTree(procSteps || []);
  if (!tree.length) return { nodes: [], edges: [], cols: 0, rows: 0 };
  const byId = {};
  tree.forEach((s) => { byId[s.tmpId] = s; });
  const nodes = [];
  const edges = [];
  const placed = new Set();
  let maxCol = 0, maxRow = 0;
  const addNode = (id, col, row, kind) => {
    if (placed.has(id)) return;
    placed.add(id);
    nodes.push({ id, col, row, kind });
    if (col > maxCol) maxCol = col;
    if (row > maxRow) maxRow = row;
  };
  const walk = (startNode, col, row) => {
    let node = startNode, c = col;
    let exit = { id: startNode.tmpId, col, row };
    let guard = 0;
    while (node && guard++ < 500) {
      addNode(node.tmpId, c, row, node.isJoinPoint ? "join" : "step");
      exit = { id: node.tmpId, col: c, row };
      const kids = treeChildrenOf(tree, node.tmpId);
      if (kids.length === 0) break;
      if (kids.length === 1) {
        edges.push({ from: node.tmpId, to: kids[0].tmpId });
        node = kids[0]; c += 1; continue;
      }
      const joinStep = node.joinTmpId ? byId[node.joinTmpId] : null;
      let maxExitCol = c;
      const branchExits = [];
      kids.forEach((kid, i) => {
        edges.push({ from: node.tmpId, to: kid.tmpId });
        const be = walk(kid, c + 1, row + i);
        branchExits.push(be);
        if (be.col > maxExitCol) maxExitCol = be.col;
      });
      if (joinStep) {
        const jcol = maxExitCol + 1;
        addNode(joinStep.tmpId, jcol, row, "join");
        branchExits.forEach((be) => edges.push({ from: be.id, to: joinStep.tmpId }));
        node = joinStep; c = jcol; continue;
      }
      exit = { id: node.tmpId, col: maxExitCol, row };
      break;
    }
    return exit;
  };
  let rootRow = 0;
  sortFlowRoots(tree).forEach((root) => {
    walk(root, 0, rootRow);
    rootRow = maxRow + 2;
  });
  return { nodes, edges, cols: maxCol + 1, rows: maxRow + 1 };
}

// Mini-esquema del flujo con la estructura REAL de ramas y uniones.
function FlowMiniMap({ procSteps, color, t }) {
  const { nodes, edges, cols, rows } = computeFlowLayout(procSteps);
  if (!nodes.length) {
    return <div style={{ height: 22, display: "flex", alignItems: "center", fontSize: 10.5, color: t.textFaint }}>Sin pasos</div>;
  }
  const pad = 6, colW = 30, rowH = 18, r = 4;
  const W = pad * 2 + (cols - 1) * colW + r * 2;
  const H = pad * 2 + (rows - 1) * rowH + r * 2;
  const px = (c) => pad + r + c * colW;
  const py = (rw) => pad + r + rw * rowH;
  const nodeById = {};
  nodes.forEach((n) => { nodeById[n.id] = n; });
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} height={Math.min(H, 96)}
      preserveAspectRatio="xMinYMid meet" style={{ display: "block" }}>
      {edges.map((e, i) => {
        const a = nodeById[e.from], b = nodeById[e.to];
        if (!a || !b) return null;
        const x1 = px(a.col), y1 = py(a.row), x2 = px(b.col), y2 = py(b.row);
        const dx = Math.max((x2 - x1) / 2, 6);
        return <path key={i} d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`}
          fill="none" stroke={t.border} strokeWidth="1.5" />;
      })}
      {nodes.map((n) => n.kind === "join"
        ? <rect key={n.id} x={px(n.col) - r} y={py(n.row) - r} width={r * 2} height={r * 2} rx="1.5"
            fill={color} transform={`rotate(45 ${px(n.col)} ${py(n.row)})`} />
        : <circle key={n.id} cx={px(n.col)} cy={py(n.row)} r={r} fill={color} />)}
    </svg>
  );
}

// ============================================================================
// MODO CINE — presentación a pantalla completa de los flujos (ciclo de operación)
// ============================================================================
const CINEMA_CSS = `
.cine-btn{ background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.14); color:#e7ebf1;
  width:44px; height:44px; border-radius:99px; display:flex; align-items:center; justify-content:center;
  cursor:pointer; transition:background .15s, border-color .15s; }
.cine-btn:hover{ background:rgba(255,255,255,0.13); border-color:rgba(255,255,255,0.3); }
.cine-btn-lg{ width:58px; height:58px; }
@keyframes cineNodeIn{ from{opacity:0; transform:scale(.3);} to{opacity:1; transform:scale(1);} }
@keyframes cineEdgeIn{ to{ stroke-dashoffset:0; } }
@keyframes cineFadeUp{ from{opacity:0; transform:translateY(10px);} to{opacity:1; transform:translateY(0);} }
@keyframes cineOrbitSpin{ to{ transform:rotate(360deg); } }
@keyframes cineFadeOnly{ from{opacity:0;} to{opacity:1;} }
@keyframes cinePulse{ 0%,100%{ opacity:.45; } 50%{ opacity:1; } }
@keyframes cineHalo{ 0%,100%{ opacity:.35; r:32; } 50%{ opacity:.75; r:38; } }
.cine-node-in{ opacity:0; animation:cineNodeIn .55s cubic-bezier(.2,.8,.2,1) forwards; transform-box:fill-box; transform-origin:center; }
.cine-edge-in{ stroke-dasharray:1; stroke-dashoffset:1; animation:cineEdgeIn .7s ease forwards; }
.cine-fade-up{ opacity:0; animation:cineFadeUp .6s ease forwards; }
.cine-orbit-spin{ animation:cineOrbitSpin 70s linear infinite; transform-origin:center; }
.cine-orbit-node{ opacity:0; animation:cineFadeOnly .5s ease forwards; transition:transform .2s; }
.cine-orbit-node:hover{ transform:translate(-50%,-50%) scale(1.12) !important; }
.cine-zoom{ transition:transform 1.1s cubic-bezier(.6,.05,.2,1); transform-origin:0 0; }
.cine-halo{ animation:cineHalo 2.4s ease-in-out infinite; }
.cine-detail{ animation:cineFadeUp .5s cubic-bezier(.2,.8,.2,1) both;
  background:linear-gradient(180deg, rgba(20,26,36,0.92), rgba(12,16,24,0.94));
  border:1px solid rgba(255,255,255,0.1); border-radius:16px; backdrop-filter:blur(12px);
  box-shadow:0 20px 60px rgba(0,0,0,0.55); }
.cine-chip{ font-size:11.5px; font-weight:500; padding:3px 10px; border-radius:99px;
  border:1px solid rgba(255,255,255,0.14); color:#cdd3dd; }
.cine-dim{ transition:opacity .8s ease; }
`;

function CinemaParticles({ color }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0, h = 0, raf = 0;
    const N = 64;
    const parts = Array.from({ length: N }, () => ({
      x: Math.random(), y: Math.random(),
      vx: (Math.random() - 0.5) * 0.0006, vy: (Math.random() - 0.5) * 0.0006,
      r: Math.random() * 1.6 + 0.5, a: Math.random() * 0.5 + 0.15,
    }));
    const resize = () => {
      w = canvas.width = canvas.offsetWidth * dpr;
      h = canvas.height = canvas.offsetHeight * dpr;
    };
    resize();
    window.addEventListener("resize", resize);
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > 1) p.vx *= -1;
        if (p.y < 0 || p.y > 1) p.vy *= -1;
        const X = p.x * w, Y = p.y * h;
        for (let j = i + 1; j < parts.length; j++) {
          const q = parts[j];
          const dx = (p.x - q.x) * w, dy = (p.y - q.y) * h;
          const d2 = dx * dx + dy * dy;
          const max = 130 * dpr;
          if (d2 < max * max) {
            const o = (1 - Math.sqrt(d2) / max) * 0.12;
            ctx.strokeStyle = `rgba(150,165,190,${o})`;
            ctx.lineWidth = dpr * 0.6;
            ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(q.x * w, q.y * h); ctx.stroke();
          }
        }
        ctx.beginPath();
        ctx.arc(X, Y, p.r * dpr, 0, 7);
        ctx.fillStyle = `rgba(205,215,235,${p.a})`;
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, []);
  return <canvas ref={ref} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} />;
}

function CinemaFlow({ proc, data, layout, tour, focus, onFocusStep }) {
  const W = 1280, H = 680, padX = 190, padTop = 170, padBottom = 170;
  const cols = Math.max(layout.cols, 1), rows = Math.max(layout.rows, 1);
  const availW = W - padX * 2, availH = H - padTop - padBottom;
  const colW = cols > 1 ? Math.min(availW / (cols - 1), 300) : 0;
  const rowH = rows > 1 ? Math.min(availH / (rows - 1), 150) : 0;
  const contentW = (cols - 1) * colW, contentH = (rows - 1) * rowH;
  const offX = padX + (availW - contentW) / 2;
  const offY = padTop + (availH - contentH) / 2;
  const px = (c) => offX + c * colW;
  const py = (r) => (rows > 1 ? offY + r * rowH : H / 2 + 10);
  const nById = {};
  layout.nodes.forEach((n) => { nById[n.id] = n; });
  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  const focusNode = focus >= 0 && tour[focus] ? tour[focus] : null;
  const scale = focusNode ? 2.4 : 1;
  const fx = focusNode ? px(focusNode.col) : 0;
  const fy = focusNode ? py(focusNode.row) : 0;
  const tx = focusNode ? W / 2 - fx * scale : 0;
  const ty = focusNode ? H / 2 - fy * scale : 0;

  const detail = (() => {
    if (!focusNode) return null;
    const st = proc.steps.find((s) => s.id === focusNode.id);
    const src = st && st.sourceId ? data.sources.find((s) => s.id === st.sourceId) : null;
    const fields = src ? data.fields.filter((f) => f.sourceId === src.id) : [];
    const roles = data.roles.filter((r) => r.stepId === focusNode.id);
    return { st, src, fields, roles };
  })();

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {/* Título del proceso (fijo) */}
      <div style={{ position: "absolute", top: 76, left: 60, zIndex: 3 }} className="cine-fade-up">
        <div style={{ fontSize: 34, fontWeight: 600, color: "#f4f6fa", letterSpacing: "-0.01em" }}>{truncate(proc.name, 40)}</div>
        <div style={{ fontSize: 13, letterSpacing: "0.22em", color: proc.color, marginTop: 6, textTransform: "uppercase" }}>
          {proc.areaName} · {proc.steps.length} pasos
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
        <defs>
          <filter id="cineGlow" x="-120%" y="-120%" width="340%" height="340%">
            <feGaussianBlur stdDeviation="9" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <g className="cine-zoom" style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}>
          {layout.edges.map((e, i) => {
            const a = nById[e.from], b = nById[e.to];
            if (!a || !b) return null;
            const x1 = px(a.col), y1 = py(a.row), x2 = px(b.col), y2 = py(b.row);
            const dx = Math.max((x2 - x1) / 2, 24);
            const dim = focusNode && !(a.id === focusNode.id || b.id === focusNode.id);
            return <path key={i} d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`}
              fill="none" stroke={proc.color} strokeOpacity={dim ? 0.15 : 0.5} strokeWidth="2" pathLength="1"
              className={"cine-edge-in cine-dim"} style={{ animationDelay: `${0.3 + a.col * 0.35}s` }} />;
          })}
          {layout.nodes.map((n) => {
            const cx = px(n.col), cy = py(n.row);
            const nm = (proc.steps.find((s) => s.id === n.id) || {}).name || "";
            const isFocus = focusNode && n.id === focusNode.id;
            const dim = focusNode && !isFocus;
            const ti = tour.findIndex((tn) => tn.id === n.id);
            return (
              <g key={n.id} className="cine-node-in cine-dim" opacity={dim ? 0.22 : 1}
                onClick={() => onFocusStep && onFocusStep(ti)}
                style={{ animationDelay: `${0.35 + n.col * 0.35}s`, transformOrigin: `${cx}px ${cy}px`, cursor: "pointer" }}>
                {isFocus && <circle cx={cx} cy={cy} r="32" fill="none" stroke={proc.color} strokeWidth="2" className="cine-halo" />}
                {/* área de click más grande e invisible para acertarle fácil */}
                <circle cx={cx} cy={cy} r="26" fill="transparent" />
                {n.kind === "join"
                  ? <rect x={cx - 13} y={cy - 13} width="26" height="26" rx="4" fill={proc.color}
                      transform={`rotate(45 ${cx} ${cy})`} filter="url(#cineGlow)" />
                  : <circle cx={cx} cy={cy} r="16" fill={proc.color} filter="url(#cineGlow)" />}
                <text x={cx} y={cy + 40} fill="#dfe4ec" fontSize="14" textAnchor="middle" style={{ fontWeight: 500 }}>
                  {truncate(nm || (n.kind === "join" ? "Unión" : "Paso"), 18)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {/* Tarjeta de detalle del paso enfocado */}
      {detail && (
        <div key={focusNode.id} className="cine-detail" style={{ position: "absolute", left: 60, bottom: 130,
          width: 360, maxWidth: "42vw", padding: "18px 20px", zIndex: 4, color: "#e7ebf1" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, background: proc.color, boxShadow: `0 0 10px ${proc.color}` }} />
            <span style={{ fontSize: 11, letterSpacing: "0.14em", color: "#8a93a1", textTransform: "uppercase" }}>
              Paso {focus + 1} de {tour.length}{focusNode.kind === "join" ? " · Unión" : ""}
            </span>
          </div>
          <div style={{ fontSize: 21, fontWeight: 600, marginBottom: 12 }}>{detail.st?.name || (focusNode.kind === "join" ? "Unión de ramas" : "Paso")}</div>
          {detail.src && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              <span className="cine-chip">{detail.src.kind === "file" ? "Archivo" : "ERP"}: {detail.src.code || "—"}</span>
              {detail.src.where && <span className="cine-chip">{detail.src.where}</span>}
            </div>
          )}
          {detail.fields.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10.5, letterSpacing: "0.1em", color: "#6b7482", textTransform: "uppercase", marginBottom: 5 }}>Datos ({detail.fields.length})</div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {detail.fields.slice(0, 6).map((f) => (
                  <span key={f.id} style={{ fontSize: 11.5, padding: "3px 9px", borderRadius: 6,
                    background: f.sensitive ? "rgba(229,58,58,0.16)" : "rgba(255,255,255,0.06)",
                    color: f.sensitive ? "#ff9a9a" : "#cdd3dd" }}>{f.name || "campo"}{f.sensitive ? " ●" : ""}</span>
                ))}
                {detail.fields.length > 6 && <span style={{ fontSize: 11.5, color: "#6b7482", padding: "3px 4px" }}>+{detail.fields.length - 6}</span>}
              </div>
            </div>
          )}
          {detail.roles.length > 0 && (
            <div>
              <div style={{ fontSize: 10.5, letterSpacing: "0.1em", color: "#6b7482", textTransform: "uppercase", marginBottom: 5 }}>Responsables</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {detail.roles.slice(0, 3).map((r, i) => (
                  <div key={i} style={{ fontSize: 12.5, color: "#cdd3dd" }}>
                    <span style={{ color: "#8a93a1" }}>{r.type}: </span>{r.person || r.email || "—"}
                  </div>
                ))}
              </div>
            </div>
          )}
          {!detail.src && detail.fields.length === 0 && detail.roles.length === 0 && (
            <div style={{ fontSize: 12.5, color: "#8a93a1" }}>Sin fuente ni responsables documentados en este paso.</div>
          )}
        </div>
      )}
    </div>
  );
}

function CinemaOrbit({ procs, onPick }) {
  const R = Math.min(250, 120 + procs.length * 14);
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "relative", width: R * 2 + 200, height: R * 2 + 200, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width={R * 2 + 200} height={R * 2 + 200} style={{ position: "absolute", inset: 0 }}>
          <circle className="cine-orbit-spin" cx="50%" cy="50%" r={R} fill="none"
            stroke="rgba(229,58,58,0.28)" strokeWidth="1.5" strokeDasharray="2 7" />
          <circle cx="50%" cy="50%" r={R} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
        </svg>
        <div style={{ textAlign: "center", maxWidth: 260, zIndex: 2 }}>
          <div style={{ fontSize: 12, letterSpacing: "0.24em", color: "#e53a3a", textTransform: "uppercase" }}>Dacomsa</div>
          <div style={{ fontSize: 27, fontWeight: 600, marginTop: 8 }}>Ciclo de operación</div>
          <div style={{ fontSize: 13, color: "#8a93a1", marginTop: 10 }}>{procs.length} proceso{procs.length === 1 ? "" : "s"} · toca uno para reproducir</div>
        </div>
        {procs.map((p, i) => {
          const ang = (i / procs.length) * Math.PI * 2 - Math.PI / 2;
          const x = Math.cos(ang) * R, y = Math.sin(ang) * R;
          return (
            <div key={p.id} onClick={() => onPick(i)} className="cine-orbit-node"
              style={{ position: "absolute", left: `calc(50% + ${x}px)`, top: `calc(50% + ${y}px)`,
                transform: "translate(-50%,-50%)", cursor: "pointer", textAlign: "center", width: 130, animationDelay: `${i * 0.05}s` }}>
              <div style={{ width: 18, height: 18, borderRadius: 99, background: p.color, boxShadow: `0 0 16px ${p.color}`, margin: "0 auto 7px" }} />
              <div style={{ fontSize: 11.5, color: "#cdd3dd", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
              <div style={{ fontSize: 9.5, color: "#6b7482", marginTop: 1 }}>{p.steps.length} pasos</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CinemaMode({ data, areaColors, onClose }) {
  const procs = useMemo(() => data.processes
    .filter((p) => data.steps.some((s) => s.processId === p.id))
    .map((p) => ({
      ...p,
      areaName: (data.areas.find((a) => a.id === p.areaId) || {}).name || "Sin área",
      color: areaColors[p.areaId] || "#e53a3a",
      steps: data.steps.filter((s) => s.processId === p.id),
    })), [data, areaColors]);

  const [scene, setScene] = useState("orbit");
  const [idx, setIdx] = useState(0);
  const [focus, setFocus] = useState(-1); // -1 = flujo completo; 0..n = paso enfocado
  const [playing, setPlaying] = useState(true);
  const rootRef = useRef(null);

  const safeIdx = Math.min(idx, Math.max(procs.length - 1, 0));
  const cur = procs[safeIdx];
  const layout = useMemo(() => (cur ? computeFlowLayout(cur.steps) : { nodes: [], edges: [], cols: 0, rows: 0 }), [cur && cur.id]); // eslint-disable-line
  const tour = useMemo(() => [...layout.nodes].sort((a, b) => a.col - b.col || a.row - b.row), [layout]);

  const gotoProc = useCallback((i) => { setIdx(i); setFocus(-1); }, []);

  // Avanza: primero recorre pasos del flujo, luego pasa al siguiente proceso.
  const advance = useCallback(() => {
    setFocus((f) => {
      if (f < tour.length - 1) return f + 1;
      setIdx((i) => (i + 1) % procs.length);
      return -1;
    });
  }, [tour.length, procs.length]);
  const back = useCallback(() => {
    setFocus((f) => {
      if (f > -1) return f - 1;
      setIdx((i) => (i - 1 + procs.length) % procs.length);
      return -1;
    });
  }, [procs.length]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { if (scene === "flow") setScene("orbit"); else onClose(); }
      else if (scene === "flow") {
        if (e.key === "ArrowRight") advance();
        else if (e.key === "ArrowLeft") back();
        else if (e.key === " ") { e.preventDefault(); setPlaying((p) => !p); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scene, advance, back, onClose]);

  // Autoplay: da tiempo a la entrada del flujo y luego avanza paso a paso.
  useEffect(() => {
    if (!playing || scene !== "flow") return undefined;
    const delay = focus < 0 ? 2600 : 4200;
    const timer = setTimeout(advance, delay);
    return () => clearTimeout(timer);
  }, [playing, scene, idx, focus, advance]);

  useEffect(() => {
    const el = rootRef.current;
    if (el && el.requestFullscreen) el.requestFullscreen().catch(() => {});
    return () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
  }, []);

  if (!procs.length || !cur) return null;

  return (
    <div ref={rootRef} style={{ position: "fixed", inset: 0, zIndex: 9999, background: "#070a10",
      color: "#fff", fontFamily: "var(--font-main)", overflow: "hidden" }}>
      <style>{CINEMA_CSS}</style>
      <CinemaParticles color={cur.color} />
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none",
        background: "radial-gradient(ellipse at center, transparent 52%, rgba(0,0,0,0.62) 100%)" }} />

      <div style={{ position: "absolute", top: 0, left: 0, right: 0, display: "flex", alignItems: "center",
        justifyContent: "space-between", padding: "20px 30px", zIndex: 5 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 9, height: 9, borderRadius: 99, background: "#e53a3a", boxShadow: "0 0 12px #e53a3a", animation: "cinePulse 2s ease-in-out infinite" }} />
          <span style={{ fontSize: 12.5, letterSpacing: "0.18em", textTransform: "uppercase", color: "#8a93a1" }}>Modo cine · Ciclo de operación</span>
        </div>
        <div onClick={onClose} style={{ cursor: "pointer", color: "#8a93a1", display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <X size={18} /> Salir
        </div>
      </div>

      {scene === "orbit"
        ? <CinemaOrbit procs={procs} onPick={(i) => { gotoProc(i); setScene("flow"); }} />
        : <CinemaFlow proc={cur} data={data} layout={layout} tour={tour} focus={focus}
            onFocusStep={(i) => { if (i >= 0) { setFocus(i); setPlaying(false); } }} />}

      {scene === "flow" && (
        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, display: "flex", flexDirection: "column",
          alignItems: "center", gap: 14, padding: "0 0 26px", zIndex: 5 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center", maxWidth: "70vw" }}>
            {procs.map((p, i) => (
              <span key={p.id} onClick={() => gotoProc(i)} style={{ width: i === safeIdx ? 24 : 7, height: 7,
                borderRadius: 99, cursor: "pointer", background: i === safeIdx ? cur.color : "#39424f", transition: "all .3s" }} />
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <button className="cine-btn" onClick={back} title="Anterior (←)"><ChevronLeft size={22} /></button>
            <button className="cine-btn cine-btn-lg" onClick={() => setPlaying((p) => !p)} title="Reproducir (espacio)">
              {playing ? <Pause size={22} /> : <Play size={22} />}</button>
            <button className="cine-btn" onClick={advance} title="Siguiente (→)"><ChevronRight size={22} /></button>
            <button className="cine-btn" onClick={() => { setScene("orbit"); setFocus(-1); }} title="Ver el ciclo"><LayoutGrid size={19} /></button>
          </div>
          <div style={{ fontSize: 11.5, color: "#5c6470", letterSpacing: "0.04em" }}>
            {focus < 0 ? "Flujo completo" : `Paso ${focus + 1} / ${tour.length}`} · {cur.name}
          </div>
        </div>
      )}
    </div>
  );
}

function FlowsView({ data, t, areaColors, onOpen, onNew, initialCinema, onCinemaConsumed }) {
  const [cinema, setCinema] = useState(!!initialCinema);
  const setCineUrl = (on) => { try { window.history.replaceState(null, "", on ? "/cine" : "/"); } catch (e) { /* noop */ } };
  const openCinema = () => { setCinema(true); setCineUrl(true); };
  const closeCinema = () => { setCinema(false); setCineUrl(false); };
  useEffect(() => {
    if (initialCinema) { setCineUrl(true); onCinemaConsumed?.(); }
  }, []); // eslint-disable-line
  const groups = data.areas.map((a) => ({
    area: a,
    procs: data.processes.filter((p) => p.areaId === a.id)
      .sort((x, y) => (y.lastModified || "").localeCompare(x.lastModified || "")),
  })).filter((g) => g.procs.length > 0);
  const orphan = data.processes.filter((p) => !data.areas.some((a) => a.id === p.areaId));
  if (orphan.length) groups.push({ area: { id: "__none__", name: "Sin área asignada" }, procs: orphan });

  const renderCard = (p) => {
    const st = processFlowStats(p.id, data);
    const ac = areaColors[p.areaId] || t.primary;
    const version = p.version || 1;
    const growing = st.total > 0 && (version > 1 || flowDaysSince(p.lastModified) <= 14);
    return (
      <div key={p.id} className="premium-card interactive-hover" onClick={() => onOpen(p.id)}
        style={{ padding: 16, cursor: "pointer", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 9, height: 9, borderRadius: 99, background: ac, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: t.text,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name || "Sin nombre"}</div>
          {growing ? (
            <span style={{ fontSize: 10.5, fontWeight: 600, color: "#0B7285", background: "#12B88618",
              padding: "2px 8px", borderRadius: 99, whiteSpace: "nowrap" }}>▲ v{version}</span>
          ) : (
            <span style={{ fontSize: 10.5, fontWeight: 500, color: t.textFaint }}>v{version}</span>
          )}
        </div>
        <FlowMiniMap procSteps={data.steps.filter((s) => s.processId === p.id)} color={ac} t={t} />
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: t.textDim }}>
          <span>{st.total} paso{st.total === 1 ? "" : "s"}</span>
          <span style={{ color: t.textFaint }}>·</span>
          <span>{st.branched ? `${st.forks} bifurcación${st.forks === 1 ? "" : "es"}` : "lineal"}</span>
          {st.joins > 0 && <><span style={{ color: t.textFaint }}>·</span><span>{st.joins} unión{st.joins === 1 ? "" : "es"}</span></>}
        </div>
      </div>
    );
  };

  return (
    <div>
      <Header title="Flujos — portafolio de procesos"
        sub="Qué procesos existen y cómo van creciendo · clic para abrir el detalle"
        t={t}
        action={<div style={{ display: "flex", gap: 8 }}>
          {data.processes.length > 0 && (
            <Btn t={t} variant="ghost" onClick={openCinema}><Play size={15} /> Modo cine</Btn>
          )}
          <Btn t={t} onClick={onNew}><Plus size={16} /> Nuevo flujo</Btn>
        </div>} />

      {cinema && <CinemaMode data={data} areaColors={areaColors} onClose={closeCinema} />}

      {groups.length === 0 ? (
        <div className="premium-card" style={{ padding: 28, textAlign: "center", color: t.textFaint, fontSize: 13 }}>
          Aún no hay flujos documentados. Crea el primero con «Nuevo flujo».
        </div>
      ) : groups.map((g) => {
        const totalSteps = g.procs.reduce((n, p) => n + data.steps.filter((s) => s.processId === p.id).length, 0);
        const ac = areaColors[g.area.id] || t.primary;
        return (
          <div key={g.area.id} style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <span style={{ width: 10, height: 10, borderRadius: 99, background: ac, flexShrink: 0 }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: t.text }}>{g.area.name}</span>
              <span style={{ fontSize: 11.5, color: t.textFaint, fontWeight: 500 }}>
                {g.procs.length} proceso{g.procs.length === 1 ? "" : "s"} · {totalSteps} pasos
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(258px, 1fr))", gap: 12 }}>
              {g.procs.map(renderCard)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DocProgress({ data, t, areaColors, setView }) {
  const documented = data.processes.filter((p) => isProcessDocumented(p.id, data));
  const pending = data.processes.filter((p) => !isProcessDocumented(p.id, data));
  const total = data.processes.length;
  const pct = total ? Math.round((documented.length / total) * 100) : 0;
  const color = pct >= 80 ? "#34A853" : pct >= 40 ? "var(--primary)" : "#FBBC04";

  const byArea = useMemo(() => data.areas.map((area) => {
    const procs = data.processes.filter((p) => p.areaId === area.id);
    const done = procs.filter((p) => isProcessDocumented(p.id, data));
    const pend = procs.filter((p) => !isProcessDocumented(p.id, data));
    const areaPct = procs.length ? Math.round((done.length / procs.length) * 100) : 0;
    return { area, procs, done, pend, areaPct };
  }).filter((x) => x.procs.length > 0), [data]);

  const orphanProcs = data.processes.filter((p) => !data.areas.some((a) => a.id === p.areaId));

  return (
    <div style={{ marginBottom: 12 }}>
      {/* Resumen global */}
      <div className="premium-card glass-panel" style={{ padding: 14, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 9, background: `${color}18`,
            border: `1px solid ${color}33`,
            display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Target size={18} color={color} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.01em", color: "var(--text-main)", fontFamily: "var(--font-display)" }}>Progreso global</div>
            <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 1, fontWeight: 400 }}>
              {total === 0
                ? "Declara metas en Administración para empezar"
                : `${documented.length} documentado${documented.length !== 1 ? "s" : ""} · ${pending.length} pendiente${pending.length !== 1 ? "s" : ""}`}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 28, fontWeight: 700, color, letterSpacing: -0.5, lineHeight: 1, fontFamily: "var(--font-display)" }}>{pct}%</div>
            <div style={{ fontSize: 10.5, color: "var(--text-faint)", marginTop: 2, fontWeight: 500 }}>{documented.length} / {total} metas</div>
          </div>
        </div>
        <div style={{ height: 7, background: "var(--surface-alt)", borderRadius: 99, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 99, transition: "width .5s" }} />
        </div>
        {total === 0 && (
          <div style={{ marginTop: 14, fontSize: 13.5, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 8 }}>
            <Circle size={14} />
            <span onClick={() => setView("admin")} style={{ color: "var(--primary)", cursor: "pointer", fontWeight: 600 }}>
              Ir a Administración → Metas de documentación</span>
          </div>
        )}
      </div>

      {/* Desglose por área */}
      {byArea.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
          {byArea.map(({ area, procs, done, pend, areaPct }) => {
            const ac = areaColors[area.id] || "var(--primary)";
            const areaColor = areaPct >= 80 ? "#34A853" : areaPct >= 40 ? ac : "#FBBC04";
            return (
              <div key={area.id} className="premium-card" style={{ padding: 18, borderTop: `4px solid ${ac}`, position: 'relative' }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 99, background: ac, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "var(--font-display)", color: "var(--text-main)", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{area.name}</div>
                    <div style={{ fontSize: 11.5, color: "var(--text-faint)", fontWeight: 500 }}>{done.length} de {procs.length} metas</div>
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: areaColor, fontFamily: "var(--font-display)" }}>{areaPct}%</div>
                </div>
                <div style={{ height: 6, background: "var(--surface-alt)", borderRadius: 99, overflow: "hidden", marginBottom: 14 }}>
                  <div style={{ height: "100%", width: `${areaPct}%`, background: ac, borderRadius: 99,
                    transition: "width .5s" }} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 200, overflowY: "auto" }}>
                  {procs.map((p) => {
                    const isDone = isProcessDocumented(p.id, data);
                    const stepCount = data.steps.filter((s) => s.processId === p.id).length;
                    return (
                      <div key={p.id} onClick={!isDone ? () => setView("capture") : undefined}
                        className="interactive-hover"
                        style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
                          background: "var(--surface-alt)", borderRadius: 8, fontSize: 12.5,
                          cursor: !isDone ? "pointer" : "default",
                          borderLeft: `3px solid ${isDone ? "#34A853" : "#FBBC04"}` }}>
                        {isDone
                          ? <Check size={14} color="#34A853" style={{ flexShrink: 0 }} />
                          : <Circle size={14} color="#FBBC04" style={{ flexShrink: 0 }} />}
                        <span style={{ fontWeight: 600, flex: 1, color: "var(--text-main)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                        <span style={{ fontSize: 10.5, color: "var(--text-faint)", fontWeight: 600 }}>
                          {isDone ? `${stepCount} paso${stepCount !== 1 ? "s" : ""}` : "Pendiente"}
                        </span>
                        {!isDone && <ChevronRight size={13} color="var(--text-faint)" />}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {orphanProcs.length > 0 && (
        <div className="premium-card" style={{ marginTop: 16, padding: 18 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, color: "var(--text-dim)", fontFamily: "var(--font-display)" }}>Sin área asignada</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {orphanProcs.map((p) => {
              const isDone = isProcessDocumented(p.id, data);
              return (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
                  background: "var(--surface-alt)", borderRadius: 8, fontSize: 13 }}>
                  {isDone ? <Check size={14} color="#34A853" /> : <Circle size={14} color="#FBBC04" />}
                  <span style={{ fontWeight: 600, flex: 1, color: "var(--text-main)" }}>{p.name}</span>
                  <span style={{ fontSize: 11, color: "var(--text-faint)", fontWeight: 500 }}>{isDone ? "Documentado" : "Pendiente"}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function MiniBar({ title, pct, t }) {
  return (
    <div className="premium-card" style={{ padding: 18, display: "flex", flexDirection: "column", justifyContent: "center" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 9 }}>
        <div style={{ fontSize: 13, color: "var(--text-dim)", fontWeight: 500 }}>{title}</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: "var(--primary)" }}>{pct}%</div>
      </div>
      <div style={{ height: 6, background: "var(--surface-alt)", borderRadius: 99, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: "var(--primary)", borderRadius: 99, transition: "width .5s", boxShadow: "var(--shadow-primary-glow)" }} />
      </div>
    </div>
  );
}

function AiReadiness({ coverage, ownerCov, stepsCov, t }) {
  const ai = Math.round(coverage * 0.5 + ownerCov * 0.25 + stepsCov * 0.25);
  const label = ai >= 75 ? "Listo" : ai >= 45 ? "Intermedio" : "Inicial";
  
  // Gradiente premium para la barra
  const barGrad = "linear-gradient(90deg, #A142F4 0%, var(--primary) 100%)";
  const glowShadow = "0 0 12px rgba(161, 66, 244, 0.4)";
  
  return (
    <div className="premium-card glass-panel" style={{ padding: 22, position: "relative", overflow: "hidden" }}>
      {/* Luz ambiental sutil en la esquina */}
      <div style={{ position: "absolute", top: -20, right: -20, width: 90, height: 90, 
        background: "radial-gradient(circle, rgba(161,66,244,0.15) 0%, transparent 70%)", pointerEvents: "none" }} />
        
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <Sparkles size={18} color="#A142F4" style={{ filter: "drop-shadow(0 0 4px rgba(161,66,244,0.6))" }} />
        <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--font-display)", color: "var(--text-main)" }}>Preparación para Agentes de IA</div>
        <span style={{ marginLeft: "auto", padding: "4px 12px", borderRadius: 999, fontSize: 11.5,
          fontWeight: 700, background: "rgba(161, 66, 244, 0.12)", color: "#B55CFF", border: "1px solid rgba(161, 66, 244, 0.2)" }}>
          {label} · {ai}%
        </span>
      </div>
      <div style={{ height: 8, background: "var(--surface-alt)", borderRadius: 99, overflow: "hidden", marginBottom: 12 }}>
        <div style={{ height: "100%", width: `${ai}%`, background: barGrad, borderRadius: 99, transition: "width .5s", boxShadow: glowShadow }} />
      </div>
      <div style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.6 }}>
        Evalúa el volumen de contexto semántico estructurado disponible para agentes de Inteligencia Artificial: 
        diccionario de datos ({coverage}%), propietarios identificados ({ownerCov}%) y linaje del proceso ({stepsCov}%). 
        Un catálogo gobernado es la base técnica para habilitar respuestas confiables y sin alucinaciones.
      </div>
    </div>
  );
}

function SourceMix({ data, t }) {
  const kindColors = { erp: "var(--primary)", file: "#FBBC04", db: "#34A853", report: "#A142F4" };
  const counts = SOURCE_KINDS.map((k) => ({ ...k,
    n: data.sources.filter((s) => s.kind === k.id).length, color: kindColors[k.id] }));
  const total = data.sources.length;
  let cum = 0;
  return (
    <div className="premium-card" style={{ padding: 20 }}>
      <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--font-display)", marginBottom: 16, color: "var(--text-main)" }}>Composición de fuentes</div>
      {total === 0 ? <div style={{ color: "var(--text-faint)", fontSize: 13.5, padding: "20px 0" }}>Aún no hay fuentes documentadas.</div>
        : <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
            <svg width={110} height={110} viewBox="0 0 110 110" style={{ transform: "rotate(-90deg)", flexShrink: 0 }}>
              <circle cx={55} cy={55} r={44} fill="none" stroke="var(--surface-alt)" strokeWidth={14} />
              {counts.filter((c) => c.n > 0).map((c) => {
                const pct = (c.n / total) * 100;
                const el = (
                  <circle key={c.id} cx={55} cy={55} r={44} fill="none" stroke={c.color} strokeWidth={14}
                    pathLength={100} strokeDasharray={`${pct} ${100 - pct}`} strokeDashoffset={-cum} strokeLinecap="round" />
                );
                cum += pct; return el;
              })}
            </svg>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
              {counts.map((c) => (
                <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: c.color, flexShrink: 0,
                    opacity: c.n ? 1 : 0.3 }} />
                  <span style={{ color: c.n ? "var(--text-main)" : "var(--text-faint)", flex: 1, fontWeight: 500 }}>{c.label}</span>
                  <span style={{ fontWeight: 700, color: c.n ? "var(--text-main)" : "var(--text-faint)" }}>{c.n}</span>
                </div>
              ))}
              <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 6, lineHeight: 1.4 }}>
                Las fuentes de tipo <strong style={{ color: "#FBBC04" }}>archivo no gobernado</strong> representan brechas críticas de control.</div>
            </div>
          </div>}
    </div>
  );
}

// ============================================================================
// CAPTURA — un solo lienzo. El proceso se ve como nodo (preview).
// ============================================================================
// Autocomplete de transacciones SAP
function SapAutocomplete({ value, onChange, kind, t }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(value || "");
  const ref = useRef();

  useEffect(() => { setQ(value || ""); }, [value]);

  const suggestions = useMemo(() => {
    if (kind !== "erp" || !q || q.length < 1) return [];
    const lower = q.toLowerCase();
    return SAP_TXNS.filter((tx) => tx.code.toLowerCase().includes(lower)
      || tx.desc.toLowerCase().includes(lower) || tx.mod.toLowerCase().includes(lower)).slice(0, 8);
  }, [q, kind]);

  const handleSelect = (tx) => { onChange(tx.code); setQ(tx.code); setOpen(false); };

  const modColors = {
    SD: { bg: "rgba(66, 133, 244, 0.12)", text: "#4285F4" },
    FI: { bg: "rgba(52, 168, 83, 0.12)", text: "#34A853" },
    MM: { bg: "rgba(255, 109, 1, 0.12)", text: "#FF6D01" },
    CO: { bg: "rgba(161, 66, 244, 0.12)", text: "#A142F4" },
    PP: { bg: "rgba(251, 188, 4, 0.12)", text: "#FBBC04" },
    QM: { bg: "rgba(36, 193, 224, 0.12)", text: "#24C1E0" },
    HR: { bg: "rgba(234, 67, 53, 0.12)", text: "#EA4335" },
    BC: { bg: "rgba(122, 132, 148, 0.12)", text: "#7A8494" },
  };

  return (
    <div style={{ position: "relative" }} ref={ref}>
      <input 
        className="input-premium"
        placeholder={kind === "erp" ? "Buscar transacción SAP..." : "Nombre del archivo / fuente"}
        value={q} onChange={(e) => { setQ(e.target.value); onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 180)}
        style={{ fontSize: 13, background: "var(--surface-solid)" }} 
      />
      {open && suggestions.length > 0 && (
        <div className="glass-panel" style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20,
          border: "1px solid var(--border-color)", borderRadius: 10,
          boxShadow: "var(--shadow-md)", maxHeight: 220, overflow: "auto", marginTop: 4, padding: "4px" }}>
          {suggestions.map((tx) => {
            const badge = modColors[tx.mod] || { bg: "rgba(122, 132, 148, 0.1)", text: "var(--text-dim)" };
            return (
              <div key={tx.code} onMouseDown={() => handleSelect(tx)}
                className="interactive-hover"
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                  cursor: "pointer", borderRadius: 8, transition: "all var(--transition-fast)", marginBottom: 2 }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--surface-alt)")}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}>
                <span style={{ fontFamily: "monospace", fontWeight: 700, color: "var(--primary)",
                  minWidth: 55, fontSize: 12.5 }}>{tx.code}</span>
                <span style={{ color: "var(--text-main)", fontSize: 12.5, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tx.desc}</span>
                <span style={{ fontSize: 9.5, color: badge.text, fontWeight: 700, backgroundColor: badge.bg,
                  padding: "2px 8px", borderRadius: 999, border: `1px solid ${badge.text}1F` }}>{tx.mod}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProcessStepCapturePanel({
  st, stepIndex, stepFields, stepRoles, siblings, areaId, color, t, areaColors, data,
  updStep, updField, rmField, addFieldRow, importHeader, setStepRoles,
  readOnly = false, lockHolder = null,
}) {
  const hasSiblings = siblings.length > 1;
  const sibIdx = siblings.indexOf(st);
  const thisRoles = stepRoles.filter((r) => r.stepTmpId === st.tmpId);
  const ro = readOnly;

  return (
    <div style={{ background: t.surfaceSolid, border: "1px solid " + t.border, borderRadius: 8,
      padding: 12, opacity: ro ? 0.92 : 1 }}>
      {ro && lockHolder && (
        <div className="step-panel-lock-banner">
          <Lock size={14} />
          <span><strong>{lockHolder}</strong> está editando este paso. Solo lectura.</span>
        </div>
      )}
      <div style={{ fontSize: 11, color: t.textDim, marginBottom: 10 }}>
        Paso {stepIndex + 1}{hasSiblings ? ` · rama ${String.fromCharCode(65 + sibIdx)}` : ""}
      </div>

      {hasSiblings && (
        <div style={{ marginBottom: 10 }}>
          <input placeholder={"Etiqueta rama " + String.fromCharCode(65 + sibIdx)}
            value={st.pathLabel || ""} onChange={(e) => !ro && updStep(st.tmpId, "pathLabel", e.target.value)}
            readOnly={ro}
            style={{ ...inputStyle(t), fontSize: 12 }} />
        </div>
      )}

      <Field label="¿Qué se hace en este paso?" t={t}>
        <Input t={t} placeholder="Ej. Consultar pedidos abiertos" value={st.name}
          onChange={(e) => updStep(st.tmpId, "name", e.target.value)} readOnly={ro} />
      </Field>

      <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 10, marginTop: 12 }}>
        <Field label="Tipo de fuente" t={t}>
          <select value={st.kind} onChange={(e) => updStep(st.tmpId, "kind", e.target.value)}
            disabled={ro}
            style={{ ...inputStyle(t), background: t.surfaceSolid, cursor: ro ? "not-allowed" : "pointer", fontSize: 13 }}>
            {SOURCE_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
        </Field>
        <Field label="Transacción / archivo" t={t}>
          <SapAutocomplete value={st.code} onChange={(v) => updStep(st.tmpId, "code", v)} kind={st.kind} t={t} disabled={ro} />
        </Field>
      </div>

      <Field label="Área responsable del paso" t={t}
        hint="Si otra área ejecuta este paso, selecciónala aquí.">
        <select value={st.stepAreaId || ""} onChange={(e) => updStep(st.tmpId, "stepAreaId", e.target.value)}
          disabled={ro}
          style={{ ...inputStyle(t), background: t.surfaceSolid, cursor: ro ? "not-allowed" : "pointer", fontSize: 13,
            maxWidth: 320, color: st.stepAreaId ? t.text : t.textFaint,
            borderColor: st.stepAreaId && st.stepAreaId !== areaId ? (areaColors[st.stepAreaId] || t.primary) + "88" : t.border }}>
          <option value="">Área del proceso (por defecto)</option>
          {data.areas.filter((a) => a.id !== areaId).map((a) => (
            <option key={a.id} value={a.id}>↪ {a.name}</option>
          ))}
        </select>
      </Field>

      <div style={{ marginTop: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.textDim, marginBottom: 8 }}>DATOS DE ESTE PASO</div>
        {stepFields.map((f) => (
          <div key={f.tmpId} style={{ display: "grid", gridTemplateColumns: "1fr 1.6fr auto auto", gap: 7,
            marginBottom: 6, alignItems: "start" }}>
            <div>
              <input placeholder="Dato / columna" value={f.name}
                onChange={(e) => !ro && updField(f.tmpId, "name", e.target.value)}
                readOnly={ro}
                style={{ ...inputStyle(t), background: t.surfaceSolid, fontSize: 13, padding: "8px 10px" }} />
              {f.example ? <div style={{ fontSize: 10, color: t.textFaint, marginTop: 2,
                fontFamily: "monospace" }}>ej: {f.example}</div> : null}
            </div>
            <input placeholder="¿Qué significa?" value={f.description}
              onChange={(e) => !ro && updField(f.tmpId, "description", e.target.value)}
              readOnly={ro}
              style={{ ...inputStyle(t), background: t.surfaceSolid, fontSize: 13, padding: "8px 10px" }} />
            <div onClick={() => !ro && updField(f.tmpId, "sensitive", !f.sensitive)} title="Sensible"
              style={{ width: 28, height: 28, borderRadius: 7, cursor: ro ? "not-allowed" : "pointer", display: "flex",
                alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700,
                border: "1px solid " + (f.sensitive ? "#EA4335" : t.border),
                color: f.sensitive ? "#EA4335" : t.textFaint,
                background: f.sensitive ? "#EA433518" : t.surfaceSolid, opacity: ro ? 0.65 : 1 }}>S</div>
            {!ro && (
              <Trash2 size={14} color={t.textFaint} style={{ cursor: "pointer", marginTop: 7 }}
                onClick={() => rmField(f.tmpId)} />
            )}
          </div>
        ))}
        {!ro && (
          <div style={{ display: "flex", gap: 12, marginTop: 4, alignItems: "center", flexWrap: "wrap" }}>
            <div onClick={() => addFieldRow(st.tmpId)} style={{ display: "inline-flex", alignItems: "center",
              gap: 4, fontSize: 12, color: t.primary, cursor: "pointer", fontWeight: 500 }}>
              <Plus size={12} /> Dato
            </div>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12,
              color: t.textDim, cursor: "pointer", fontWeight: 500 }}>
              <Upload size={12} /> Subir layout (Excel)
              <input type="file" accept=".xlsx,.xls,.csv" hidden
                onChange={(e) => { if (e.target.files[0]) { importHeader(st.tmpId, e.target.files[0]); e.target.value = ""; } }} />
            </label>
          </div>
        )}
      </div>

      <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid " + t.border }}>
        {thisRoles.length === 0 && (
          <div style={{ fontSize: 11, color: t.textFaint, marginBottom: 6 }}>Sin responsable</div>
        )}
        {thisRoles.map((ra) => {
          return (
            <div key={ra.tmpId} style={{ display: "grid", gridTemplateColumns: "110px 1fr auto", gap: 6,
              alignItems: "center", marginBottom: 4 }}>
              <select value={ra.type} onChange={(e) => !ro && setStepRoles((arr) =>
                arr.map((x) => x.tmpId === ra.tmpId ? { ...x, type: e.target.value } : x))}
                disabled={ro}
                style={{ ...inputStyle(t), cursor: ro ? "not-allowed" : "pointer", fontSize: 11, padding: "5px 6px" }}>
                {ROLE_TYPES.map((rt) => <option key={rt.id} value={rt.id}>{rt.label}</option>)}
              </select>
              <input placeholder="Email" value={ra.email || ""}
                onChange={(e) => !ro && setStepRoles((arr) =>
                  arr.map((x) => x.tmpId === ra.tmpId
                    ? { ...x, email: e.target.value, person: e.target.value.split("@")[0] } : x))}
                readOnly={ro}
                style={{ ...inputStyle(t), fontSize: 12, padding: "5px 8px" }} />
              {!ro && thisRoles.length > 1 && (
                <Trash2 size={13} color={t.textFaint} style={{ cursor: "pointer" }}
                  onClick={() => setStepRoles((arr) => arr.filter((x) => x.tmpId !== ra.tmpId))} />
              )}
            </div>
          );
        })}
        {!ro && (
          <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
            {ROLE_TYPES.map((rt) => (
              <div key={rt.id} onClick={() => setStepRoles((arr) => [...arr,
                { tmpId: uid(), stepTmpId: st.tmpId, type: rt.id, email: "", person: "" }])}
                style={{ fontSize: 10, color: t.textDim, cursor: "pointer", padding: "2px 0" }}>
                + {rt.label}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function buildCaptureProcessPayload({
  areaId, subArea, procName, trigger, steps, fields, stepRoles,
  editingId, editingProc, bumpVersion, versionComment, authUser, collabSession,
  forceNewProcessId = false,
}) {
  let newVersion = 1;
  let newHistory = [];
  const processId = (editingId && !forceNewProcessId) ? editingId : uid();

  if (editingId && editingProc) {
    if (bumpVersion) {
      newVersion = (editingProc.version || 1) + 1;
      newHistory = [...(editingProc.versionHistory || []), {
        version: editingProc.version || 1,
        date: editingProc.lastModified || new Date().toISOString(),
        comment: versionComment.trim() || "Sin comentario",
        name: editingProc.name,
        authorName: authUser?.nombre || collabSession?.usuario || "",
        authorEmail: authUser?.email || collabSession?.email || "",
      }];
    } else {
      newVersion = editingProc.version || 1;
      newHistory = [...(editingProc.versionHistory || [])];
    }
  }

  const executors = [...new Set(
    stepRoles.filter((r) => (r.person || "").trim() || (r.email || "").trim())
      .map((r) => (r.person || "").trim() || (r.email || "").split("@")[0]),
  )];
  const payload = {
    process: {
      id: processId,
      areaId,
      name: procName.trim(),
      trigger,
      subArea,
      executors,
      lastModified: new Date().toISOString(),
      version: newVersion,
      versionHistory: newHistory,
    },
    steps: [],
    sources: [],
    fields: [],
    roles: [],
  };

  let order = 0;
  const visited = new Set();
  const tmpToStepId = {};
  const tmpToSourceId = {};
  const forkJoinTmp = {};

  const emitStep = (st, parentTmp = null) => {
    const sourceId = st.persistedSourceId || uid();
    const stepId = st.persistedId || uid();
    const code = st.code.trim() || st.name.trim() || `PASO-${order + 1}`;
    const parentStepId = parentTmp ? tmpToStepId[parentTmp] : null;
    payload.sources.push({
      id: sourceId, processId, kind: st.kind || "erp", code, where: st.where || "",
    });
    payload.steps.push({
      id: stepId, processId,
      name: st.name.trim() || (st.isJoinPoint ? "Unión de ramas" : `Paso ${order + 1}`),
      order: order++, sourceId, stepAreaId: st.stepAreaId || "",
      isJoinPoint: !!st.isJoinPoint,
      parentStepId: parentStepId || null,
      joinStepId: null,
      pathLabel: st.pathLabel || "",
    });
    tmpToStepId[st.tmpId] = stepId;
    tmpToSourceId[st.tmpId] = sourceId;
    if (st.joinTmpId) forkJoinTmp[st.tmpId] = st.joinTmpId;
    stepRoles
      .filter((r) => r.stepTmpId === st.tmpId && ((r.person || "").trim() || (r.email || "").trim()))
      .forEach((r) => {
        payload.roles.push({
          id: uid(), processId, stepId, type: r.type,
          person: (r.person || "").trim() || (r.email || "").split("@")[0],
          email: (r.email || "").trim(),
        });
      });
    fields
      .filter((f) => f.stepTmpId === st.tmpId && f.name.trim())
      .forEach((f) => {
        payload.fields.push({
          id: uid(), sourceId, name: f.name.trim(),
          description: (f.description || "").trim(), sensitive: !!f.sensitive, example: f.example || "",
        });
      });
  };

  const walk = (st, parentTmp = null) => {
    if (!st || visited.has(st.tmpId)) return;
    visited.add(st.tmpId);
    emitStep(st, parentTmp);
    const children = steps.filter((c) => c.parentTmpId === st.tmpId && !c.isJoinPoint);
    if (children.length > 1) {
      children.forEach((ch) => walk(ch, st.tmpId));
      if (st.joinTmpId) {
        const join = steps.find((s) => s.tmpId === st.joinTmpId);
        walk(join, st.tmpId);
      }
    } else if (children.length === 1) {
      walk(children[0], st.tmpId);
    }
  };

  steps.filter((s) => !s.parentTmpId && !s.isJoinPoint).forEach((s) => walk(s));

  Object.entries(forkJoinTmp).forEach(([forkTmp, joinTmp]) => {
    const forkId = tmpToStepId[forkTmp];
    const joinId = tmpToStepId[joinTmp];
    if (!forkId || !joinId) return;
    const forkStep = payload.steps.find((s) => s.id === forkId);
    if (forkStep) forkStep.joinStepId = joinId;
  });

  return { payload, tmpToStepId, tmpToSourceId, processId };
}

function processStructureFingerprint(catalogData, processId) {
  const procSteps = resolveStepTreeMetadata(
    catalogData.steps
      .filter((s) => s.processId === processId)
      .sort((a, b) => a.order - b.order),
  );
  if (!procSteps.length) return `${processId}:empty`;
  return procSteps.map((s) => [
    s.id, s.order, s.parentStepId || "", s.joinStepId || "", (s.pathLabel || "").trim(),
  ].join(":")).join("|");
}

function catalogProcessToCaptureState(catalogData, processId, prev = null) {
  const procStepsRaw = catalogData.steps
    .filter((s) => s.processId === processId)
    .sort((a, b) => a.order - b.order);

  const procSteps = procStepsRaw.length ? resolveStepTreeMetadata(procStepsRaw) : [];
  const procSources = catalogData.sources.filter((s) => s.processId === processId);
  const procRoles = catalogData.roles.filter((r) => r.processId === processId);
  const prevTmpById = {};
  if (prev?.steps) {
    prev.steps.forEach((s) => {
      if (s.persistedId) prevTmpById[s.persistedId] = s.tmpId;
    });
  }

  const stepIdMap = {};
  const newSteps = [];
  const newFields = [];
  const newStepRoles = [];

  procSteps.forEach((st) => {
    const src = procSources.find((s) => s.id === st.sourceId);
    const tmpId = prevTmpById[st.id] || uid();
    stepIdMap[st.id] = tmpId;
    newSteps.push({
      tmpId,
      persistedId: st.id,
      persistedSourceId: src?.id || null,
      persistedOrder: st.order ?? 0,
      parentTmpId: null,
      joinTmpId: null,
      isJoinPoint: !!st.isJoinPoint || isJoinStepRecord(st),
      name: st.name || "",
      kind: src ? src.kind : "erp",
      code: src ? src.code : "",
      where: src ? (src.where || "") : "",
      pathLabel: st.pathLabel || "",
      stepAreaId: st.stepAreaId || "",
    });
    if (src) {
      catalogData.fields.filter((f) => f.sourceId === src.id).forEach((f) => {
        newFields.push({
          tmpId: uid(), stepTmpId: tmpId,
          name: f.name || "", description: f.description || "",
          sensitive: f.sensitive || false, example: f.example || "",
        });
      });
    }
    procRoles.filter((r) => r.stepId === st.id).forEach((r) => {
      newStepRoles.push({
        tmpId: uid(), stepTmpId: tmpId, type: r.type || "owner",
        person: r.person || "", email: r.email || "",
      });
    });
  });

  procSteps.forEach((st) => {
    const ns = newSteps.find((s) => s.tmpId === stepIdMap[st.id]);
    if (!ns) return;
    ns.parentTmpId = st.parentStepId ? (stepIdMap[st.parentStepId] || null) : null;
    ns.joinTmpId = st.joinStepId ? (stepIdMap[st.joinStepId] || null) : null;
    ns.pathLabel = st.pathLabel || ns.pathLabel;
  });

  procRoles.filter((r) => !r.stepId).forEach((r) => {
    const firstTmpId = newSteps.length > 0 ? newSteps[0].tmpId : null;
    if (firstTmpId) {
      newStepRoles.push({
        tmpId: uid(), stepTmpId: firstTmpId, type: r.type || "owner",
        person: r.person || "", email: r.email || "",
      });
    }
  });

  return { steps: newSteps, fields: newFields, stepRoles: newStepRoles };
}

function reconcileCaptureWithCatalog(catalogData, processId, steps, fields, stepRoles, opts = {}) {
  const fromCatalog = catalogProcessToCaptureState(catalogData, processId, { steps, fields, stepRoles });
  const catalogIds = new Set(fromCatalog.steps.map((s) => s.persistedId).filter(Boolean));
  const localOnlySteps = steps.filter((s) => !s.persistedId);
  const localTmpIds = new Set(localOnlySteps.map((s) => s.tmpId));
  const remoteTs = processLastModifiedTs(catalogData, processId);
  const localPublishTs = opts.localPublishTs || 0;
  const keepPendingPersisted = localPublishTs > remoteTs;
  // Nunca re-agregar un paso que ya fue borrado remotamente (tombstone): de lo
  // contrario la eliminación de otro usuario "revive" desde el estado local.
  const deletedSet = new Set((catalogData.deletedIds || []).map((d) => d.id));
  const pendingPersisted = keepPendingPersisted
    ? steps.filter((s) => s.persistedId && !catalogIds.has(s.persistedId) && !deletedSet.has(s.persistedId))
    : [];
  const pendingTmpIds = new Set([
    ...localTmpIds,
    ...pendingPersisted.map((s) => s.tmpId),
  ]);

  return {
    steps: [...fromCatalog.steps, ...pendingPersisted, ...localOnlySteps],
    fields: [
      ...fromCatalog.fields,
      ...fields.filter((f) => pendingTmpIds.has(f.stepTmpId)),
    ],
    stepRoles: [
      ...fromCatalog.stepRoles,
      ...stepRoles.filter((r) => pendingTmpIds.has(r.stepTmpId)),
    ],
  };
}

function Capture({
  tenantId, data, t, areaColors, addArea, setAreaColor, saveProcessCapture,
  initialProcId, onInitialConsumed, entryNonce,
  sheetsUrl, collabApiSupported, collabSession, authUser,
  stepLocks, onRefreshLocks, remoteUpdateNotice, onApplyRemoteUpdate, onDismissRemoteUpdate,
  onCaptureCollabState,
}) {
  // "chooser" = pantalla de selección (nuevo vs. editar existente); "editor" = formulario.
  const [mode, setMode] = useState(initialProcId ? "editor" : "chooser");
  const [areaId, setAreaId] = useState("");
  const [subArea, setSubArea] = useState("");
  const [procName, setProcName] = useState("");
  const [trigger, setTrigger] = useState("");
  const [steps, setSteps] = useState([]);
  const [fields, setFields] = useState([]);
  const [stepRoles, setStepRoles] = useState([]); // {tmpId, stepTmpId, type, person, email}
  const [saved, setSaved] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [versionComment, setVersionComment] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [selectedStepTmpId, setSelectedStepTmpId] = useState(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState(null);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const draftTimerRef = useRef(null);
  const draftSnapshotRef = useRef({});
  const draftHydratedRef = useRef(false);
  const initialProcIdRef = useRef(initialProcId);
  const heldLockRef = useRef(null);
  const [lockNotice, setLockNotice] = useState(null);
  const skipNextPublishRef = useRef(false);
  const skipMergeRef = useRef(false);
  const workingCopyTimerRef = useRef(null);
  const [liveSyncAt, setLiveSyncAt] = useState(null);
  const [remoteStepsAdded, setRemoteStepsAdded] = useState(0);
  const lastRemoteStructureRef = useRef("");
  const localEditGenRef = useRef(0);
  const lastPublishedGenRef = useRef(0);
  const skipEditBumpRef = useRef(false);
  // true en cuanto el usuario hace algún cambio real en esta sesión de edición.
  // Sirve para subir la versión una sola vez, automáticamente, al terminar de editar.
  const sessionDirtyRef = useRef(false);
  const lastLocalPublishTsRef = useRef(0);
  const draftUserEmail = authUser?.email || collabSession?.email || "";

  const sessionId = collabSession?.sessionId || null;
  const identified = !!(authUser?.nombre && authUser?.email);

  const releaseHeldLock = useCallback(async () => {
    if (!sheetsUrl || !collabApiSupported || !sessionId || !heldLockRef.current) return;
    const { processId, stepId } = heldLockRef.current;
    heldLockRef.current = null;
    await releaseStepLockRemote(sheetsUrl, { sessionId, processId, stepId });
    onRefreshLocks?.();
  }, [sheetsUrl, collabApiSupported, sessionId, onRefreshLocks]);

  useEffect(() => () => {
    if (sheetsUrl && collabApiSupported && sessionId) {
      releaseSessionLocksRemote(sheetsUrl, sessionId);
    }
  }, [sheetsUrl, collabApiSupported, sessionId]);

  useEffect(() => {
    if (!collabApiSupported || !sheetsUrl || !sessionId || !selectedStepTmpId || !editingId) return;
    const timer = setInterval(() => {
      heartbeatLocksRemote(sheetsUrl, sessionId).then(() => onRefreshLocks?.());
    }, LOCK_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [collabApiSupported, sheetsUrl, sessionId, selectedStepTmpId, editingId, onRefreshLocks]);

  const handleSelectStep = async (tmpId, processIdOverride) => {
    const pid = processIdOverride || editingId;
    const st = steps.find((s) => s.tmpId === tmpId);
    if (!st || st.isJoinPoint) return;

    const stepId = stepLockStorageId(st);
    const lockKey = pid ? `${pid}:${stepId}` : null;

    if (collabApiSupported && pid && sheetsUrl && sessionId) {
      const existing = lockKey ? stepLocks?.[lockKey] : null;

      if (existing && existing.sessionId !== sessionId) {
        if (heldLockRef.current
          && (heldLockRef.current.processId !== pid || heldLockRef.current.stepId !== stepId)) {
          await releaseStepLockRemote(sheetsUrl, {
            sessionId,
            processId: heldLockRef.current.processId,
            stepId: heldLockRef.current.stepId,
          });
          heldLockRef.current = null;
          onRefreshLocks?.();
        }
        setLockNotice(null);
        setSelectedStepTmpId(tmpId);
        return;
      }

      if (heldLockRef.current
        && (heldLockRef.current.processId !== pid || heldLockRef.current.stepId !== stepId)) {
        await releaseStepLockRemote(sheetsUrl, {
          sessionId,
          processId: heldLockRef.current.processId,
          stepId: heldLockRef.current.stepId,
        });
      }
      const result = await acquireStepLockRemote(sheetsUrl, {
        sessionId,
        email: collabSession.email,
        usuario: collabSession.usuario,
        processId: pid,
        stepId,
      });
      if (result?.status === "locked") {
        const who = result.lock?.usuario || result.lock?.email || "Otro usuario";
        setLockNotice(null);
        setSelectedStepTmpId(tmpId);
        onRefreshLocks?.();
        return;
      }
      heldLockRef.current = { processId: pid, stepId };
      onRefreshLocks?.();
    }

    setLockNotice(null);
    setSelectedStepTmpId(tmpId);
  };

  useEffect(() => {
    if (!selectedStepTmpId || !editingId || !sessionId) return;
    const st = steps.find((s) => s.tmpId === selectedStepTmpId);
    if (!st) return;
    const stepId = stepLockStorageId(st);
    const lock = stepLocks?.[`${editingId}:${stepId}`];
    if (lock && lock.sessionId !== sessionId && heldLockRef.current?.stepId === stepId) {
      const who = lock.usuario || lock.email || "Otro usuario";
      setLockNotice(`${who} tomó la edición de este paso. Solo lectura.`);
      heldLockRef.current = null;
    }
  }, [stepLocks, selectedStepTmpId, editingId, sessionId, steps]);

  const publishWorkingCopy = useCallback((force = false) => {
    if (!force && skipNextPublishRef.current) {
      skipNextPublishRef.current = false;
      return;
    }
    if (!areaId || !procName.trim()) return;
    if (!steps.length && !editingId) return;

    let procId = editingId;
    if (!procId) {
      procId = uid();
      setEditingId(procId);
    }

    // No re-publicar pasos ya borrados remotamente (tombstone): evita que el autosave
    // "reviva" un paso que otro usuario eliminó, si dispara antes de limpiarlo del form.
    const tombSet = new Set((data.deletedIds || []).map((d) => d.id));
    const pubSteps = steps.filter((s) => !(s.persistedId && tombSet.has(s.persistedId)));
    const pubStepTmpIds = new Set(pubSteps.map((s) => s.tmpId));
    const pubFields = fields.filter((f) => pubStepTmpIds.has(f.stepTmpId));
    const pubStepRoles = stepRoles.filter((r) => pubStepTmpIds.has(r.stepTmpId));

    const proc = data.processes.find((p) => p.id === procId) || null;
    const { payload, tmpToStepId, tmpToSourceId } = buildCaptureProcessPayload({
      areaId, subArea, procName, trigger, steps: pubSteps, fields: pubFields, stepRoles: pubStepRoles,
      editingId: procId, editingProc: proc, bumpVersion: false, versionComment: "",
      authUser, collabSession,
    });
    const tmpToOrder = {};
    payload.steps.forEach((s) => {
      const tmp = Object.entries(tmpToStepId).find(([, id]) => id === s.id)?.[0];
      if (tmp) tmpToOrder[tmp] = s.order;
    });

    const activeProcSteps = data.steps.filter((s) => s.processId === procId);
    const currentPersistedStepIds = new Set(steps.map((s) => s.persistedId).filter(Boolean));
    const deletedPersistedStepIds = activeProcSteps
      .filter((s) => !currentPersistedStepIds.has(s.id))
      .map((s) => s.id);

    const activeProcSources = data.sources.filter((s) => s.processId === procId);
    const activeProcSourceIds = new Set(activeProcSources.map((s) => s.id));
    
    const activeProcFields = data.fields.filter((f) => activeProcSourceIds.has(f.sourceId));
    const currentPersistedFieldIds = new Set(fields.map((f) => f.persistedId).filter(Boolean));
    const deletedPersistedFieldIds = activeProcFields
      .filter((f) => !currentPersistedFieldIds.has(f.id))
      .map((f) => f.id);

    const activeProcRoles = data.roles.filter((r) => r.processId === procId);
    const currentPersistedRoleIds = new Set(stepRoles.map((r) => r.persistedId).filter(Boolean));
    const deletedPersistedRoleIds = activeProcRoles
      .filter((r) => !currentPersistedRoleIds.has(r.id))
      .map((r) => r.id);

    const deletedIds = [
      ...deletedPersistedStepIds,
      ...deletedPersistedFieldIds,
      ...deletedPersistedRoleIds,
    ];

    saveProcessCapture(payload, procId, deletedIds);
    skipMergeRef.current = true;
    skipEditBumpRef.current = true;
    // Solo re-escribir steps si algún persistedId/sourceId/orden cambió realmente.
    // Si no, evitamos un setSteps con arrays nuevos que re-armaría el timer de
    // autosave en bucle (y mantendría skipMergeRef casi siempre activo, bloqueando
    // la reconciliación de cambios remotos).
    const needsIdSync = steps.some((st) =>
      (tmpToStepId[st.tmpId] && tmpToStepId[st.tmpId] !== st.persistedId)
      || (tmpToSourceId[st.tmpId] && tmpToSourceId[st.tmpId] !== st.persistedSourceId)
      || (tmpToOrder[st.tmpId] != null && tmpToOrder[st.tmpId] !== st.persistedOrder));
    if (needsIdSync) {
      setSteps((s) => s.map((st) => ({
        ...st,
        persistedId: tmpToStepId[st.tmpId] || st.persistedId,
        persistedSourceId: tmpToSourceId[st.tmpId] || st.persistedSourceId,
        persistedOrder: tmpToOrder[st.tmpId] ?? st.persistedOrder,
      })));
    } else {
      skipMergeRef.current = false;
    }
    lastPublishedGenRef.current = localEditGenRef.current;
    lastLocalPublishTsRef.current = Date.now();
    setLiveSyncAt(new Date().toISOString());
  }, [
    areaId, procName, steps, fields, stepRoles, editingId, subArea, trigger,
    data, saveProcessCapture, authUser, collabSession,
  ]);

  const flushWorkingCopyNow = useCallback(() => {
    if (workingCopyTimerRef.current) {
      clearTimeout(workingCopyTimerRef.current);
      workingCopyTimerRef.current = null;
    }
    publishWorkingCopy(true);
  }, [publishWorkingCopy]);

  useEffect(() => {
    onCaptureCollabState?.({
      editingId,
      pendingLocal: localEditGenRef.current > lastPublishedGenRef.current,
      localPublishTs: lastLocalPublishTsRef.current,
    });
  }, [editingId, steps, fields, stepRoles, liveSyncAt, onCaptureCollabState]);

  useEffect(() => {
    if (!draftHydrated) return;
    if (skipEditBumpRef.current) {
      skipEditBumpRef.current = false;
      return;
    }
    if (!steps.length && !fields.length && !stepRoles.length) return;
    localEditGenRef.current += 1;
    sessionDirtyRef.current = true;
  }, [draftHydrated, steps, fields, stepRoles]);

  useEffect(() => {
    if (!draftHydrated || !areaId || !procName.trim()) return;
    // El flujo nuevo no se sincroniza solo: se publica en el primer «Crear flujo»
    // (flushWorkingCopyNow). Una vez que existe editingId, todo es transparente.
    if (!editingId) return;
    if (!steps.length) return;
    if (workingCopyTimerRef.current) clearTimeout(workingCopyTimerRef.current);
    workingCopyTimerRef.current = setTimeout(() => {
      workingCopyTimerRef.current = null;
      publishWorkingCopy();
    }, WORKING_COPY_SYNC_MS);
    return () => {
      if (workingCopyTimerRef.current) clearTimeout(workingCopyTimerRef.current);
    };
  }, [
    draftHydrated, areaId, subArea, procName, trigger, steps, fields, stepRoles,
    editingId, publishWorkingCopy,
  ]);

  useEffect(() => {
    if (!editingId || !draftHydrated) return;
    if (skipMergeRef.current) {
      // Saltamos ESTE ciclo (fue nuestro propio publish), pero NO tocamos
      // lastRemoteStructureRef: si el setData en realidad vino de un applyRemoteCatalog
      // con cambios de otro usuario, marcar aquí la estructura remota bloquearía la
      // reconciliación para siempre. Dejarlo permite que el siguiente ciclo la aplique.
      skipMergeRef.current = false;
      return;
    }
    const fp = processStructureFingerprint(data, editingId);
    if (fp === lastRemoteStructureRef.current) return;

    // ¿El remoto agregó pasos a ESTE flujo que aún no tenemos en el formulario?
    // Si es así, reconciliamos siempre (union seguro que conserva lo local): es el
    // caso "otro usuario insertó un paso y no lo veo". Solo cuando NO hay pasos
    // remotos nuevos aplicamos los guards que evitan pisar edición de texto en curso.
    const remoteStepIdsForProc = new Set(
      data.steps.filter((s) => s.processId === editingId).map((s) => s.id),
    );
    const formPersistedIds = new Set(steps.map((s) => s.persistedId).filter(Boolean));
    const remoteAddedSteps = [...remoteStepIdsForProc].some((id) => !formPersistedIds.has(id));
    // ¿Algún paso que tengo en el formulario fue borrado remotamente (tombstone)?
    const deletedSet = new Set((data.deletedIds || []).map((d) => d.id));
    const remoteRemovedSteps = steps.some((s) => s.persistedId && deletedSet.has(s.persistedId));

    if (!remoteAddedSteps && !remoteRemovedSteps) {
      if (localEditGenRef.current > lastPublishedGenRef.current) {
        const remoteTs = processLastModifiedTs(data, editingId);
        const hasLocalOnly = steps.some((s) => !s.persistedId);
        if (hasLocalOnly || lastLocalPublishTsRef.current >= remoteTs) return;
      }

      const hasUnpublished = localEditGenRef.current > lastPublishedGenRef.current;
      if (hasUnpublished) {
        const remoteStepIds = remoteStepIdsForProc;
        const hasLocalOnly = steps.some((s) => !s.persistedId
          || (s.persistedId && !remoteStepIds.has(s.persistedId)));
        if (hasLocalOnly) {
          if (liveSyncAt) {
            const remoteTs = processLastModifiedTs(data, editingId);
            const publishTs = Date.parse(liveSyncAt);
            if (!Number.isNaN(publishTs) && remoteTs <= publishTs) return;
          } else {
            return;
          }
        }
      }
    }

    const merged = reconcileCaptureWithCatalog(data, editingId, steps, fields, stepRoles, {
      localPublishTs: lastLocalPublishTsRef.current,
    });
    const prevCount = steps.filter((s) => s.persistedId).length;
    const nextCount = merged.steps.filter((s) => s.persistedId).length;

    skipNextPublishRef.current = true;
    skipEditBumpRef.current = true;
    lastRemoteStructureRef.current = fp;
    lastPublishedGenRef.current = localEditGenRef.current;
    setSteps(merged.steps);
    setFields(merged.fields);
    setStepRoles(merged.stepRoles);

    const added = nextCount - prevCount;
    if (added > 0) {
      setRemoteStepsAdded((n) => n + added);
      setTimeout(() => setRemoteStepsAdded(0), 5000);
    } else if (prevCount > nextCount) {
      setRemoteStepsAdded(-2);
      setTimeout(() => setRemoteStepsAdded(0), 4000);
    } else if (prevCount > 0 && nextCount > 0) {
      setRemoteStepsAdded(-1);
      setTimeout(() => setRemoteStepsAdded(0), 4000);
    }
  }, [data, editingId, draftHydrated]);

  // Efecto dedicado y determinista para ELIMINACIONES remotas: independiente de la
  // maquinaria de merge/skip. Si el catálogo trae un tombstone para un paso que este
  // formulario todavía muestra, lo quita (y sus campos/roles) y evita re-publicarlo.
  useEffect(() => {
    if (!editingId) return;
    const deletedSet = new Set((data.deletedIds || []).map((d) => d.id));
    if (!deletedSet.size) return;
    const removedTmpIds = new Set(
      steps.filter((s) => s.persistedId && deletedSet.has(s.persistedId)).map((s) => s.tmpId),
    );
    if (!removedTmpIds.size) return;
    skipNextPublishRef.current = true;
    skipEditBumpRef.current = true;
    lastPublishedGenRef.current = localEditGenRef.current;
    setSteps((arr) => arr.filter((s) => !removedTmpIds.has(s.tmpId)));
    setFields((arr) => arr.filter((f) => !removedTmpIds.has(f.stepTmpId)));
    setStepRoles((arr) => arr.filter((r) => !removedTmpIds.has(r.stepTmpId)));
    setSelectedStepTmpId((cur) => (removedTmpIds.has(cur) ? null : cur));
    setRemoteStepsAdded(-2);
    setTimeout(() => setRemoteStepsAdded(0), 4000);
  }, [data, editingId, steps]);

  useEffect(() => { initialProcIdRef.current = initialProcId; }, [initialProcId]);

  draftSnapshotRef.current = {
    areaId, subArea, procName, trigger, steps, fields, stepRoles,
    editingId, selectedStepTmpId, versionComment,
  };

  useEffect(() => {
    if (!initialProcId) return;
    loadProcess(initialProcId);
    setMode("editor");
    onInitialConsumed?.();
    setDraftRestored(false);
    setDraftHydrated(true);
    draftHydratedRef.current = true;
  }, [initialProcId]);

  // Al entrar a Documentar desde el menú, volver siempre a la pantalla de selección.
  useEffect(() => {
    if (!entryNonce) return;
    if (initialProcIdRef.current) return;
    setMode("chooser");
  }, [entryNonce]);

  useEffect(() => {
    if (initialProcId) return;

    let cancelled = false;
    (async () => {
      const draft = await loadCaptureDraft(tenantId, draftUserEmail);
      if (cancelled || initialProcIdRef.current) {
        if (!cancelled) {
          setDraftHydrated(true);
          draftHydratedRef.current = true;
        }
        return;
      }
      if (captureDraftHasContent(draft)) {
        setAreaId(draft.areaId || "");
        setSubArea(draft.subArea || "");
        setProcName(draft.procName || "");
        setTrigger(draft.trigger || "");
        setSteps(draft.steps || []);
        setFields(draft.fields || []);
        setStepRoles(draft.stepRoles || []);
        setEditingId(draft.editingId || null);
        setSelectedStepTmpId(draft.selectedStepTmpId || draft.steps?.[0]?.tmpId || null);
        setVersionComment(draft.versionComment || "");
        setDraftRestored(true);
        if (draft.savedAt) setDraftSavedAt(draft.savedAt);
      }
      setDraftHydrated(true);
      draftHydratedRef.current = true;
    })();
    return () => { cancelled = true; };
  }, [tenantId]);

  useEffect(() => {
    if (!draftHydrated) return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      const draft = draftSnapshotRef.current;
      saveCaptureDraft(tenantId, draft, draftUserEmail).then(() => {
        if (captureDraftHasContent(draft)) setDraftSavedAt(new Date().toISOString());
      });
    }, 400);
    return () => { if (draftTimerRef.current) clearTimeout(draftTimerRef.current); };
  }, [draftHydrated, tenantId, draftUserEmail, areaId, subArea, procName, trigger, steps, fields, stepRoles, editingId, selectedStepTmpId, versionComment]);

  useEffect(() => {
    if (!draftHydrated) return;
    const flushDraft = () => { saveCaptureDraft(tenantId, draftSnapshotRef.current, draftUserEmail); };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushDraft();
    };
    window.addEventListener("beforeunload", flushDraft);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", flushDraft);
      document.removeEventListener("visibilitychange", onVisibility);
      flushDraft();
    };
  }, [draftHydrated, tenantId, draftUserEmail]);

  const color = areaColors[areaId] || t.primary;
  const canSave = areaId && procName.trim();
  const editingProc = editingId ? data.processes.find((p) => p.id === editingId) : null;
  const currentVersion = editingProc ? (editingProc.version || 1) : 0;
  const versionHistory = editingProc ? (editingProc.versionHistory || []) : [];

  // Cargar proceso existente al formulario
  const loadProcess = (procId) => {
    const proc = data.processes.find((p) => p.id === procId);
    if (!proc) return;
    setEditingId(procId);
    setAreaId(proc.areaId || "");
    setSubArea(proc.subArea || "");
    setProcName(proc.name || "");
    setTrigger(proc.trigger || "");
    const built = catalogProcessToCaptureState(data, procId);
    lastRemoteStructureRef.current = processStructureFingerprint(data, procId);
    skipEditBumpRef.current = true;
    lastPublishedGenRef.current = localEditGenRef.current;
    setSteps(built.steps);
    setFields(built.fields);
    setStepRoles(built.stepRoles);
    const firstTmp = built.steps[0]?.tmpId || null;
    if (firstTmp && collabApiSupported && sheetsUrl) {
      setTimeout(() => handleSelectStep(firstTmp, procId), 0);
    } else {
      setSelectedStepTmpId(firstTmp);
    }
  };

  const clearForm = async () => {
    // Al terminar de editar, sube la versión una vez si hubo cambios (transparente).
    commitVersionIfDirty();
    await releaseHeldLock();
    if (sheetsUrl && collabApiSupported && sessionId) {
      releaseSessionLocksRemote(sheetsUrl, sessionId);
    }
    heldLockRef.current = null;
    sessionDirtyRef.current = false;
    setEditingId(null); setAreaId(""); setSubArea(""); setProcName("");
    setTrigger(""); setSteps([]); setFields([]); setStepRoles([]);
    setVersionComment(""); setShowHistory(false); setSelectedStepTmpId(null);
    setDraftRestored(false); setDraftSavedAt(null);
    clearCaptureDraft(tenantId, draftUserEmail);
    setMode("chooser");
  };

  // Empieza un flujo nuevo desde cero (limpia cualquier borrador previo).
  const startNewFlow = async () => {
    await releaseHeldLock();
    heldLockRef.current = null;
    sessionDirtyRef.current = false;
    setEditingId(null); setAreaId(""); setSubArea(""); setProcName("");
    setTrigger(""); setSteps([]); setFields([]); setStepRoles([]);
    setVersionComment(""); setShowHistory(false); setSelectedStepTmpId(null);
    setDraftRestored(false); setDraftSavedAt(null);
    clearCaptureDraft(tenantId, draftUserEmail);
    draftHydratedRef.current = true;
    setDraftHydrated(true);
    setMode("editor");
  };

  // Abre un flujo existente para editarlo.
  const editExistingFlow = (procId) => {
    loadProcess(procId);
    draftHydratedRef.current = true;
    setDraftHydrated(true);
    setMode("editor");
  };

  const addStepRow = (parentTmpId) => {
    const newId = uid();
    setSteps((s) => [...s,
      { tmpId: newId, parentTmpId: parentTmpId || null, joinTmpId: null, name: "", kind: "erp",
        code: "", where: "", pathLabel: "", stepAreaId: "" }]);
    setSelectedStepTmpId(newId);
    setTimeout(() => flushWorkingCopyNow(), 0);
  };

  const insertStepAfter = (afterTmpId) => {
    const newId = uid();
    const directChild = steps.find((s) => s.parentTmpId === afterTmpId && !s.isJoinPoint);
    setSteps((s) => {
      const updated = directChild
        ? s.map((x) => x.tmpId === directChild.tmpId ? { ...x, parentTmpId: newId } : x)
        : s;
      return [...updated, {
        tmpId: newId, parentTmpId: afterTmpId, joinTmpId: null, name: "", kind: "erp",
        code: "", where: "", pathLabel: "", stepAreaId: "",
      }];
    });
    setSelectedStepTmpId(newId);
    setTimeout(() => flushWorkingCopyNow(), 0);
  };

  const addBranchFrom = (parentTmpId) => {
    const children = treeChildrenOf(steps, parentTmpId);
    const newOnes = children.length === 0
      ? [{ tmpId: uid(), parentTmpId, joinTmpId: null, name: "", kind: "erp", code: "", where: "", pathLabel: "Camino A", stepAreaId: "" },
         { tmpId: uid(), parentTmpId, joinTmpId: null, name: "", kind: "erp", code: "", where: "", pathLabel: "Camino B", stepAreaId: "" }]
      : [{ tmpId: uid(), parentTmpId, joinTmpId: null, name: "", kind: "erp", code: "", where: "",
          pathLabel: "Camino " + String.fromCharCode(65 + children.length), stepAreaId: "" }];
    setSteps((s) => [...s, ...newOnes]);
    setSelectedStepTmpId(newOnes[newOnes.length - 1].tmpId);
  };

  const addConvergence = (forkTmpId) => {
    const newId = uid();
    setSteps((s) => [
      ...s.map((x) => x.tmpId === forkTmpId ? { ...x, joinTmpId: newId } : x),
      { tmpId: newId, parentTmpId: forkTmpId, joinTmpId: null, isJoinPoint: true,
        name: "Unión de ramas", kind: "erp", code: "", where: "", pathLabel: "", stepAreaId: "" },
    ]);
    setSelectedStepTmpId(newId);
  };
  const updStep = (id, k, v) => setSteps((s) => s.map((x) => x.tmpId === id ? { ...x, [k]: v } : x));
  const rmStep = (id) => {
    const toRemove = new Set();
    const collect = (pid) => {
      toRemove.add(pid);
      steps.filter((s) => s.parentTmpId === pid).forEach((s) => collect(s.tmpId));
      const st = steps.find((s) => s.tmpId === pid);
      if (st?.joinTmpId) collect(st.joinTmpId);
    };
    collect(id);
    setSteps((s) => s
      .filter((x) => !toRemove.has(x.tmpId))
      .map((x) => (x.joinTmpId && toRemove.has(x.joinTmpId) ? { ...x, joinTmpId: null } : x)));
    setFields((f) => f.filter((x) => !toRemove.has(x.stepTmpId)));
    setStepRoles((r) => r.filter((x) => !toRemove.has(x.stepTmpId)));
    if (toRemove.has(selectedStepTmpId)) {
      const remaining = steps.filter((x) => !toRemove.has(x.tmpId));
      setSelectedStepTmpId(remaining[0]?.tmpId || null);
    }
    setTimeout(() => flushWorkingCopyNow(), 0);
  };
  const addFieldRow = (stepTmpId) => setFields((f) => [...f,
    { tmpId: uid(), stepTmpId, name: "", description: "", sensitive: false, example: "" }]);
  const updField = (id, k, v) => setFields((f) => f.map((x) => x.tmpId === id ? { ...x, [k]: v } : x));
  const rmField = (id) => setFields((f) => f.filter((x) => x.tmpId !== id));

  const importHeader = (stepTmpId, file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
        if (!matrix.length) return;
        const headers = (matrix[0] || []).map((h) => String(h).trim());
        // Detectar formato: si las cabeceras son "Campo","Descripción","Ejemplo" → formato estructurado
        const lowerHeaders = headers.map((h) => h.toLowerCase());
        const hasStructured = lowerHeaders.some((h) => h.includes("campo") || h.includes("columna"))
          && lowerHeaders.some((h) => h.includes("descrip") || h.includes("significado"));
        let newRows;
        if (hasStructured) {
          // Formato estructurado: cada fila es un campo
          const colField = lowerHeaders.findIndex((h) => h.includes("campo") || h.includes("columna"));
          const colDesc = lowerHeaders.findIndex((h) => h.includes("descrip") || h.includes("significado"));
          const colEx = lowerHeaders.findIndex((h) => h.includes("ejemplo") || h.includes("dummy") || h.includes("sample"));
          const colSens = lowerHeaders.findIndex((h) => h.includes("sensible") || h.includes("sensitive"));
          newRows = matrix.slice(1).filter((row) => row[colField]).map((row) => ({
            tmpId: uid(), stepTmpId,
            name: String(row[colField] || "").trim(),
            description: colDesc >= 0 ? String(row[colDesc] || "").trim() : "",
            example: colEx >= 0 ? String(row[colEx] || "").trim() : "",
            sensitive: colSens >= 0 ? /^s[ií]/i.test(String(row[colSens] || "").trim()) : false,
          }));
        } else {
          // Formato libre: cabeceras = nombres de campo, fila 1 = ejemplo
          const sample = matrix[1] || [];
          newRows = headers.filter(Boolean).map((h, i) => ({
            tmpId: uid(), stepTmpId, name: h,
            description: "", sensitive: false,
            example: sample[i] != null ? String(sample[i]) : "",
          }));
        }
        setFields((f) => [...f.filter((x) => x.stepTmpId !== stepTmpId || x.name.trim()), ...newRows]);
      } catch (err) { /* ignore */ }
    };
    reader.readAsArrayBuffer(file);
  };

  // Primer guardado explícito de un flujo nuevo: lo persiste una vez y deja al
  // usuario dentro del editor (ya con editingId). A partir de ahí todo es en vivo.
  const createFlow = () => {
    flushWorkingCopyNow();
    sessionDirtyRef.current = false;
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  // Sube la versión una sola vez al terminar de editar un flujo existente,
  // solo si hubo cambios reales en esta sesión. Mantiene el mismo id de proceso.
  const commitVersionIfDirty = () => {
    if (!editingId || !sessionDirtyRef.current) return;
    const editingProcForSave = data.processes.find((p) => p.id === editingId) || null;
    const { payload } = buildCaptureProcessPayload({
      areaId, subArea, procName, trigger, steps, fields, stepRoles,
      editingId, editingProc: editingProcForSave, bumpVersion: true,
      versionComment, authUser, collabSession,
    });
    saveProcessCapture(payload, editingId);
    sessionDirtyRef.current = false;
    lastPublishedGenRef.current = localEditGenRef.current;
  };

  const processArea = data.areas.find((a) => a.id === areaId);
  const childrenOf = (id) => treeChildrenOf(steps, id);
  const rootSteps = sortFlowRoots(steps);

  const stepOrderMap = useMemo(() => buildStepOrderMap(steps), [steps]);

  const buildFlowCard = (st) => {
    const stepArea = st.stepAreaId ? data.areas.find((a) => a.id === st.stepAreaId) : null;
    const stepColor = tmpStepColor(st, areaId, areaColors, color, data.areas);
    const siblings = st.parentTmpId ? childrenOf(st.parentTmpId) : rootSteps;
    return {
      step: { name: st.name || (st.isJoinPoint ? "Unión" : `Paso ${(stepOrderMap[st.tmpId] || 0) + 1}`) },
      src: st.code ? { code: st.code, kind: st.kind || "erp" } : null,
      stepFields: fields.filter((f) => f.stepTmpId === st.tmpId && f.name.trim()),
      stepRoles: stepRoles.filter((r) => r.stepTmpId === st.tmpId),
      stepArea,
      stepColor,
      isUngoverned: st.kind === "file",
      pathLabel: siblings.length > 1 && !st.isJoinPoint
        ? (st.pathLabel || `Camino ${String.fromCharCode(65 + siblings.indexOf(st))}`) : null,
      index: stepOrderMap[st.tmpId] || 0,
    };
  };

  const selectedStep = steps.find((s) => s.tmpId === selectedStepTmpId);
  const selectedIndex = stepOrderMap[selectedStepTmpId] ?? 0;
  const selectedSiblings = selectedStep
    ? (selectedStep.parentTmpId ? childrenOf(selectedStep.parentTmpId) : rootSteps)
    : [];

  const collabSummary = summarizeProcessCollab(editingId, stepLocks, steps, sessionId);
  const selectedStepLock = selectedStep && editingId
    ? stepLocks?.[`${editingId}:${stepLockStorageId(selectedStep)}`] : null;
  const selectedStepReadOnly = !!(selectedStepLock && selectedStepLock.sessionId !== sessionId);
  const selectedLockHolder = selectedStepReadOnly ? lockEditorLabel(selectedStepLock) : null;

  const remoteConflictMajor = !!(remoteUpdateNotice?.payload && editingId && editingProc && (() => {
    const remoteProc = remoteUpdateNotice.payload.data?.processes?.find((p) => p.id === editingId);
    if (!remoteProc) return false;
    const remoteVer = Number(remoteProc.version) || 0;
    const localVer = Number(editingProc.version) || 0;
    if (remoteVer > localVer) return true;
    const remoteTs = remoteProc.lastModified || remoteProc.updatedAt || "";
    const localTs = editingProc.lastModified || editingProc.updatedAt || "";
    return remoteTs && localTs && remoteTs > localTs;
  })());

  if (mode === "chooser") {
    const hasDraft = !!(procName.trim() || steps.length);
    const procList = [...data.processes].sort((a, b) => {
      const ta = a.lastModified || "", tb = b.lastModified || "";
      return tb.localeCompare(ta);
    });
    return (
      <div>
        <Header title="Documentar"
          sub="Crea un flujo nuevo o continúa editando uno existente."
          t={t} />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 18 }}>
          <div onClick={startNewFlow} className="interactive-hover"
            style={{ background: t.surfaceSolid, border: `1px solid ${t.primary}55`, borderRadius: 14,
              padding: 20, cursor: "pointer", display: "flex", gap: 14, alignItems: "center" }}>
            <div style={{ width: 42, height: 42, borderRadius: 11, background: t.primary + "1a",
              display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Plus size={22} color={t.primary} />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: t.text }}>Crear un flujo nuevo</div>
              <div style={{ fontSize: 12, color: t.textDim, marginTop: 2 }}>Empieza desde cero un proceso.</div>
            </div>
          </div>

          {hasDraft && (
            <div onClick={() => setMode("editor")} className="interactive-hover"
              style={{ background: t.surfaceSolid, border: `1px solid ${t.border}`, borderRadius: 14,
                padding: 20, cursor: "pointer", display: "flex", gap: 14, alignItems: "center" }}>
              <div style={{ width: 42, height: 42, borderRadius: 11, background: "#F5A62322",
                display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <FileText size={20} color="#F5A623" />
              </div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600, color: t.text }}>Continuar borrador</div>
                <div style={{ fontSize: 12, color: t.textDim, marginTop: 2 }}>
                  {procName.trim() || "Sin nombre"} · {steps.length} paso{steps.length === 1 ? "" : "s"}
                </div>
              </div>
            </div>
          )}
        </div>

        <div style={{ fontSize: 12, fontWeight: 600, color: t.textDim, marginBottom: 10, letterSpacing: "0.02em" }}>
          EDITAR UN FLUJO EXISTENTE
        </div>
        {procList.length === 0 ? (
          <div style={{ background: t.surfaceSolid, border: `1px dashed ${t.border}`, borderRadius: 12,
            padding: 24, textAlign: "center", color: t.textFaint, fontSize: 13 }}>
            Aún no hay flujos documentados. Crea el primero arriba.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {procList.map((p) => {
              const area = data.areas.find((a) => a.id === p.areaId);
              const stepCount = data.steps.filter((s) => s.processId === p.id).length;
              const areaColor = areaColors[p.areaId] || t.primary;
              return (
                <div key={p.id} onClick={() => editExistingFlow(p.id)} className="interactive-hover"
                  style={{ background: t.surfaceSolid, border: `1px solid ${t.border}`, borderRadius: 11,
                    padding: "12px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 99, background: areaColor, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: t.text, overflow: "hidden",
                      textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name || "Sin nombre"}</div>
                    <div style={{ fontSize: 11.5, color: t.textFaint, marginTop: 1 }}>
                      {area ? area.name : "Sin área"}{p.subArea ? " · " + p.subArea : ""} · {stepCount} paso{stepCount === 1 ? "" : "s"} · v{p.version || 1}
                    </div>
                  </div>
                  <ChevronRight size={16} color={t.textFaint} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <Header title={editingId
          ? procName + " · v" + currentVersion
          : "Documentar un proceso"}
        sub={editingId ? "Editando v" + currentVersion + ". Ramas en paralelo (vertical); usa «Unir ramas» para converger."
          : "Icono rama = caminos paralelos · botón «Unir ramas» = punto donde vuelven a juntarse."}
        t={t}
        action={<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {editingId ? (
            <>
              <span style={{ fontSize: 12, color: t.textFaint, display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 7, height: 7, borderRadius: 99, background: "#34A853", boxShadow: "0 0 6px #34A853" }} />
                {sheetsUrl
                  ? (liveSyncAt ? "Guardado " + formatRelativeTime(liveSyncAt) : "Guardado automático")
                  : "Guardado local"}
              </span>
              <Btn t={t} variant="ghost" onClick={clearForm}>
                <Check size={15} /> Terminar</Btn>
            </>
          ) : (
            <Btn t={t} onClick={(canSave && steps.length) ? createFlow : undefined}
              disabled={!canSave || !steps.length}>
              <Check size={16} /> Crear flujo</Btn>
          )}
        </div>} />

      {identified && (
        <div style={{ fontSize: 11, color: t.textFaint, marginBottom: 10, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ width: 6, height: 6, borderRadius: 99, background: "#34A853", boxShadow: "0 0 6px #34A853" }} />
          Sesión: <strong style={{ color: t.textDim, fontWeight: 600 }}>{authUser.nombre}</strong>
          {collabApiSupported && sheetsUrl ? " · sync en vivo activo" : sheetsUrl ? " · sync en vivo (actualiza Apps Script para bloqueo de pasos)" : ""}
          {liveSyncAt && sheetsUrl && (
            <span style={{ color: t.textFaint }}>· compartido {formatRelativeTime(liveSyncAt)}</span>
          )}
        </div>
      )}

      {remoteStepsAdded > 0 && (
        <div className="collab-remote-steps-notice">
          <RefreshCw size={14} />
          {remoteStepsAdded === 1
            ? "Otro usuario agregó un paso — ya aparece en el flujo"
            : `Otro usuario agregó ${remoteStepsAdded} pasos — ya aparecen en el flujo`}
        </div>
      )}
      {remoteStepsAdded === -2 && (
        <div className="collab-remote-steps-notice collab-remote-steps-notice-warn">
          <RefreshCw size={14} />
          Otro usuario eliminó pasos — el flujo se actualizó
        </div>
      )}
      {remoteStepsAdded === -1 && (
        <div className="collab-remote-steps-notice">
          <RefreshCw size={14} />
          El flujo se actualizó para coincidir con la versión compartida (orden y ramas)
        </div>
      )}

      {(draftRestored || draftSavedAt) && (
        <div style={{
          background: t.primary + "12", border: `1px solid ${t.primary}40`, color: t.text,
          borderRadius: 10, padding: "10px 14px", marginBottom: 14, fontSize: 13,
          display: "flex", alignItems: "center", gap: 8, lineHeight: 1.45,
        }}>
          <FileText size={15} color={t.primary} style={{ flexShrink: 0 }} />
          <div>
            {draftRestored && <strong>Se restauró tu borrador.</strong>}
            {draftRestored && draftSavedAt ? " " : null}
            {draftSavedAt && (
              <span>Último guardado automático: {formatDraftTime(draftSavedAt)}.</span>
            )}
            {" "}Puedes ir al mapa de relaciones u otra sección sin perder tu avance.
          </div>
        </div>
      )}

      {editingId && (
        <div style={{ background: t.primary + "0D", border: "1px solid " + t.primary + "33", borderRadius: 10,
          padding: "12px 16px", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <FileText size={15} color={t.primary} />
            <span style={{ fontSize: 13, fontWeight: 600, color: t.text }}>Editando v{currentVersion}</span>
            {versionHistory.length > 0 && (
              <span onClick={() => setShowHistory(!showHistory)} style={{ fontSize: 12, color: t.primary,
                cursor: "pointer", fontWeight: 500, marginLeft: "auto" }}>
                {showHistory ? "Ocultar historial" : "Ver historial (" + versionHistory.length + ")"}</span>
            )}
            <span onClick={clearForm} style={{ fontSize: 12, color: t.textFaint, cursor: "pointer",
              marginLeft: versionHistory.length > 0 ? 0 : "auto" }}>Cancelar</span>
          </div>
          <input placeholder="¿Qué cambió en esta versión?"
            value={versionComment} onChange={(e) => setVersionComment(e.target.value)}
            style={{ ...inputStyle(t), fontSize: 13, background: t.surfaceSolid }} />
          {showHistory && versionHistory.length > 0 && (
            <div style={{ marginTop: 10, borderTop: "1px solid " + t.border, paddingTop: 10 }}>
              {versionHistory.slice().reverse().map((v, i) => (
                <div key={i} style={{ display: "flex", gap: 10, fontSize: 12.5, marginBottom: 6 }}>
                  <span style={{ fontWeight: 700, color: t.primary, minWidth: 28 }}>v{v.version}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: t.textDim }}>{v.comment}</div>
                    {(v.authorName || v.authorEmail) && (
                      <div style={{ fontSize: 11, color: t.textFaint, marginTop: 2 }}>
                        {v.authorName || v.authorEmail}
                        {v.authorName && v.authorEmail ? ` · ${v.authorEmail}` : ""}
                        {v.date ? ` · ${new Date(v.date).toLocaleString()}` : ""}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!editingId && data.processes.length > 0 && (
        <div style={{ background: t.surfaceAlt, border: "1px solid " + t.border, borderRadius: 10,
          padding: "12px 16px", marginBottom: 16, display: "flex", alignItems: "center", gap: 12 }}>
          <FileText size={16} color={t.textDim} />
          <div style={{ fontSize: 13, color: t.textDim, fontWeight: 500 }}>¿Editar uno existente?</div>
          <select onChange={(e) => { if (e.target.value) loadProcess(e.target.value); }}
            value="" style={{ ...inputStyle(t), flex: 1, maxWidth: 340, cursor: "pointer", fontSize: 13 }}>
            <option value="">Seleccionar proceso…</option>
            {data.processes.map((p) => {
              const a = data.areas.find((ar) => ar.id === p.areaId);
              return <option key={p.id} value={p.id}>{a ? a.name + " — " : ""}{p.name}</option>;
            })}
          </select>
        </div>
      )}

      {saved && (
        <div style={{ background: t.primary + "1A", border: "1px solid " + t.primary + "55", color: t.text,
          borderRadius: 10, padding: "11px 15px", marginBottom: 16, fontSize: 14, display: "flex",
          alignItems: "center", gap: 9 }}><Check size={16} color={t.primary} /> Proceso guardado.</div>
      )}

      {remoteUpdateNotice && (
        <div className={remoteConflictMajor ? "collab-conflict-major" : "collab-conflict-minor"}>
          <div className="collab-conflict-icon">
            {remoteConflictMajor ? <AlertTriangle size={18} /> : <RefreshCw size={16} />}
          </div>
          <div className="collab-conflict-body">
            <strong>
              {remoteConflictMajor
                ? "Conflicto: alguien guardó una versión más nueva de este proceso"
                : "Hay una versión más reciente en el servidor"}
            </strong>
            <span>
              {remoteUpdateNotice.processName ? ` «${remoteUpdateNotice.processName}»` : ""}
              {remoteUpdateNotice.version ? ` (v${remoteUpdateNotice.version})` : ""}.
              {remoteConflictMajor
                ? " Si guardas ahora podrías sobrescribir cambios de otro usuario."
                : " Puedes actualizar cuando termines."}
            </span>
          </div>
          <div className="collab-conflict-actions">
            <div onClick={onApplyRemoteUpdate} className="collab-conflict-btn-primary">
              {remoteConflictMajor ? "Cargar versión remota" : "Actualizar ahora"}
            </div>
            <div onClick={onDismissRemoteUpdate} className="collab-conflict-btn-ghost">Después</div>
          </div>
        </div>
      )}

      {lockNotice && (
        <div className="collab-lock-notice">
          <Lock size={15} />
          {lockNotice}
        </div>
      )}

      {collabApiSupported && editingId && identified && collabSummary.totalActive > 0 && (
        <div className="collab-steps-banner">
          <div className="collab-steps-banner-title">
            <Users size={14} />
            Edición en vivo por paso
          </div>
          <div className="collab-steps-banner-list">
            {collabSummary.selfTmpId && (() => {
              const st = steps.find((s) => s.tmpId === collabSummary.selfTmpId);
              return (
                <span className="collab-step-chip collab-step-chip-self">
                  Tú · {st?.name || "Paso"}
                </span>
              );
            })()}
            {collabSummary.others.map((entry) => (
              <span key={entry.tmpId} className="collab-step-chip collab-step-chip-other">
                {entry.who} · {entry.stepName}
              </span>
            ))}
          </div>
        </div>
      )}

      <div style={{ background: t.surfaceSolid, border: "1px solid " + t.border, borderRadius: 14, padding: 18, marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.textDim, marginBottom: 12 }}>DATOS DEL PROCESO</div>
        <div style={{ display: "grid", gridTemplateColumns: "160px 130px 1fr", gap: 10, marginBottom: 12 }}>
          <Field label="Área" t={t}>
            <Select t={t} value={areaId} onChange={(e) => setAreaId(e.target.value)}>
              <option value="">— elige —</option>
              {data.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
          <Field label="Subárea" t={t}>
            <Input t={t} placeholder="Opcional" value={subArea} onChange={(e) => setSubArea(e.target.value)} />
          </Field>
          <Field label="Nombre del proceso" t={t}>
            <Input t={t} placeholder="Ej. Reporte de venta diaria" value={procName}
              onChange={(e) => setProcName(e.target.value)} />
          </Field>
        </div>
        <Field label="¿Qué lo dispara?" t={t}>
          <Textarea t={t} value={trigger} onChange={(e) => setTrigger(e.target.value)} />
        </Field>
        {areaId && (
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: t.textFaint, fontWeight: 600 }}>Color del área:</span>
            {SEED_AREA_COLORS.map((c) => (
              <div key={c} onClick={() => setAreaColor(areaId, c)} style={{ width: 22, height: 22, borderRadius: 6,
                background: c, cursor: "pointer",
                border: color === c ? "2px solid " + t.text : "2px solid transparent" }} />
            ))}
          </div>
        )}
      </div>

      <div style={{ marginBottom: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: t.textDim, display: "flex", alignItems: "center", gap: 6 }}>
          <Network size={14} /> FLUJO DEL PROCESO
          <span style={{ fontSize: 11, color: t.textFaint, fontWeight: 400 }}>
            · rama = paralelo vertical · Unir ramas = convergencia
          </span>
        </div>
      </div>

      <ProcessFlowCanvas mode="edit" t={t} areaColors={areaColors} procColor={color}
        processArea={processArea} treeSteps={steps} buildCard={buildFlowCard}
        selectedKey={selectedStepTmpId} onSelectCard={handleSelectStep}
        onAddAfter={insertStepAfter} onAddBranch={addBranchFrom} onAddConvergence={addConvergence}
        onRemoveCard={rmStep} onAddFirst={() => addStepRow(null)}
        processId={editingId} sessionId={sessionId} stepLocks={stepLocks} />

      <div style={{ marginTop: 18 }}>
        {selectedStep ? (
          <ProcessStepCapturePanel
            st={selectedStep} stepIndex={selectedIndex} stepFields={fields.filter((f) => f.stepTmpId === selectedStep.tmpId)}
            stepRoles={stepRoles} siblings={selectedSiblings} areaId={areaId} color={color} t={t}
            areaColors={areaColors} data={data} updStep={updStep} updField={updField} rmField={rmField}
            addFieldRow={addFieldRow} importHeader={importHeader} setStepRoles={setStepRoles}
            readOnly={selectedStepReadOnly} lockHolder={selectedLockHolder}
          />
        ) : (
          <div style={{ border: "1.5px dashed " + t.border, borderRadius: 12, padding: 28, textAlign: "center",
            color: t.textFaint, fontSize: 13 }}>
            Selecciona un paso en el grafo superior o agrega el primero con el botón +
          </div>
        )}
      </div>
    </div>
  );
}

// Diagrama de flujo vertical con bifurcaciones tipo árbol
function FlowPreview({ t, color, procName, subArea, steps, fields, areaName }) {
  const rootSteps = steps.filter((s) => !s.parentTmpId);
  const childrenOf = (id) => steps.filter((s) => s.parentTmpId === id);
  const namedFields = fields.filter((f) => f.name.trim()).length;
  const branches = steps.filter((s) => childrenOf(s.tmpId).length > 1).length;

  const renderNode = (st, depth) => {
    const children = childrenOf(st.tmpId);
    const siblings = st.parentTmpId ? childrenOf(st.parentTmpId) : rootSteps;
    const hasSiblings = siblings.length > 1;
    const sibIdx = siblings.indexOf(st);

    return (
      <div key={st.tmpId} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        {/* Etiqueta de camino */}
        {hasSiblings && (
          <div style={{ fontSize: 9.5, fontWeight: 700, color, marginBottom: 3,
            padding: "1px 7px", background: color + "18", borderRadius: 4 }}>
            {st.pathLabel || "Camino " + String.fromCharCode(65 + sibIdx)}</div>
        )}
        {/* Nodo */}
        <div style={{ padding: "6px 10px", borderRadius: 8, border: "1.5px solid " + color,
          background: t.surfaceSolid, maxWidth: 140, textAlign: "center", position: "relative" }}>
          <div style={{ fontSize: 10.5, fontWeight: 500, color: t.text, lineHeight: 1.3,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {st.name || "..."}</div>
          {st.code && <div style={{ fontSize: 8.5, fontFamily: "monospace", color: t.textFaint, marginTop: 2 }}>
            {st.code}</div>}
        </div>
        {/* Flecha + hijos */}
        {children.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <div style={{ width: 2, height: 10, background: color + "44" }} />
            {children.length === 1 ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div style={{ width: 0, height: 0, borderLeft: "4px solid transparent",
                  borderRight: "4px solid transparent", borderTop: "5px solid " + color + "66", marginBottom: 3 }} />
                {renderNode(children[0], depth + 1)}
              </div>
            ) : (
              <div>
                {/* Rombo de decisión */}
                <div style={{ display: "flex", justifyContent: "center", marginBottom: 4 }}>
                  <div style={{ width: 16, height: 16, background: color + "22", border: "1.5px solid " + color,
                    transform: "rotate(45deg)", borderRadius: 2 }} />
                </div>
                {/* Ramas */}
                <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                  {children.map((child) => (
                    <div key={child.tmpId} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                      <div style={{ width: 2, height: 8, background: color + "33" }} />
                      <div style={{ width: 0, height: 0, borderLeft: "3px solid transparent",
                        borderRight: "3px solid transparent", borderTop: "4px solid " + color + "55", marginBottom: 3 }} />
                      {renderNode(child, depth + 1)}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ background: t.dark ? "#0A0C0E" : "#FAFBFC", border: "1px solid " + t.border,
      borderRadius: 12, padding: 16, minHeight: 200, overflow: "auto" }}>
      {areaName && <div style={{ fontSize: 10, color: t.textFaint, marginBottom: 2 }}>
        {areaName}{subArea ? " / " + subArea : ""}</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <div style={{ width: 32, height: 32, borderRadius: 99, border: "2px solid " + color,
          background: t.surfaceSolid, boxShadow: "0 0 12px " + color + "44", display: "flex",
          alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Layers size={15} color={color} />
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{procName || "Tu proceso"}</div>
          <div style={{ fontSize: 10.5, color: t.textFaint }}>
            {steps.length} paso{steps.length !== 1 ? "s" : ""}
            {branches > 0 ? " · " + branches + " divisi" + (branches > 1 ? "ones" : "ón") : ""}
            {" · "}{namedFields} dato{namedFields !== 1 ? "s" : ""}</div>
        </div>
      </div>
      {rootSteps.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0, paddingTop: 4 }}>
          {rootSteps.map((s) => renderNode(s, 0))}
        </div>
      ) : (
        <div style={{ color: t.textFaint, fontSize: 12, textAlign: "center", padding: "20px 0" }}>
          Añade pasos para ver el diagrama.</div>
      )}
    </div>
  );
}


function catalogTypeLabel(typeId) {
  return CATALOG_DATA_TYPES.find((x) => x.id === typeId)?.label || typeId;
}

const CATALOG_TEMPLATE_FORMAT = "gobernanza-catalogo-v1";

function catalogFileSafeName(name) {
  return String(name || "catalogo").replace(/[<>:"/\\|?*]+/g, "_").trim() || "catalogo";
}

function snapshotCatalogForHistory(rows, columns) {
  return rows.map((r, order) => ({
    order,
    values: Object.fromEntries(columns.map((col) => [col.name, String(r.values?.[col.id] ?? "")])),
  }));
}

function validateCatalogImportSchema(fileColumns, expectedColumns) {
  const errors = [];
  if (fileColumns.length !== expectedColumns.length) {
    errors.push(`El archivo define ${fileColumns.length} columnas y el catálogo tiene ${expectedColumns.length}.`);
  }
  const n = Math.max(fileColumns.length, expectedColumns.length);
  for (let i = 0; i < n; i++) {
    const exp = expectedColumns[i];
    const got = fileColumns[i];
    if (!exp && got) errors.push(`Columna extra en posición ${i + 1}: "${got.name}" (${got.dataType})`);
    if (exp && !got) errors.push(`Falta la columna "${exp.name}" en posición ${i + 1}.`);
    if (exp && got) {
      if (exp.name !== got.name) {
        errors.push(`Columna ${i + 1}: se esperaba "${exp.name}" y el archivo trae "${got.name}".`);
      }
      if (exp.dataType !== got.dataType) {
        errors.push(
          `Columna "${exp.name}": tipo esperado "${catalogTypeLabel(exp.dataType)}" (${exp.dataType}), `
          + `archivo "${catalogTypeLabel(got.dataType)}" (${got.dataType}).`,
        );
      }
    }
  }
  return errors;
}

function buildCatalogExportSheets(catalog, columns, rows) {
  const meta = [
    ["clave", "valor"],
    ["formato", CATALOG_TEMPLATE_FORMAT],
    ["catalogo", catalog.name],
    ["version", String(catalog.version || 1)],
    ["exportado", new Date().toISOString()],
    ["descripcion", catalog.description || ""],
  ];
  const colSpec = [
    ["nombre", "tipo", "requerido", "productOwner", "contexto", "valoresPredefinidos"],
    ...columns.map((col) => [
      col.name, col.dataType, col.required ? "Sí" : "No",
      col.productOwner || "", col.context || col.description || "",
      (col.predefinedValues || []).join("|"),
    ]),
  ];
  const dataSheet = [
    columns.map((c) => c.name),
    ...rows.map((r) => columns.map((col) => r.values?.[col.id] ?? "")),
  ];
  return { meta, colSpec, dataSheet };
}

function exportCatalogXlsx(catalog, columns, rows) {
  const { meta, colSpec, dataSheet } = buildCatalogExportSheets(catalog, columns, rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(meta), "_Meta");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(colSpec), "_Columnas");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dataSheet), "Datos");
  XLSX.writeFile(wb, `${catalogFileSafeName(catalog.name)}_v${catalog.version || 1}.xlsx`);
}

function csvEscapeComma(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvEscapeSemicolon(value) {
  const s = String(value ?? "");
  if (/[;\n\r"]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function exportCatalogCsv(catalog, columns, rows) {
  const lines = [
    `#formato=${CATALOG_TEMPLATE_FORMAT}`,
    `#catalogo=${catalog.name}`,
    `#version=${catalog.version || 1}`,
    `#exportado=${new Date().toISOString()}`,
    "#columnas",
    "nombre;tipo;requerido;productOwner;contexto;valoresPredefinidos",
    ...columns.map((col) => [
      col.name, col.dataType, col.required ? "Sí" : "No",
      col.productOwner || "", col.context || col.description || "",
      (col.predefinedValues || []).join("|"),
    ].map(csvEscapeSemicolon).join(";")),
    "#datos",
    columns.map((c) => csvEscapeComma(c.name)).join(","),
    ...rows.map((r) => columns.map((col) => csvEscapeComma(r.values?.[col.id] ?? "")).join(",")),
  ];
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${catalogFileSafeName(catalog.name)}_v${catalog.version || 1}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function sheetToAoA(ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
}

function parseCatalogXlsxTemplate(wb) {
  const colSheet = wb.Sheets._Columnas;
  const dataSheet = wb.Sheets.Datos;
  if (!colSheet || !dataSheet) {
    return { ok: false, error: "Plantilla inválida: debe incluir las hojas _Columnas y Datos." };
  }
  const colRows = sheetToAoA(colSheet);
  const dataRows = sheetToAoA(dataSheet);
  if (colRows.length < 2) return { ok: false, error: "La hoja _Columnas no tiene definición de columnas." };
  const fileColumns = colRows.slice(1)
    .filter((r) => String(r[0] || "").trim())
    .map((r) => ({
      name: String(r[0] || "").trim(),
      dataType: String(r[1] || "text").trim(),
    }));
  if (!fileColumns.length) return { ok: false, error: "No se encontraron columnas en _Columnas." };
  if (!dataRows.length) return { ok: false, error: "La hoja Datos está vacía." };
  const parsedRows = dataRows.slice(1)
    .filter((r) => r.some((c) => String(c).trim()))
    .map((row) => {
      const values = {};
      fileColumns.forEach((col, i) => { values[col.name] = String(row[i] ?? ""); });
      return { values };
    });
  return { ok: true, fileColumns, rows: parsedRows };
}

function parseCatalogCsvTemplate(text) {
  const lines = text.split(/\r?\n/);
  let section = null;
  const fileColumns = [];
  const dataRows = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const tag = line.slice(1).toLowerCase();
      if (tag === "columnas") section = "columnas";
      else if (tag === "datos") section = "datos";
      else section = null;
      continue;
    }
    if (section === "columnas") {
      if (line.toLowerCase().startsWith("nombre;")) continue;
      const parts = line.split(";");
      if (parts[0]) {
        fileColumns.push({
          name: parts[0].trim(),
          dataType: (parts[1] || "text").trim(),
        });
      }
    } else if (section === "datos") {
      const vals = parseCsvLine(line);
      const headerKey = fileColumns.map((c) => c.name).join("|");
      if (vals.map((v) => v.trim()).join("|") === headerKey) continue;
      if (vals.some((v) => v.trim())) {
        const values = {};
        fileColumns.forEach((col, i) => { values[col.name] = vals[i] ?? ""; });
        dataRows.push({ values });
      }
    }
  }
  if (!fileColumns.length) {
    return { ok: false, error: "CSV inválido: falta la sección #columnas con nombre y tipo." };
  }
  return { ok: true, fileColumns, rows: dataRows };
}

async function parseCatalogImportFile(file) {
  const buf = await file.arrayBuffer();
  if (file.name.toLowerCase().endsWith(".csv")) {
    const text = new TextDecoder("utf-8").decode(buf).replace(/^\uFEFF/, "");
    return parseCatalogCsvTemplate(text);
  }
  const wb = XLSX.read(buf, { type: "array" });
  if (wb.SheetNames.includes("_Columnas") && wb.SheetNames.includes("Datos")) {
    return parseCatalogXlsxTemplate(wb);
  }
  const first = wb.Sheets[wb.SheetNames[0]];
  if (!first) return { ok: false, error: "El archivo está vacío." };
  const asText = XLSX.utils.sheet_to_csv(first);
  return parseCatalogCsvTemplate(asText);
}

function rowsFromCatalogSnapshot(snapshot, columns, catalogId) {
  const list = Array.isArray(snapshot) ? snapshot : [];
  return list.map((item, order) => {
    const values = {};
    columns.forEach((col) => { values[col.id] = item.values?.[col.name] ?? ""; });
    return { id: uid(), catalogId, order, values };
  });
}

function catalogColumnBlanks(colId, rows) {
  return rows.filter((r) => !String(r.values?.[colId] ?? "").trim()).length;
}

function catalogFullyBlankRows(rows, columns) {
  if (!columns.length) return rows.length;
  return rows.filter((r) => columns.every((col) => !String(r.values?.[col.id] ?? "").trim())).length;
}

function DataCatalogsSection({ data, t, areaColors, setData }) {
  const [activeCatalogId, setActiveCatalogId] = useState(null);
  const [editingColumnId, setEditingColumnId] = useState(null);
  const [showContext, setShowContext] = useState(true);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [versionComment, setVersionComment] = useState("");
  const [importMessage, setImportMessage] = useState(null);
  const [newCatalogName, setNewCatalogName] = useState("");
  const importInputRef = useRef(null);

  const catalogs = data.dataCatalogs || [];
  const allColumns = data.catalogColumns || [];
  const allRows = data.catalogRows || [];

  const touchCatalog = (catalogId) => {
    setData((d) => ({
      ...d,
      dataCatalogs: (d.dataCatalogs || []).map((c) => c.id === catalogId
        ? { ...c, lastModified: new Date().toISOString() } : c),
    }));
  };

  const createCatalog = () => {
    const name = newCatalogName.trim();
    if (!name) return;
    const id = uid();
    const colId = uid();
    setData((d) => ({
      ...d,
      dataCatalogs: [...(d.dataCatalogs || []), {
        id, name, description: "", areaId: d.areas[0]?.id || "",
        lastModified: new Date().toISOString(), version: 1, versionHistory: [],
      }],
      catalogColumns: [...(d.catalogColumns || []), {
        id: colId, catalogId: id, name: "Identificador", dataType: "text",
        description: "Clave o código del registro", productOwner: "", context: "",
        predefinedValues: [], order: 0, required: true,
      }],
    }));
    setNewCatalogName("");
    setActiveCatalogId(id);
    setEditingColumnId(colId);
  };

  const deleteCatalog = (catalogId) => {
    if (!window.confirm("¿Eliminar este catálogo y todos sus datos?")) return;
    setData((d) => ({
      ...d,
      dataCatalogs: (d.dataCatalogs || []).filter((c) => c.id !== catalogId),
      catalogColumns: (d.catalogColumns || []).filter((c) => c.catalogId !== catalogId),
      catalogRows: (d.catalogRows || []).filter((r) => r.catalogId !== catalogId),
    }));
    if (activeCatalogId === catalogId) {
      setActiveCatalogId(null);
      setEditingColumnId(null);
    }
  };

  const updateCatalog = (catalogId, patch) => {
    setData((d) => ({
      ...d,
      dataCatalogs: (d.dataCatalogs || []).map((c) => c.id === catalogId ? { ...c, ...patch } : c),
    }));
    touchCatalog(catalogId);
  };

  const addColumn = (catalogId) => {
    const cols = allColumns.filter((c) => c.catalogId === catalogId);
    const colId = uid();
    setData((d) => ({
      ...d,
      catalogColumns: [...(d.catalogColumns || []), {
        id: colId, catalogId, name: `Columna ${cols.length + 1}`, dataType: "text",
        description: "", productOwner: "", context: "", predefinedValues: [],
        order: cols.length, required: false,
      }],
    }));
    setEditingColumnId(colId);
    touchCatalog(catalogId);
  };

  const updateColumn = (colId, patch) => {
    const col = allColumns.find((c) => c.id === colId);
    if (!col) return;
    setData((d) => ({
      ...d,
      catalogColumns: (d.catalogColumns || []).map((c) => c.id === colId ? { ...c, ...patch } : c),
    }));
    touchCatalog(col.catalogId);
  };

  const deleteColumn = (colId) => {
    const col = allColumns.find((c) => c.id === colId);
    if (!col) return;
    if (!window.confirm(`¿Eliminar la columna "${col.name}"?`)) return;
    setData((d) => ({
      ...d,
      catalogColumns: (d.catalogColumns || []).filter((c) => c.id !== colId),
      catalogRows: (d.catalogRows || []).map((r) => {
        if (r.catalogId !== col.catalogId) return r;
        const values = { ...r.values };
        delete values[colId];
        return { ...r, values };
      }),
    }));
    if (editingColumnId === colId) setEditingColumnId(null);
    touchCatalog(col.catalogId);
  };

  const addRow = (catalogId) => {
    const rows = allRows.filter((r) => r.catalogId === catalogId);
    setData((d) => ({
      ...d,
      catalogRows: [...(d.catalogRows || []), {
        id: uid(), catalogId, order: rows.length, values: {},
      }],
    }));
    touchCatalog(catalogId);
  };

  const deleteRow = (rowId, catalogId) => {
    setData((d) => ({
      ...d,
      catalogRows: (d.catalogRows || []).filter((r) => r.id !== rowId),
    }));
    touchCatalog(catalogId);
  };

  const setCell = (rowId, colId, value, catalogId) => {
    setData((d) => ({
      ...d,
      catalogRows: (d.catalogRows || []).map((r) => r.id === rowId
        ? { ...r, values: { ...r.values, [colId]: value } } : r),
    }));
    touchCatalog(catalogId);
  };

  const saveCatalogVersion = (catalogId, comment, source = "manual") => {
    const cat = (data.dataCatalogs || []).find((c) => c.id === catalogId);
    if (!cat) return;
    const cols = allColumns.filter((c) => c.catalogId === catalogId).sort((a, b) => a.order - b.order);
    const rws = allRows.filter((r) => r.catalogId === catalogId).sort((a, b) => a.order - b.order);
    const entry = {
      version: cat.version || 1,
      date: cat.lastModified || new Date().toISOString(),
      comment: comment.trim() || "Sin comentario",
      source,
      rowCount: rws.length,
      snapshot: snapshotCatalogForHistory(rws, cols),
    };
    setData((d) => ({
      ...d,
      dataCatalogs: (d.dataCatalogs || []).map((c) => c.id === catalogId ? {
        ...c,
        version: (c.version || 1) + 1,
        lastModified: new Date().toISOString(),
        versionHistory: [...(c.versionHistory || []), entry],
      } : c),
    }));
    setVersionComment("");
  };

  const restoreCatalogVersion = (catalogId, historyEntry) => {
    const cat = (data.dataCatalogs || []).find((c) => c.id === catalogId);
    if (!cat || !historyEntry?.snapshot) return;
    const cols = allColumns.filter((c) => c.catalogId === catalogId).sort((a, b) => a.order - b.order);
    const rws = allRows.filter((r) => r.catalogId === catalogId).sort((a, b) => a.order - b.order);
    const backupEntry = {
      version: cat.version || 1,
      date: cat.lastModified || new Date().toISOString(),
      comment: `Antes de restaurar v${historyEntry.version}`,
      source: "restore-backup",
      rowCount: rws.length,
      snapshot: snapshotCatalogForHistory(rws, cols),
    };
    const restoredRows = rowsFromCatalogSnapshot(historyEntry.snapshot, cols, catalogId);
    setData((d) => ({
      ...d,
      dataCatalogs: (d.dataCatalogs || []).map((c) => c.id === catalogId ? {
        ...c,
        version: (c.version || 1) + 1,
        lastModified: new Date().toISOString(),
        versionHistory: [...(c.versionHistory || []), backupEntry, {
          version: historyEntry.version,
          date: new Date().toISOString(),
          comment: `Restaurado desde v${historyEntry.version}`,
          source: "restore",
          rowCount: restoredRows.length,
          snapshot: historyEntry.snapshot,
        }],
      } : c),
      catalogRows: [
        ...(d.catalogRows || []).filter((r) => r.catalogId !== catalogId),
        ...restoredRows,
      ],
    }));
    setImportMessage({ type: "success", text: `Restaurada la versión v${historyEntry.version} (${restoredRows.length} filas).` });
  };

  const handleCatalogImport = async (file) => {
    if (!activeCatalogId || !file) return;
    setImportMessage(null);
    const cols = allColumns.filter((c) => c.catalogId === activeCatalogId).sort((a, b) => a.order - b.order);
    const rws = allRows.filter((r) => r.catalogId === activeCatalogId).sort((a, b) => a.order - b.order);
    const cat = catalogs.find((c) => c.id === activeCatalogId);
    if (!cols.length) {
      setImportMessage({ type: "error", text: "El catálogo no tiene columnas definidas." });
      return;
    }
    let parsed;
    try {
      parsed = await parseCatalogImportFile(file);
    } catch (_) {
      setImportMessage({ type: "error", text: "No se pudo leer el archivo." });
      return;
    }
    if (!parsed.ok) {
      setImportMessage({ type: "error", text: parsed.error });
      return;
    }
    const schemaErrors = validateCatalogImportSchema(parsed.fileColumns, cols);
    if (schemaErrors.length) {
      setImportMessage({
        type: "error",
        text: `Carga rechazada: los nombres y tipos no coinciden.\n${schemaErrors.join("\n")}`,
      });
      return;
    }
    if (!window.confirm(
      `Se importarán ${parsed.rows.length} filas y se reemplazarán las ${rws.length} actuales. `
      + `Se guardará un respaldo de la versión v${cat.version || 1} antes de importar. ¿Continuar?`,
    )) return;

    const backupEntry = {
      version: cat.version || 1,
      date: cat.lastModified || new Date().toISOString(),
      comment: `Antes de importar ${file.name}`,
      source: "import-backup",
      rowCount: rws.length,
      snapshot: snapshotCatalogForHistory(rws, cols),
    };
    const newRows = parsed.rows.map((row, order) => {
      const values = {};
      cols.forEach((col) => { values[col.id] = row.values[col.name] ?? ""; });
      return { id: uid(), catalogId: activeCatalogId, order, values };
    });
    const newVersion = (cat.version || 1) + 1;
    setData((d) => ({
      ...d,
      dataCatalogs: (d.dataCatalogs || []).map((c) => c.id === activeCatalogId ? {
        ...c,
        version: newVersion,
        lastModified: new Date().toISOString(),
        versionHistory: [...(c.versionHistory || []), backupEntry, {
          version: newVersion,
          date: new Date().toISOString(),
          comment: `Importación: ${parsed.rows.length} filas desde ${file.name}`,
          source: "import",
          rowCount: newRows.length,
          snapshot: snapshotCatalogForHistory(newRows, cols),
        }],
      } : c),
      catalogRows: [
        ...(d.catalogRows || []).filter((r) => r.catalogId !== activeCatalogId),
        ...newRows,
      ],
    }));
    setImportMessage({
      type: "success",
      text: `Importadas ${newRows.length} filas. Nueva versión v${newVersion}.`,
    });
  };

  if (!activeCatalogId) {
    return (
      <div>
        <Header title="Diccionario de Datos" t={t}
          sub="Define, estructura y versiona los datos maestros de tu organización"
          action={
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Input t={t} placeholder="Nombre del catálogo" value={newCatalogName}
                onChange={(e) => setNewCatalogName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") createCatalog(); }}
                style={{ width: 220 }} />
              <Btn t={t} onClick={createCatalog}><Plus size={16} /> Nuevo catálogo</Btn>
            </div>
          } />

        {catalogs.length === 0 ? (
          <div style={{
            border: `1.5px dashed ${t.border}`, borderRadius: 14, padding: 48, textAlign: "center",
            color: t.textDim, background: t.surfaceAlt,
          }}>
            <FileSpreadsheet size={36} color={t.textFaint} style={{ marginBottom: 12 }} />
            <div style={{ fontSize: 15, fontWeight: 600, color: t.text, marginBottom: 6 }}>Sin catálogos aún</div>
            <div style={{ fontSize: 13, maxWidth: 420, margin: "0 auto" }}>
              Crea catálogos para datos que no viven en SAP: columnas con tipo, descripción, product owner y contexto.
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
            {catalogs.map((cat) => {
              const cols = allColumns.filter((c) => c.catalogId === cat.id);
              const rows = allRows.filter((r) => r.catalogId === cat.id);
              const area = data.areas.find((a) => a.id === cat.areaId);
              const ac = area ? (areaColors[area.id] || t.primary) : t.primary;
              return (
                <div key={cat.id} style={{
                  background: t.surfaceSolid, border: `1px solid ${t.border}`, borderRadius: 12,
                  padding: 16, cursor: "pointer", transition: "border-color .15s",
                }}
                  onClick={() => { setActiveCatalogId(cat.id); setEditingColumnId(null); }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = ac + "88"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = t.border; }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
                    <div style={{
                      width: 36, height: 36, borderRadius: 9, background: ac + "22",
                      border: `2px solid ${ac}44`, display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <FileSpreadsheet size={18} color={ac} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 15 }}>{cat.name}</div>
                      {area && <div style={{ fontSize: 11, color: ac, marginTop: 2 }}>{area.name}</div>}
                    </div>
                    <div onClick={(e) => { e.stopPropagation(); deleteCatalog(cat.id); }}
                      title="Eliminar catálogo"
                      style={{ padding: 4, cursor: "pointer", color: t.textFaint }}>
                      <Trash2 size={14} />
                    </div>
                  </div>
                  {cat.description && (
                    <div style={{ fontSize: 12, color: t.textDim, marginBottom: 10, lineHeight: 1.4 }}>
                      {cat.description}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 12, fontSize: 11, color: t.textFaint, alignItems: "center" }}>
                    <span>{cols.length} columnas</span>
                    <span>{rows.length} filas</span>
                    {(cat.version || 1) > 1 && (
                      <span style={{ color: t.primary, fontWeight: 600 }}>v{cat.version}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const catalog = catalogs.find((c) => c.id === activeCatalogId);
  if (!catalog) {
    return (
      <div>
        <Header title="Catálogo no encontrado" t={t} sub="El registro pudo haberse eliminado" />
        <Btn t={t} variant="soft" onClick={() => setActiveCatalogId(null)}>Volver al listado</Btn>
      </div>
    );
  }

  const columns = allColumns.filter((c) => c.catalogId === activeCatalogId).sort((a, b) => a.order - b.order);
  const rows = allRows.filter((r) => r.catalogId === activeCatalogId).sort((a, b) => a.order - b.order);
  const area = data.areas.find((a) => a.id === catalog.areaId);
  const ac = area ? (areaColors[area.id] || t.primary) : t.primary;
  const fullyBlankRows = catalogFullyBlankRows(rows, columns);
  const versionHistory = catalog.versionHistory || [];

  const toolBtnStyle = {
    padding: "7px 12px", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: 500,
    border: `1px solid ${t.border}`, background: t.surfaceAlt, color: t.textDim,
    display: "flex", alignItems: "center", gap: 6,
  };

  const renderCellInput = (row, col) => {
    const value = row.values?.[col.id] ?? "";
    if (col.predefinedValues?.length) {
      return (
        <select value={value} onChange={(e) => setCell(row.id, col.id, e.target.value, activeCatalogId)}
          className="catalog-cell-input" style={{ cursor: "pointer" }}>
          <option value="">—</option>
          {col.predefinedValues.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      );
    }
    if (col.dataType === "boolean") {
      return (
        <select value={value} onChange={(e) => setCell(row.id, col.id, e.target.value, activeCatalogId)}
          className="catalog-cell-input" style={{ cursor: "pointer" }}>
          <option value="">—</option>
          <option value="Sí">Sí</option>
          <option value="No">No</option>
        </select>
      );
    }
    return (
      <input
        type={col.dataType === "number" ? "number" : col.dataType === "date" ? "date" : col.dataType === "email" ? "email" : "text"}
        value={value}
        placeholder="—"
        onChange={(e) => setCell(row.id, col.id, e.target.value, activeCatalogId)}
        className="catalog-cell-input"
      />
    );
  };

  const editingCol = editingColumnId ? allColumns.find((c) => c.id === editingColumnId) : null;

  return (
    <div style={{ width: "100%" }}>
      {/* Header del catálogo */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <div onClick={() => { setActiveCatalogId(null); setEditingColumnId(null); }}
          className="interactive-hover"
          style={{
            width: 34, height: 34, borderRadius: 99, border: `1.5px solid ${t.border}`,
            display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: t.textDim,
          }}>
          <ChevronRight size={17} style={{ transform: "rotate(180deg)" }} />
        </div>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <input value={catalog.name} onChange={(e) => updateCatalog(catalog.id, { name: e.target.value })}
              className="input-premium"
              style={{ fontSize: 18, fontWeight: 600, padding: "6px 10px", flex: 1 }} />
            <span style={{
              fontSize: 11, fontWeight: 700, color: t.primary, background: t.primary + "18",
              padding: "4px 10px", borderRadius: 6, whiteSpace: "nowrap",
            }}>v{catalog.version || 1}</span>
          </div>
          <textarea value={catalog.description || ""} placeholder="Descripción del catálogo (origen, uso, alcance…)"
            onChange={(e) => updateCatalog(catalog.id, { description: e.target.value })}
            className="input-premium"
            style={{ fontSize: 13, marginTop: 8, width: "100%", minHeight: 48, resize: "vertical" }} />
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select value={catalog.areaId || ""} onChange={(e) => updateCatalog(catalog.id, { areaId: e.target.value })}
            className="input-premium" style={{ fontSize: 13, cursor: "pointer", minWidth: 140 }}>
            <option value="">Sin área</option>
            {data.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <div style={{
            padding: "7px 12px", borderRadius: 8, fontSize: 12, background: t.surfaceAlt,
            border: `1px solid ${t.border}`, color: t.textDim,
          }}>
            {rows.length} filas · {fullyBlankRows} vacías
          </div>
          <div onClick={() => exportCatalogXlsx(catalog, columns, rows)} title="Descargar plantilla Excel"
            style={toolBtnStyle}>
            <Download size={14} /> Excel
          </div>
          <div onClick={() => exportCatalogCsv(catalog, columns, rows)} title="Descargar plantilla CSV"
            style={toolBtnStyle}>
            <Download size={14} /> CSV
          </div>
          <div onClick={() => importInputRef.current?.click()} title="Cargar plantilla (mismos nombres y tipos)"
            style={{ ...toolBtnStyle, color: t.primary, borderColor: t.primary + "44" }}>
            <Upload size={14} /> Importar
          </div>
          <input ref={importInputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleCatalogImport(file);
              e.target.value = "";
            }} />
        </div>
      </div>

      {importMessage && (
        <div style={{
          marginBottom: 12, padding: "10px 14px", borderRadius: 10, fontSize: 13, lineHeight: 1.45,
          whiteSpace: "pre-wrap",
          background: importMessage.type === "error" ? "#EA433514" : t.primary + "14",
          border: `1px solid ${importMessage.type === "error" ? "#EA433544" : t.primary + "44"}`,
          color: importMessage.type === "error" ? "#EA4335" : t.text,
        }}>
          {importMessage.text}
        </div>
      )}

      {/* Control de versiones */}
      <div style={{
        background: t.surfaceAlt, border: `1px solid ${t.border}`, borderRadius: 10,
        padding: "12px 16px", marginBottom: 14,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <FileText size={15} color={t.primary} />
          <span style={{ fontSize: 13, fontWeight: 600, color: t.text }}>Control de versiones</span>
          {versionHistory.length > 0 && (
            <span onClick={() => setShowVersionHistory((v) => !v)} style={{
              fontSize: 12, color: t.primary, cursor: "pointer", fontWeight: 500, marginLeft: "auto",
            }}>
              {showVersionHistory ? "Ocultar historial" : `Ver historial (${versionHistory.length})`}
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <input placeholder="Comentario de versión (opcional)" value={versionComment}
            onChange={(e) => setVersionComment(e.target.value)}
            className="input-premium" style={{ fontSize: 13, flex: 1, minWidth: 200 }} />
          <div onClick={() => saveCatalogVersion(catalog.id, versionComment)} style={{
            ...toolBtnStyle, color: t.primary, borderColor: t.primary + "44", fontWeight: 600,
          }}>
            <Check size={14} /> Registrar versión
          </div>
        </div>
        {showVersionHistory && versionHistory.length > 0 && (
          <div style={{ marginTop: 12, borderTop: `1px solid ${t.border}`, paddingTop: 10 }}>
            {versionHistory.slice().reverse().map((entry, i) => (
              <div key={`${entry.version}-${entry.date}-${i}`} style={{
                display: "flex", gap: 10, alignItems: "flex-start", fontSize: 12.5, marginBottom: 8,
              }}>
                <span style={{ fontWeight: 700, color: t.primary, minWidth: 32 }}>v{entry.version}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: t.text }}>{entry.comment}</div>
                  <div style={{ fontSize: 11, color: t.textFaint, marginTop: 2 }}>
                    {entry.rowCount ?? 0} filas
                    {entry.source ? ` · ${entry.source}` : ""}
                    {entry.date ? ` · ${new Date(entry.date).toLocaleString()}` : ""}
                  </div>
                </div>
                {entry.snapshot?.length > 0 && (
                  <div onClick={() => {
                    if (window.confirm(`¿Restaurar v${entry.version} (${entry.rowCount} filas)?`)) {
                      restoreCatalogVersion(catalog.id, entry);
                    }
                  }} style={{
                    fontSize: 11, color: t.primary, cursor: "pointer", fontWeight: 600,
                    padding: "4px 8px", borderRadius: 6, border: `1px solid ${t.primary}44`,
                    whiteSpace: "nowrap",
                  }}>
                    <RotateCcw size={11} style={{ verticalAlign: -2, marginRight: 4 }} />
                    Restaurar
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ===== TABLA TIPO EXCEL ===== */}
      <div className="catalog-table-wrap">
        <table className="catalog-table">
          <thead>
            <tr>
              <th className="catalog-row-num-head" />
              {columns.map((col) => {
                const blanks = catalogColumnBlanks(col.id, rows);
                const isActive = editingColumnId === col.id;
                const typeLabel = catalogTypeLabel(col.dataType);
                return (
                  <th key={col.id} className={`catalog-th ${isActive ? "catalog-th-active" : ""}`}>
                    <div className="catalog-th-content" onClick={() => setEditingColumnId(col.id)}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontWeight: 700, color: t.text, fontSize: 13 }}>{col.name}</span>
                        <Settings size={12} color={t.textFaint} style={{ flexShrink: 0, opacity: 0.6 }} />
                      </div>
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
                        <span style={{
                          fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 4,
                          background: ac + "18", color: ac, border: `1px solid ${ac}28`,
                        }}>{typeLabel}</span>
                        {col.required && (
                          <span style={{
                            fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 4,
                            background: "#EA433518", color: "#EA4335",
                          }}>REQ</span>
                        )}
                        {col.predefinedValues?.length > 0 && (
                          <span style={{
                            fontSize: 9, fontWeight: 600, padding: "1px 5px", borderRadius: 4,
                            background: t.surfaceSolid, color: t.textFaint, border: `1px solid ${t.border}`,
                          }}>{col.predefinedValues.length} val</span>
                        )}
                      </div>
                      {col.productOwner && (
                        <div style={{ fontSize: 10, color: t.textDim, display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
                          <Users size={9} /> {col.productOwner}
                        </div>
                      )}
                      {blanks > 0 && (
                        <div style={{ fontSize: 10, color: "#EA4335", fontWeight: 500 }}>
                          {blanks} vacía{blanks !== 1 ? "s" : ""}
                        </div>
                      )}
                    </div>
                  </th>
                );
              })}
              <th style={{
                width: 44, minWidth: 44, borderBottom: `2px solid ${t.border}`, background: t.surfaceAlt,
                verticalAlign: "middle", textAlign: "center",
              }}>
                <div onClick={() => addColumn(catalog.id)} title="Nueva columna" style={{
                  width: 28, height: 28, borderRadius: 6, border: `1.5px dashed ${t.primary}66`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  cursor: "pointer", color: t.primary, background: t.primary + "0A", margin: "0 auto",
                }}>
                  <Plus size={16} strokeWidth={2.5} />
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={row.id}>
                <td className="catalog-row-num">
                  <div style={{ fontSize: 10, color: t.textFaint, marginBottom: 4 }}>{ri + 1}</div>
                  <div onClick={() => deleteRow(row.id, catalog.id)} style={{ cursor: "pointer", color: t.textFaint, lineHeight: 0 }}
                    title="Eliminar fila"><Trash2 size={11} /></div>
                </td>
                {columns.map((col) => (
                  <td key={col.id} className="catalog-td">
                    {renderCellInput(row, col)}
                  </td>
                ))}
                <td style={{ borderBottom: `1px solid ${t.border}`, background: t.surfaceAlt + "44" }} />
              </tr>
            ))}
            <tr>
              <td className="catalog-row-num" style={{ background: t.surfaceAlt }}>
                <div onClick={() => addRow(catalog.id)} title="Nueva fila" style={{
                  width: 28, height: 28, borderRadius: 6, border: `1.5px dashed ${t.primary}66`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  cursor: "pointer", color: t.primary, background: t.primary + "0A",
                }}>
                  <Plus size={16} strokeWidth={2.5} />
                </div>
              </td>
              <td colSpan={columns.length + 1} style={{
                padding: "10px 14px", color: t.textFaint, fontSize: 12,
                borderTop: `1px dashed ${t.border}`,
              }}>
                {rows.length === 0
                  ? "Pulsa + para agregar la primera fila o columna."
                  : `${rows.length} fila${rows.length !== 1 ? "s" : ""} · ${columns.length} columna${columns.length !== 1 ? "s" : ""}`}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ===== DRAWER DE CONFIGURACIÓN DE COLUMNA ===== */}
      {editingCol && (
        <>
          <div className="catalog-drawer-overlay" onClick={() => setEditingColumnId(null)} />
          <div className="catalog-drawer">
            <div className="catalog-drawer-header">
              <div style={{
                width: 38, height: 38, borderRadius: 10, background: ac + "18",
                border: `1px solid ${ac}33`, display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: 0,
              }}>
                <Settings size={18} color={ac} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-main)", fontFamily: "var(--font-display)" }}>
                  Configurar columna
                </div>
                <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>
                  Define el esquema, contexto y responsable
                </div>
              </div>
              <div onClick={() => setEditingColumnId(null)} style={{
                width: 30, height: 30, borderRadius: 8, display: "flex", alignItems: "center",
                justifyContent: "center", cursor: "pointer", color: "var(--text-faint)",
                border: "1px solid var(--border-color)", flexShrink: 0,
              }}>
                <X size={16} />
              </div>
            </div>

            <div className="catalog-drawer-body">
              {/* Nombre */}
              <div>
                <div className="catalog-drawer-field-label">Nombre de columna</div>
                <input value={editingCol.name}
                  onChange={(e) => updateColumn(editingCol.id, { name: e.target.value })}
                  className="input-premium" autoFocus
                  style={{ fontSize: 14, fontWeight: 600 }} />
              </div>

              {/* Tipo de dato */}
              <div>
                <div className="catalog-drawer-field-label">Tipo de dato</div>
                <select value={editingCol.dataType}
                  onChange={(e) => updateColumn(editingCol.id, { dataType: e.target.value })}
                  className="input-premium" style={{ cursor: "pointer" }}>
                  {CATALOG_DATA_TYPES.map((dt) => (
                    <option key={dt.id} value={dt.id}>{dt.label}</option>
                  ))}
                </select>
              </div>

              {/* Product Owner */}
              <div>
                <div className="catalog-drawer-field-label">Product Owner</div>
                <input placeholder="Nombre del responsable del dato" value={editingCol.productOwner || ""}
                  onChange={(e) => updateColumn(editingCol.id, { productOwner: e.target.value })}
                  className="input-premium" style={{ fontSize: 13 }} />
                <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 4 }}>
                  Persona que define las reglas de negocio de esta columna
                </div>
              </div>

              {/* Contexto / Descripción */}
              <div>
                <div className="catalog-drawer-field-label">Contexto y significado</div>
                <textarea placeholder="¿Qué representa esta columna? ¿Cuál es su origen y uso?" value={editingCol.context || editingCol.description || ""}
                  onChange={(e) => updateColumn(editingCol.id, { context: e.target.value, description: e.target.value })}
                  className="input-premium"
                  style={{ fontSize: 13, minHeight: 80, resize: "vertical", lineHeight: 1.5 }} />
              </div>

              {/* Valores predefinidos */}
              <div>
                <div className="catalog-drawer-field-label">Valores predefinidos</div>
                <textarea placeholder={"Escribe un valor por línea.\nEj:\nActivo\nInactivo\nPendiente"}
                  value={(editingCol.predefinedValues || []).join("\n")}
                  onChange={(e) => updateColumn(editingCol.id, {
                    predefinedValues: e.target.value.split("\n").map((v) => v.trim()).filter(Boolean),
                  })}
                  className="input-premium"
                  style={{ fontSize: 13, minHeight: 72, resize: "vertical", lineHeight: 1.5 }} />
                {editingCol.predefinedValues?.length > 0 && (
                  <div style={{ fontSize: 11, color: ac, marginTop: 4, fontWeight: 500 }}>
                    {editingCol.predefinedValues.length} valor{editingCol.predefinedValues.length !== 1 ? "es" : ""} definido{editingCol.predefinedValues.length !== 1 ? "s" : ""}
                  </div>
                )}
              </div>

              {/* Requerido */}
              <label style={{
                display: "flex", alignItems: "center", gap: 10, fontSize: 13, cursor: "pointer",
                padding: "10px 14px", borderRadius: 10, background: "var(--surface-alt)",
                border: "1px solid var(--border-color)",
              }}>
                <input type="checkbox" checked={!!editingCol.required}
                  onChange={(e) => updateColumn(editingCol.id, { required: e.target.checked })}
                  style={{ width: 16, height: 16, accentColor: ac }} />
                <div>
                  <div style={{ fontWeight: 600, color: "var(--text-main)" }}>Campo requerido</div>
                  <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2 }}>Las celdas vacías se marcarán como incompletas</div>
                </div>
              </label>
            </div>

            <div className="catalog-drawer-footer">
              <button onClick={() => setEditingColumnId(null)} className="btn-premium" style={{ flex: 1, justifyContent: "center" }}>
                <Check size={15} /> Listo
              </button>
              <button onClick={() => deleteColumn(editingCol.id)} className="btn-premium"
                style={{ borderColor: "rgba(234, 67, 53, 0.3)", color: "#EA4335", backgroundColor: "rgba(234, 67, 53, 0.05)" }}>
                <Trash2 size={14} /> Eliminar
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}


function Admin({ data, t, areaColors, addArea, addProcess, setAreaColor, del, bulkMerge, restoreDummyProcess,
  authUser, authToken, sheetsUrl }) {
  const [tab, setTab] = useState("structure");
  const [newArea, setNewArea] = useState("");
  const [pName, setPName] = useState(""); const [pArea, setPArea] = useState("");
  const fileRef = useRef();
  const [importMsg, setImportMsg] = useState(null);

  const downloadTemplate = () => {
    const wb = XLSX.utils.book_new();
    const rows = [
      { Area: "Ventas", Proceso: "Reporte de venta diaria", Paso: "Consulta de facturas",
        Transaccion: "VA05", Sistema: "SAP ECC", Dato: "Importe neto",
        Significado: "Monto de la venta sin IVA, en pesos", Sensible: "No" },
      { Area: "Ventas", Proceso: "Reporte de venta diaria", Paso: "Consulta de facturas",
        Transaccion: "VA05", Sistema: "SAP ECC", Dato: "Cliente",
        Significado: "Razón social del cliente facturado", Sensible: "No" },
      { Area: "Finanzas", Proceso: "Cierre contable", Paso: "Extracción de saldos",
        Transaccion: "FBL3N", Sistema: "SAP ECC", Dato: "Saldo cuenta",
        Significado: "Saldo de la cuenta contable al cierre", Sensible: "No" },
    ];
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{ wch: 14 }, { wch: 26 }, { wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 40 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, ws, "Procesos");
    XLSX.writeFile(wb, "template-gobernanza.xlsx");
  };

  const handleImport = (file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: "array" });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
        const areaMap = {}; const procMap = {}; const srcMap = {};
        const payload = { areas: [], processes: [], steps: [], sources: [], fields: [] };
        data.areas.forEach((a) => (areaMap[a.name.toLowerCase()] = a.id));
        data.processes.forEach((p) => (procMap[`${p.areaId}|${p.name.toLowerCase()}`] = p.id));
        let colorIdx = data.areas.length;
        const stepOrder = {};
        rows.forEach((r) => {
          const areaName = String(r.Area || "").trim(); if (!areaName) return;
          let aid = areaMap[areaName.toLowerCase()];
          if (!aid) { aid = uid(); areaMap[areaName.toLowerCase()] = aid;
            payload.areas.push({ id: aid, name: areaName });
            setAreaColor(aid, SEED_AREA_COLORS[colorIdx++ % SEED_AREA_COLORS.length]); }
          const procName = String(r.Proceso || "").trim(); if (!procName) return;
          const pkey = `${aid}|${procName.toLowerCase()}`;
          let pid = procMap[pkey];
          if (!pid) { pid = uid(); procMap[pkey] = pid;
            payload.processes.push({ id: pid, areaId: aid, name: procName, trigger: "", lifecycle: [] }); }
          const code = String(r.Transaccion || "").trim();
          let sid = null;
          if (code) { const skey = `${pid}|${code.toLowerCase()}`;
            sid = srcMap[skey];
            if (!sid) { sid = uid(); srcMap[skey] = sid;
              payload.sources.push({ id: sid, processId: pid, kind: "erp", code, where: String(r.Sistema || "") }); } }
          const stepName = String(r.Paso || "").trim();
          if (stepName) { const o = (stepOrder[pid] = (stepOrder[pid] == null ? 0 : stepOrder[pid] + 1));
            payload.steps.push({ id: uid(), processId: pid, name: stepName, order: o, sourceId: sid }); }
          const dato = String(r.Dato || "").trim();
          if (dato && sid) payload.fields.push({ id: uid(), sourceId: sid, name: dato,
            description: String(r.Significado || ""), sensitive: /^s[ií]$/i.test(String(r.Sensible || "").trim()) });
        });
        bulkMerge(payload);
        setImportMsg({ ok: true, text: `Importado: ${payload.areas.length} áreas, ${payload.processes.length} procesos, ${payload.sources.length} transacciones, ${payload.fields.length} datos.` });
      } catch (err) {
        setImportMsg({ ok: false, text: "No se pudo leer el archivo. Usa el template descargable." });
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const tabs = [
    { id: "structure", label: "Áreas" },
    { id: "metas", label: "Metas de documentación" },
    { id: "import", label: "Carga masiva" },
    ...(isSuperUser(authUser) ? [{ id: "users", label: "Usuarios" }] : []),
  ];

  return (
    <div>
      <Header title="Administración" sub="Pre-carga la estructura para que tu equipo solo documente el detalle." t={t} />
      <div style={{ display: "flex", gap: 6, marginBottom: 20, borderBottom: `1px solid ${t.border}` }}>
        {tabs.map((tb) => (
          <div key={tb.id} onClick={() => setTab(tb.id)} style={{ padding: "9px 15px", cursor: "pointer",
            fontSize: 14, fontWeight: 500, color: tab === tb.id ? t.text : t.textDim,
            borderBottom: tab === tb.id ? `2px solid ${t.primary}` : "2px solid transparent", marginBottom: -1 }}>
            {tb.label}</div>
        ))}
      </div>

      {tab === "structure" && (
        <div style={{ maxWidth: 560 }}>
          <div style={{ background: t.surfaceSolid, border: `1px solid ${t.border}`, borderRadius: 12, padding: 20 }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Áreas</div>
            <div style={{ fontSize: 13, color: t.textDim, marginBottom: 14, lineHeight: 1.5 }}>
              Define las áreas de negocio y su color. Puedes elegir de la paleta o un color personalizado.</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              <Input t={t} placeholder="Nueva área" value={newArea} onChange={(e) => setNewArea(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && newArea.trim()) { addArea(newArea.trim()); setNewArea(""); } }} />
              <Btn t={t} onClick={() => { if (newArea.trim()) { addArea(newArea.trim()); setNewArea(""); } }}>
                <Plus size={15} /></Btn>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {data.areas.map((a) => (
                <div key={a.id} style={{ padding: "11px 13px", background: t.surfaceAlt, borderRadius: 9 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                    <span style={{ width: 12, height: 12, borderRadius: 99, background: areaColors[a.id],
                      boxShadow: `0 0 8px ${areaColors[a.id]}`, flexShrink: 0 }} />
                    <span style={{ fontSize: 14, fontWeight: 500, flex: 1 }}>{a.name}</span>
                    <Trash2 size={15} color={t.textFaint} style={{ cursor: "pointer" }} onClick={() => del("areas", a.id)} />
                  </div>
                  <AreaColorPicker color={areaColors[a.id]} onChange={(c) => setAreaColor(a.id, c)} t={t} swatchSize={18} />
                </div>
              ))}
              {data.areas.length === 0 && <div style={{ color: t.textFaint, fontSize: 13.5 }}>Sin áreas aún.</div>}
            </div>
          </div>
        </div>
      )}

      {tab === "metas" && (
        <div style={{ maxWidth: 640 }}>
          <div style={{ background: t.surfaceSolid, border: `1px solid ${t.border}`, borderRadius: 12, padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <Target size={18} color={t.primary} />
              <div style={{ fontSize: 15, fontWeight: 600 }}>Metas de documentación</div>
            </div>
            <div style={{ fontSize: 13, color: t.textDim, marginBottom: 16, lineHeight: 1.55 }}>
              Declara los procesos que tu equipo debe documentar. Un proceso queda <strong>documentado</strong> cuando
              tiene al menos un paso en la sección Documentar. El Panel muestra el avance en tiempo real.</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
              <select value={pArea} onChange={(e) => setPArea(e.target.value)}
                style={{ ...inputStyle(t), cursor: "pointer", flex: "0 0 140px" }}>
                <option value="">Área…</option>
                {data.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <Input t={t} placeholder="Nombre del proceso a documentar" value={pName}
                onChange={(e) => setPName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && pArea && pName.trim()) {
                  addProcess({ areaId: pArea, name: pName.trim(), trigger: "", lifecycle: [] });
                  setPName("");
                } }} />
              <Btn t={t} onClick={() => { if (pArea && pName.trim()) { addProcess({ areaId: pArea, name: pName.trim(),
                trigger: "", lifecycle: [] }); setPName(""); } }} disabled={!pArea || !pName.trim()}>
                <Plus size={15} /></Btn>
            </div>
            {data.processes.length > 0 && (() => {
              const done = data.processes.filter((p) => isProcessDocumented(p.id, data)).length;
              const pct = Math.round((done / data.processes.length) * 100);
              return (
                <div style={{ marginTop: 14, marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 6 }}>
                    <span style={{ color: t.textDim }}>Avance: {done} de {data.processes.length} documentados</span>
                    <span style={{ fontWeight: 600, color: t.primary }}>{pct}%</span>
                  </div>
                  <div style={{ height: 6, background: t.surfaceAlt, borderRadius: 99, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: t.primary, borderRadius: 99 }} />
                  </div>
                </div>
              );
            })()}
            <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 12 }}>
              {data.processes.map((p) => {
                const a = data.areas.find((x) => x.id === p.areaId);
                const documented = isProcessDocumented(p.id, data);
                const stepCount = data.steps.filter((s) => s.processId === p.id).length;
                return (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 12px",
                    background: t.surfaceAlt, borderRadius: 9,
                    borderLeft: `3px solid ${documented ? "#34A853" : "#FBBC04"}` }}>
                    <span style={{ width: 9, height: 9, borderRadius: 99, background: areaColors[p.areaId], flexShrink: 0 }} />
                    <span style={{ fontSize: 14, fontWeight: 500, flex: 1 }}>{p.name}</span>
                    <span style={{ fontSize: 12, color: t.textFaint }}>{a ? a.name : ""}</span>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999,
                      background: documented ? "#34A85318" : "#FBBC0418",
                      color: documented ? "#34A853" : "#FBBC04" }}>
                      {documented ? `Documentado · ${stepCount} paso${stepCount !== 1 ? "s" : ""}` : "Pendiente"}
                    </span>
                    <Trash2 size={15} color={t.textFaint} style={{ cursor: "pointer" }} onClick={() => del("processes", p.id)} />
                  </div>
                );
              })}
              {data.processes.length === 0 && (
                <div style={{ color: t.textFaint, fontSize: 13.5, padding: "8px 0" }}>
                  Sin metas declaradas. Agrega los procesos que quieres que el equipo documente.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === "import" && (
        <div style={{ maxWidth: 640 }}>
          <div style={{ background: t.surfaceSolid, border: `1px solid ${t.border}`, borderRadius: 12, padding: 24 }}>
            <div style={{ display: "flex", gap: 14, marginBottom: 22 }}>
              <div style={{ width: 44, height: 44, borderRadius: 10, background: t.primary + "18", display: "flex",
                alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <FileSpreadsheet size={22} color={t.primary} /></div>
              <div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>Carga masiva desde Excel</div>
                <div style={{ fontSize: 13.5, color: t.textDim, marginTop: 3, lineHeight: 1.5 }}>
                  Si ya documentaste procesos en una hoja, descarga el template, ajústalo y súbelo.
                  Reconoce áreas, procesos, pasos, transacciones y datos.</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <Btn t={t} variant="soft" onClick={downloadTemplate}><Download size={16} /> Descargar template</Btn>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden
                onChange={(e) => e.target.files[0] && handleImport(e.target.files[0])} />
              <Btn t={t} onClick={() => fileRef.current.click()}><Upload size={16} /> Subir archivo</Btn>
            </div>
            {importMsg && (
              <div style={{ marginTop: 16, padding: "11px 14px", borderRadius: 9, fontSize: 13.5,
                background: importMsg.ok ? t.primary + "15" : "#EA433515",
                border: `1px solid ${importMsg.ok ? t.primary + "55" : "#EA433555"}`,
                color: t.text }}>{importMsg.text}</div>
            )}
            <div style={{ marginTop: 20, paddingTop: 18, borderTop: `1px solid ${t.border}` }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: t.textDim, marginBottom: 8 }}>COLUMNAS DEL TEMPLATE</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {["Area", "Proceso", "Paso", "Transaccion", "Sistema", "Dato", "Significado", "Sensible"].map((c) => (
                  <span key={c} style={{ fontSize: 12, fontFamily: "monospace", background: t.surfaceAlt,
                    padding: "3px 9px", borderRadius: 6, color: t.textDim }}>{c}</span>
                ))}
              </div>
            </div>
          </div>

          {restoreDummyProcess && (
            <div style={{ marginTop: 16, background: t.surfaceSolid, border: `1px solid ${t.border}`,
              borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Restaurar proceso de prueba</div>
              <div style={{ fontSize: 13, color: t.textDim, marginBottom: 14, lineHeight: 1.5 }}>
                Recupera <strong>Proceso dummy</strong> en el área <strong>Pruebas</strong> con 10 pasos,
                bifurcaciones simuladas y 2 uniones. Si ya existía, se reemplaza.
              </div>
              <Btn t={t} onClick={restoreDummyProcess}>
                <RotateCcw size={16} /> Restaurar Proceso dummy
              </Btn>
            </div>
          )}
        </div>
      )}

      {tab === "users" && isSuperUser(authUser) && (
        <UserManagementPanel t={t} sheetsUrl={sheetsUrl} authToken={authToken} authUser={authUser} />
      )}
    </div>
  );
}
// ============================================================================
// CATÁLOGO
// ============================================================================
// DIRECTORIO ORGANIZACIONAL — quién toca qué, con qué sensibilidad
// ============================================================================
function OrgDirectory({ data, t, areaColors, procColors, setPersonInfo }) {
  const [q, setQ] = useState("");
  const [expandedUser, setExpandedUser] = useState(null);
  const peopleInfo = {};
  (data.people || []).forEach((p) => { peopleInfo[p.email] = p; });

  // Construir mapa de usuarios: email → roles, procesos, sensibilidad
  const users = useMemo(() => {
    const map = new Map(); // email → {email, roles: [{type, processId, stepId, stepName}], ...}

    // Desde roles asignados
    data.roles.forEach((r) => {
      const email = (r.email || r.person || "").trim().toLowerCase();
      if (!email) return;
      if (!map.has(email)) map.set(email, { email, name: "", assignments: [] });
      if (!map.get(email).name && (r.person || "").trim()) map.get(email).name = r.person.trim();
      const proc = data.processes.find((p) => p.id === r.processId);
      const step = r.stepId ? data.steps.find((s) => s.id === r.stepId) : null;
      const area = proc ? data.areas.find((a) => a.id === proc.areaId) : null;
      // Count sensitive fields in this process
      const procSources = data.sources.filter((s) => s.processId === (proc ? proc.id : ""));
      const sensitiveCount = procSources.reduce((sum, src) =>
        sum + data.fields.filter((f) => f.sourceId === src.id && f.sensitive).length, 0);
      const totalFields = procSources.reduce((sum, src) =>
        sum + data.fields.filter((f) => f.sourceId === src.id).length, 0);

      map.get(email).assignments.push({
        type: r.type, processId: proc ? proc.id : "",
        processName: proc ? proc.name : "?",
        stepName: step ? step.name : null,
        areaId: area ? area.id : "",
        areaName: area ? area.name : "?",
        sensitiveCount, totalFields,
      });
    });

    // Desde ejecutores de procesos
    data.processes.forEach((p) => {
      (p.executors || []).forEach((name) => {
        const email = (name || "").trim().toLowerCase();
        if (!email) return;
        if (!map.has(email)) map.set(email, { email, name: "", assignments: [] });
        if (!map.get(email).name && name && !name.includes("@")) map.get(email).name = name.trim();
        const already = map.get(email).assignments.some((a) => a.processId === p.id);
        if (!already) {
          const area = data.areas.find((a) => a.id === p.areaId);
          const procSources = data.sources.filter((s) => s.processId === p.id);
          const sensitiveCount = procSources.reduce((sum, src) =>
            sum + data.fields.filter((f) => f.sourceId === src.id && f.sensitive).length, 0);
          const totalFields = procSources.reduce((sum, src) =>
            sum + data.fields.filter((f) => f.sourceId === src.id).length, 0);
          map.get(email).assignments.push({
            type: "executor", processId: p.id, processName: p.name,
            stepName: null, areaId: area ? area.id : "", areaName: area ? area.name : "?",
            sensitiveCount, totalFields,
          });
        }
      });
    });

    // Agregar métricas por usuario
    const result = Array.from(map.values()).map((u) => {
      const uniqueProcs = new Set(u.assignments.map((a) => a.processId));
      const uniqueAreas = new Set(u.assignments.map((a) => a.areaId).filter(Boolean));
      const totalSensitive = u.assignments.reduce((sum, a) => sum + a.sensitiveCount, 0);
      const hasOwner = u.assignments.some((a) => a.type === "owner");
      const hasSteward = u.assignments.some((a) => a.type === "steward");
      const hasCustodian = u.assignments.some((a) => a.type === "custodian");
      return { ...u, procCount: uniqueProcs.size, areaCount: uniqueAreas.size,
        totalSensitive, hasOwner, hasSteward, hasCustodian };
    });

    result.sort((a, b) => b.procCount - a.procCount);
    return result;
  }, [data, areaColors]);

  const filtered = q
    ? users.filter((u) => u.email.includes(q.toLowerCase()) ||
        u.assignments.some((a) => a.processName.toLowerCase().includes(q.toLowerCase()) ||
          a.areaName.toLowerCase().includes(q.toLowerCase())))
    : users;

  const roleColors = { owner: "#4285F4", steward: "#34A853", custodian: "#A142F4", executor: "#9AA0A6" };
  const roleLabels = { owner: "Owner", steward: "Steward", custodian: "Custodian", executor: "Ejecutor" };

  // Agrupar personas por área (una persona puede aparecer en varias áreas).
  const memberInArea = (u, matchAreaId) => {
    const inArea = u.assignments.filter((a) => (matchAreaId === "__none__" ? !a.areaId : a.areaId === matchAreaId));
    return { user: u, roleTypes: [...new Set(inArea.map((a) => a.type))],
      procCount: new Set(inArea.map((a) => a.processId)).size };
  };
  const areaGroups = data.areas
    .map((area) => ({ area, members: filtered.filter((u) => u.assignments.some((a) => a.areaId === area.id)).map((u) => memberInArea(u, area.id)) }))
    .filter((g) => g.members.length > 0);
  const orphan = filtered.filter((u) => u.assignments.some((a) => !a.areaId)).map((u) => memberInArea(u, "__none__"));
  if (orphan.length) areaGroups.push({ area: { id: "__none__", name: "Sin área asignada" }, members: orphan });

  const renderExpandedDetail = (u) => (
    <div style={{ padding: "0 4px 6px", marginTop: 6 }}>
      {setPersonInfo && (
        <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input defaultValue={peopleInfo[u.email]?.name || u.name || ""} placeholder="Nombre para mostrar"
            onBlur={(e) => setPersonInfo(u.email, { name: e.target.value.trim() })}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            style={{ ...inputStyle(t), flex: "0 0 200px", fontSize: 12 }} />
          <input defaultValue={peopleInfo[u.email]?.photoUrl || ""} placeholder="Foto (pega URL de imagen)"
            onBlur={(e) => setPersonInfo(u.email, { photoUrl: e.target.value.trim() })}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            style={{ ...inputStyle(t), flex: 1, minWidth: 180, fontSize: 12 }} />
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto auto auto", gap: "0", fontSize: 12,
        border: "1px solid " + t.border, borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: "8px 12px", fontWeight: 600, color: t.textDim, background: t.surfaceAlt }}>Rol</div>
        <div style={{ padding: "8px 12px", fontWeight: 600, color: t.textDim, background: t.surfaceAlt }}>Proceso / Paso</div>
        <div style={{ padding: "8px 12px", fontWeight: 600, color: t.textDim, background: t.surfaceAlt }}>Área</div>
        <div style={{ padding: "8px 12px", fontWeight: 600, color: t.textDim, background: t.surfaceAlt }}>Datos</div>
        <div style={{ padding: "8px 12px", fontWeight: 600, color: t.textDim, background: t.surfaceAlt }}>Sensibles</div>
        {u.assignments.map((a, i) => {
          const rc = roleColors[a.type] || t.textDim;
          const ac = areaColors[a.areaId] || t.textDim;
          return (
            <React.Fragment key={i}>
              <div style={{ padding: "6px 12px", borderTop: "1px solid " + t.border + "44" }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: rc, background: rc + "15", padding: "2px 6px", borderRadius: 4 }}>{roleLabels[a.type] || a.type}</span>
              </div>
              <div style={{ padding: "6px 12px", borderTop: "1px solid " + t.border + "44" }}>
                <div style={{ fontWeight: 500, color: t.text }}>{a.processName}</div>
                {a.stepName && <div style={{ fontSize: 11, color: t.textFaint }}>↳ {a.stepName}</div>}
              </div>
              <div style={{ padding: "6px 12px", borderTop: "1px solid " + t.border + "44", display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 8, height: 8, borderRadius: 99, background: ac }} />
                <span style={{ color: t.textDim }}>{a.areaName}</span>
              </div>
              <div style={{ padding: "6px 12px", borderTop: "1px solid " + t.border + "44", color: t.textDim, textAlign: "center" }}>{a.totalFields}</div>
              <div style={{ padding: "6px 12px", borderTop: "1px solid " + t.border + "44", textAlign: "center" }}>
                {a.sensitiveCount > 0 ? <span style={{ color: "#EA4335", fontWeight: 600 }}>{a.sensitiveCount}</span> : <span style={{ color: t.textFaint }}>—</span>}
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );

  const renderMemberCard = (m) => {
    const u = m.user;
    const isOpen = expandedUser === u.email;
    const info = peopleInfo[u.email] || {};
    const displayName = info.name || u.name || u.email.split("@")[0];
    return (
      <div key={u.email} style={{ gridColumn: isOpen ? "1 / -1" : "auto",
        background: t.surfaceSolid, border: "1px solid " + (isOpen ? t.primary + "55" : t.border), borderRadius: 12 }}>
        <div onClick={() => setExpandedUser(isOpen ? null : u.email)} className="interactive-hover"
          style={{ display: "flex", alignItems: "center", gap: 11, padding: "12px 14px", cursor: "pointer" }}>
          <UserAvatar person={displayName} email={u.email} photoUrl={info.photoUrl} size={38} t={t} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: t.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</div>
            <div style={{ fontSize: 11.5, color: t.textFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.email}</div>
          </div>
          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
            {m.roleTypes.map((rt) => (
              <span key={rt} style={{ fontSize: 9.5, fontWeight: 600, color: roleColors[rt] || t.textDim,
                background: (roleColors[rt] || t.textDim) + "18", padding: "2px 6px", borderRadius: 4 }}>{roleLabels[rt] || rt}</span>
            ))}
          </div>
        </div>
        {isOpen && renderExpandedDetail(u)}
      </div>
    );
  };

  return (
    <div>
      <Header title="Equipos por área"
        sub={users.length + " personas · toca a alguien para ver qué procesos maneja"} t={t}
        action={<div style={{ position: "relative" }}>
          <Search size={16} color={t.textFaint} style={{ position: "absolute", left: 11, top: 10 }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar persona, proceso o área…"
            style={{ ...inputStyle(t), padding: "9px 12px 9px 34px", width: 280 }} /></div>} />

      {filtered.length === 0 ? (
        <div style={{ padding: "56px 20px", textAlign: "center", color: t.textFaint }}>
          <Users size={36} strokeWidth={1.3} />
          <div style={{ fontSize: 15, marginTop: 12 }}>
            {q ? "Sin resultados." : "Asigna responsables en cada paso al documentar."}</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          {areaGroups.map((g) => {
            const ac = areaColors[g.area.id] || t.primary;
            return (
              <div key={g.area.id}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 99, background: ac, flexShrink: 0 }} />
                  <span style={{ fontSize: 14, fontWeight: 600, color: t.text }}>{g.area.name}</span>
                  <span style={{ fontSize: 11.5, color: t.textFaint, fontWeight: 500 }}>
                    {g.members.length} persona{g.members.length === 1 ? "" : "s"}
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
                  {g.members.map(renderMemberCard)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


function SettingsModal({ theme, t, data, areaColors, setAreaColor, onSave, onClose }) {
  const [draft, setDraft] = useState(theme);
  const logoRef = useRef();
  const readImg = (file, key) => { const r = new FileReader();
    r.onload = () => setDraft((s) => ({ ...s, [key]: r.result })); r.readAsDataURL(file); };
  const palette = SEED_AREA_COLORS.slice(0, 7);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "#000A", display: "flex",
      alignItems: "center", justifyContent: "center", zIndex: 50, padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: t.surfaceSolid, border: `1px solid ${t.border}`,
        borderRadius: 14, padding: 24, width: "100%", maxWidth: 540, maxHeight: "88vh", overflow: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <div style={{ fontSize: 18, fontWeight: 600, display: "flex", alignItems: "center", gap: 9 }}>
            <Palette size={18} color={t.primary} /> Personalización</div>
          <X size={20} style={{ cursor: "pointer", color: t.textDim }} onClick={onClose} /></div>
        <Field label="Nombre de la empresa" t={t}>
          <Input t={t} value={draft.companyName} onChange={(e) => setDraft({ ...draft, companyName: e.target.value })} /></Field>
        <Field label="Logotipo" t={t}>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div style={{ border: `1px solid ${t.border}`, borderRadius: 8,
              width: 140, height: 56, display: "flex", alignItems: "center", justifyContent: "center",
              overflow: "hidden", background: t.surfaceAlt }}>
              <img src={draft.logo} alt="" style={{ maxHeight: "78%", maxWidth: "84%", objectFit: "contain" }} />
            </div>
          </div>
          <div style={{ fontSize: 11, color: t.textFaint, marginTop: 6, lineHeight: 1.4 }}>
            El logotipo está fijado por configuración de la marca.
          </div>
        </Field>
        <Field label="Color principal" t={t}>
          <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
            {palette.map((c) => (
              <div key={c} onClick={() => setDraft({ ...draft, primary: c })} style={{ width: 30, height: 30,
                borderRadius: 8, background: c, cursor: "pointer",
                border: draft.primary === c ? `2px solid ${t.text}` : "2px solid transparent" }} />
            ))}
            <input type="color" value={draft.primary} onChange={(e) => setDraft({ ...draft, primary: e.target.value })}
              style={{ width: 30, height: 30, borderRadius: 8, border: `1px solid ${t.border}`, cursor: "pointer",
                background: "transparent", padding: 2 }} /></div>
        </Field>
        <Field label="Tema" t={t}>
          <div style={{ display: "flex", gap: 10 }}>
            {[{ id: "dark", label: "Oscuro" }, { id: "light", label: "Claro" }].map((m) => (
              <div key={m.id} onClick={() => setDraft({ ...draft, mode: m.id })} style={{ flex: 1, padding: "10px",
                borderRadius: 8, cursor: "pointer", textAlign: "center", fontWeight: 500, fontSize: 14,
                border: draft.mode === m.id ? `1.5px solid ${draft.primary}` : `1px solid ${t.border}`,
                background: draft.mode === m.id ? draft.primary + "18" : t.surfaceAlt,
                color: draft.mode === m.id ? t.text : t.textDim }}>{m.label}</div>
            ))}</div>
        </Field>
        {data.areas.length > 0 && (
          <Field label="Color de cada área" t={t}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {data.areas.map((a) => (
                <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 14, fontWeight: 500, width: 120 }}>{a.name}</span>
                  <div style={{ display: "flex", gap: 6 }}>
                    {SEED_AREA_COLORS.map((c) => (
                      <div key={c} onClick={() => setAreaColor(a.id, c)} style={{ width: 22, height: 22, borderRadius: 6,
                        background: c, cursor: "pointer",
                        border: areaColors[a.id] === c ? `2px solid ${t.text}` : "2px solid transparent" }} />
                    ))}</div>
                </div>
              ))}
            </div>
          </Field>
        )}
        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
          <Btn t={t} variant="ghost" onClick={onClose} style={{ flex: 1, justifyContent: "center" }}>Cancelar</Btn>
          <Btn t={{ primary: draft.primary }} onClick={() => onSave(draft)}
            style={{ flex: 1, justifyContent: "center" }}><Check size={15} /> Guardar</Btn></div>
      </div>
    </div>
  );
}
