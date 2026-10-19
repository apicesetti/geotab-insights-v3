// Glosario de columnas: qué mide cada dato y cómo se calcula. Lo usa el "?"
// de los encabezados de tabla cuando la columna no trae su propia ayuda.
(function (GI) {
  "use strict";

  const RISK = "Índice de riesgo en puntos cada 100 km: se suma cada infracción multiplicada por el peso de su categoría (Configuración → Categorías) y se divide por los km recorridos. El ralentí no cuenta.";

  const HELP = {
    // Identificación
    "Conductor": "Conductor identificado en el viaje o en la infracción (por llave, tarjeta o asignación en MyGeotab). 'Sin conductor identificado' agrupa lo que no tiene conductor asignado.",
    "Vehículo": "Nombre del vehículo en MyGeotab.",
    "Perfil": "Tipo de vehículo (por grupo: bitren, camión, liviano) y servicio (corta o larga distancia, por grupo o detectado según la distancia típica de sus recorridos).",
    "Servicio": "Corta o larga distancia: por el grupo del vehículo en MyGeotab o, si no tiene, según la distancia mediana de sus recorridos (umbral en Configuración → Corta / larga distancia).",
    "Categoría": "Agrupación de reglas de MyGeotab (Configuración → Reglas y objetivos). Cada categoría tiene un peso en el índice de riesgo.",
    "Regla": "Regla de excepción de MyGeotab que genera las infracciones.",
    "Origen": "Zona donde empezó el recorrido (la última zona donde el vehículo estuvo detenido antes de salir).",
    "Destino": "Zona donde terminó el recorrido (primera zona con una parada más larga que el mínimo de Configuración → Recorridos).",
    "Recorrido": "Viaje de una zona a otra: une los viajes intermedios con paradas cortas y se corta al llegar a una zona o tras una parada larga fuera de zona.",
    "Tramo": "Recorrido origen → destino que hizo el conductor.",
    "Tramo principal": "Recorrido origen → destino donde el conductor hizo más km en el período.",
    "Métrica": "Indicador que se compara antes y después del hito.",
    "Día": "Fecha de la jornada (día en que empezó el primer viaje).",
    "#": "Número del punto caliente, ordenado por peso de sus infracciones. Es el mismo número que aparece en el mapa.",
    "Ubicación": "Centro del punto caliente (latitud, longitud). El enlace lo abre en Google Maps.",

    // Distancia y tiempo
    "Km": "Kilómetros recorridos en el período, sumando la distancia de los viajes de MyGeotab.",
    "Km promedio": "Distancia promedio de un recorrido de este origen a este destino.",
    "Recorridos": "Cantidad de veces que se hizo el recorrido en el período.",
    "Vehículos": "Cantidad de vehículos distintos.",
    "Días trabajados": "Días en que el conductor tuvo al menos un viaje.",
    "Inicio": "Hora del primer arranque del día.",
    "Fin": "Hora en que terminó el último viaje del día.",
    "Jornada": "Tiempo desde el primer arranque hasta el último corte del día (incluye paradas).",
    "Manejo": "Horas en movimiento del día (suma de la duración de manejo de los viajes, sin ralentí ni paradas).",
    "Manejo prom./día": "Promedio de horas en movimiento por día trabajado.",
    "Máx. en un día": "El día con más horas de manejo del período.",
    "Descanso previo": "Horas entre el fin de la jornada anterior y el inicio de esta.",
    "Descanso más corto": "El menor descanso entre dos jornadas consecutivas del período.",
    "Días seguidos": "Máxima cantidad de días consecutivos con viajes.",
    "Continuo máx.": "Mayor tiempo manejando sin una pausa de al menos 15 minutos. Se marca cuántas veces superó el límite de manejo continuo.",
    "Manejo continuo máx.": "Mayor tiempo manejando sin una pausa de al menos 15 minutos. Se marca cuántas veces superó las 4 h seguidas.",
    "Veces": "Cantidad de veces que el conductor hizo ese recorrido en el período.",
    "Última vez": "Fecha de la última vez que hizo el recorrido.",

    // Infracciones y riesgo
    "Infracciones": "Cantidad de infracciones de riesgo (reglas asignadas a categorías de riesgo) en el período. No incluye ralentí ni reglas operativas.",
    "Eventos": "Cantidad de infracciones de esa categoría o regla en el período.",
    "Riesgo": RISK,
    "Riesgo real": RISK + " Es el valor real del conductor sobre sus recorridos.",
    "Esperado": "Índice que tendría el conductor si manejara como el promedio de la flota en los mismos recorridos que hizo: km en cada recorrido × riesgo de la flota en ese recorrido.",
    "Su riesgo": RISK + " Solo en este tramo y para este conductor.",
    "Flota en el tramo": "Índice de riesgo de toda la flota en este mismo tramo (pts/100 km).",
    "Conducta": "Riesgo real ÷ esperado. 1 = igual que la flota en los mismos tramos; ×1,3 o más = peor de lo esperable (es cómo maneja); ×0,8 o menos = mejor.",
    "Conducta en el tramo": "Su riesgo en el tramo ÷ el riesgo de la flota en ese mismo tramo. Por encima de 1, en ese tramo maneja peor que el resto.",
    "Exposición": "Riesgo esperado del conductor ÷ promedio de la flota. Mide qué tan riesgosos son los tramos que le tocan: Alta (×1,2 o más), Media o Baja (×0,8 o menos). No depende de cómo maneja.",
    "Peligrosidad": "Índice de riesgo del tramo para toda la flota ÷ promedio de la flota. ×1 = como el promedio; ×1,3 o más = tramo peligroso.",
    "Peligrosidad del tramo": "Índice de riesgo del tramo para toda la flota ÷ promedio de la flota.",
    "Horario de riesgo": "% de los km del conductor hechos en las horas marcadas en rojo en 'Cuándo ocurren las infracciones' (horas con 1,5 veces o más las infracciones por km del promedio).",
    "De noche": "% de los km hechos entre la puesta y la salida del sol, calculadas para la fecha y la ubicación de cada viaje (cambian con la estación y la latitud).",
    "Cada 100 km": "Infracciones cada 100 km recorridos: cantidad ÷ km × 100.",
    "pts/100 km": RISK + " Calculado para ese día.",
    "Hoy /100 km": "Infracciones cada 100 km de la regla en el último período completo (según la agrupación elegida arriba).",
    "Hoy": "Índice de riesgo en el último período completo.",
    "Objetivo": "Máximo de infracciones cada 100 km que fijaste para la regla (Configuración → Reglas y objetivos).",
    "Tendencia": "Cambio por período según una recta ajustada a la serie (regresión lineal), sin contar períodos incompletos. Verde baja, rojo sube.",
    "Proyectado": "Valor estimado unos períodos adelante si sigue la tendencia actual.",
    "Estado": "Situación de la regla respecto de su objetivo: dentro, sobre y subiendo, sobre y bajando, o va a superarlo según la tendencia.",
    "% del riesgo": "Cuánto aporta la categoría al índice de riesgo: (eventos × peso) ÷ total ponderado.",
    "% del total": "Porcentaje de las infracciones de la categoría que corresponden a este conductor.",
    "Más frecuente": "Categoría de infracción más repetida del conductor.",
    "Tipos de infracción": "Categorías de las infracciones, de la más frecuente a la menos, con su cantidad. Pasá el mouse para ver todas.",
    "Tipos": "Categorías de las infracciones, de la más frecuente a la menos.",
    "Más infracciones": "Conductor con más infracciones en este recorrido, con la cantidad entre paréntesis.",
    "Alertas": "Cantidad de límites superados ese día: manejo diario, duración de la jornada y descanso previo (Configuración → Fatiga y gravedad).",
    "Fatiga": "Nivel según cuántos límites supera en el período (manejo por día, jornada, descanso, días seguidos y manejo continuo): Alta 3 o más, Media 1 o 2, Baja ninguno.",
    "Horas ↔ infracciones": "Correlación (−1 a 1) entre las horas de manejo de cada día y sus infracciones por km. Cerca de 0: sin relación. Por encima de 0,4: a más horas, más infracciones. Hacen falta 8 días.",
    "Prolongadas": "Infracciones que duran al menos el mínimo configurado (Configuración → Fatiga y gravedad), según la duración que informa MyGeotab.",
    "% prolongadas": "Prolongadas ÷ total de infracciones de la categoría.",
    "Duración promedio": "Duración media de cada infracción según MyGeotab (desde que empieza hasta que termina).",
    "Minutos en infracción": "Suma de la duración de sus infracciones prolongadas.",
    "La más larga": "Duración de su infracción más larga.",
    "Aporte al cambio": "Cuántos pts/100 km del cambio total del índice explica: (puntos 2.ª mitad ÷ km 2.ª mitad) − (puntos 1.ª mitad ÷ km 1.ª mitad). Los aportes de la tabla suman el cambio total.",
    "Riesgo propio": "Índice de riesgo de ese conductor o vehículo en la 1.ª y en la 2.ª mitad del período.",
    "Eventos 1.ª": "Infracciones de la categoría en la 1.ª mitad del período.",
    "Eventos 2.ª": "Infracciones de la categoría en la 2.ª mitad del período.",
    "Km 1.ª → 2.ª": "Km en la 1.ª y en la 2.ª mitad del período.",
    "Infracciones 1.ª → 2.ª": "Infracciones en la 1.ª y en la 2.ª mitad del período.",
    "Antes": "Valor en la ventana de días anterior al hito.",
    "Después": "Valor en la ventana de días posterior al hito.",
    "Cambio": "Variación porcentual de después respecto de antes.",

    // Combustible y ralentí
    "Ralentí": "% del tiempo con motor encendido y vehículo detenido sobre el total de horas en marcha (o las horas de ralentí, según la tabla).",
    "Litros ralentí": "Litros consumidos en ralentí según el contador del vehículo (o estimados por horas de ralentí si el vehículo no lo informa), con su costo si cargaste el precio.",
    "L/100 km": "Consumo: litros del contador de combustible ÷ km × 100. Solo vehículos que informan el contador.",
    "Exceso": "Litros por encima del consumo de referencia del perfil (más la tolerancia) y del ralentí máximo, con su costo si hay precio cargado.",

    // Tráfico
    "Vel. media": "Km ÷ horas en movimiento de todos los viajes del recorrido (no cuenta paradas ni ralentí).",
    "Caída": "Cuánto más lento es el recorrido en su franja horaria más lenta respecto de la más rápida. Una caída grande suele indicar tráfico.",
    "Conductores": "Cantidad de conductores (o vehículos, si no hay conductor identificado) distintos con infracciones en el lugar.",
  };

  // Columnas con número variable en el nombre.
  const PREFIX = [
    [/^Jornadas \+/, "Días en que la jornada (del primer arranque al último corte) superó el máximo configurado."],
    [/^Descansos [−-]/, "Veces que el descanso entre dos jornadas seguidas fue menor que el mínimo configurado."],
    [/^En \d+/, "Valor proyectado para dentro de esa cantidad de períodos si sigue la tendencia actual."],
  ];

  function columnHelp(label) {
    if (!label || typeof label !== "string") return null;
    if (HELP[label]) return HELP[label];
    for (const [re, txt] of PREFIX) if (re.test(label)) return txt;
    return null;
  }

  Object.assign(GI, { columnHelp, COLUMN_HELP: HELP });
})(window.GI);
