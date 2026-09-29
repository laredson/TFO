# Guía de usuario · TFO 1.0.0-rc.1

## Antes de empezar

Requisitos: Node.js 20 o superior, Codex CLI y PowerShell 7 en Windows. El motor no requiere instalar dependencias de npm.

Este RC está diseñada para **Windows con Codex local**. La carpeta y los permisos de trabajo los determina el host. Revisa el objetivo, los límites de escritura y las tareas antes de autorizar una ruta; TFO no convierte una carpeta de trabajo en un sandbox.

## Elegir una modalidad

### Supervisor con selección fija

Pide una secuencia acotada de prompts para el chat actual. TFO guarda los pasos autorizados, espera a que cierre el turno actual y procesa un paso cada vez, comprobando la respuesta y el recibo antes de avanzar. Esta modalidad conserva la selección de modelo y esfuerzo existente.

### Cadenas supervisadas

Para dividir el trabajo, pide cadenas con tareas, dependencias y resultados esperados. Cada tarea puede indicar modelo y esfuerzo. El llamador activo prepara y ejecuta las llamadas nativas de Codex una vez cada una; TFO conserva los resultados y verifica selección y recibos antes de habilitar dependencias. El retorno final es un paso independiente que espera a que terminen las cadenas y el turno de origen. La integración también lleva una selección justificada por tarea: para una integración de código acotada, la decisión inicial puede ser Sol medio; para una comprobación mecánica, Luna. TFO debe aplicar y verificar lo pedido, sin heredar otro modelo como sustituto silencioso. El cambio del principal usa el adaptador de interfaz: deja visible el marcador exacto que entregue TFO y el editor vacío. Si no puede verificar destino y selección, exige revisión antes de enviar. El nombre de la herramienta avanzada es `tfo_budgeted_chat_start`.

Los cambios de selección por tarea se han verificado en el flujo integrado, pero siguen siendo supervisados. No equivalen a ejecución autónoma completa.

## Durante una ruta

1. Comprueba que el plan describe el resultado esperado y los límites autorizados.
2. Inicia la modalidad adecuada y deja que el turno actual termine cuando se indique.
3. Revisa el estado, las selecciones observadas y los resultados que vuelven al principal.
4. Inspecciona e integra los cambios y ejecuta las comprobaciones apropiadas para tu proyecto.

Una pausa impide iniciar nuevos envíos; los turnos ya activos pueden terminar. Cancelar detiene pasos pendientes y conserva los resultados recibidos. Ninguna de las dos acciones puede retirar un envío que ya comenzó.

## Si algo se detiene o queda incierto

Si la selección observada no coincide, falta un recibo, el envío es ambiguo o hay intervención durante el turno, la ruta requiere revisión. No la vuelvas a enviar a ciegas: comprueba el estado y el historial del chat para determinar si el prompt llegó y si el turno terminó. Reanuda solo después de resolver el punto de control; si no puede confirmarse, deja la ruta detenida y vuelve a planificar desde el último resultado verificado.

Las respuestas de trabajadores y sus informes no sustituyen la revisión del código ni las pruebas del proyecto. Los recibos demuestran qué turno y selección se observaron, no la corrección del resultado.

## Instalación y reinstalación

Instala el paquete/skill/MCP `tfo` en la instancia local de Codex usando el mecanismo de instalación local del paquete RC. Para actualizar o reinstalar, cierra rutas activas, conserva `TFO/data`, instala la nueva versión y prueba en un chat nuevo para cargar sus herramientas; recarga la aplicación si el host todavía conserva el proceso anterior. Antes de retirar o reemplazar los datos, guarda la información local que quieras conservar. Consulta INSTALL.md para instalar y docs/RELEASE_READINESS.md para los criterios de aceptación del candidato.

## Datos y alcance

El estado local vive bajo `TFO/data`; trátalo como persistente si necesitas recuperar una ruta. TFO no crea commits, hace push ni publica el proyecto. El soporte de ChatGPT Projects, la finalización autónoma de todos los cambios de selección, escrituras reales en ramas y el ahorro calibrado no están disponibles/verificados en este RC.

## Selección y evidencia

La IA del chat evalúa dificultad, riesgo y comprobaciones, y propone modelo y esfuerzo dentro de los límites del usuario. TFO guarda la decisión y comprueba el modelo realmente ejecutado. La selección se hace para cada tarea, incluidos los siguientes turnos del principal. El soporte completo de cambios autónomos del principal aún debe acreditarse con una prueba en vivo; una prueba con adaptador simulado no basta.
