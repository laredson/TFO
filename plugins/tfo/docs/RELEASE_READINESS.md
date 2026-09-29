# Aceptación de TFO 1.0.0-rc.1

Este RC prepara la prueba del usuario antes de publicar una versión estable. Un resultado de una versión anterior no sustituye la validación del paquete actual.

## Comprobaciones de construcción

- Identidad `tfo`, metadatos coherentes y archivos públicos sin rutas de la máquina, identificadores privados ni secretos.
- Suite completa, validadores de plugin/skill, hashes del runtime generado y archivos de distribución.
- Instalación y arranque MCP en perfil limpio; herramientas sin nombres duplicados.
- Conservación del paquete anterior y datos; descubrimiento de hooks separado de su aprobación normal en Codex.

El registro detallado de validación del RC se conserva fuera del paquete público.

## Puerta de aceptación antes de publicar la versión estable

- [ ] Abrir un chat nuevo con TFO y confirmar versión `1.0.0-rc.1`.
- [ ] Confirmar confianza de hooks mediante la interfaz normal si el host la solicita.
- [ ] Probar tareas pequeñas y revisar archivos y recibos.
- [ ] Solicitar un retorno con modelo/esfuerzo distinto del principal; dejar visible su marcador y el editor vacío, terminar el turno fuente y comprobar un turno nuevo posterior a todos los prerrequisitos.
- [ ] Verificar selección pedida frente a observada; si hay intervención, selección incorrecta o envío incierto, comprobar que exige revisión y no repite.
- [ ] Para IGTAP, usar el controlador compatible con su aislamiento Git. No presentar el controlador nativo de carpetas de prueba como soporte de modelos mixtos en worktrees.
- [ ] Revisar recuperación y límites con el usuario; autorizar expresamente la publicación estable.

## Límites mantenidos

Windows/Codex local; selección mediante interfaz condicionada a sus controles y chat visible. Continuaciones de trabajadores supervisadas. ChatGPT Projects y ahorro calibrado pendientes. El archivo portable está preparado para la futura carga en complementos; empaquetarlo no lo publica ni certifica sus servicios web.
