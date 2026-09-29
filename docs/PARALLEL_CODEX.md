# Coordinación de chats de Codex con TFO

## Selección por tarea: prueba supervisada

`tfo_native_*` añade un controlador supervisado para las herramientas nativas de Codex: prepara un DAG con `selection` por nodo y un límite `maxParallelWorkers` de 1 a 8 (2 por defecto). `claim` registra intención y devuelve los argumentos exactos para crear o continuar el chat; el llamador ejecuta una vez la herramienta indicada y registra el ID real con `acknowledge`. `observe` comprueba el recibo de delegación, selección real, respuesta, uso y dependencias. La creación realiza la primera tarea útil. No hay otro modelo dentro de TFO.

Esta modalidad necesita un llamador activo de herramientas del host: no es autónoma al cerrar el chat. Por ahora está limitada a directorios hijos separados fuera de Git (`scratch_folders`), explícitamente autorizados; son límites de tarea, no un sandbox. El controlador convencional `tfo_parallel_*` descrito abajo conserva sus modelos y exige worktrees para escritura. La cola `codex queue` no incluye modelo/esfuerzo en su petición por mensaje; sus opciones generales no prueban cambio de selección. Las continuaciones de trabajadores siguen necesitando un llamador activo; el retorno final dispone de un adaptador independiente.

Las estimaciones de coste son heurísticas sin calibrar. Ahora acumulan los prompts y salidas previstos de pasos anteriores, identifican sus supuestos y no equiparan una recomendación de confianza baja con ahorro. No predicen latencia, llamadas a herramientas, cuotas de suscripción ni efecto cuantitativo del esfuerzo. El coste observado equivalente usa tokens del host y precios API estándar; no es una factura ni una medición de cuota.

En la prueba real, el envío nativo hacia el principal activo se inyectó en su turno actual y no cambió Astra/xhigh a Luna/high. Se conservó el flujo en `needs_review`, sin reenvío, y se integraron los archivos en el turno activo autorizado. El controlador ahora rechaza este caso antes de enviar. Ese intento histórico no acredita el adaptador de retorno del RC; su aceptación requiere un recibo nuevo con la selección solicitada.

La IA del principal planifica las tareas y abre los chats mediante las herramientas nativas de Codex. TFO es un supervisor convencional: observa turnos, conserva respuestas completas, habilita dependencias y envía los prompts siguientes. No contiene otra IA ni abre un segundo App Server escritor.

## Retorno persistente desde una prueba de modelos

El controlador nativo puede terminar con un retorno independiente al principal mediante `runtime/native-join-control.mjs`. Primero se ejecuta `preflight` en el contexto de permisos que tendrá el supervisor: comprueba la interfaz de cola, acceso de escritura a los archivos de estado sin modificarlos y creación/eliminación de un archivo propio de prueba. No envía mensajes. Esta comprobación detecta problemas de acceso al estado local antes de anunciar el retorno.

Después de enviar todas las tareas de trabajadores, `arm <archivo-con-runId>` arma un único nodo final del principal. Su selección se evalúa por la tarea. Si coincide con la selección de origen, usa la cola nativa; si cambia, usa el adaptador de interfaz con guardas. El armado comprueba capacidad sin tocar la interfaz ni exigir que el turno fuente haya terminado.

Para cambiar selección, muestra en la respuesta final el `mainJoinMarker` exacto devuelto por la preparación: `TFO_MAIN_JOIN <flowId> <mainThreadId>`. Deja visible ese marcador y el editor vacío. El supervisor exige que el marcador figure tanto en el recibo final fuente como en la ventana correcta. Comprueba reserva, propietario, cierre de todos los trabajadores y del turno fuente, contador de mensajes y selección. Aplica modelo/esfuerzo, envía una vez y verifica el recibo. Un destino oculto, borrador, aprobación, intervención o resultado ambiguo detiene el flujo para revisión.

El proceso conserva una copia inmutable del motor. Termina el turno de planificación tras su acuse de arranque: la espera no requiere un llamador IA activo. Las continuaciones de trabajadores con cambios de modelo siguen usando las herramientas nativas llamadas por la IA. La aceptación del nuevo adaptador en la interfaz real continúa siendo una puerta explícita del RC.

## Flujo

`tfo_parallel_prepare` guarda el proyecto, sus cadenas y dependencias. Cada cadena es un chat (`lane`), y cada tarea es un nodo con prompt y criterios de aceptación. El nodo final pertenece a `main` y debe depender de todo el trabajo. La preparación devuelve un mensaje inicial exacto por chat. La IA usa `create_thread` con el mismo proyecto y después `tfo_parallel_bind` con el ID real y el espacio de trabajo devueltos por el host. No se acepta un ID de creación pendiente.

`tfo_parallel_start` arranca un supervisor independiente con acuse de inicio y copia inmutable del código. Los chats nuevos responden al mensaje de preparación; TFO verifica el emisor, texto, respuesta y selección antes de ejecutar sus tareas. Las herramientas nativas guardan esa preparación como `codex_delegation`, distinto del mensaje normal que guarda la cola.

Ejemplo: preparación → (X → ampliar X) y (Y → ampliar Y) → integración. Cada cadena conserva su chat, su contexto y su rama. Al terminar una cadena, su resultado queda guardado mientras la otra continúa. El principal recibe las respuestas de ambas al cumplirse la dependencia de integración. Pueden existir varios prompts de integración consecutivos.

Con `currentNodeId`, el principal realiza una tarea durante el turno en que prepara el plan, en paralelo con los chats auxiliares. TFO registra su respuesta final al acabar ese turno. Sin ese campo, espera a que termine el turno de planificación antes de enviar tareas al principal. Nunca interrumpe el turno para insertar la integración.

## Carpetas y Git

Las tareas que escriben en un repositorio deben usar la raíz de un worktree registrado, una rama con nombre y el mismo repositorio. Se verifican `git worktree list`, la raíz, el directorio común y la rama; no basta un indicador de aislamiento enviado por la IA. Chats de escritura distintos no pueden compartir checkout o rama. Los worktrees se crean/reutilizan mediante las herramientas nativas del host. Una subcarpeta ordinaria comparte rama e índice y no sirve para ese propósito.

Para pruebas desechables fuera de Git, el controlador persistente admite `workspaceMode: scratch_folders`. El proyecto y todas las carpetas asignadas deben existir, no pertenecer a ningún checkout Git, ser hijos directos o indirectos del proyecto y no solaparse. Cada lane y `mainWorkspace` reciben su propia carpeta. El chat puede estar abierto en una carpeta padre que contenga ese árbol. Este modo delimita la tarea y permite probar creación, integración y entrega; no añade aislamiento de seguridad ni sustituye worktrees para desarrollo real.

El motor comprueba identidades de checkout; no es un sandbox adicional. Los permisos efectivos siguen siendo los del host. Los prompts acotan el trabajo al workspace asignado. TFO no realiza commits, merges, publicaciones, pushes ni limpieza de worktrees. El principal integra los cambios y ejecuta las comprobaciones del proyecto conforme a la autorización del usuario.

El proyecto guardado en la aplicación puede apuntar a una carpeta distinta del repositorio. Debe resolverse esa asociación antes de crear worktrees. El directorio registrado del proyecto puede ser una carpeta padre del checkout. Verifica esa asociación explícitamente; no supongas que una subcarpeta implica aislamiento Git.

## Recibos, controles y recuperación

Un checkpoint exige un solo prompt exacto, un turno completado, una sola entrada de usuario, respuesta final y selección real coincidente. En tareas auxiliares se exige además un reporte JSON con `status: completed`; `blocked`, una respuesta inválida o una selección distinta detienen dependencias. Se conserva el texto completo, selección, turno, workspace, rama y HEAD. Esto valida el recibo y la afirmación del trabajador, no sustituye la revisión y las pruebas del principal.

Las reservas persistentes evitan que otra ruta de proyecto o cola FIFO reclame un chat reservado. Se registra la intención antes del único intento de envío. Ante un resultado ambiguo, reinicio o intervención del usuario, el estado es `needs_review` y no se reintenta. Pausar impide nuevos envíos y permite recoger turnos en curso. Cancelar espera sus recibos, detiene los pasos pendientes y conserva archivos. Un envío ya iniciado no puede retirarse.

El transporte conserva modelo/esfuerzo. El modelo real del mensaje inicial debe estar dentro del techo del principal. No cambia selectores, confianza de hooks, permisos ni configuración global. La interfaz no necesita estar en primer plano.

## Plataformas y validación

Este adaptador es para Codex local. `tfo_project_*` sigue siendo el planificador de almacenamiento. `tfo_parallel_*` es el flujo ejecutable. ChatGPT normal y sus Proyectos necesitan un adaptador separado; la conexión MCP web y su panel no prueban envío automático ni coordinación entre conversaciones.

Las pruebas automatizadas cubren cadenas paralelas, barrera de integración, tarea del principal durante el turno, pausa, cancelación, bloqueos, selección incorrecta, intervención, envío incierto, aislamiento con repositorios/worktrees Git reales y el ciclo de dos constructores → integrador → verificación principal en carpetas desechables. La evidencia histórica de chats reales debe distinguirse de las pruebas simuladas y de la aceptación pendiente del RC.

## Política común de selección

Crear, continuar y retornar al principal requieren la misma evaluación por tarea. La IA registra motivo y selección dentro del perfil del usuario; TFO comprueba la selección ejecutada. El contrato selectedJoin usa el adaptador de interfaz conectado al host y exige verificar destino, selección y recibo. La prueba de aceptación en vivo está pendiente. La cola nativa conserva la selección y solo es válida cuando coincide con la selección evaluada para la tarea. Sin transporte compatible, el envío se bloquea antes de realizarse.
