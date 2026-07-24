"""
Backend de la app de Gobernanza sobre Databricks + Unity Catalog.

Reemplaza al Apps Script de Google Sheets manteniendo EXACTAMENTE el mismo
contrato JSON, para que el frontend React casi no cambie: solo apuntar
DACOMSA_SHEETS_URL al endpoint /api de esta app.

Acciones soportadas (POST /api con {"action": ...}):
  load, acquireLock, releaseLock, releaseSession, heartbeat,
  checkAuth, bootstrapSuper, login, logout, validateSession,
  registerUser, listUsers.
Un POST SIN acción reconocida = guardar catálogo (equivalente a writeCatalog).

Almacenamiento: tablas Delta en Unity Catalog (ver sql/schema.sql).
"""
import os
import hashlib
import time
import uuid
import datetime as dt

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from databricks import sql

# --------------------------------------------------------------------------
# Configuración
# --------------------------------------------------------------------------
CATALOG = os.environ.get("UC_CATALOG", "main")
SCHEMA = os.environ.get("UC_SCHEMA", "gobernanza")
HTTP_PATH = os.environ.get("DATABRICKS_HTTP_PATH", "")
HOST = os.environ.get("DATABRICKS_SERVER_HOSTNAME", "")
TOKEN = os.environ.get("DATABRICKS_TOKEN")  # en Apps lo provee el service principal
STATIC_DIR = os.environ.get("STATIC_DIR", "dist")

LOCK_TTL_MS = 90_000
SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

def tbl(name: str) -> str:
    return f"`{CATALOG}`.`{SCHEMA}`.`{name}`"

# Colecciones del catálogo: clave JSON -> (tabla, columnas, columna-llave)
CATALOG_TABLES = {
    "areas":          ("areas",           ["id", "nombre", "color"], "id"),
    "processes":      ("processes",        ["id", "area", "subArea", "nombre", "disparador", "ejecutores", "version", "ultimaModificacion"], "id"),
    "steps":          ("steps",            ["id", "proceso", "area", "orden", "nombre", "areaResponsable", "sourceId", "transaccion", "parentStepId", "joinStepId", "etiquetaRama", "esUnion"], "id"),
    "sources":        ("sources",          ["id", "proceso", "tipo", "codigo", "sistema"], "id"),
    "fields":         ("fields",           ["id", "sourceId", "dato", "significado", "ejemplo", "sensible", "transaccion", "proceso", "area"], "id"),
    "roles":          ("roles",            ["id", "proceso", "stepId", "tipo", "email", "persona"], "id"),
    "dataCatalogs":   ("data_catalogs",    ["id", "nombre", "descripcion", "area", "ultimaModificacion", "version", "historialVersiones"], "id"),
    "catalogColumns": ("catalog_columns",  ["id", "catalogo", "nombre", "tipo", "descripcion", "productOwner", "contexto", "valoresPredefinidos", "orden", "requerido"], "id"),
    "catalogRows":    ("catalog_rows",     ["id", "catalogo", "orden", "valores"], "id"),
    "configuracion":  ("configuracion",    ["clave", "valor"], "clave"),
    "people":         ("people",           ["email", "nombre", "foto"], "email"),
    "deletedIds":     ("deleted_ids",      ["id"], "id"),
}
# Tablas de contenido a las que aplican los tombstones (borrado por id).
TOMBSTONED = ["areas", "processes", "steps", "sources", "fields", "roles"]

# --------------------------------------------------------------------------
# Conexión a Unity Catalog (SQL Warehouse)
# --------------------------------------------------------------------------
def connect():
    return sql.connect(
        server_hostname=HOST,
        http_path=HTTP_PATH,
        access_token=TOKEN,
    )

def query(sqltext, params=None):
    with connect() as conn, conn.cursor() as cur:
        cur.execute(sqltext, params or [])
        cols = [c[0] for c in cur.description] if cur.description else []
        return [dict(zip(cols, row)) for row in cur.fetchall()]

def now_iso():
    return dt.datetime.utcnow().isoformat() + "Z"

def sha256_hex(text):
    return hashlib.sha256(str(text).encode("utf-8")).hexdigest()

# --------------------------------------------------------------------------
# Catálogo: leer y guardar
# --------------------------------------------------------------------------
def read_catalog():
    data = {}
    for key, (table, cols, _k) in CATALOG_TABLES.items():
        rows = query(f"SELECT {', '.join('`'+c+'`' for c in cols)} FROM {tbl(table)}")
        data[key] = rows
    data["edicionesActivas"] = prune_locks()
    return {"status": "ok", "data": data}

def write_catalog(body):
    with connect() as conn, conn.cursor() as cur:
        # 1) Tombstones monotónicos: unir los que llegan con los existentes.
        incoming_del = [str(d.get("id")) for d in (body.get("deletedIds") or []) if d.get("id")]
        existing_del = {r["id"] for r in query(f"SELECT id FROM {tbl('deleted_ids')}")}
        merged_del = existing_del.union(incoming_del)

        # 2) Upsert de cada colección (delete-by-id de lo entrante + insert).
        for key, (table, cols, keycol) in CATALOG_TABLES.items():
            if key == "deletedIds":
                continue
            rows = body.get(key) or []
            _upsert(cur, table, cols, keycol, rows)

        # 3) Persistir tombstones (overwrite de la tabla pequeña).
        cur.execute(f"DELETE FROM {tbl('deleted_ids')}")
        if merged_del:
            cur.executemany(
                f"INSERT INTO {tbl('deleted_ids')} (id) VALUES (?)",
                [[d] for d in merged_del],
            )
        # 4) Aplicar tombstones a las tablas de contenido (que no reviva nada).
        if merged_del:
            del_list = list(merged_del)
            for key in TOMBSTONED:
                table = CATALOG_TABLES[key][0]
                _delete_ids(cur, table, "id", del_list)
    return {"status": "ok", "timestamp": now_iso()}

def _upsert(cur, table, cols, keycol, rows):
    keys = [str(r.get(keycol)) for r in rows if r.get(keycol) not in (None, "")]
    if keys:
        _delete_ids(cur, table, keycol, keys)
    if rows:
        placeholders = ", ".join(["?"] * len(cols))
        cur.executemany(
            f"INSERT INTO {tbl(table)} ({', '.join('`'+c+'`' for c in cols)}) VALUES ({placeholders})",
            [[_s(r.get(c)) for c in cols] for r in rows],
        )

def _delete_ids(cur, table, keycol, ids):
    # Elimina en lotes para no pasarse del límite de la sentencia.
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        marks = ", ".join(["?"] * len(chunk))
        cur.execute(f"DELETE FROM {tbl(table)} WHERE `{keycol}` IN ({marks})", chunk)

def _s(v):
    return "" if v is None else str(v)

# --------------------------------------------------------------------------
# Colaboración: bloqueo por paso (Delta; ver nota sobre Lakebase para OLTP)
# --------------------------------------------------------------------------
def prune_locks():
    rows = query(f"SELECT * FROM {tbl('ediciones_activas')}")
    now = time.time() * 1000
    kept = []
    for r in rows:
        ts = _parse_ms(r.get("latido") or r.get("bloqueadoEn"))
        if ts and (now - ts) <= LOCK_TTL_MS:
            kept.append(r)
    if len(kept) != len(rows):
        _rewrite_locks(kept)
    return kept

def _rewrite_locks(rows):
    cols = ["id", "sessionId", "usuario", "email", "processId", "stepId", "bloqueadoEn", "latido"]
    with connect() as conn, conn.cursor() as cur:
        cur.execute(f"DELETE FROM {tbl('ediciones_activas')}")
        if rows:
            cur.executemany(
                f"INSERT INTO {tbl('ediciones_activas')} ({', '.join('`'+c+'`' for c in cols)}) VALUES ({', '.join(['?']*len(cols))})",
                [[_s(r.get(c)) for c in cols] for r in rows],
            )

def acquire_lock(b):
    locks = prune_locks()
    pid, sid, sess = str(b.get("processId", "")), str(b.get("stepId", "")), str(b.get("sessionId", ""))
    existing = next((l for l in locks if str(l["processId"]) == pid and str(l["stepId"]) == sid), None)
    if existing and str(existing["sessionId"]) != sess:
        return {"status": "locked", "lock": existing}
    now = now_iso()
    if existing:
        existing["latido"] = now
        _rewrite_locks(locks)
        return {"status": "ok", "lock": existing}
    row = {"id": str(uuid.uuid4()), "sessionId": sess, "usuario": _s(b.get("usuario")),
           "email": _s(b.get("email")), "processId": pid, "stepId": sid, "bloqueadoEn": now, "latido": now}
    locks.append(row)
    _rewrite_locks(locks)
    return {"status": "ok", "lock": row}

def release_lock(b):
    pid, sid, sess = str(b.get("processId", "")), str(b.get("stepId", "")), str(b.get("sessionId", ""))
    kept = [l for l in prune_locks() if not (str(l["processId"]) == pid and str(l["stepId"]) == sid and str(l["sessionId"]) == sess)]
    _rewrite_locks(kept)
    return {"status": "ok"}

def release_session(b):
    sess = str(b.get("sessionId", ""))
    kept = [l for l in prune_locks() if str(l["sessionId"]) != sess]
    _rewrite_locks(kept)
    return {"status": "ok"}

def heartbeat(b):
    sess = str(b.get("sessionId", ""))
    now = now_iso()
    rows = prune_locks()
    touched = False
    for r in rows:
        if str(r["sessionId"]) == sess:
            r["latido"] = now
            touched = True
    if touched:
        _rewrite_locks(rows)
    return {"status": "ok"}

def _parse_ms(iso):
    if not iso:
        return None
    try:
        return dt.datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp() * 1000
    except Exception:
        return None

# --------------------------------------------------------------------------
# Autenticación (tablas users/sessions). Alternativa: identidad nativa DBX.
# --------------------------------------------------------------------------
def _public_user(u):
    return {"id": u["id"], "nombre": u["nombre"], "email": u["email"], "rol": u["rol"],
            "activo": str(u.get("activo")).lower() != "false"}

def _find_user_email(email):
    e = str(email or "").strip().lower()
    rows = query(f"SELECT * FROM {tbl('users')} WHERE lower(email) = ?", [e])
    return rows[0] if rows else None

def _create_session(user_id):
    token = uuid.uuid4().hex + uuid.uuid4().hex
    exp = (dt.datetime.utcnow() + dt.timedelta(milliseconds=SESSION_TTL_MS)).isoformat() + "Z"
    with connect() as conn, conn.cursor() as cur:
        cur.execute(f"INSERT INTO {tbl('sessions')} (token, userId, expiraEn, creadoEn) VALUES (?,?,?,?)",
                    [token, user_id, exp, now_iso()])
    return token

def _user_from_token(token):
    if not token:
        return None
    rows = query(f"SELECT * FROM {tbl('sessions')} WHERE token = ?", [token])
    if not rows:
        return None
    exp = _parse_ms(rows[0].get("expiraEn"))
    if not exp or exp < time.time() * 1000:
        return None
    urows = query(f"SELECT * FROM {tbl('users')} WHERE id = ?", [rows[0]["userId"]])
    if not urows or str(urows[0].get("activo")).lower() == "false":
        return None
    return _public_user(urows[0])

def auth_check():
    n = query(f"SELECT count(*) AS c FROM {tbl('users')}")[0]["c"]
    return {"status": "ok", "needsBootstrap": int(n) == 0}

def auth_bootstrap(b):
    n = query(f"SELECT count(*) AS c FROM {tbl('users')}")[0]["c"]
    if int(n) > 0:
        return {"status": "error", "message": "Ya existe un super usuario"}
    email, nombre, pw = str(b.get("email", "")).strip().lower(), str(b.get("nombre", "")).strip(), str(b.get("password", ""))
    if not (email and nombre and pw):
        return {"status": "error", "message": "Datos incompletos"}
    uid = str(uuid.uuid4())
    with connect() as conn, conn.cursor() as cur:
        cur.execute(f"INSERT INTO {tbl('users')} (id,nombre,email,passwordHash,rol,activo,creadoEn,creadoPor) VALUES (?,?,?,?,?,?,?,?)",
                    [uid, nombre, email, sha256_hex(pw), "super", "true", now_iso(), "bootstrap"])
    return {"status": "ok", "token": _create_session(uid), "user": {"id": uid, "nombre": nombre, "email": email, "rol": "super", "activo": True}}

def auth_login(b):
    email, pw = str(b.get("email", "")).strip().lower(), str(b.get("password", ""))
    u = _find_user_email(email)
    if not u or str(u.get("activo")).lower() == "false" or u["passwordHash"] != sha256_hex(pw):
        return {"status": "error", "message": "Correo o contraseña incorrectos"}
    return {"status": "ok", "token": _create_session(u["id"]), "user": _public_user(u)}

def auth_logout(b):
    with connect() as conn, conn.cursor() as cur:
        cur.execute(f"DELETE FROM {tbl('sessions')} WHERE token = ?", [str(b.get("token", ""))])
    return {"status": "ok"}

def auth_validate(b):
    u = _user_from_token(b.get("token"))
    return {"status": "ok", "user": u} if u else {"status": "error", "message": "Sesión inválida"}

def auth_register(b):
    caller = _user_from_token(b.get("token"))
    if not caller or caller["rol"] != "super":
        return {"status": "error", "message": "Sin permiso"}
    email, nombre, pw = str(b.get("email", "")).strip().lower(), str(b.get("nombre", "")).strip(), str(b.get("password", ""))
    rol = "super" if b.get("rol") == "super" else "editor"
    if not (email and nombre and pw):
        return {"status": "error", "message": "Datos incompletos"}
    if _find_user_email(email):
        return {"status": "error", "message": "Ese correo ya existe"}
    with connect() as conn, conn.cursor() as cur:
        cur.execute(f"INSERT INTO {tbl('users')} (id,nombre,email,passwordHash,rol,activo,creadoEn,creadoPor) VALUES (?,?,?,?,?,?,?,?)",
                    [str(uuid.uuid4()), nombre, email, sha256_hex(pw), rol, "true", now_iso(), caller["email"]])
    return {"status": "ok"}

def auth_list_users(b):
    caller = _user_from_token(b.get("token"))
    if not caller or caller["rol"] != "super":
        return {"status": "error", "message": "Sin permiso"}
    return {"status": "ok", "users": [_public_user(u) for u in query(f"SELECT * FROM {tbl('users')}")]}

# --------------------------------------------------------------------------
# Router (mismo contrato que el Apps Script)
# --------------------------------------------------------------------------
ROUTES = {
    "load": lambda b: read_catalog(),
    "checkAuth": lambda b: auth_check(),
    "bootstrapSuper": auth_bootstrap,
    "login": auth_login,
    "logout": auth_logout,
    "validateSession": auth_validate,
    "registerUser": auth_register,
    "listUsers": auth_list_users,
    "acquireLock": acquire_lock,
    "releaseLock": release_lock,
    "releaseSession": release_session,
    "heartbeat": heartbeat,
}

app = FastAPI(title="Gobernanza · Unity Catalog backend")

# CORS abierto para desarrollo (el frontend en :5173 pegándole a :8000).
# En producción, al servir dist/ desde la misma App, es mismo-origen y no aplica.
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

@app.post("/api")
async def api(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    action = body.get("action")
    try:
        if action in ROUTES:
            return JSONResponse(ROUTES[action](body))
        # Sin acción reconocida => guardar catálogo (equivale a writeCatalog).
        return JSONResponse(write_catalog(body))
    except Exception as err:  # noqa: BLE001
        return JSONResponse({"status": "error", "message": str(err)})

@app.get("/api")
async def api_get():
    # Fallback GET que usa el cliente para load.
    try:
        return JSONResponse(read_catalog())
    except Exception as err:  # noqa: BLE001
        return JSONResponse({"status": "error", "message": str(err)})

@app.get("/healthz")
async def healthz():
    return {"ok": True}

# Sirve el build de React (dist/) como estáticos en la raíz.
if os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
