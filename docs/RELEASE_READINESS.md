# Aceptación de TFO 1.0.0-rc.3

Esta candidata incorpora [Inteligente, Custom, uso, permisos y mediciones](SMART_MODES.md). Una instalación nueva usa Automático · Permitir siempre · Inteligente Normal; una actualización conserva preferencias explícitas. La aceptación del paquete instalado y la comparativa se registran por separado.

Este RC prepara la prueba del usuario antes de publicar una versión estable. Un resultado de una versión anterior no sustituye la validación del paquete actual.

## Comprobaciones de construcción

- Identidad `tfo`, metadatos coherentes y archivos públicos sin rutas de la máquina, identificadores privados ni secretos.
- Suite completa, validadores de plugin/skill, hashes del runtime generado y archivos de distribución.
- Instalación y arranque MCP en perfil limpio; herramientas sin nombres duplicados.
- Conservación del paquete anterior y datos; descubrimiento de hooks separado de su aprobación normal en Codex.

El registro detallado de validación del RC se conserva fuera del paquete público.

## Evidencia de esta candidata

- [x] Suite completa: 242 pruebas; metadatos, coherencia del paquete y regresiones de modos/permisos.
- [x] Panel local probado en navegador con datos aislados: persistencia, Custom, permisos y tamaño estrecho.
- [x] Herramientas rc.3 cargadas en chat nuevo; opciones versión 3 y catálogo real.
- [x] Flujo HQ real: Sol 6.1 medio y Astra medio en el mismo auxiliar, integración y revisor independiente sin hallazgos.
- [x] Recibo final del principal verificado por el motor.
- [x] Hook descubierto, habilitado y de confianza, sin modificar aprobaciones.
- [x] Opciones representadas en los ajustes nativos de Codex, confirmadas mediante capturas del usuario del paquete instalado `1.0.0-rc.3+codex.1`.
- [ ] Aceptación de worktrees nativos Git con el proyecto asociado al repositorio real.
- [ ] Proyecto Defold acordado, piloto y comparativa medida antes de Latest.

## Evidencia histórica y comprobaciones posteriores

Los siguientes resultados anteriores no sustituyen los ensayos de rc.3 descritos arriba.

- [x] Principal activo con tres auxiliares, nueve turnos de trabajadores, tres revisiones e integración en el mismo turno. Se conservó un bloqueo válido y se resolvió con una tarea nueva.
- [ ] Verificar worktrees nativos reales y publicación del hito exclusivamente desde el principal en rama y PR borrador.
- [x] Recuperación real desde el MCP instalado ante cierre prematuro: un envío al mismo principal tras un minuto, selección conservada, trabajador sin repetición y cierre final verificado.
- [ ] Completar aceptación real de fallos terminales, reinicios y esperas de 3/10 minutos. El límite global de tres intentos, entregas inciertas y pausas/interrupciones tienen cobertura automatizada.
- [x] Registrar tokens observados y latencia del piloto y de la recuperación. El equivalente API es una referencia, no una factura ni una medición aislada del coste de esperar.
- [ ] Calibrar el coste de espera y probar capacidad real gradualmente. El test simulado de 100 no acredita 100 turnos simultáneos en Codex.

- [x] Abrir un chat nuevo con TFO y confirmar versión `1.0.0-rc.3`.
- [x] Confirmar confianza de hooks: el host ya lo marca trusted; no solicitó cambios de aprobación.
- [ ] Probar tareas pequeñas y revisar archivos y recibos.
- [ ] Solicitar un retorno con modelo/esfuerzo distinto del principal; dejar visible su marcador y el editor vacío, terminar el turno fuente y comprobar un turno nuevo posterior a todos los prerrequisitos.
- [ ] Verificar selección pedida frente a observada; si hay intervención, selección incorrecta o envío incierto, comprobar que exige revisión y no repite.
- [ ] Para IGTAP, verificar worktrees nativos registrados y selección real por tarea. La aceptación en carpetas de prueba no acredita el aislamiento Git.
- [ ] Revisar recuperación y límites con el usuario; autorizar expresamente la publicación estable.

## Límites mantenidos

Windows/Codex local; selección mediante interfaz condicionada a sus controles y chat visible. Continuaciones de trabajadores supervisadas. ChatGPT Projects y ahorro calibrado pendientes. El archivo portable está preparado para la futura carga en complementos; empaquetarlo no lo publica ni certifica sus servicios web.
