# Desplegar como Databricks App **desde la UI** (sin CLI)

Guía paso a paso para publicar la app en un workspace de Azure Databricks
usando solo la interfaz web. El frontend se sirve desde la propia App (necesario
para que funcione el SSO de Microsoft).

## Paso 0 — Compilar el frontend dentro de la carpeta de la app
En tu compu, en la raíz del proyecto:

```bash
npm install
npm run build:databricks
```

Esto genera el build de React directamente en `databricks/dist/`. La carpeta
`databricks/` queda lista para subir:

```
databricks/
  app.yaml
  requirements.txt
  server/  (main.py, __init__.py)
  dist/    <-- build del frontend (generado)
```

## Paso 1 — Crear las tablas en Unity Catalog
En Databricks → **SQL Editor**, pega y ejecuta `databricks/sql/schema.sql`.
Si tu catálogo no es `main`, reemplázalo en el archivo antes de correrlo.

## Paso 2 — Subir el código al Workspace
En Databricks → **Workspace** → crea una carpeta (p. ej. `gobernanza-app`) →
botón **Import** / arrastrar → sube el **contenido de `databricks/`**
(incluyendo `dist/`). Debe quedar `app.yaml` en la raíz de esa carpeta.

> Alternativa: **Create → Git folder** con el repo `BussinesFederation`, rama
> `feat/databricks-unity-catalog`. Como `dist/` está en `.gitignore`, tras
> clonar **sube `dist/` a mano** dentro de la carpeta.

## Paso 3 — Crear la App
1. Barra lateral → **Compute** → pestaña **Apps** → **Create app**.
2. Tipo: **Custom** (traer tu propio código).
3. Nombre: `gobernanza`.
4. **Source code path**: la carpeta del Workspace donde está `app.yaml`.

## Paso 4 — Recurso: SQL Warehouse
En la config de la App → **Resources** → **Add resource → SQL warehouse** →
elige tu warehouse (serverless recomendado) → permiso **CAN_USE**.
Esto conecta la App vía su **service principal** (sin token manual).

## Paso 5 — Variables de entorno
En la config de la App (vienen de `app.yaml`, edítalas aquí si hace falta):
- `UC_CATALOG` = tu catálogo (ej. `main`)
- `UC_SCHEMA` = `gobernanza`
- `SUPER_EMAILS` = tu correo (para entrar como super)
- `STATIC_DIR` = `dist`

## Paso 6 — Deploy
Botón **Deploy**. Espera a **Running** y copia la **URL**
(`https://<app>.databricksapps.com`).

## Paso 7 — Permisos en Unity Catalog
En SQL Editor, otorga acceso al **service principal de la App** (su nombre
aparece en la config de la App):

```sql
GRANT USE CATALOG ON CATALOG main TO `<app-service-principal>`;
GRANT USE SCHEMA, SELECT, MODIFY ON SCHEMA main.gobernanza TO `<app-service-principal>`;
```

## Paso 8 — Abrir
Entra a la URL. Al ser Azure Databricks ya vienes autenticado con **Microsoft
(SSO)** → la app hace **login automático**. Como tu correo está en
`SUPER_EMAILS`, entras como **super** y puedes dar de alta/roles en
**Administración → Usuarios**.

---

## Actualizar la app después de cambios
1. `npm run build:databricks` (regenera `dist/`).
2. Vuelve a subir la carpeta al Workspace (o `git pull` en el Git folder + subir `dist/`).
3. En la App → **Deploy** de nuevo.

## Notas
- El frontend **debe** servirse desde la App (no desde Vercel): el SSO de
  Microsoft solo llega en los headers cuando abres la app vía Databricks.
- Colaboración/locks corren en Delta (polling ~5s). Para más "vivo", migrar el
  estado efímero a Lakebase (ver README.md).
