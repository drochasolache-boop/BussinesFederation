const SHEETS_URL =
  "https://script.google.com/macros/s/AKfycbx16-VdaEHLi4W2rU1_NaGdZZs7WjLJpElUNwGU5BAfd_KTxXW8yy0Gysa-gQTXOXMMjQ/exec";

const uid = () => Math.random().toString(36).slice(2, 9);

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

const PROCESS_BLUEPRINTS = {
  "Reporte de venta diaria": {
    trigger: "Cuando dirección me pide el reporte de ventas del día",
    steps: [
      { name: "Consultar pedidos abiertos", code: "VA05", system: "SAP ECC", fields: [
        { name: "Importe neto", desc: "Monto de venta sin IVA en pesos", example: "125000.00", sensitive: false },
        { name: "Cliente", desc: "Razón social del cliente facturado", example: "ACME SA", sensitive: false },
      ]},
      { name: "Validar facturas del día", code: "VF03", system: "SAP ECC", responsibleArea: "Finanzas", fields: [
        { name: "Folio fiscal", desc: "UUID del CFDI timbrado", example: "A1B2-C3D4", sensitive: true },
      ]},
      { name: "Consolidar en Excel", code: "VENTAS_DIARIA.xlsx", kind: "file", system: "SharePoint", fields: [
        { name: "Total día", desc: "Suma de importes netos validados", example: "890000.00", sensitive: false },
      ]},
    ],
    roles: [
      { type: "owner", email: "roberto.sanchez@dacomsa.com", person: "Roberto Sánchez" },
      { type: "steward", email: "gabriela.cruz@dacomsa.com", person: "Gabriela Cruz" },
    ],
  },
  "Facturación": {
    trigger: "Cuando un pedido de venta está listo para facturar",
    steps: [
      { name: "Crear factura en SAP", code: "VF01", system: "SAP ECC", fields: [
        { name: "Importe factura", desc: "Total con IVA de la factura", example: "145000.00", sensitive: false },
      ]},
      { name: "Timbrar CFDI", code: "TIMBRADO", kind: "report", system: "PAC", responsibleArea: "Finanzas", fields: [
        { name: "UUID", desc: "Identificador fiscal del comprobante", example: "F9E8-D7C6", sensitive: true },
      ]},
    ],
    roles: [
      { type: "owner", email: "fernando.navarro@dacomsa.com", person: "Fernando Navarro" },
      { type: "custodian", email: "admin.erp@dacomsa.com", person: "Admin ERP" },
    ],
  },
  "Cierre contable mensual": {
    trigger: "Al cierre del mes contable",
    steps: [
      { name: "Extraer partidas de mayor", code: "FBL3N", system: "SAP ECC", fields: [
        { name: "Saldo cuenta", desc: "Saldo contable al cierre", example: "2500000.00", sensitive: false },
      ]},
      { name: "Conciliar bancos", code: "FF7A", system: "SAP ECC", responsibleArea: "TI", fields: [
        { name: "Posición tesorería", desc: "Saldo disponible en bancos", example: "980000.00", sensitive: true },
      ]},
    ],
    roles: [
      { type: "owner", email: "contabilidad@dacomsa.com", person: "Contabilidad" },
      { type: "steward", email: "analista.finanzas@dacomsa.com", person: "Analista Finanzas" },
    ],
  },
  "Pago a proveedores": {
    trigger: "Cuando vence una factura de proveedor autorizada",
    steps: [
      { name: "Listar partidas abiertas", code: "FBL1N", system: "SAP ECC", fields: [
        { name: "Importe pendiente", desc: "Monto por pagar al proveedor", example: "45000.00", sensitive: false },
      ]},
      { name: "Validar orden de compra", code: "ME23N", system: "SAP ECC", responsibleArea: "Compras", fields: [
        { name: "OC autorizada", desc: "Orden de compra vinculada a la factura", example: "4500123456", sensitive: false },
      ]},
      { name: "Ejecutar pago", code: "F110", system: "SAP ECC", noAssignee: true, fields: [
        { name: "Referencia pago", desc: "Folio del pago programado", example: "PAG-2026-0142", sensitive: false },
      ]},
    ],
    roles: [{ type: "owner", email: "tesoreria@dacomsa.com", person: "Tesorería" }],
  },
  "Solicitud de compra": {
    trigger: "Cuando un área solicita material o servicio",
    steps: [
      { name: "Crear requisición", code: "ME51N", system: "SAP ECC", fields: [
        { name: "Centro de costo", desc: "CeCo que absorbe el gasto", example: "CC-1001", sensitive: false },
      ]},
      { name: "Aprobar requisición", code: "ME54N", system: "SAP ECC", responsibleArea: "Finanzas", fields: [
        { name: "Estatus aprobación", desc: "Estado del workflow de compras", example: "Aprobado", sensitive: false },
      ]},
    ],
    roles: [{ type: "owner", email: "compras@dacomsa.com", person: "Compras" }],
  },
  "Entrada de mercancía": {
    trigger: "Cuando llega material del proveedor al almacén",
    steps: [
      { name: "Registrar entrada", code: "MIGO", system: "SAP ECC", fields: [
        { name: "Cantidad recibida", desc: "Unidades ingresadas al almacén", example: "120", sensitive: false },
      ]},
      { name: "Validar contra orden de compra", code: "ME23N", system: "SAP ECC", responsibleArea: "Compras", fields: [
        { name: "Cantidad OC", desc: "Cantidad autorizada en la orden de compra", example: "120", sensitive: false },
      ]},
      { name: "Verificar stock", code: "MB52", system: "SAP ECC", noAssignee: true, fields: [
        { name: "Stock disponible", desc: "Existencia actual del material", example: "540", sensitive: false },
      ]},
    ],
    roles: [{ type: "steward", email: "almacen@dacomsa.com", person: "Almacén" }],
  },
  "Cálculo de nómina": {
    trigger: "Cada quincena para pago de nómina",
    steps: [
      { name: "Capturar incidencias", code: "PA30", system: "SAP HCM", fields: [
        { name: "Horas extra", desc: "Horas extraordinarias del periodo", example: "8", sensitive: true },
      ]},
      { name: "Contabilizar nómina", code: "FB01", system: "SAP ECC", responsibleArea: "Finanzas", fields: [
        { name: "Centro de costo nómina", desc: "CeCo donde se contabiliza la provisión", example: "CC-RH-01", sensitive: false },
      ]},
      { name: "Ejecutar nómina", code: "PC00_M99_CALC", system: "SAP HCM", fields: [
        { name: "Neto a pagar", desc: "Monto neto quincenal del empleado", example: "18500.00", sensitive: true },
      ]},
    ],
    roles: [
      { type: "owner", email: "rh@dacomsa.com", person: "Recursos Humanos" },
      { type: "custodian", email: "ti.hcm@dacomsa.com", person: "TI HCM" },
    ],
  },
  "Alta de usuario en ERP": {
    trigger: "Cuando un colaborador nuevo requiere acceso al ERP",
    steps: [
      { name: "Solicitar alta con RH", code: "SOLICITUD_ALTA", kind: "file", system: "ServiceNow", responsibleArea: "Recursos Humanos", fields: [
        { name: "Puesto autorizado", desc: "Rol de negocio aprobado por RH", example: "Analista de ventas", sensitive: false },
      ]},
      { name: "Crear usuario", code: "SU01", system: "SAP ECC", fields: [
        { name: "Usuario SAP", desc: "ID técnico del usuario en el sistema", example: "JPEREZ", sensitive: false },
      ]},
      { name: "Asignar roles", code: "PFCG", system: "SAP ECC", noAssignee: true, fields: [
        { name: "Perfil autorizado", desc: "Rol transaccional aprobado por el área", example: "Z_SD_VENTAS", sensitive: true },
      ]},
    ],
    roles: [{ type: "custodian", email: "ti.seguridad@dacomsa.com", person: "Seguridad TI" }],
  },
};

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

function enrichWithSteps(catalog) {
  const areas = dedupeAreas(catalog.areas);
  const processes = dedupeById(catalog.processes);
  const steps = [];
  const sources = [];
  const fields = [];
  const roles = [];

  const areaByName = Object.fromEntries(areas.map((a) => [String(a.nombre).toLowerCase(), a]));

  processes.forEach((proc) => {
    const blueprint = PROCESS_BLUEPRINTS[proc.nombre];
    if (!blueprint) return;

    if (!proc.disparador) proc.disparador = blueprint.trigger;
    proc.ultimaModificacion = new Date().toISOString();
    proc.version = (Number(proc.version) || 1);

    blueprint.steps.forEach((st, order) => {
      const stepId = uid();
      const sourceId = uid();
      const kind = st.kind || "erp";

      steps.push({
        id: stepId,
        proceso: proc.nombre,
        area: proc.area,
        orden: order,
        nombre: st.name,
        areaResponsable: st.responsibleArea || "",
        sourceId,
        transaccion: st.code,
      });

      sources.push({
        id: sourceId,
        proceso: proc.nombre,
        tipo: kind,
        codigo: st.code,
        sistema: st.system || "",
      });

      (st.fields || []).forEach((f) => {
        fields.push({
          id: uid(),
          sourceId,
          dato: f.name,
          significado: f.desc,
          ejemplo: f.example || "",
          sensible: f.sensitive ? "Sí" : "No",
          transaccion: st.code,
          proceso: proc.nombre,
          area: proc.area,
        });
      });

      (st.noAssignee ? [] : (blueprint.roles || [])).forEach((r) => {
        roles.push({
          id: uid(),
          proceso: proc.nombre,
          stepId,
          tipo: r.type,
          email: r.email,
          persona: r.person,
        });
      });
    });
  });

  return {
    areas,
    processes,
    steps,
    sources,
    fields,
    roles,
  };
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
const enriched = enrichWithSteps(catalog);
await saveCatalog(enriched);

console.log("Catálogo simulado en Google Sheets:");
console.log(`  Áreas: ${enriched.areas.length}`);
console.log(`  Procesos: ${enriched.processes.length}`);
console.log(`  Pasos: ${enriched.steps.length}`);
console.log(`  Fuentes: ${enriched.sources.length}`);
console.log(`  Datos: ${enriched.fields.length}`);
console.log(`  Roles: ${enriched.roles.length}`);
console.log(`  Procesos documentados: ${new Set(enriched.steps.map((s) => s.proceso)).size}`);

const crossArea = enriched.steps.filter((s) => s.areaResponsable && s.areaResponsable !== s.area);
console.log(`  Pasos con otra área responsable: ${crossArea.length}`);
crossArea.forEach((s) => {
  console.log(`    · ${s.proceso} (${s.area}) → "${s.nombre}" ejecuta ${s.areaResponsable}`);
});

const stepsWithRoles = new Set(enriched.roles.map((r) => r.stepId));
const noAssigneeSteps = enriched.steps.filter((s) => !stepsWithRoles.has(s.id));
console.log(`  Pasos sin usuario asignado (riesgo amarillo): ${noAssigneeSteps.length}`);
noAssigneeSteps.forEach((s) => {
  console.log(`    · ${s.proceso} → "${s.nombre}"`);
});
