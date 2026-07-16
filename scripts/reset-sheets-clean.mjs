/**
 * Limpia Google Sheets para distribución + prueba rápida lectura/escritura.
 * Uso: node scripts/reset-sheets-clean.mjs
 */

import {
  SHEETS_URL,
  loadCatalog,
  saveCatalog,
  countRows,
  emptyCatalog,
} from "./lib/sheets-client.mjs";

const uid = () => Math.random().toString(36).slice(2, 9);

function assert(cond, msg) {
  if (!cond) throw new Error(`FALLO: ${msg}`);
}

function logCounts(label, counts) {
  console.log(`  ${label}: áreas=${counts.areas} procesos=${counts.processes} pasos=${counts.steps} fuentes=${counts.sources} datos=${counts.fields} roles=${counts.roles}`);
}

console.log("=== Reset Google Sheets — Gobernanza POC ===\n");
console.log(`URL: ${SHEETS_URL}\n`);

// 1) Lectura inicial
console.log("1) Lectura inicial…");
const before = await loadCatalog();
const beforeCounts = countRows(before);
logCounts("Estado actual", beforeCounts);

// 2) Escritura vacía (limpio para empresa)
console.log("\n2) Limpiando catálogo (solo encabezados)…");
await saveCatalog(emptyCatalog());
const afterClean = await loadCatalog();
const cleanCounts = countRows(afterClean);
logCounts("Tras limpieza", cleanCounts);
assert(
  cleanCounts.areas === 0 && cleanCounts.processes === 0 && cleanCounts.steps === 0,
  "El catálogo no quedó vacío",
);

// 3) Prueba rápida escritura + lectura con dato mínimo
console.log("\n3) Prueba lectura/escritura (dato de smoke test)…");
const testAreaId = uid();
const testProcId = uid();
const testStepId = uid();
const testSourceId = uid();
const testFieldId = uid();
const testRoleId = uid();
const stamp = new Date().toISOString();

const testPayload = {
  areas: [{ id: testAreaId, nombre: "__SMOKE_TEST__", color: "#4285F4" }],
  processes: [{
    id: testProcId,
    area: "__SMOKE_TEST__",
    subArea: "",
    nombre: "__Proceso test sync__",
    disparador: `Prueba automática ${stamp}`,
    ejecutores: "",
    version: 1,
    ultimaModificacion: stamp,
  }],
  steps: [{
    id: testStepId,
    proceso: "__Proceso test sync__",
    area: "__SMOKE_TEST__",
    orden: 0,
    nombre: "Paso de verificación",
    areaResponsable: "",
    sourceId: testSourceId,
    transaccion: "SMOKE-01",
  }],
  sources: [{
    id: testSourceId,
    proceso: "__Proceso test sync__",
    tipo: "erp",
    codigo: "SMOKE-01",
    sistema: "POC",
  }],
  fields: [{
    id: testFieldId,
    sourceId: testSourceId,
    dato: "Campo test",
    significado: "Verificación de sync",
    ejemplo: "OK",
    sensible: "No",
    transaccion: "SMOKE-01",
    proceso: "__Proceso test sync__",
    area: "__SMOKE_TEST__",
  }],
  roles: [{
    id: testRoleId,
    proceso: "__Proceso test sync__",
    stepId: testStepId,
    tipo: "owner",
    email: "smoke@test.local",
    persona: "Smoke Test",
  }],
};

await saveCatalog(testPayload);
const afterTest = await loadCatalog();
const testCounts = countRows(afterTest);
logCounts("Tras smoke test", testCounts);
assert(testCounts.areas === 1, "No se escribió el área de prueba");
assert(testCounts.processes === 1, "No se escribió el proceso de prueba");
assert(testCounts.steps === 1, "No se escribió el paso de prueba");
assert(
  afterTest.areas?.[0]?.nombre === "__SMOKE_TEST__",
  "La lectura no devolvió el área esperada",
);
assert(
  afterTest.processes?.[0]?.nombre === "__Proceso test sync__",
  "La lectura no devolvió el proceso esperado",
);

// 4) Limpieza final para distribución
console.log("\n4) Limpieza final para distribución a la empresa…");
await saveCatalog(emptyCatalog());
const final = await loadCatalog();
const finalCounts = countRows(final);
logCounts("Estado final", finalCounts);
assert(
  finalCounts.areas === 0 && finalCounts.processes === 0,
  "El estado final no quedó limpio",
);

console.log("\n✓ Listo. Google Sheets quedó vacío y la sincronización funciona.");
console.log("  · Lectura (load): OK");
console.log("  · Escritura (save): OK");
console.log("  · Round-trip verificado con dato temporal eliminado");
console.log("\nLa empresa puede abrir la app y empezar desde cero (áreas, procesos, etc.).");
