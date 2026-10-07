# Resultados disponibles de TFO / Code Fragment

[Descargar las siete builds Windows juntas](https://github.com/laredson/TFO/releases/download/v1.0.0-rc.3/builds_code_fragment_7_modos.zip)

Extrae todo el ZIP y abre el ejecutable de cada carpeta. Incluye instrucciones. Los ZIP individuales de la tabla incluyen además fuentes de Defold. Los nombres parecidos pertenecen a implementaciones independientes.

## Rendimiento observado

Normal presentó el menor tiempo total y el menor coste de referencia entre los cinco prototipos con recorrido automático completo. En esta muestra Ahorro no resultó más barato y Rápido no terminó antes que Normal. Esto describe estas ejecuciones; no establece una ventaja general de un modo.

| Modo / descarga individual | Tiempo total | Turnos del maestro | USD de referencia | Resultado |
|---|---:|---:|---:|---|
| [Custom Luna low](https://github.com/laredson/TFO/releases/download/v1.0.0-rc.3/minigame_lunalow_jardin_de_chispas.zip) | 52,1 min | 23,3 min | 0,23 | Arranque verificado; partida y reinicio sin verificar. Coordinación TFO incompleta. |
| [Ahorro](https://github.com/laredson/TFO/releases/download/v1.0.0-rc.3/minigame_ahorro_taller_de_luciernagas.zip) | 30,2 min | 29,3 min | 2,22 | Recorrido automático completo en Defold. TFO completado. |
| [Normal](https://github.com/laredson/TFO/releases/download/v1.0.0-rc.3/minigame_normal_jardin_de_luciernagas.zip) | 19,8 min | 19,8 min | 1,57 | Recorrido automático completo en Defold. TFO completado. |
| [Rapido](https://github.com/laredson/TFO/releases/download/v1.0.0-rc.3/minigame_rapido_nidos_de_luz.zip) | 22,7 min | 22,7 min | 1,76 | Recorrido automático e imágenes del motor. TFO quedó en revisión. |
| [MaxSpeed](https://github.com/laredson/TFO/releases/download/v1.0.0-rc.3/minigame_maxspeed_jardin_de_luciernagas.zip) | 68,7 min | 55,2 min | 3,78 | Recorrido automático completo tras corregir la interfaz. Interrupción del entorno; TFO quedó en revisión. |
| [Calidad](https://github.com/laredson/TFO/releases/download/v1.0.0-rc.3/minigame_calidad_jardin_de_chispas.zip) | 48,4 min | 35,1 min | 12,88 | Recorrido automático completo. Interrupción del entorno; TFO recuperado y completado. |
| [HQ](https://github.com/laredson/TFO/releases/download/v1.0.0-rc.3/minigame_hq_jardin_de_luces.zip) | 322,9 min | 322,9 min | 9,79 | Compila y arranca; pruebas de reglas y callbacks simulados. Partida visual y revisión independiente pendientes. |

**Tiempo total**: calendario desde el primer inicio hasta el último cierre, incluidos parones y esperas entre continuaciones. **Turnos del maestro**: suma de sus duraciones, que excluye huecos entre turnos pero incluye esperas dentro de cada turno. No es tiempo de cálculo puro. No se suman auxiliares concurrentes para simular tiempo de calendario.

Luna low tuvo una continuación posterior para verificar el arranque; Ahorro tuvo otra por Computer Use. MaxSpeed y Calidad sufrieron el error de configuración del controlador y fueron reanudados. HQ acumula unas cinco horas y veintitrés minutos con un largo bloqueo de permiso/captura: ese total no sirve como comparación de velocidad. No se ha estimado ni restado un tiempo de espera sin medirlo.

**USD de referencia**: equivalente de API con las tarifas fijas de TFO del 29-09-2026, usando todos los turnos de maestro y auxiliares, incluidas continuaciones. No es un importe cobrado, una tarifa actual verificada ni consumo de cuota semanal. Cada respuesta se cuenta una vez; el razonamiento ya está incluido en la salida.

## Validación y límites

Cinco modos tienen recorrido automático completo en Defold: Ahorro, Normal, Rápido, MaxSpeed y Calidad. Luna low y HQ tienen build ejecutable con validación incompleta. La revisión independiente exigida por HQ no se realizó: este resultado no acredita HQ completo.

TFO cerró correctamente Ahorro, Normal y Calidad. Los otros cuatro flujos quedaron en revisión por problemas de coordinación o reconocimiento de recibos. El número de assertions no es una puntuación de calidad.

Todavía no hay evaluación humana comparable de diversión, comprensión por un niño de seis años ni duración real de la partida. Predominan los diseños de combinar y transformar fichas para encender jardines o nidos; el encargo común no garantizó diversidad de géneros.

Las primeras seis variantes compartieron equipo y se iniciaron en paralelo; HQ se ejecutó después. Hay una sola ejecución por modo e incidencias distintas. La tabla no constituye un ranking definitivo de los modelos.

## Datos y siguientes pruebas

[CSV por modo](data/modes.csv) · [CSV por turno](data/turns.csv) · [Método completo](METHOD.md)

Máximo, MaxHQ y Custom Astra ultra no se han iniciado y no tienen build todavía. Sus resultados permanecen vacíos, no como ceros. TFO no se ha promovido a release Latest.


[Descargar resultados y método](https://github.com/laredson/TFO/releases/download/v1.0.0-rc.3/resultados_code_fragment_7_modos.zip). Esta copia pública excluye conversaciones, rutas personales y estado interno de validación.
