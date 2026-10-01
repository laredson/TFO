# Notas de TFO

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
