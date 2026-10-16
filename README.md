# Geotab Insights v3 — Cesetti

Add-In de MyGeotab para encontrar oportunidades de mejora en **ralentí, consumo de
combustible, costos y seguridad**, y medir el **impacto de las decisiones del
cliente** (capacitaciones, cambios de política) marcándolas como hitos.

100 % estático, sin backend y sin build: corre en el iframe del Add-In con la
sesión del usuario. Se publica con GitHub Pages.

## Qué cambia respecto de la v2

| | v2 | v3 |
|---|---|---|
| Configuración | `localStorage` (cada usuario la suya) | **AddInData**: igual para todos los usuarios de la base |
| Hitos | `localStorage` | **AddInData**, con alcance (grupos) y categorías |
| Quién edita | cualquiera | administradores (clearance *Everything*) + editores listados |
| Carga | todo el StatusData de combustible del rango + GetFeed por regla + `GetReportData` (no soportado) | **caché por día ya compactado** en IndexedDB; solo se piden días nuevos. Viajes por `Get<Trip>` (soportado) |
| Agrupación | solo semana | día / semana / mes, sin volver a consultar la API |
| Comparación de consumo | "pesados / livianos" por palabra clave (los bitren caían en "otros") | **perfiles**: tipo de vehículo × corta/larga distancia, con objetivos propios |
| Mapeo de reglas | tildar una por una | sugerencia automática (stock + cámaras SRF_), conteo de eventos, oculta Dummy/[TEST], avisa duplicados |
| Conductores | — | ranking por riesgo y por ralentí, con cobertura de identificación |
| Recorridos | — | ranking origen → destino por zonas + mapa de calor de eventos |
| Lista de vehículos | tabla larga | top 12 con "ver todos", orden por exceso/ralentí/consumo y detalle al hacer click |

## Conceptos

- **Índice de riesgo** = Σ(eventos × peso de su categoría) / km × 100. Los pesos se
  editan en Configuración. Ralentí y eventos operativos tienen peso 0.
- **Perfil** = tipo de vehículo × tipo de servicio. Cada vehículo toma el primer
  tipo de la lista cuyos grupos contenga (Bitren va antes que Camión).
  El servicio sale de los grupos "corta"/"larga" configurados; si no está en
  ninguno, se clasifica automáticamente por la distancia mediana de sus recorridos.
- **Referencia de consumo**: el L/100 km objetivo del perfil o, si está en 0, la
  mediana del perfil. El exceso se cuenta solo por encima de la tolerancia (10 %).
- **Recorrido**: desde que el vehículo sale de una zona hasta que llega a otra (o
  hace una parada de más de N horas). Movimientos dentro de la misma zona se ignoran.
- **Impacto de un hito**: misma cantidad de días antes y después, sobre los
  vehículos de los grupos indicados, normalizado por km.
- **Combustible**: deltas diarios de los contadores acumulados
  `DiagnosticDeviceTotalFuelId` y `DiagnosticDeviceTotalIdleFuelId`. Si un vehículo
  no reporta el de ralentí, se estima con horas de ralentí × L/h del tipo de vehículo.
  El combustible por conductor se reparte por km (total) y por horas de ralentí.

## Estructura

```
static/
  index.html
  style.css
  vendor/            React 18, htm, Chart.js 4, Leaflet + leaflet.heat
  js/core/
    util.js          fechas locales, buckets, reintentos, wrapper del api
    catalog.js       categorías, reglas stock, sugerencias, config por defecto
    storage.js       AddInData (config en chunks + hitos), permisos
    data.js          lectura de MyGeotab con caché diario en IndexedDB
    model.js         cubo vehículo × día y todas las agregaciones (puro, testeable)
  js/ui/
    components.js    tabla, KPI, gráficos, selector de grupos
    tabs.js          Resumen, Combustible, Seguridad, Conductores, Recorridos
    milestones.js    Hitos
    config.js        Configuración
    app.js           App + entry point geotab.addin.cesettiInsightsV3
dev/
  index.html         abre el add-in con una flota simulada (sin MyGeotab)
  mock-api.js
```

## Desplegar

1. GitHub Pages sobre la rama `main`, carpeta raíz.
2. En cada base: *Administración → Sistema → Add-Ins → Nuevo Add-In* y pegar
   `addin-config.json`. **No cambiar el `id`**: es la clave con la que se guarda
   la configuración compartida en AddInData.
3. Un administrador abre el add-in: arranca en Configuración con sugerencias
   automáticas. Revisar y "Guardar para todos".

La v2 puede seguir instalada en paralelo mientras se valida.

## Quién puede verlo

`addin-config.json` incluye `"enableViewSecurityId": true`. Con eso MyGeotab
crea el permiso *Ver "Geotab Insights v3 - Cesetti"* en las autorizaciones
(clearances). Viene activado solo para Administrador; para darlo a otros
perfiles hay que crear una sub-autorización con ese permiso activado y
asignarla a los usuarios. Quien no lo tenga no ve el ítem en el menú.

## Probar sin MyGeotab

```
python3 -m http.server 8000
# abrir http://localhost:8000/dev/index.html
```

## Notas

- La restricción "solo administradores" es de la interfaz: la Storage API de
  MyGeotab no permite limitar escritura por usuario.
- El caché local se considera definitivo para días cerrados hace más de 48 h;
  los últimos 2 días se vuelven a pedir cada 15 min. Configuración → General →
  "Borrar caché" fuerza una descarga completa.
- El mapa de calor busca la posición de cada evento (LogRecord) solo al pedirlo
  y la guarda; usa teselas de OpenStreetMap.
