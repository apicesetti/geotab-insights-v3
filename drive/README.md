# Mi jornada — add-in de Geotab Drive

**Desde la v1.1 es un add-in unificado** con tres pestañas:

- **Mi jornada** (este repo: `core.js`, `app.js`): tiempo restante, fatiga, índice de riesgo y vehículo.
- **Tripulación** ([apicesetti/workinghours](https://github.com/apicesetti/workinghours), `scripts/drive.js`): carga de acompañantes, confirmación "¿Viajás con…?", "Viajo con…" y planilla.
- **Clientes** (v1.2, misma base de Horas de trabajo 1.3): "Llegué a un cliente" con la posición del teléfono, geocerca de 100 × 100 m pedida al supervisor si el cliente no tiene, visitas del día con el tiempo en cada cliente y el tiempo y los km entre clientes, y la carga de clientes en las paradas.

`shell.js` registra los dos como un solo add-in (un ícono, un `onStartup`) y abre directamente en *Tripulación* cuando hay algo para responder (la pestaña muestra cuántas cosas faltan). La página carga los scripts de workinghours desde `../../workinghours/` — los dos repos se publican en `apicesetti.github.io`.

**Acompañantes**: la jornada y la fatiga de quien viaja de acompañante salen de las tripulaciones de Horas de trabajo. Se toman los viajes del vehículo mientras estuvo a bordo; cuentan como jornada, no como manejo. Si dijo "No viajo" no cuentan; si todavía no confirmó, cuentan y se muestra "sin confirmar". Si en el mismo momento manejó él, gana el manejo.

El conductor ve en el teléfono, con los **mismos límites y cálculos que Insights by Cesetti**:

- **Te queda**: horas de jornada, de manejo y de manejo continuo que le quedan, y a qué hora llega a cada límite. Fuera de jornada muestra el descanso que lleva y cuánto le falta para el mínimo.
- **Fatiga**: índice estimado actual, cuándo pasaría a alto si sigue así, riesgo del próximo turno y las señales de sus últimas jornadas.
- **Índice de riesgo**: puntos cada 100 km de los últimos 28 días contra los 28 anteriores, las últimas 8 semanas y las categorías con más eventos.
- **Vehículo**: el vehículo en el que está identificado y a qué distancia está.

## Avisos (notificación del teléfono)

| Aviso | Cuándo |
|---|---|
| Te queda poco de jornada / manejo / manejo continuo | al 80 % de cada límite, una vez por jornada |
| Llegaste al límite | al 100 %, con aviso por voz |
| Seguís identificado en el vehículo | el teléfono está a más de 200 m del vehículo, el vehículo sigue con su identificación y está detenido. Hacen falta 2 lecturas seguidas (2 min) y no se repite antes de 30 min. Con voz. |
| Vehículo en movimiento con tu identificación | igual que el anterior, pero el vehículo se mueve: alguien maneja con su llavero o su sesión. |

En la tarjeta **Vehículo** (que pasa arriba de todo cuando el conductor está lejos) hay dos botones:

- **Me desvinculo** → agrega un cambio de conductor a "desconocido" en ese vehículo (`DriverChange` con `UnknownDriverId`). Desde ese momento los viajes y eventos dejan de quedar a su nombre.
- **Me relevaron** → elige de la lista quién lo reemplazó (conductores activos de sus mismos grupos, con buscador). A ese conductor le llega un **mensaje de usuario** en su Drive (`TextMessage` con `recipient`; solo lo ve él) con la hora y un link a la ubicación del vehículo, pidiéndole que se identifique con su llavero. El vehículo **no** se le asigna. Después el que entregó queda desvinculado, igual que en el botón anterior.

La distancia se calcula entre el GPS del teléfono (`api.mobile.geolocation`) y la última posición del vehículo (`DeviceStatusInfo`). Se descuenta el error de la lectura del teléfono y se descartan las lecturas con más de 150 m de error. "Identificado" = `DeviceStatusInfo.driver` es el conductor (llavero NFC, GO Focus o Drive).

## De dónde salen los números

| | Origen |
|---|---|
| Límites de jornada, manejo, continuo, descanso, días seguidos | `settings.fatigue` de Insights (AddInData `a2jBAg7PpaFdQpimkOJ7Ajg`). Se relee **cada 1 hora**; si no se puede leer, se usa la última leída y, si nunca se leyó, los valores de fábrica (12 / 9 / 4 / 8 h, 6 días). |
| Jornada | viajes (`Trip`) del conductor separados por pausas de menos de `rest_split` (4 h). Mismo código de Insights (`static/js/core/fatigue.js`). |
| Viaje en curso | `DeviceStatusInfo` del vehículo: si está manejando y el viaje todavía no llegó al servidor, se suma hasta ahora. |
| Índice de riesgo | `ExceptionEvent` de los vehículos que manejó, con el mapeo de reglas, los pesos y la gravedad por duración de Insights. Cuentan los eventos con su conductor, o sin conductor dentro de uno de sus viajes. |

Opcional: en la configuración de Insights se puede agregar una clave `drive` para cambiar los valores del add-in (ver `DRIVE_DEFAULTS` en `core.js`), por ejemplo `{"away": {"distance_m": 300}}`.

## Instalación

1. GitHub Pages ya publica el repo: la página queda en `https://apicesetti.github.io/geotab-insights-v3/drive/index.html`.
2. En cada base: *Administración → Sistema → Configuración del sistema → Add-Ins → Nuevo* y pegar `drive/addin-config.json`. Es un add-in **aparte** de Insights (no lleva el `id` de Insights). **Quitar "Horas de trabajo (Drive)"** si estaba instalado: ya viene incluido acá. La página "Horas de trabajo" de MyGeotab se deja como está.
3. **Permisos del perfil con el que entran los conductores a Drive** — tiene que poder ver: *Viajes*, *Excepciones*, *Cambios de conductor*, *Estado de los vehículos* (DeviceStatusInfo), *Vehículos*, *Usuarios* (para la lista de relevo) y *Datos de add-ins* (lectura). Para los botones: **agregar cambios de conductor** y **enviar mensajes**. Si falta un permiso, el add-in lo dice en pantalla.
4. **Configuración de Insights visible para los conductores**: Insights guarda la configuración en el grupo de la empresa y en los grupos de acceso de los usuarios **al momento de guardar**. Si un conductor tiene un grupo de acceso nuevo, volver a guardar la configuración desde Insights.
5. En cada teléfono: entrar a Drive una vez y aceptar los permisos de **ubicación** y **notificaciones**.

## Limitaciones

- Los avisos corren mientras Drive está abierto. Con la app en segundo plano, Android suele seguir corriéndolos un rato; iOS los suspende.
- En iOS, `api.mobile` (ubicación, notificaciones, voz) solo funciona si el add-in se carga en la vista principal de Drive, no en un iframe ni en una ventana nueva.
- La posición del vehículo detenido es la última que informó el equipo GO.

## Probar sin Geotab

```
node drive/test-core.js          # lógica (límites, riesgo, alejamiento, acompañante)
python3 drive/dev/run_e2e.py     # navegador con API simulado (Playwright), capturas en drive/dev/shots
python3 drive/dev/run_shell.py   # add-in unificado con dos teléfonos (requiere ../workinghours clonado al lado)
```
