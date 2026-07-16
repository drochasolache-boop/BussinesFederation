# Conectar con Google Sheets — Guía paso a paso

Esta guía te permite sincronizar automáticamente los datos de gobernanza a un Google Sheet. Cada vez que guardes un proceso, el Sheet se actualiza solo.

## Paso 1: Crear el Google Sheet

1. Ve a [sheets.google.com](https://sheets.google.com) y crea una hoja nueva
2. Nómbrala "Gobernanza de datos" (o como prefieras)
3. **No crees hojas manualmente** — el script las crea automáticamente

## Paso 2: Abrir el editor de Apps Script

1. En tu Google Sheet, ve a **Extensiones → Apps Script**
2. Se abre un editor de código. Borra todo el contenido que tenga
3. Pega el siguiente código **completo**:

```javascript
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
    if (!sheet || sheet.getLastRow() < 2) { result[key] = []; continue; }
    var values = sheet.getDataRange().getValues();
    var headers = values[0];
    result[key] = [];
    for (var i = 1; i < values.length; i++) {
      var row = {};
      for (var j = 0; j < headers.length; j++) {
        row[headers[j]] = values[i][j];
      }
      result[key].push(row);
    }
  }
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
      sheet.getRange(1, 1, 1, cols.length)
        .setFontWeight("bold")
        .setBackground("#4285F4")
        .setFontColor("#FFFFFF");
    }
    if (rows.length > 0) {
      var matrix = rows.map(function(row) {
        return cols.map(function(col) {
          var val = row[col];
          return val !== undefined && val !== null ? val : "";
        });
      });
      sheet.getRange(2, 1, matrix.length, cols.length).setValues(matrix);
    }
    for (var i = 1; i <= cols.length; i++) sheet.autoResizeColumn(i);
  }

  var defaultNames = ["Sheet1", "Hoja 1", "Hoja1"];
  defaultNames.forEach(function(dn) {
    var def = spreadsheet.getSheetByName(dn);
    if (def && spreadsheet.getSheets().length > 1) {
      try { spreadsheet.deleteSheet(def); } catch(e) {}
    }
  });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    if (body.action === "load") {
      return ContentService.createTextOutput(
        JSON.stringify(readCatalog(ss))
      ).setMimeType(ContentService.MimeType.JSON);
    }

    writeCatalog(body, ss);
    return ContentService.createTextOutput(
      JSON.stringify({ status: "ok", timestamp: new Date().toISOString() })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ status: "error", message: err.toString() })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

// Test manual: abre la URL en el navegador
function doGet(e) {
  return ContentService.createTextOutput(
    JSON.stringify(readCatalog())
  ).setMimeType(ContentService.MimeType.JSON);
}
```

4. Guarda el proyecto (Ctrl+S). Ponle nombre "Gobernanza Sync" o similar.

## Paso 3: Desplegar como Web App

1. En Apps Script, haz click en **Implementar → Nueva implementación**
2. En "Tipo", selecciona **App web**
3. Configura:
   - **Descripción**: "Sync gobernanza"
   - **Ejecutar como**: **Yo** (tu cuenta)
   - **Quién tiene acceso**: **Cualquier persona** (necesario para que la app le envíe datos sin autenticar)
4. Click en **Implementar**
5. **Copia la URL** que te da (empieza con `https://script.google.com/macros/s/...`)

## Paso 4: Listo — la app ya está conectada

Cada **empresa** tiene su propio Google Sheet y su URL de Web App. En `src/App.jsx`, el array `TENANTS` define los entornos. Pega la URL del Web App en `sheetsUrl` de cada una.

Si re-despliegas el script (por actualizaciones), actualiza la URL correspondiente en `TENANTS`.

### Login y colaboración multi-usuario

Para **login**, registro de editores (solo super usuario) y colaboración con bloqueo de pasos, usa el script unificado en **[APPS-SCRIPT-AUTH-LOGIN.md](./APPS-SCRIPT-AUTH-LOGIN.md)** y vuelve a desplegar.

(Si solo necesitas bloqueo de pasos sin login, sigue [APPS-SCRIPT-COLABORACION.md](./APPS-SCRIPT-COLABORACION.md).)

El Sheet tendrá estas hojas y la app las lee al abrir y las escribe en cada cambio:

| Hoja | Contenido |
|---|---|
| **Configuracion** | Marca de la empresa: nombre, logo (base64), banner, color, tema |
| **Áreas** | Áreas con su color |
| **Procesos** | Nombre, área, subárea, disparador, ejecutores, versión, fecha |
| **Pasos** | Cada paso con su proceso, orden y área responsable |
| **Fuentes** | Transacciones/archivos con tipo y código |
| **Datos** | Campos documentados con significado, ejemplo y sensibilidad |
| **Roles** | Responsables por paso con rol y email |
| **CatalogosDatos** | Catálogos de datos fuera de SAP (versión e historial en JSON) |
| **ColumnasCatalogo** | Definición de columnas (tipo, owner, contexto) |
| **FilasCatalogo** | Registros del catálogo (valores en JSON) |
| **EdicionesActivas** | Bloqueos de paso en edición (colaboración) |
| **Usuarios** | Cuentas de login (super / editor) |
| **Sesiones** | Tokens de sesión activos |

## Notas

- Los datos se **sobrescriben completos** en cada sync (no es incremental). Esto garantiza consistencia.
- Si cambias algo directo en el Sheet, se sobreescribirá en el siguiente sync desde la app.
- El **logo** se guarda en `Configuracion` como texto base64 (`data:image/...`). Usa imágenes pequeñas (&lt; 100 KB); Google Sheets limita ~50 000 caracteres por celda.
- Para una segunda empresa: crea otro Sheet, despliega el mismo script y pega su URL en `TENANTS[1].sheetsUrl`.
- Si re-despliegas el script (por actualizaciones), la URL puede cambiar — actualiza `TENANTS` en `src/App.jsx`.
- El sync usa `mode: "no-cors"` así que no verás errores en consola aunque funcione bien. Para verificar, revisa el Sheet después de guardar un proceso.
