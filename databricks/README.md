# Backend Databricks + Unity Catalog

Reemplaza el Apps Script de Google Sheets por un backend **FastAPI** sobre
**Unity Catalog**, manteniendo el mismo contrato JSON. El frontend React casi no
cambia: solo se apunta `DACOMSA_SHEETS_URL` al `/api` de esta app.

## Estructura
- `sql/schema.sql` — DDL de las tablas Delta en Unity Catalog.
- `server/main.py` — FastAPI: rutea las mismas acciones (`load`, push, `login`, locks…).
- `app.yaml` — configuración de Databricks Apps.
- `requirements.txt` — dependencias Python.

## 1. Crear las tablas
En un SQL Editor / Notebook de Databricks, ejecuta `sql/schema.sql`.
Cambia `main` por tu catálogo si usas otro.

## 2. Probar en local
```bash
cd databricks
python -m venv .venv && . .venv/Scripts/activate   # (Windows: .venv\Scripts\activate)
pip install -r requirements.txt

export DATABRICKS_SERVER_HOSTNAME="<workspace>.cloud.databricks.com"
export DATABRICKS_HTTP_PATH="/sql/1.0/warehouses/<warehouse_id>"
export DATABRICKS_TOKEN="<personal_access_token>"
export UC_CATALOG="main" UC_SCHEMA="gobernanza"
export STATIC_DIR="../dist"        # build de React (opcional en dev)

uvicorn server.main:app --reload --port 8000
```
Prueba: `curl -X POST localhost:8000/api -d '{"action":"checkAuth"}'`
→ `{"status":"ok","needsBootstrap":true}`

## 3. Conectar el frontend
En `src/App.jsx`, cambia `DACOMSA_SHEETS_URL` a la URL del backend + `/api`:
```js
const DACOMSA_SHEETS_URL = "https://<tu-app>.databricksapps.com/api";
// En local: "http://localhost:8000/api"
```
El resto del cliente funciona igual (mismas acciones y formato de filas).

> ¿Prefieres desplegar **desde la UI** (sin CLI)? Sigue **`DEPLOY-UI.md`** —
> solo compila con `npm run build:databricks` y sube la carpeta al Workspace.

## 4. Desplegar con un comando (Asset Bundle) — recomendado
Con el **Databricks CLI v0.230+** autenticado (`databricks auth login`) y el
esquema ya creado:

1. Edita `databricks.yml` (en la raíz): pon tu `warehouse_id`, `uc_catalog`,
   `super_emails` y el `host` del workspace en el target `dev`/`prod`.
2. Ejecuta:
   ```bash
   ./scripts/deploy-databricks.sh dev      # build + copia dist + bundle deploy + run
   ```
   (En Windows con Git Bash funciona igual; o corre los pasos del script a mano.)
3. Toma la URL de la App en Databricks (**Compute → Apps**).
4. Da permisos al service principal de la App sobre el esquema (ver Fase 7 abajo).

## 4-bis. Desplegar manual como Databricks App
1. `npm run build` (genera `dist/`).
2. Sube este directorio + `dist/` a Databricks (Workspace o repo) y crea una
   **Databricks App** apuntando a `app.yaml`.
3. Asocia un **SQL Warehouse** (serverless con auto-stop) como recurso y
   otorga al **service principal** de la App permisos SELECT/MODIFY sobre
   `main.gobernanza`.
4. La App queda en `https://<app>.databricksapps.com` sirviendo el frontend y `/api`.

## Diferencias vs. Google Sheets (a tener en cuenta)
- **Escritura**: hoy el push manda el catálogo completo; el backend hace
  upsert por id + aplica tombstones. Siguiente paso: MERGE por entidad para
  reducir costo/latencia.
- **Colaboración/locks**: viven en una tabla Delta. Delta es OLAP: para muchos
  locks/heartbeats conviene mover el estado efímero a **Databricks Lakebase
  (Postgres OLTP)**. Con polling (~5s) y pocos usuarios, Delta sirve para el POC.
- **Auth (SSO / Microsoft Entra ID)**: ya NO hay contraseñas. La Databricks App
  autentica con Entra ID; el backend lee la identidad de los headers
  (`X-Forwarded-Email`) y mapea email → rol en la tabla `user_roles`. El
  frontend hace **login automático** (acción `ssoLogin`) sin pantalla de login.
  - Configura `SUPER_EMAILS` (env, separado por comas) con los correos que deben
    ser **super** por defecto; el resto entran como `editor`. Si la tabla está
    vacía, el primer usuario que entra queda como super.
  - Un super puede reasignar roles desde **Administración → Usuarios** (acción
    `registerUser`, que ahora asigna rol por email, sin contraseña).

## Pendientes (roadmap)
- [ ] MERGE por proceso/paso en lugar de upsert masivo.
- [ ] Estado de colaboración en Lakebase (OLTP) para menor latencia.
- [ ] Auth nativa de Databricks (headers de identidad) en vez de tablas propias.
- [ ] Permisos de UC por área/proceso (aprovechar governance de Unity Catalog).
