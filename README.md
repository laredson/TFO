# TFO · TaskFlow Orchestrator

Esta candidata incorpora [Inteligente, Custom, uso, permisos y mediciones](docs/SMART_MODES.md). Una instalación nueva usa Automático · Permitir siempre · Inteligente Normal; una actualización conserva preferencias explícitas. La aceptación del paquete instalado y la comparativa se registran por separado.

**1.0.0-rc.3 — candidato para Windows y Codex local.** La publicación estable queda pendiente de la prueba de aceptación del usuario.

TFO coordina tareas, dependencias y resultados de chats. La IA estima dificultad y riesgo y propone un modelo y esfuerzo adecuados dentro de los límites del usuario. Esta regla incluye creación, continuaciones e integración en el principal. TFO registra la decisión y verifica la selección que ejecutó el host.

## Comportamiento

- Inteligente combina Luna 6, Sol 6.1 y Astra 6 según la tarea. Custom fija modelo y potencia; los recibos y planes anteriores conservan su identidad exacta.
- Principal activo por defecto: coordina, adapta prompts e integra dentro de su turno. TFO observa resultados y conserva checkpoints duraderos.
- Hasta 100 auxiliares y 1.000 tareas por flujo; paralelismo configurable de 1 a 100, dos trabajadores simultáneos por defecto. La capacidad efectiva depende del host.
- Recuperación ante caída comprobada: tres intentos por ejecución, con esperas de 1, 3 y 10 minutos. Una pausa o interrupción ambigua no provoca reactivación.
- Retorno diferido compatible con planes anteriores: espera a los trabajadores y al cierre del turno de origen antes de enviar una vez.
- El retorno con otra selección usa el adaptador de la interfaz de Codex: exige el chat correcto visible y el editor vacío, aplica modelo/esfuerzo y comprueba el recibo. Si no puede verificarlo, se detiene para revisión. La cola nativa solo sirve cuando la selección prevista coincide.
- Reservas persistentes, pausa, cancelación y conservación de resultados. Un envío incierto nunca se repite automáticamente.
- Identidad `tfo`: skill, MCP, herramientas `tfo_*`, configuración `TFO_*` y datos en `TFO/data`.

## Instalar y probar

Consulta [INSTALL.md](INSTALL.md). La [prerelease 1.0.0-rc.3](https://github.com/laredson/TFO/releases/tag/v1.0.0-rc.3) contiene los archivos local, portable y sus sumas SHA-256; también se pueden construir desde este código en `dist/`. El paquete local conserva el formato de hooks de Codex; el portable se genera por separado para preparar la futura distribución como complemento. La promoción a estable queda pendiente de la comparativa acordada.

Consulta la [guía](docs/USER_GUIDE.md), la [coordinación](docs/PARALLEL_CODEX.md), las [notas del RC](docs/RELEASE_NOTES.md) y los [criterios de aceptación](docs/RELEASE_READINESS.md).

## Licencia

TFO se distribuye bajo la [TFO Community License 1.0](LICENSE.md). El uso local e interno es gratuito, también para trabajo profesional. Se pueden compartir copias sin cobrar por TFO. La venta, el alojamiento para terceros o la integración en un producto o plataforma requieren un acuerdo escrito con Victor Salvadores Hernandez. Esta licencia de código visible no es una licencia *open source*.

## Límites del RC

El adaptador nuevo está cubierto por pruebas automatizadas; su aceptación en la interfaz real con otro modelo sigue siendo una comprobación explícita de este RC. Depende de que Codex exponga los controles esperados. TFO no incorpora otra IA ni garantiza el modelo óptimo, latencia o ahorro medido.

El controlador nativo admite worktrees Git verificados y carpetas de prueba separadas fuera de Git. Los auxiliares Git comienzan con preparación sin escrituras y requieren reconocer su worktree real antes de recibir la tarea. El principal revisa, integra y realiza commits, pushes y PR borrador autorizados. Se verificó en Codex una reactivación tras cierre prematuro desde el plugin instalado. Los worktrees nativos y los otros fallos de recuperación requieren más aceptación en vivo; las pruebas simuladas de 100 auxiliares no acreditan capacidad real de Codex. ChatGPT Projects necesita su propio adaptador.
