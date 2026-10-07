# Guía de usuario · TFO 1.0.0-rc.3

Esta candidata incorpora [Inteligente, Custom, uso, permisos y mediciones](SMART_MODES.md). Una instalación nueva usa Automático · Permitir siempre · Inteligente Normal; una actualización conserva preferencias explícitas. La aceptación del paquete instalado y la comparativa se registran por separado.

## Antes de empezar

Requisitos: Node.js 20 o superior, Codex CLI y PowerShell 7 en Windows. El motor no requiere instalar dependencias de npm.

Este RC está diseñado para **Windows con Codex local**. La carpeta y los permisos de trabajo los determina el host. Revisa el objetivo, los límites de escritura y las tareas antes de autorizar una ruta; TFO no convierte una carpeta de trabajo en un sandbox.

## Elegir una modalidad

### Supervisor con selección fija

Pide una secuencia acotada de prompts para el chat actual. TFO guarda los pasos autorizados, espera a que cierre el turno actual y procesa un paso cada vez, comprobando la respuesta y el recibo antes de avanzar. Esta modalidad conserva la selección de modelo y esfuerzo existente.

### Cadenas supervisadas

Para dividir el trabajo, pide cadenas con tareas, dependencias y resultados esperados. La modalidad nueva mantiene activo al principal: abre auxiliares, recibe resultados, adapta tareas e integra dentro del mismo turno. Cada tarea lleva una selección justificada de modelo y esfuerzo; la del principal permanece fija durante su turno. TFO conserva y verifica recibos. El principal realiza los commits, pushes y PR borrador autorizados; los auxiliares entregan cambios locales.

En Opciones, el paralelismo predeterminado permite de 1 a 100 trabajadores, con 2 inicialmente. Un cambio global afecta a coordinaciones nuevas; el control de cada flujo permite cambiar su límite en caliente sin interrumpir trabajo activo. El máximo configurado no garantiza capacidad de Codex. Git requiere worktrees separados y comprobados antes de permitir escrituras auxiliares.

Ante una caída verificada o cierre prematuro, TFO puede reactivar el principal tres veces como máximo, con esperas de 1, 3 y 10 minutos. Una espera legítima, pausa o interrupción ambigua no dispara recuperación. Un envío incierto se comprueba antes de continuar y no se repite automáticamente. Las ejecuciones anteriores conservan el retorno diferido y sus límites.

Los cambios de selección por tarea se han verificado en el flujo integrado, pero siguen siendo supervisados. No equivalen a ejecución autónoma completa.

## Durante una ruta

1. Comprueba que el plan describe el resultado esperado y los límites autorizados.
2. En la coordinación activa, el principal sigue trabajando o esperando hasta verificar la integración y cerrar la coordinación. La modalidad diferida indica cuándo acabar el turno fuente.
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
