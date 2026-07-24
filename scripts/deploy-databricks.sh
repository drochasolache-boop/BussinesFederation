#!/usr/bin/env bash
# Despliega la app como Databricks App con un comando.
#   ./scripts/deploy-databricks.sh dev        (o prod)
#
# Requiere: Node/npm, Databricks CLI v0.230+ (databricks auth login) y el
# esquema de Unity Catalog ya creado (databricks/sql/schema.sql).
set -euo pipefail

TARGET="${1:-dev}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> 1/3 Build del frontend (Vite)"
npm run build

echo "==> 2/3 Copiando build a databricks/dist"
rm -rf databricks/dist
cp -r dist databricks/dist

echo "==> 3/3 Desplegando bundle (target: $TARGET)"
databricks bundle deploy -t "$TARGET"
databricks bundle run gobernanza_app -t "$TARGET"

echo "==> Listo. Revisa la URL de la App en Databricks (Compute -> Apps)."
