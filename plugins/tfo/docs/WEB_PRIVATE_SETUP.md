# TFO: preparación web privada

El paquete incluye runtime/web-server.mjs, una entrada separada de la ejecución local de Codex. Guarda hasta 20 prompts con sus etiquetas de modelo/esfuerzo y la URL de conversación; permite consultar y cancelar el plan. Los datos se guardan en LOCALAPPDATA/TFO/web-data y pueden configurarse con TFO_WEB_DATA_DIR.

En esta beta los planes web quedan en awaiting_host_adapter: no se envían prompts, no se crean chats y no se seleccionan modelos. Tener una conexión MCP o mostrar el panel no demuestra orquestación de ChatGPT Projects.

Desde la carpeta de TFO se puede ejecutar un diagnóstico local que no abre conexiones:

```powershell
pwsh -NoProfile -File ./scripts/configure-web-tunnel.ps1
```

El script informa de Node, de la entrada web y de la presencia de tunnel-client. La configuración real de una cuenta/túnel y sus requisitos de acceso quedan fuera de la validación de esta beta. Deben comprobarse con la documentación vigente del proveedor antes de conectar. Nunca publicar runtime/server.mjs mediante un túnel: contiene herramientas de ejecución local.

El servidor web usa almacenamiento separado, no importa la ejecución local de Codex y no puede acceder por sí solo a los archivos del proyecto. No guardar claves en el paquete ni pegarlas en el chat.
