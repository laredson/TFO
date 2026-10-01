# Instalar TFO 1.0.0-rc.2

Este archivo acompaña al candidato local para Windows/Codex. Extrae el ZIP completo en una carpeta estable llamada TFO. Conserva la estructura, incluida .agents/plugins/marketplace.json.

Desde PowerShell 7, dentro de la carpeta extraída, ejecuta:

```powershell
./scripts/install-local.ps1
```

El script reconstruye el paquete, registra el catálogo local tfo-local e instala tfo@tfo-local. Conserva copias de una instalación TFO anterior en .tfo/rollback. No sustituye ni elimina otro paquete, no importa datos por su cuenta y no cambia la confianza de hooks. Comprueba el complemento en un chat nuevo; la aplicación puede requerir recargar el MCP. Revisa los hooks mediante la interfaz normal del host.

Usa un chat nuevo para cargar la skill y herramientas nuevas. La aprobación normal de hooks es independiente de instalar el paquete. Esta versión es un candidato público, no la versión estable.

## Datos anteriores

Cierra los supervisores de la instalación antigua. El importador rechaza datos activos o ambiguos y destinos existentes. Elige una carpeta destino nueva y ejecuta:

```powershell
node scripts/import-legacy.mjs --source-data-dir 'RUTA_DE_DATOS_ANTERIORES' --target-data-dir 'RUTA_NUEVA_TFO'
```

Solo activa los ajustes validados. El historial queda bajo migration-archive, literal e inactivo; no se reanudan colas. El origen permanece intacto. El destino de uso normal del nuevo motor es LOCALAPPDATA/TFO/data y puede configurarse con TFO_DATA_DIR. Usa una carpeta nueva si el destino predeterminado ya existe.

## Recuperación

Conserva el paquete anterior y sus datos hasta completar una prueba en vivo. Si TFO no funciona, deja sus rutas detenidas y vuelve a activar el paquete anterior mediante Codex. No actives dos supervisores sobre los mismos chats ni mezcles sus directorios de datos. Las copias de .tfo/rollback permiten conservar paquetes; no equivalen a una reversión automática de la configuración global.

## Paquete portable

El archivo tfo-1.0.0-rc.2-portable.zip contiene una sola carpeta tfo con plugin.json y mcp.json portables. Está preparado para la futura carga en complementos. Usa el archivo local para la instalación en Codex: el formato portable cambia el descubrimiento de hooks en el host local actual. No implica compatibilidad de orquestación con ChatGPT Projects.
