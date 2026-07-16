# Login y usuarios — actualización Apps Script

Para la **pantalla de login**, el registro de editores (solo super usuario) y el **autor en el historial de versiones**, actualiza el Apps Script de tu Google Sheet con el código de abajo.

Incluye también **colaboración en vivo** (bloqueo de pasos). Si ya seguiste [APPS-SCRIPT-COLABORACION.md](./APPS-SCRIPT-COLABORACION.md), reemplaza todo el script por este archivo unificado.

## Qué agrega

| Hoja / acción | Uso |
|---|---|
| **Usuarios** | Cuentas con hash SHA-256 de contraseña, rol `super` o `editor` |
| **Sesiones** | Tokens de sesión con expiración (~30 días) |
| `checkAuth` | La app detecta si hay que crear el super usuario inicial |
| `bootstrapSuper` | Primera vez: creas tu cuenta super |
| `login` / `logout` / `validateSession` | Sesión persistente en el navegador |
| `registerUser` / `listUsers` | Solo super usuario da de alta editores |
| **EdicionesActivas** | Bloqueo de pasos entre usuarios (colaboración) |

## Pasos

1. Abre tu Sheet → **Extensiones → Apps Script**
2. Reemplaza **todo** el código por el de abajo
3. **Implementar → Nueva implementación → App web**
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier persona**
4. Copia la URL y actualízala en `TENANTS` → `sheetsUrl` en `src/App.jsx` si cambió
5. Abre la app: verás **Configuración inicial** para crear el super usuario (solo la primera vez)

## Flujo en la app

1. **Primera vez (con Sheets):** pantalla «Configuración inicial» → creas super usuario
2. **Login:** correo + contraseña
3. **Super usuario:** Administración → pestaña **Usuarios** → registrar editores
4. **Editores:** inician sesión y documentan procesos; cada guardado registra **autor** en el historial de versiones

Si el Apps Script aún no está actualizado, la app crea el super usuario en el navegador para desbloquear el acceso hasta que despliegues el script.

## Código Apps Script completo (auth + sync + colaboración)

```javascript
var LOCK_TTL_MS = 90000;
var SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sha256Hex(text) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text));
  return digest.map(function(b) {
    var v = b < 0 ? b + 256 : b;
    return ("0" + v.toString(16)).slice(-2);
  }).join("");
}

function readSheetTable(sheet) {
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

function writeSheetTable(sheet, headers, rows, rowMapper) {
  sheet.clearContents();
  if (headers.length) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#4285F4").setFontColor("#FFFFFF");
  }
  if (rows && rows.length) {
    var matrix = rows.map(rowMapper);
    sheet.getRange(2, 1, rows.length, headers.length).setValues(matrix);
  }
}

function getUsuariosSheet(ss) {
  var sheet = ss.getSheetByName("Usuarios");
  if (!sheet) {
    sheet = ss.insertSheet("Usuarios");
    writeSheetTable(sheet, ["id","nombre","email","passwordHash","rol","activo","creadoEn","creadoPor"], [], function() { return []; });
  }
  return sheet;
}

function getSesionesSheet(ss) {
  var sheet = ss.getSheetByName("Sesiones");
  if (!sheet) {
    sheet = ss.insertSheet("Sesiones");
    writeSheetTable(sheet, ["token","userId","expiraEn","creadoEn"], [], function() { return []; });
  }
  return sheet;
}

function readUsuarios(ss) {
  return readSheetTable(getUsuariosSheet(ss));
}

function writeUsuarios(ss, rows) {
  writeSheetTable(getUsuariosSheet(ss),
    ["id","nombre","email","passwordHash","rol","activo","creadoEn","creadoPor"],
    rows,
    function(r) { return [r.id, r.nombre, r.email, r.passwordHash, r.rol, r.activo, r.creadoEn, r.creadoPor || ""]; }
  );
}

function readSesiones(ss) {
  return readSheetTable(getSesionesSheet(ss));
}

function writeSesiones(ss, rows) {
  writeSheetTable(getSesionesSheet(ss),
    ["token","userId","expiraEn","creadoEn"],
    rows,
    function(r) { return [r.token, r.userId, r.expiraEn, r.creadoEn]; }
  );
}

function pruneSesiones(ss) {
  var now = Date.now();
  var kept = readSesiones(ss).filter(function(s) {
    var exp = Date.parse(s.expiraEn || "");
    return exp && exp > now;
  });
  writeSesiones(ss, kept);
  return kept;
}

function publicUser(u) {
  return { id: u.id, nombre: u.nombre, email: u.email, rol: u.rol, activo: u.activo !== false && u.activo !== "false" };
}

function findUserByEmail(ss, email) {
  var lower = String(email || "").trim().toLowerCase();
  var users = readUsuarios(ss);
  for (var i = 0; i < users.length; i++) {
    if (String(users[i].email || "").trim().toLowerCase() === lower) return users[i];
  }
  return null;
}

function findUserById(ss, id) {
  var users = readUsuarios(ss);
  for (var i = 0; i < users.length; i++) {
    if (String(users[i].id) === String(id)) return users[i];
  }
  return null;
}

function createSession(ss, userId) {
  var sessions = pruneSesiones(ss);
  var now = new Date();
  var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, "");
  var row = {
    token: token,
    userId: userId,
    expiraEn: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    creadoEn: now.toISOString(),
  };
  sessions.push(row);
  writeSesiones(ss, sessions);
  return token;
}

function userFromToken(ss, token) {
  if (!token) return null;
  var sessions = pruneSesiones(ss);
  var session = null;
  for (var i = 0; i < sessions.length; i++) {
    if (String(sessions[i].token) === String(token)) { session = sessions[i]; break; }
  }
  if (!session) return null;
  var user = findUserById(ss, session.userId);
  if (!user || user.activo === false || user.activo === "false") return null;
  return publicUser(user);
}

function authCheck(ss) {
  var users = readUsuarios(ss);
  return { status: "ok", needsBootstrap: users.length === 0 };
}

function authBootstrapSuper(body, ss) {
  var users = readUsuarios(ss);
  if (users.length > 0) return { status: "error", message: "Ya existe un super usuario" };
  var email = String(body.email || "").trim().toLowerCase();
  var nombre = String(body.nombre || "").trim();
  var password = String(body.password || "");
  if (!email || !nombre || !password) return { status: "error", message: "Datos incompletos" };
  var user = {
    id: Utilities.getUuid(),
    nombre: nombre,
    email: email,
    passwordHash: sha256Hex(password),
    rol: "super",
    activo: true,
    creadoEn: new Date().toISOString(),
    creadoPor: "bootstrap",
  };
  writeUsuarios(ss, [user]);
  var token = createSession(ss, user.id);
  return { status: "ok", token: token, user: publicUser(user) };
}

function authLogin(body, ss) {
  var email = String(body.email || "").trim().toLowerCase();
  var password = String(body.password || "");
  var user = findUserByEmail(ss, email);
  if (!user || user.activo === false || user.activo === "false") {
    return { status: "error", message: "Correo o contraseña incorrectos" };
  }
  if (user.passwordHash !== sha256Hex(password)) {
    return { status: "error", message: "Correo o contraseña incorrectos" };
  }
  var token = createSession(ss, user.id);
  return { status: "ok", token: token, user: publicUser(user) };
}

function authLogout(body, ss) {
  var token = String(body.token || "");
  var kept = pruneSesiones(ss).filter(function(s) { return String(s.token) !== token; });
  writeSesiones(ss, kept);
  return { status: "ok" };
}

function authValidateSession(body, ss) {
  var user = userFromToken(ss, body.token);
  if (!user) return { status: "error", message: "Sesión inválida" };
  return { status: "ok", user: user };
}

function authRegisterUser(body, ss) {
  var caller = userFromToken(ss, body.token);
  if (!caller || caller.rol !== "super") return { status: "error", message: "Sin permiso" };
  var email = String(body.email || "").trim().toLowerCase();
  var nombre = String(body.nombre || "").trim();
  var password = String(body.password || "");
  var rol = body.rol === "super" ? "super" : "editor";
  if (!email || !nombre || !password) return { status: "error", message: "Datos incompletos" };
  if (findUserByEmail(ss, email)) return { status: "error", message: "Ese correo ya existe" };
  var users = readUsuarios(ss);
  users.push({
    id: Utilities.getUuid(),
    nombre: nombre,
    email: email,
    passwordHash: sha256Hex(password),
    rol: rol,
    activo: true,
    creadoEn: new Date().toISOString(),
    creadoPor: caller.email,
  });
  writeUsuarios(ss, users);
  return { status: "ok" };
}

function authListUsers(body, ss) {
  var caller = userFromToken(ss, body.token);
  if (!caller || caller.rol !== "super") return { status: "error", message: "Sin permiso" };
  var users = readUsuarios(ss).map(publicUser);
  return { status: "ok", users: users };
}

// --- Colaboración (bloqueo de pasos) ---

function getEdicionesSheet(ss) {
  var sheet = ss.getSheetByName("EdicionesActivas");
  if (!sheet) {
    sheet = ss.insertSheet("EdicionesActivas");
    writeSheetTable(sheet, ["id","sessionId","usuario","email","processId","stepId","bloqueadoEn","latido"], [], function() { return []; });
  }
  return sheet;
}

function readEdicionesActivas(ss) {
  return readSheetTable(getEdicionesSheet(ss));
}

function writeEdicionesActivas(ss, rows) {
  writeSheetTable(getEdicionesSheet(ss),
    ["id","sessionId","usuario","email","processId","stepId","bloqueadoEn","latido"],
    rows,
    function(r) { return [r.id, r.sessionId, r.usuario, r.email, r.processId, r.stepId, r.bloqueadoEn, r.latido]; }
  );
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
      existing = locks[i]; break;
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
    if (String(r.sessionId) === sessionId) { r.latido = now; touched = true; }
  });
  if (touched) writeEdicionesActivas(ss, rows);
  return { status: "ok" };
}

// --- Catálogo ---

function readCatalog(ss) {
  var spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
  var sheets = {
    areas:     { name: "Áreas",    cols: ["id","nombre","color"] },
    processes: { name: "Procesos", cols: ["id","area","subArea","nombre","disparador","ejecutores","version","ultimaModificacion","historialVersiones"] },
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
    result[key] = readSheetTable(sheet);
  }
  result.edicionesActivas = pruneStaleLocks(spreadsheet);
  return { status: "ok", data: result };
}

function writeCatalog(data, ss) {
  var spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
  var sheets = {
    "Áreas":      { data: data.areas,     cols: ["id","nombre","color"] },
    "Procesos":   { data: data.processes, cols: ["id","area","subArea","nombre","disparador","ejecutores","version","ultimaModificacion","historialVersiones"] },
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

    if (body.action === "checkAuth") {
      return ContentService.createTextOutput(JSON.stringify(authCheck(ss))).setMimeType(ContentService.MimeType.JSON);
    }
    if (body.action === "bootstrapSuper") {
      return ContentService.createTextOutput(JSON.stringify(authBootstrapSuper(body, ss))).setMimeType(ContentService.MimeType.JSON);
    }
    if (body.action === "login") {
      return ContentService.createTextOutput(JSON.stringify(authLogin(body, ss))).setMimeType(ContentService.MimeType.JSON);
    }
    if (body.action === "logout") {
      return ContentService.createTextOutput(JSON.stringify(authLogout(body, ss))).setMimeType(ContentService.MimeType.JSON);
    }
    if (body.action === "validateSession") {
      return ContentService.createTextOutput(JSON.stringify(authValidateSession(body, ss))).setMimeType(ContentService.MimeType.JSON);
    }
    if (body.action === "registerUser") {
      return ContentService.createTextOutput(JSON.stringify(authRegisterUser(body, ss))).setMimeType(ContentService.MimeType.JSON);
    }
    if (body.action === "listUsers") {
      return ContentService.createTextOutput(JSON.stringify(authListUsers(body, ss))).setMimeType(ContentService.MimeType.JSON);
    }
    if (body.action === "load") {
      return ContentService.createTextOutput(JSON.stringify(readCatalog(ss))).setMimeType(ContentService.MimeType.JSON);
    }
    if (body.action === "acquireLock") {
      return ContentService.createTextOutput(JSON.stringify(acquireStepLock(body, ss))).setMimeType(ContentService.MimeType.JSON);
    }
    if (body.action === "releaseLock") {
      return ContentService.createTextOutput(JSON.stringify(releaseStepLock(body, ss))).setMimeType(ContentService.MimeType.JSON);
    }
    if (body.action === "releaseSession") {
      return ContentService.createTextOutput(JSON.stringify(releaseSessionLocks(body, ss))).setMimeType(ContentService.MimeType.JSON);
    }
    if (body.action === "heartbeat") {
      return ContentService.createTextOutput(JSON.stringify(heartbeatLocks(body, ss))).setMimeType(ContentService.MimeType.JSON);
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

## Seguridad

- Las contraseñas se guardan como **hash SHA-256** (no texto plano)
- Solo el **super usuario** puede registrar cuentas
- Los tokens expiran a los 30 días; al cerrar sesión se invalidan en el Sheet
- Este script es adecuado para equipos internos con acceso controlado al Sheet; no sustituye un IdP empresarial completo
