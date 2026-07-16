/**
 * Restaura "Proceso dummy" en Google Sheets (pocas ramificaciones para pruebas).
 * Uso: node scripts/seed-dummy-process.mjs
 */

const SHEETS_URL =
  "https://script.google.com/macros/s/AKfycbx16-VdaEHLi4W2rU1_NaGdZZs7WjLJpElUNwGU5BAfd_KTxXW8yy0Gysa-gQTXOXMMjQ/exec";

const uid = () => Math.random().toString(36).slice(2, 9);

const DUMMY_AREA = "Pruebas";
const DUMMY_PROCESS = "Proceso dummy";

const STEP_BLUEPRINT = [
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

function dedupeAreas(rows) {
  const seenId = new Set();
  const seenName = new Set();
  return (rows || []).filter((a) => {
    const nameKey = String(a.nombre || "").trim().toLowerCase();
    if (!a.id || seenId.has(a.id) || (nameKey && seenName.has(nameKey))) return false;
    seenId.add(a.id);
    if (nameKey) seenName.add(nameKey);
    return true;
  });
}

function dedupeById(rows, key = "id") {
  const seen = new Set();
  return (rows || []).filter((r) => {
    if (!r[key] || seen.has(r[key])) return false;
    seen.add(r[key]);
    return true;
  });
}

function stripDummy(catalog) {
  const isDummyProc = (name) => String(name || "").trim().toLowerCase() === DUMMY_PROCESS.toLowerCase();
  catalog.processes = (catalog.processes || []).filter((p) => !isDummyProc(p.nombre));
  catalog.steps = (catalog.steps || []).filter((s) => !isDummyProc(s.proceso));
  catalog.sources = (catalog.sources || []).filter((s) => !isDummyProc(s.proceso));
  catalog.fields = (catalog.fields || []).filter((f) => !isDummyProc(f.proceso));
  catalog.roles = (catalog.roles || []).filter((r) => !isDummyProc(r.proceso));
}

function buildDummyRows(catalog) {
  let areas = dedupeAreas(catalog.areas);
  let area = areas.find((a) => String(a.nombre).toLowerCase() === DUMMY_AREA.toLowerCase());
  if (!area) {
    area = { id: uid(), nombre: DUMMY_AREA, color: "#4285F4" };
    areas.push(area);
  }

  const processId = uid();
  const steps = [];
  const sources = [];
  const fields = [];
  const roles = [];

  STEP_BLUEPRINT.forEach((st, order) => {
    const stepId = uid();
    const sourceId = uid();
    steps.push({
      id: stepId,
      proceso: DUMMY_PROCESS,
      area: DUMMY_AREA,
      orden: order,
      nombre: st.name,
      areaResponsable: "",
      sourceId,
      transaccion: st.code,
    });
    sources.push({
      id: sourceId,
      proceso: DUMMY_PROCESS,
      tipo: "erp",
      codigo: st.code,
      sistema: "POC",
    });
    fields.push({
      id: uid(),
      sourceId,
      dato: "Estado",
      significado: `Indicador del paso ${st.name}`,
      ejemplo: st.join ? "Convergido" : "OK",
      sensible: "No",
      transaccion: st.code,
      proceso: DUMMY_PROCESS,
      area: DUMMY_AREA,
    });
    if (st.assign) {
      roles.push({
        id: uid(),
        proceso: DUMMY_PROCESS,
        stepId,
        tipo: "owner",
        email: "dummy.owner@empresa.com",
        persona: "Owner Dummy",
      });
    }
  });

  const processes = [
    ...(catalog.processes || []).filter((p) => String(p.nombre).toLowerCase() !== DUMMY_PROCESS.toLowerCase()),
    {
      id: processId,
      area: DUMMY_AREA,
      subArea: "POC",
      nombre: DUMMY_PROCESS,
      disparador: "Proceso de prueba con bifurcaciones y uniones para el mapa de relaciones",
      ejecutores: "Owner Dummy",
      version: 1,
      ultimaModificacion: new Date().toISOString(),
    },
  ];

  return {
    areas,
    processes,
    steps: [...(catalog.steps || []), ...steps],
    sources: [...(catalog.sources || []), ...sources],
    fields: [...(catalog.fields || []), ...fields],
    roles: [...(catalog.roles || []), ...roles],
  };
}

async function loadCatalog() {
  const res = await fetch(SHEETS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action: "load" }),
  });
  const json = await res.json();
  if (json.status === "error") throw new Error(json.message);
  return json.data;
}

async function saveCatalog(payload) {
  const res = await fetch(SHEETS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (json.status === "error") throw new Error(json.message);
  return json;
}

const catalog = await loadCatalog();
stripDummy(catalog);
const enriched = buildDummyRows(catalog);
await saveCatalog(enriched);

console.log("Proceso dummy restaurado en Google Sheets:");
console.log(`  Área: ${DUMMY_AREA}`);
console.log(`  Proceso: ${DUMMY_PROCESS}`);
console.log(`  Pasos: ${STEP_BLUEPRINT.length} (incluye 2 uniones y ramas simuladas)`);
console.log("Recarga la app (F5) para verlo en Documentar y en el Mapa de relaciones.");
