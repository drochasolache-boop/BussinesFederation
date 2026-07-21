# Apps Script COMPLETO — catálogo + colaboración + tombstones + login/usuarios + Personas

Este es el script único y definitivo. Reemplaza **TODO** tu código de Apps Script por esto (Ctrl+A → pegar), **Guardar**, y **Implementar → Administrar implementaciones → ✏️ → Versión: Nueva versión → Implementar**.

Incluye:
- **Login / usuarios** (hojas `Usuarios` y `Sesiones`) — los usuarios que des de alta pueden iniciar sesión desde cualquier dispositivo.
- **Colaboración** (hoja `EdicionesActivas`) — bloqueo por paso.
- **Catálogo** con **tombstones monotónicos** (hoja `Borrados`) — las eliminaciones no se pierden ni reviven.
- **Personas** (hoja `Personas`) — nombre y foto (URL) por persona para el Directorio de Equipos.

```javascript
var LOCK_TTL_MS = 90000;
var SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ============================ Utilidades ============================
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
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#6B7280").setFontColor("#FFFFFF");
  }
  if (rows && rows.length) {
    var matrix = rows.map(rowMapper);
    sheet.getRange(2, 1, rows.length, headers.length).setValues(matrix);
  }
}

// ============================ Usuarios / Sesiones ============================
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

function readUsuarios(ss) { return readSheetTable(getUsuariosSheet(ss)); }
function writeUsuarios(ss, rows) {
  writeSheetTable(getUsuariosSheet(ss),
    ["id","nombre","email","passwordHash","rol","activo","creadoEn","creadoPor"],
    rows,
    function(r) { return [r.id, r.nombre, r.email, r.passwordHash, r.rol, r.activo, r.creadoEn, r.creadoPor || ""]; }
  );
}
function readSesiones(ss) { return readSheetTable(getSesionesSheet(ss)); }
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
  sessions.push({
    token: token, userId: userId,
    expiraEn: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    creadoEn: now.toISOString(),
  });
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
    id: Utilities.getUuid(), nombre: nombre, email: email,
    passwordHash: sha256Hex(password), rol: "super", activo: true,
    creadoEn: new Date().toISOString(), creadoPor: "bootstrap",
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
    id: Utilities.getUuid(), nombre: nombre, email: email,
    passwordHash: sha256Hex(password), rol: rol, activo: true,
    creadoEn: new Date().toISOString(), creadoPor: caller.email,
  });
  writeUsuarios(ss, users);
  return { status: "ok" };
}
function authListUsers(body, ss) {
  var caller = userFromToken(ss, body.token);
  if (!caller || caller.rol !== "super") return { status: "error", message: "Sin permiso" };
  return { status: "ok", users: readUsuarios(ss).map(publicUser) };
}

// ============================ Colaboración (bloqueo por paso) ============================
function getEdicionesSheet(ss) {
  var sheet = ss.getSheetByName("EdicionesActivas");
  if (!sheet) {
    sheet = ss.insertSheet("EdicionesActivas");
    writeSheetTable(sheet, ["id","sessionId","usuario","email","processId","stepId","bloqueadoEn","latido"], [], function() { return []; });
  }
  return sheet;
}
function readEdicionesActivas(ss) { return readSheetTable(getEdicionesSheet(ss)); }
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
  var processId = String(body.processId || ""), stepId = String(body.stepId || ""), sessionId = String(body.sessionId || "");
  var existing = null;
  for (var i = 0; i < locks.length; i++) {
    if (String(locks[i].processId) === processId && String(locks[i].stepId) === stepId) { existing = locks[i]; break; }
  }
  if (existing && String(existing.sessionId) !== sessionId) return { status: "locked", lock: existing };
  var now = new Date().toISOString();
  if (existing) { existing.latido = now; writeEdicionesActivas(ss, locks); return { status: "ok", lock: existing }; }
  var row = { id: Utilities.getUuid(), sessionId: sessionId, usuario: String(body.usuario || ""),
    email: String(body.email || ""), processId: processId, stepId: stepId, bloqueadoEn: now, latido: now };
  locks.push(row);
  writeEdicionesActivas(ss, locks);
  return { status: "ok", lock: row };
}
function releaseStepLock(body, ss) {
  var processId = String(body.processId || ""), stepId = String(body.stepId || ""), sessionId = String(body.sessionId || "");
  var kept = pruneStaleLocks(ss).filter(function(l) {
    if (String(l.processId) !== processId || String(l.stepId) !== stepId) return true;
    return String(l.sessionId) !== sessionId;
  });
  writeEdicionesActivas(ss, kept);
  return { status: "ok" };
}
function releaseSessionLocks(body, ss) {
  var sessionId = String(body.sessionId || "");
  var kept = pruneStaleLocks(ss).filter(function(l) { return String(l.sessionId) !== sessionId; });
  writeEdicionesActivas(ss, kept);
  return { status: "ok" };
}
function heartbeatLocks(body, ss) {
  var sessionId = String(body.sessionId || ""), now = new Date().toISOString(), touched = false;
  var rows = pruneStaleLocks(ss);
  rows.forEach(function(r) { if (String(r.sessionId) === sessionId) { r.latido = now; touched = true; } });
  if (touched) writeEdicionesActivas(ss, rows);
  return { status: "ok" };
}

// ============================ Catálogo (con tombstones + Personas) ============================
function readCatalog(ss) {
  var spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
  var names = {
    areas: "Áreas", processes: "Procesos", steps: "Pasos", sources: "Fuentes",
    fields: "Datos", roles: "Roles", dataCatalogs: "CatalogosDatos",
    catalogColumns: "ColumnasCatalogo", catalogRows: "FilasCatalogo",
    configuracion: "Configuracion", deletedIds: "Borrados", people: "Personas",
  };
  var result = {};
  for (var key in names) {
    result[key] = readSheetTable(spreadsheet.getSheetByName(names[key]));
  }
  result.edicionesActivas = pruneStaleLocks(spreadsheet);
  return { status: "ok", data: result };
}

function writeCatalog(data, ss) {
  var spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();

  // Tombstones monotónicos: unir "Borrados" con lo existente (nunca se pierde uno) y
  // NO escribir filas cuyo id esté tombstoned (evita que una eliminación reviva).
  var existingDeleted = readSheetTable(spreadsheet.getSheetByName("Borrados")) || [];
  var deletedSet = {};
  var mergedDeleted = [];
  existingDeleted.concat(data.deletedIds || []).forEach(function(r) {
    var id = r && r.id != null ? String(r.id) : "";
    if (id && !deletedSet[id]) { deletedSet[id] = true; mergedDeleted.push({ id: id }); }
  });
  function dropDeleted(rows) {
    return (rows || []).filter(function(r) { return !(r && deletedSet[String(r.id)]); });
  }

  var sheets = {
    "Áreas":      { data: dropDeleted(data.areas),     cols: ["id","nombre","color"] },
    "Procesos":   { data: dropDeleted(data.processes), cols: ["id","area","subArea","nombre","disparador","ejecutores","version","ultimaModificacion"] },
    "Pasos":      { data: dropDeleted(data.steps),     cols: ["id","proceso","area","orden","nombre","areaResponsable","sourceId","transaccion","parentStepId","joinStepId","etiquetaRama","esUnion"] },
    "Fuentes":    { data: dropDeleted(data.sources),   cols: ["id","proceso","tipo","codigo","sistema"] },
    "Datos":      { data: dropDeleted(data.fields),    cols: ["id","sourceId","dato","significado","ejemplo","sensible","transaccion","proceso","area"] },
    "Roles":      { data: dropDeleted(data.roles),     cols: ["id","proceso","stepId","tipo","email","persona"] },
    "CatalogosDatos": { data: data.dataCatalogs, cols: ["id","nombre","descripcion","area","ultimaModificacion","version","historialVersiones"] },
    "ColumnasCatalogo": { data: data.catalogColumns, cols: ["id","catalogo","nombre","tipo","descripcion","productOwner","contexto","valoresPredefinidos","orden","requerido"] },
    "FilasCatalogo": { data: data.catalogRows, cols: ["id","catalogo","orden","valores"] },
    "Configuracion": { data: data.configuracion, cols: ["clave","valor"] },
    "Borrados":   { data: mergedDeleted, cols: ["id"] },
    "Personas":   { data: data.people, cols: ["email","nombre","foto"] },
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
      sheet.getRange(1, 1, 1, cols.length).setFontWeight("bold").setBackground("#6B7280").setFontColor("#FFFFFF");
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

// ============================ Router ============================
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var out = function(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); };

    if (body.action === "checkAuth")        return out(authCheck(ss));
    if (body.action === "bootstrapSuper")   return out(authBootstrapSuper(body, ss));
    if (body.action === "login")            return out(authLogin(body, ss));
    if (body.action === "logout")           return out(authLogout(body, ss));
    if (body.action === "validateSession")  return out(authValidateSession(body, ss));
    if (body.action === "registerUser")     return out(authRegisterUser(body, ss));
    if (body.action === "listUsers")        return out(authListUsers(body, ss));

    if (body.action === "load")             return out(readCatalog(ss));
    if (body.action === "acquireLock")      return out(acquireStepLock(body, ss));
    if (body.action === "releaseLock")      return out(releaseStepLock(body, ss));
    if (body.action === "releaseSession")   return out(releaseSessionLocks(body, ss));
    if (body.action === "heartbeat")        return out(heartbeatLocks(body, ss));

    // Cualquier otro POST = guardar catálogo completo (fusión la hace el cliente)
    writeCatalog(body, ss);
    return out({ status: "ok", timestamp: new Date().toISOString() });
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

## Después de pegar y redeployar

1. La **primera vez** que abras la app apuntando a este script, si no hay usuarios te pedirá **crear la cuenta de administrador** (super). A partir de ahí, entra a **Administración → Usuarios** para dar de alta editores.
2. Las cuentas semilla locales (admin@dacomsa.com / María) dejan de usarse: ahora manda el Sheet.
3. Hojas que crea solo: `Usuarios`, `Sesiones`, `EdicionesActivas`, `Borrados`, `Personas` (además de las de catálogo).
4. Acceso del deployment: **Ejecutar como: Yo** · **Quién tiene acceso: Cualquier usuario**.

## Seguridad
- Contraseñas en **hash SHA-256** (no texto plano).
- Solo el **super usuario** registra cuentas.
- Tokens de sesión expiran a los 30 días.
