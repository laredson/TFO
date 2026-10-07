# Modos, uso y permisos · TFO 1.0.0-rc.3

Una instalación nueva empieza con **Automático · Permitir siempre · Inteligente Normal**. Al actualizar se conservan las preferencias explícitas: Ahorro anterior se migra a Inteligente Ahorro. Las rutas guardadas mantienen sus decisiones y restricciones.

## Modos

La IA valora cada tarea y registra una referencia Normal, una selección y el motivo. TFO valida el catálogo, aplica la política, comprueba límites y verifica el modelo recibido. No se ejecuta otro trabajo para calcular Normal.

| Prioridad inteligente | Criterio |
| --- | --- |
| Normal | Equilibrar calidad, tiempo y consumo total; Luna, Sol y Astra según la tarea, sin proporciones fijas. |
| Ahorro | Minimizar coste total esperado, incluidos fallos, correcciones y contexto. Puede convenir Sol. |
| Rápido | Reducir duración, incluida la organización del trabajo, con mejora proporcionada al sobrecoste. |
| MaxSpeed | Dar más peso a velocidad que Rápido, evitando grandes incrementos por mejoras mínimas. |
| Calidad | Subir Luna → Sol 6.1 → Astra, conservando potencia. Astra conserva su potencia. |
| HQ | Calidad más revisión independiente del resultado integrado y corrección de hallazgos. |
| Máximo | Buscar mejoras perceptibles en calidad y velocidad. Luna alto sigue siendo válido si subir no compensa. |
| MaxHQ | Máximo más revisión independiente y correcciones. |

**Custom** fija Luna 6, Sol 6.1 o Astra 6 y una potencia disponible en el host. Se aplica a nuevos turnos del maestro y sus auxiliares. Un turno activo conserva su modelo; cambiarlo exige un nuevo turno y un recibo verificable.

HQ/MaxHQ necesitan coordinación nativa con un chat de revisión de solo lectura. Una cola de un solo chat no se puede convertir silenciosamente en HQ. El cierre exige una revisión sin hallazgos pendientes que cubra toda la implementación y las correcciones. Una revisión fallida conserva su evidencia; se agregan tareas de corrección y otra revisión antes del cierre.

## Uso y permiso son decisiones diferentes

Uso decide cuándo se propone TFO: Automático; Añadir al plan y preguntar fuera del plan; o Siempre preguntar una vez por trabajo. Un plan siempre espera su aceptación. Una respuesta explícita previa vale para el mismo trabajo; no se pregunta de nuevo por cada prompt.

Permiso decide si puede enviar: Permitir siempre, Preguntar o Deshabilitar. Una concesión puede cubrir el proyecto o la cadena de chats de un trabajo. Permitir siempre cambia la preferencia global para trabajos nuevos. Revocar una concesión detiene futuros envíos que dependan de ella. Deshabilitar impide también nuevos envíos y recuperaciones de ejecuciones existentes; los turnos ya enviados pueden terminar y sus resultados se conservan.

Cada trabajo guarda sus opciones efectivas. Cambiar opciones globales afecta a trabajos nuevos. Una elección expresa en Permisos puede cambiar el modo de un trabajo para tareas pendientes; el principal revisa el plan antes de continuar. Una tarea ya enviada conserva selección y evidencia. Si Custom cambia el maestro, primero se necesita un turno compatible.

El panel local `tfo_options` ofrece radios Inteligente/Custom, perfiles y desplegables obtenidos del catálogo real. El servidor anuncia también opciones estructuradas mediante la extensión `openai/settings`; el host decide si las muestra en sus opciones nativas. Ambos accesos escriben la misma configuración. Los permisos de TFO no sustituyen permisos del host.

## Comunicación

Al instalar/inicializar se explica brevemente para qué sirve y se indican los valores efectivos. Ejemplo para una instalación nueva: «TFO coordina chats, encadena prompts y reúne resultados. Empieza en Automático, Permitir siempre e Inteligente Normal; puedes cambiarlo en Opciones».

Durante el trabajo se menciona su función concreta: «Usaré TFO para desarrollar y revisar estos componentes», «Usé TFO para crear tres chats» o «Preparé una cadena de cinco prompts». La ayuda detallada se ofrece cuando se pide; no se repite una presentación general en cada uso.

## Contrato del motor

- `tfo_work_prepare` devuelve `workId` y opciones, o un estado pendiente de elección/permiso sin enviar nada. Reutilizar ese ID al continuar la preparación evita repetir la pregunta.
- Nuevos proyectos usan `tfo_native_prepare`; las secuencias de un chat usan `tfo_queue_start` o `tfo_chat_start`/`tfo_budgeted_chat_start`. En cada tarea `normalSelection` expresa la referencia y `selection` la recomendación del perfil; Calidad/HQ calculan la subida automáticamente. Registrar `selectionReason`.
- `initialSelection` siempre identifica el turno actual real. En coordinación activa las tareas inline del maestro deben corresponder a ese turno. No se simula un cambio de modelo con una llamada a sí mismo.
- Las entradas antiguas `tfo_start`, `tfo_project_prepare` y `tfo_parallel_prepare` ya no crean trabajos: se redirige al contrato nuevo. Sus estados y controles de ejecuciones guardadas permanecen disponibles.
- Los límites explícitos migrados se conservan. Los costes previstos son aproximaciones con margen, no una predicción de cuota semanal. Si existe un límite semanal menor del 100% y no hay observación semanal identificable, no se autoriza un envío nuevo.

## Mediciones posteriores

`tfo_measurements` exporta JSON versión 1 de una ejecución guardada: tareas, selección Normal/solicitada/observada, tiempos cuando existen, tokens disponibles, verificación y coste API equivalente. Omite prompts, respuestas y rutas de trabajo. Los checkpoints inline que comparten turno no duplican tokens. La suma de costes conocidos se marca incompleta cuando faltan datos.

Calidad, esperas por concurrencia y cambio de cuota permanecen `null` hasta medirlos. La tarifa por millón de tokens no es el coste total de un modo; el perfil puede combinar modelos y consumir cantidades distintas. Los dólares equivalentes de API no son un cargo facturado ni puntos de cuota de Codex.

La comparativa de Defold se prepara después de la aceptación funcional. Primero se elige con el usuario un prototipo corto y una rúbrica: arranque, mecánicas pedidas, estabilidad, controles, legibilidad visual y valoración humana. El mismo encargo poco prescriptivo, base y límites se entregan a diez maestros independientes: ocho perfiles y Custom Luna low/Astra ultra. Cada maestro puede coordinar sus propias cadenas. Registrar concurrencia y esperas; hacer primero un piloto. El objetivo de cinco puntos de cuota por desarrollo de media se calibra con ese piloto.

La curva de calidad frente al tiempo se construirá con evaluaciones reales fechadas; no se interpolarán intervalos sin evaluación como si fueran medidos. Coste por desarrollo y tarifas de entrada/salida por millón irán en vistas separadas. No se distribuyen gráficas ficticias como evidencia.
