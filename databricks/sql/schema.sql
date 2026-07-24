-- ============================================================================
-- Unity Catalog — esquema de gobernanza (reemplaza las hojas de Google Sheets)
-- Ejecuta esto en un SQL Editor / Notebook de Databricks.
-- Cambia `main` por tu catálogo si usas otro (p. ej. `gobernanza_prod`).
-- Los nombres de columna coinciden con las claves JSON que espera el frontend,
-- para que el backend pueda devolverlas casi sin transformación.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS main.gobernanza
  COMMENT 'Catálogo de gobernanza de datos (POC Frasle)';

-- ---- Catálogo de procesos -------------------------------------------------
CREATE TABLE IF NOT EXISTS main.gobernanza.areas (
  id STRING, nombre STRING, color STRING
) USING DELTA;

CREATE TABLE IF NOT EXISTS main.gobernanza.processes (
  id STRING, area STRING, subArea STRING, nombre STRING, disparador STRING,
  ejecutores STRING, version STRING, ultimaModificacion STRING
) USING DELTA;

CREATE TABLE IF NOT EXISTS main.gobernanza.steps (
  id STRING, proceso STRING, area STRING, orden STRING, nombre STRING,
  areaResponsable STRING, sourceId STRING, transaccion STRING,
  parentStepId STRING, joinStepId STRING, etiquetaRama STRING, esUnion STRING
) USING DELTA;

CREATE TABLE IF NOT EXISTS main.gobernanza.sources (
  id STRING, proceso STRING, tipo STRING, codigo STRING, sistema STRING
) USING DELTA;

CREATE TABLE IF NOT EXISTS main.gobernanza.fields (
  id STRING, sourceId STRING, dato STRING, significado STRING, ejemplo STRING,
  sensible STRING, transaccion STRING, proceso STRING, area STRING
) USING DELTA;

CREATE TABLE IF NOT EXISTS main.gobernanza.roles (
  id STRING, proceso STRING, stepId STRING, tipo STRING, email STRING, persona STRING
) USING DELTA;

CREATE TABLE IF NOT EXISTS main.gobernanza.data_catalogs (
  id STRING, nombre STRING, descripcion STRING, area STRING,
  ultimaModificacion STRING, version STRING, historialVersiones STRING
) USING DELTA;

CREATE TABLE IF NOT EXISTS main.gobernanza.catalog_columns (
  id STRING, catalogo STRING, nombre STRING, tipo STRING, descripcion STRING,
  productOwner STRING, contexto STRING, valoresPredefinidos STRING,
  orden STRING, requerido STRING
) USING DELTA;

CREATE TABLE IF NOT EXISTS main.gobernanza.catalog_rows (
  id STRING, catalogo STRING, orden STRING, valores STRING
) USING DELTA;

CREATE TABLE IF NOT EXISTS main.gobernanza.configuracion (
  clave STRING, valor STRING
) USING DELTA;

-- ---- Personas (directorio: nombre + foto por email) -----------------------
CREATE TABLE IF NOT EXISTS main.gobernanza.people (
  email STRING, nombre STRING, foto STRING
) USING DELTA;

-- ---- Tombstones (borrados monotónicos: nunca se pierden) ------------------
CREATE TABLE IF NOT EXISTS main.gobernanza.deleted_ids (
  id STRING
) USING DELTA;

-- ---- Colaboración: bloqueo por paso (estado efímero) ----------------------
-- Nota: Delta es OLAP; para muchos locks/heartbeats conviene Lakebase (OLTP).
-- Aquí se deja en Delta para el POC (polling ~5s, pocos usuarios).
CREATE TABLE IF NOT EXISTS main.gobernanza.ediciones_activas (
  id STRING, sessionId STRING, usuario STRING, email STRING,
  processId STRING, stepId STRING, bloqueadoEn STRING, latido STRING
) USING DELTA;

-- ---- Roles de usuario (SSO / Entra ID) ------------------------------------
-- Con login nativo de Databricks (SSO) no guardamos contraseñas: la identidad
-- (email/nombre) viene de Databricks. Aquí solo mapeamos email -> rol.
CREATE TABLE IF NOT EXISTS main.gobernanza.user_roles (
  email STRING, nombre STRING, rol STRING, creadoEn STRING, creadoPor STRING
) USING DELTA;
