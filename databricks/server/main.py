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
# Autenticación por identidad de Databricks (SSO / Microsoft Entra ID).
# La Databricks App ya autentica al usuario; leemos su identidad de los
# headers y mapeamos email -> rol en la tabla `user_roles` (sin contraseñas).
# SUPER_EMAILS (env, separado por comas) define quién es super por defecto.
# --------------------------------------------------------------------------
SUPER_EMAILS = {e.strip().lower() for e in os.environ.get("SUPER_EMAILS", "").split(",") if e.strip()}

def identity(request):
    h = request.headers
    email = (h.get("X-Forwarded-Email") or h.get("X-Forwarded-Preferred-Username")
             or h.get("X-Forwarded-User") or "").strip().lower()
    name = h.get("X-Forwarded-Preferred-Username") or (email.split("@")[0] if email else "")
    return email, name

def _roles_count():
    return int(query(f"SELECT count(*) AS c FROM {tbl('user_roles')}")[0]["c"])

def _role_for(email):
    rows = query(f"SELECT * FROM {tbl('user_roles')} WHERE lower(email) = ?", [email])
    return (rows[0]["rol"], rows[0].get("nombre") or "") if rows else (None, None)

def ensure_user(email, name):
    if not email:
        return None
    rol, nombre = _role_for(email)
    if rol:
        return {"id": email, "email": email, "nombre": nombre or name, "rol": rol, "activo": True}
    # Nuevo: super si está en SUPER_EMAILS o si aún no hay ninguno; si no, editor.
    rol = "super" if (email in SUPER_EMAILS or _roles_count() == 0) else "editor"
    with connect() as conn, conn.cursor() as cur:
        cur.execute(f"INSERT INTO {tbl('user_roles')} (email,nombre,rol,creadoEn,creadoPor) VALUES (?,?,?,?,?)",
                    [email, name, rol, now_iso(), "sso"])
    return {"id": email, "email": email, "nombre": name, "rol": rol, "activo": True}

def _caller_is_super(request):
    email, name = identity(request)
    u = ensure_user(email, name)
    return bool(u and u["rol"] == "super")

def auth_check(request):
    # Con SSO no hay bootstrap manual: la identidad la da Databricks/Entra.
    return {"status": "ok", "needsBootstrap": False, "sso": True}

def sso_login(request):
    email, name = identity(request)
    if not email:
        return {"status": "error", "message": "Sin identidad de Databricks (SSO)"}
    return {"status": "ok", "token": email, "user": ensure_user(email, name)}

def auth_validate(request):
    email, name = identity(request)
    if not email:
        return {"status": "error", "message": "Sesión inválida"}
    return {"status": "ok", "user": ensure_user(email, name)}

def auth_logout(request):
    # El cierre real de sesión lo maneja Databricks/Entra ID.
    return {"status": "ok"}

def auth_register(request, b):
    if not _caller_is_super(request):
        return {"status": "error", "message": "Sin permiso"}
    email = str(b.get("email", "")).strip().lower()
    nombre = str(b.get("nombre", "")).strip()
    rol = "super" if b.get("rol") == "super" else "editor"
    if not email:
        return {"status": "error", "message": "Correo requerido"}
    with connect() as conn, conn.cursor() as cur:
        cur.execute(f"DELETE FROM {tbl('user_roles')} WHERE lower(email) = ?", [email])
        cur.execute(f"INSERT INTO {tbl('user_roles')} (email,nombre,rol,creadoEn,creadoPor) VALUES (?,?,?,?,?)",
                    [email, nombre, rol, now_iso(), "assign"])
    return {"status": "ok"}

def auth_list_users(request, b):
    if not _caller_is_super(request):
        return {"status": "error", "message": "Sin permiso"}
    rows = query(f"SELECT email, nombre, rol FROM {tbl('user_roles')}")
    users = [{"id": r["email"], "email": r["email"], "nombre": r.get("nombre") or "",
              "rol": r["rol"], "activo": True} for r in rows]
    return {"status": "ok", "users": users}

# --------------------------------------------------------------------------
# Router (mismo contrato que el Apps Script)
# --------------------------------------------------------------------------
# Cada handler recibe (body, request). Los de catálogo/locks ignoran request.
ROUTES = {
    "load": lambda b, r: read_catalog(),
    "checkAuth": lambda b, r: auth_check(r),
    # Con SSO, login/bootstrap/validate derivan la identidad de Databricks.
    "login": lambda b, r: sso_login(r),
    "ssoLogin": lambda b, r: sso_login(r),
    "bootstrapSuper": lambda b, r: sso_login(r),
    "logout": lambda b, r: auth_logout(r),
    "validateSession": lambda b, r: auth_validate(r),
    "registerUser": lambda b, r: auth_register(r, b),
    "listUsers": lambda b, r: auth_list_users(r, b),
    "acquireLock": lambda b, r: acquire_lock(b),
    "releaseLock": lambda b, r: release_lock(b),
    "releaseSession": lambda b, r: release_session(b),
    "heartbeat": lambda b, r: heartbeat(b),
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
            return JSONResponse(ROUTES[action](body, request))
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
