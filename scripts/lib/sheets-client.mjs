export const SHEETS_URL =
  "https://script.google.com/macros/s/AKfycbx16-VdaEHLi4W2rU1_NaGdZZs7WjLJpElUNwGU5BAfd_KTxXW8yy0Gysa-gQTXOXMMjQ/exec";

export async function loadCatalog() {
  const res = await fetch(SHEETS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action: "load" }),
  });
  const json = await res.json();
  if (json.status === "error") throw new Error(json.message || "Error al leer Sheets");
  return json.data || json;
}

export async function saveCatalog(payload) {
  const res = await fetch(SHEETS_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (json.status === "error") throw new Error(json.message || "Error al escribir Sheets");
  return json;
}

export function countRows(catalog) {
  return {
    areas: (catalog.areas || []).length,
    processes: (catalog.processes || []).length,
    steps: (catalog.steps || []).length,
    sources: (catalog.sources || []).length,
    fields: (catalog.fields || []).length,
    roles: (catalog.roles || []).length,
  };
}

export function emptyCatalog() {
  return {
    areas: [],
    processes: [],
    steps: [],
    sources: [],
    fields: [],
    roles: [],
  };
}
