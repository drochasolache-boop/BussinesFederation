# Colaboración en tiempo real — actualización Apps Script

Para bloqueo de pasos entre usuarios y sincronización en vivo, **actualiza el Apps Script** de tu Google Sheet.

## Qué agrega

- Hoja **EdicionesActivas**: quién está editando cada paso
- Acciones `acquireLock`, `releaseLock`, `releaseSession`, `heartbeat`
- La carga (`action: load`) incluye `edicionesActivas`

## Pasos

1. Abre tu Sheet → **Extensiones → Apps Script**
2. Reemplaza el código por el de abajo (incluye sync + colaboración)
3. **Implementar → Nueva implementación → App web**
4. Si la URL cambia, actualízala en `TENANTS` en `src/App.jsx`

## Código Apps Script completo

```javascript
var LOCK_TTL_MS = 90000;

function readSheetTable(sheet, cols) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = {};
    for (var j = 0; j < headers.length; j++) row[headers[j]] = values[i][j];
    rows.push(row);
  }
  return rows;
}

function getEdicionesSheet(ss) {
  var spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
  var sheet = spreadsheet.getSheetByName("EdicionesActivas");
  if (!sheet) {
    sheet = spreadsheet.insertSheet("EdicionesActivas");
    sheet.getRange(1, 1, 1, 8).setValues([[
      "id", "sessionId", "usuario", "email", "processId", "stepId", "bloqueadoEn", "latido"
    ]]);
    sheet.getRange(1, 1, 1, 8).setFontWeight("bold").setBackground("#4285F4").setFontColor("#FFFFFF");
  }
  return sheet;
}

function readEdicionesActivas(ss) {
  return readSheetTable(getEdicionesSheet(ss));
}

function writeEdicionesActivas(ss, rows) {
  var sheet = getEdicionesSheet(ss);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 8).setValues([[
    "id", "sessionId", "usuario", "email", "processId", "stepId", "bloqueadoEn", "latido"
  ]]);
  sheet.getRange(1, 1, 1, 8).setFontWeight("bold").setBackground("#4285F4").setFontColor("#FFFFFF");
  if (rows && rows.length) {
    var matrix = rows.map(function(r) {
      return [r.id, r.sessionId, r.usuario, r.email, r.processId, r.stepId, r.bloqueadoEn, r.latido];
    });
    sheet.getRange(2, 1, rows.length, 8).setValues(matrix);
  }
}

function pruneStaleLocks(ss) {
  var rows = readEdicionesActivas(ss);
  var now = Date.now();
  var kept = rows.filter(function(r) {
    var ts = Date.parse(r.latido || r.bloqueadoEn || "");
    return ts && (now - ts) <= LOCK_TTL_MS;
  });
  if (kept.length !== rows.length) writeEdicionesActivas(ss, kept);
  return kept;
}

function acquireStepLock(body, ss) {
  var locks = pruneStaleLocks(ss);
  var processId = String(body.processId || "");
  var stepId = String(body.stepId || "");
  var sessionId = String(body.sessionId || "");
  var existing = null;
  for (var i = 0; i < locks.length; i++) {
    if (String(locks[i].processId) === processId && String(locks[i].stepId) === stepId) {
      existing = locks[i];
      break;
    }
  }
  if (existing && String(existing.sessionId) !== sessionId) {
    return { status: "locked", lock: existing };
  }
  var now = new Date().toISOString();
  if (existing) {
    existing.latido = now;
    writeEdicionesActivas(ss, locks);
    return { status: "ok", lock: existing };
  }
  var row = {
    id: Utilities.getUuid(),
    sessionId: sessionId,
    usuario: String(body.usuario || ""),
    email: String(body.email || ""),
    processId: processId,
    stepId: stepId,
    bloqueadoEn: now,
    latido: now,
  };
  locks.push(row);
  writeEdicionesActivas(ss, locks);
  return { status: "ok", lock: row };
}

function releaseStepLock(body, ss) {
  var processId = String(body.processId || "");
  var stepId = String(body.stepId || "");
  var sessionId = String(body.sessionId || "");
  var kept = pruneStaleLocks(ss).filter(function(l) {
    if (String(l.processId) !== processId || String(l.stepId) !== stepId) return true;
    return String(l.sessionId) !== sessionId;
  });
  writeEdicionesActivas(ss, kept);
  return { status: "ok" };
}

function releaseSessionLocks(body, ss) {
  var sessionId = String(body.sessionId || "");
  var kept = pruneStaleLocks(ss).filter(function(l) {
    return String(l.sessionId) !== sessionId;
  });
  writeEdicionesActivas(ss, kept);
  return { status: "ok" };
}

function heartbeatLocks(body, ss) {
  var sessionId = String(body.sessionId || "");
  var now = new Date().toISOString();
  var rows = pruneStaleLocks(ss);
  var touched = false;
  rows.forEach(function(r) {
    if (String(r.sessionId) === sessionId) {
      r.latido = now;
      touched = true;
    }
  });
  if (touched) writeEdicionesActivas(ss, rows);
  return { status: "ok" };
}

function readCatalog(ss) {
  var spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
  var sheets = {
    areas:     { name: "Áreas",    cols: ["id","nombre","color"] },
    processes: { name: "Procesos", cols: ["id","area","subArea","nombre","disparador","ejecutores","version","ultimaModificacion"] },
    steps:     { name: "Pasos",    cols: ["id","proceso","area","orden","nombre","areaResponsable","sourceId","transaccion","parentStepId","joinStepId","etiquetaRama","esUnion"] },
    sources:   { name: "Fuentes",  cols: ["id","proceso","tipo","codigo","sistema"] },
    fields:    { name: "Datos",    cols: ["id","sourceId","dato","significado","ejemplo","sensible","transaccion","proceso","area"] },
    roles:     { name: "Roles",    cols: ["id","proceso","stepId","tipo","email","persona"] },
    dataCatalogs: { name: "CatalogosDatos", cols: ["id","nombre","descripcion","area","ultimaModificacion","version","historialVersiones"] },
    catalogColumns: { name: "ColumnasCatalogo", cols: ["id","catalogo","nombre","tipo","descripcion","productOwner","contexto","valoresPredefinidos","orden","requerido"] },
    catalogRows: { name: "FilasCatalogo", cols: ["id","catalogo","orden","valores"] },
    configuracion: { name: "Configuracion", cols: ["clave","valor"] },
  };
  var result = {};
  for (var key in sheets) {
    var config = sheets[key];
    var sheet = spreadsheet.getSheetByName(config.name);
    result[key] = readSheetTable(sheet, config.cols);
  }
  result.edicionesActivas = pruneStaleLocks(spreadsheet);
  return { status: "ok", data: result };
}

function writeCatalog(data, ss) {
  var spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
  var sheets = {
    "Áreas":      { data: data.areas,     cols: ["id","nombre","color"] },
    "Procesos":   { data: data.processes, cols: ["id","area","subArea","nombre","disparador","ejecutores","version","ultimaModificacion"] },
    "Pasos":      { data: data.steps,     cols: ["id","proceso","area","orden","nombre","areaResponsable","sourceId","transaccion","parentStepId","joinStepId","etiquetaRama","esUnion"] },
    "Fuentes":    { data: data.sources,   cols: ["id","proceso","tipo","codigo","sistema"] },
    "Datos":      { data: data.fields,    cols: ["id","sourceId","dato","significado","ejemplo","sensible","transaccion","proceso","area"] },
    "Roles":      { data: data.roles,     cols: ["id","proceso","stepId","tipo","email","persona"] },
    "CatalogosDatos": { data: data.dataCatalogs, cols: ["id","nombre","descripcion","area","ultimaModificacion","version","historialVersiones"] },
    "ColumnasCatalogo": { data: data.catalogColumns, cols: ["id","catalogo","nombre","tipo","descripcion","productOwner","contexto","valoresPredefinidos","orden","requerido"] },
    "FilasCatalogo": { data: data.catalogRows, cols: ["id","catalogo","orden","valores"] },
    "Configuracion": { data: data.configuracion, cols: ["clave","valor"] },
  };

  for (var name in sheets) {
    var config = sheets[name];
    var rows = config.data || [];
    var cols = config.cols;
    var sheet = spreadsheet.getSheetByName(name);
    if (!sheet) sheet = spreadsheet.insertSheet(name);
    sheet.clear();
    if (cols.length > 0) {
      sheet.getRange(1, 1, 1, cols.length).setValues([cols]);
      sheet.getRange(1, 1, 1, cols.length).setFontWeight("bold").setBackground("#4285F4").setFontColor("#FFFFFF");
    }
    if (rows.length > 0) {
      var matrix = rows.map(function(row) {
        return cols.map(function(col) {
          var val = row[col];
          return val !== undefined && val !== null ? val : "";
        });
      });
      sheet.getRange(2, 1, rows.length, cols.length).setValues(matrix);
    }
    for (var i = 1; i <= cols.length; i++) sheet.autoResizeColumn(i);
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    if (body.action === "load") {
      return ContentService.createTextOutput(JSON.stringify(readCatalog(ss)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (body.action === "acquireLock") {
      return ContentService.createTextOutput(JSON.stringify(acquireStepLock(body, ss)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (body.action === "releaseLock") {
      return ContentService.createTextOutput(JSON.stringify(releaseStepLock(body, ss)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (body.action === "releaseSession") {
      return ContentService.createTextOutput(JSON.stringify(releaseSessionLocks(body, ss)))
        .setMimeType(ContentService.MimeType.JSON);
    }
    if (body.action === "heartbeat") {
      return ContentService.createTextOutput(JSON.stringify(heartbeatLocks(body, ss)))
        .setMimeType(ContentService.MimeType.JSON);
    }

    writeCatalog(body, ss);
    return ContentService.createTextOutput(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify(readCatalog()))
    .setMimeType(ContentService.MimeType.JSON);
}
```

## Comportamiento en la app

- Cada **10 s** revisa cambios en el catálogo remoto
- Si otro usuario guardó y tú no estás editando, **actualiza solo**
- Si estás en Documentar, muestra aviso **«Actualizar ahora»**
- Al seleccionar un paso, **bloquea** ese paso para otros (~90 s sin actividad libera el bloqueo). La identidad viene del **login**, no de un modal aparte.
