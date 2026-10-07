# Notas de TFO

## 1.0.0-rc.3 — Modos, uso y permisos

- Inteligente Normal predeterminado; Ahorro, Rápido, MaxSpeed, Calidad, HQ, Máximo y MaxHQ, más Custom.
- Configuración versión 3 con migración que conserva preferencias, límites y ejecuciones históricas.
- Elección de uso por trabajo, permisos por proyecto/cadena y bloqueo de nuevos envíos al deshabilitar o revocar.
- Revisión independiente y cobertura de correcciones para HQ/MaxHQ; decisiones Normal/solicitada/observada.
- Panel local renovado y opciones nativas `openai/settings`, cuya representación se ha confirmado en Codex.
- Exportación de mediciones con datos ausentes explícitos; comparativa Defold posterior a la aceptación.
- Nuevas ejecuciones deben usar las entradas de coordinación nativa o colas; las entradas antiguas de creación se retiran para evitar saltarse las políticas nuevas. Sus controles de ejecuciones guardadas se conservan.

Validación: 242 pruebas automatizadas, panel local probado en navegador y flujo HQ real con dos turnos de un auxiliar, integración, revisor independiente y recibo final del principal. Se han verificado las selecciones Sol 6.1 medio y Astra medio. Las capturas del usuario confirman las opciones nativas del paquete instalado `1.0.0-rc.3+codex.1`.

Esta publicación es una prerelease para Windows/Codex local. Quedan pendientes la aceptación de worktrees nativos y la comparativa Defold acordada antes de la promoción a Latest. No incluye publicación en GPTD ni el adaptador completo de ChatGPT; las estimaciones no son mediciones de rendimiento ni de cuota.

Descarga el ZIP local para instalar en Codex y sigue [INSTALL.md](https://github.com/laredson/TFO/blob/v1.0.0-rc.3/INSTALL.md). Se incluyen un ZIP portable y sumas SHA-256; el formato portable no acredita compatibilidad con ChatGPT web.

## 1.0.0-rc.2 — Sol 6.1

Sol 6.1 sustituye a Sol 6 en nuevas decisiones automáticas del nivel Sol. Sol 6 sigue disponible cuando el usuario lo pide explícitamente. Se conservan los IDs exactos de selecciones de origen, recibos y planes ya aprobados.

- Compatibilidad con `gpt-6.1-sol` en catálogo, esquemas MCP, colas, selección nativa y selector de Windows. En híbrido medio, Luna medio cubre tareas acotadas y Sol 6.1 medio el trabajo de código con dependencias.
- Detección del selector GPT-6.1 y verificación exacta: una respuesta de Sol 6 no satisface una petición de Sol 6.1. Selección incorrecta, intervención o envío incierto detienen dependencias y no provocan reintentos.
- Sol 6.1 comparte el nivel Sol de la familia GPT-6 y los esfuerzos que ofrece Codex. Se conservan los límites autorizados por el usuario.
- Precios API de referencia: $2 entrada, $0.10 entrada en caché, $2.50 escritura de caché y $10 salida por millón de tokens, según la [documentación oficial](https://developers.openai.com/api/docs/models/gpt-6.1-sol). No representan consumo de cuota Codex.
- Paquetes local y portable, con sumas SHA-256. Suite de 160 pruebas automatizadas; las pruebas simuladas no certifican un cambio de modelo en la interfaz real. La aceptación en vivo continúa pendiente.

## 1.0.0-rc.1

Candidato para aceptación en Windows/Codex local, previo a la publicación estable.

## Cambios

- Migración de paquete, skill y MCP a `tfo`, herramientas `tfo_*`, variables `TFO_*` y almacenamiento `TFO/data`.
- Selección por tarea para todos los chats, incluido el principal. Se conservan selección de origen, solicitada, motivo y observada.
- Adaptador de retorno con selección explícita conectado al supervisor. Comprueba destino, cierre de trabajadores y turno fuente, reserva, editor vacío, selección y recibo. Si no puede garantizar el envío, detiene el flujo sin herencia silenciosa ni reintento.
- Supervisor con copia inmutable de sus dependencias y registro persistente del único intento de envío.
- Importación conservadora: rechaza estados activos o ambiguos, conserva el origen y archiva el historial sin reanudarlo.
- Paquetes local y portable separados para conservar la carga de hooks en la instalación local actual.

## Alcance de la evidencia

Las pruebas automatizadas verifican controles y fallos simulados. Las pruebas anteriores de modelos mixtos confirmaron nueve selecciones de trabajadores y un retorno al principal; no acreditan por sí solas el cambio autónomo del principal implementado en este RC. La aceptación debe comprobarlo con el recibo real del nuevo turno.

Las continuaciones de trabajadores con cambios de modelo siguen supervisadas mediante herramientas nativas. El retorno final puede esperar y ejecutarse sin un llamador IA activo. No equivale a autonomía completa en todos los chats.

ChatGPT Projects, modelos mixtos con escrituras reales en worktrees y calibración de costes siguen fuera de la aceptación de esta versión. Las estimaciones son orientativas, no ahorro medido ni consumo facturado.
