# TFO 1.0.0-rc.1

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
