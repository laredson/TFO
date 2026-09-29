# TFO · TaskFlow Orchestrator

**1.0.0-rc.1 — candidato para Windows y Codex local.** La publicación estable queda pendiente de la prueba de aceptación del usuario.

TFO coordina tareas, dependencias y resultados de chats. La IA estima dificultad y riesgo y propone un modelo y esfuerzo adecuados dentro de los límites del usuario. Esta regla incluye creación, continuaciones e integración en el principal. TFO registra la decisión y verifica la selección que ejecutó el host.

## Comportamiento

- Cadenas supervisadas con selección por tarea mediante herramientas nativas de Codex. Las continuaciones de trabajadores necesitan un llamador IA activo.
- Retorno independiente al principal: espera a los trabajadores y al cierre del turno de origen antes de enviar una vez.
- El retorno con otra selección usa el adaptador de la interfaz de Codex: exige el chat correcto visible y el editor vacío, aplica modelo/esfuerzo y comprueba el recibo. Si no puede verificarlo, se detiene para revisión. La cola nativa solo sirve cuando la selección prevista coincide.
- Reservas persistentes, pausa, cancelación y conservación de resultados. Un envío incierto nunca se repite automáticamente.
- Identidad `tfo`: skill, MCP, herramientas `tfo_*`, configuración `TFO_*` y datos en `TFO/data`.

## Instalar y probar

Consulta [INSTALL.md](INSTALL.md). El paquete local conserva el formato de hooks de Codex; el portable se genera por separado para preparar la futura distribución como complemento. No se ha publicado una versión estable ni un complemento público.

Consulta la [guía](docs/USER_GUIDE.md), la [coordinación](docs/PARALLEL_CODEX.md), las [notas del RC](docs/RELEASE_NOTES.md) y los [criterios de aceptación](docs/RELEASE_READINESS.md).

## Licencia

TFO se distribuye bajo la [TFO Community License 1.0](LICENSE.md). El uso local e interno es gratuito, también para trabajo profesional. Se pueden compartir copias sin cobrar por TFO. La venta, el alojamiento para terceros o la integración en un producto o plataforma requieren un acuerdo escrito con Victor Salvadores Hernandez. Esta licencia de código visible no es una licencia *open source*.

## Límites del RC

El adaptador nuevo está cubierto por pruebas automatizadas; su aceptación en la interfaz real con otro modelo sigue siendo una comprobación explícita de este RC. Depende de que Codex exponga los controles esperados. TFO no incorpora otra IA ni garantiza el modelo óptimo, latencia o ahorro medido.

El controlador nativo de modelos mixtos sigue limitado a carpetas de prueba separadas fuera de Git. El controlador de proyectos con selección fija exige worktrees para escrituras en Git. La prueba de IGTAP debe respetar esos límites: no compartir un checkout entre chats que escriben. ChatGPT Projects todavía requiere su propio adaptador; una conexión MCP web no equivale a orquestación de sus chats.
