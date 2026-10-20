// Pestaña "Corredores": mapa de tramos de ~1 km con tránsito, velocidad e
// infracciones por hora; banda km × hora a lo largo de un recorrido; y lista
// de puntos negros exportable a KML.
(function (GI) {
  "use strict";
  const React = GI.React, ReactDOM = GI.ReactDOM;
  const { useState, useMemo, useEffect, useRef } = React;
  const html = GI.html;
  const { Kpi, Panel, Info, DataTable, ChartView, Segmented } = GI;
  const n0 = v => GI.fmtNum(v, 0), n1 = v => GI.fmtNum(v, 1), n2 = v => GI.fmtNum(v, 2);
  const hh = h => String(h).padStart(2, "0");
  const factorTxt = f => (f == null ? "–" : "×" + n1(f));
  const catLabel = k => { const c = GI.CATEGORIES.find(x => x.key === k); return c ? c.label : k; };

  const SEQ = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95"];
  const DIV_LOW = ["#256abf", "#5598e7", "#9ec5f4"];
  const DIV_MID = "#f0efec";
  const NO_EV = "#9fb4cc";
  const DIV_HIGH = ["#f4c3c2", "#ec8a89", "#e34948", "#b02f2e"];
  function divColor(f) {
    if (f == null) return null;
    if (f < 0.5) return DIV_LOW[0];
    if (f < 0.75) return DIV_LOW[1];
    if (f < 0.9) return DIV_LOW[2];
    if (f <= 1.1) return DIV_MID;
    if (f < 1.5) return DIV_HIGH[0];
    if (f < 2.2) return DIV_HIGH[1];
    if (f < 3.5) return DIV_HIGH[2];
    return DIV_HIGH[3];
  }
  // Escala secuencial por quintiles (los valores de tránsito son muy sesgados).
  function quantColor(values) {
    const s = values.filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
    const q = [0.2, 0.4, 0.6, 0.8, 0.95].map(p => s[Math.floor(p * (s.length - 1))]);
    return v => {
      if (v == null || !s.length) return null;
      let i = 0;
      while (i < q.length && v > q[i]) i++;
      return SEQ[i];
    };
  }

  const EV_CAP = 4000;
  const HOURS = [
    { value: "all", label: "Todo el día", h: null },
    { value: "0-6", label: "Madrugada (0 a 6 h)", h: [0, 6] },
    { value: "6-12", label: "Mañana (6 a 12 h)", h: [6, 12] },
    { value: "12-18", label: "Tarde (12 a 18 h)", h: [12, 18] },
    { value: "18-24", label: "Noche (18 a 24 h)", h: [18, 24] },
    { value: "7-10", label: "Pico mañana (7 a 10 h)", h: [7, 10] },
    { value: "18-21", label: "Pico tarde (18 a 21 h)", h: [18, 21] },
    ...Array.from({ length: 24 }, (_, h) => ({ value: "h" + h, label: hh(h) + " a " + hh(h + 1) + " h", h: [h, h + 1] })),
  ];
  const LAYERS = [
    { value: "riesgo", label: "Riesgo" },
    { value: "transito", label: "Tránsito" },
    { value: "velocidad", label: "Velocidad" },
    { value: "dispersion", label: "Dispersión" },
    { value: "pesados", label: "% pesados" },
  ];
  const LAYER_HELP = {
    riesgo: "Puntos de infracción cada 100 km recorridos en el tramo, comparado con el promedio de todos los tramos: rojo es más riesgoso, azul menos. Los tramos con pocos km quedan en gris claro porque la tasa no sería confiable.",
    transito: "Km por día que la flota recorre en el tramo (estimado con la muestra de GPS). Más oscuro = más tránsito propio.",
    velocidad: "Velocidad media de la flota en el tramo (sin contar los momentos detenida).",
    dispersion: "Cuánto varía la velocidad en el tramo (desvío estándar en km/h). Mucha dispersión = tránsito mezclado (unos van rápido y otros lento): más riesgo de alcances y sobrepasos.",
    pesados: "Porcentaje de los km del tramo hechos por camiones y bitrenes (según el tipo de vehículo de la configuración).",
  };

  function layerValue(layer, c) {
    switch (layer) {
      case "transito": return c.kmDay;
      case "velocidad": return c.speed;
      case "dispersion": return c.sd;
      case "pesados": return c.heavyPct;
      default: return c.factor;
    }
  }
  function cellTip(c) {
    return [
      "<b>" + n0(c.kmDay) + " km/día</b> de la flota · " + n0(c.vehicles) + " vehículos",
      "Velocidad media " + (c.speed == null ? "–" : n0(c.speed) + " km/h") + " (±" + (c.sd == null ? "–" : n0(c.sd)) + ")",
      c.heavyPct != null ? n0(c.heavyPct) + "% de los km en pesados" : "",
      c.n ? n0(c.n) + " infracciones" + (c.idx != null ? " · " + n2(c.idx) + " pts/100 km (" + factorTxt(c.factor) + " el promedio)" : " · pocos km para calcular la tasa") : "Sin infracciones",
      "Hora de más tránsito: " + hh(c.peakH) + " h" + (c.evPeakH != null ? " · más infracciones a las " + hh(c.evPeakH) + " h" : ""),
    ].filter(Boolean).join("<br>");
  }

  function CorridorTab({ view, api, database }) {
    const lastDay = view.model.dayKeys[view.model.dayKeys.length - 1];
    const [nDays, setNDays] = useState(7);
    const [hours, setHours] = useState("all");
    const [layer, setLayer] = useState("riesgo");
    const [data, setData] = useState(null);       // {days, locs}
    const [progress, setProgress] = useState(null);
    const [err, setErr] = useState(null);
    const [sel, setSel] = useState(null);
    const runRef = useRef(0);

    const dayKeys = useMemo(() => {
      const ks = view.model.dayKeys.filter(dk => dk <= GI.dayKey(new Date()));
      return ks.slice(-nDays);
    }, [view.model.dayKeys, nDays]);
    const plan = useMemo(() => GI.corridorPlan(view.model, view.ids), [view.model, view.ids]);
    useEffect(() => { runRef.current++; setData(null); setProgress(null); setSel(null); }, [nDays, view.model, plan.scopeKey]);

    async function load() {
      const id = ++runRef.current;
      setErr(null); setProgress({ p: 0, label: "Muestreando el GPS de la flota" });
      try {
        const days = await GI.loadCorridorDays(api, database, dayKeys, p => { if (id === runRef.current) setProgress({ p: p * 0.7, label: "Muestreando el GPS de la flota (" + dayKeys.length + " días)" }); }, plan);
        if (id !== runRef.current) return;
        // Infracciones: si son muchas se ubica una muestra pareja en el
        // tiempo (no solo las últimas) y cada una pesa total ÷ muestra.
        const dset = new Set(dayKeys);
        const all = view.events.filter(e => e.w > 0 && view.ids.has(e.d) && dset.has(GI.dayKey(e.t))).sort((a, b) => a.t - b.t);
        const step = all.length / EV_CAP;
        const evs = step > 1 ? Array.from({ length: EV_CAP }, (_, k) => all[Math.floor(k * step)]) : all;
        setProgress({ p: 0.7, label: "Ubicando " + n0(evs.length) + " infracciones" });
        const locs = await GI.loadEventLocations(api, evs, p => { if (id === runRef.current) setProgress({ p: 0.7 + p * 0.3, label: "Ubicando " + n0(evs.length) + " infracciones" }); });
        if (id !== runRef.current) return;
        setData({ days, locs, evs, nEvAll: all.length, nEvUsed: evs.length, evScale: evs.length ? all.length / evs.length : 1 });
      } catch (e) { if (id === runRef.current) setErr("No se pudo completar el análisis: " + (e.message || e)); }
      if (id === runRef.current) setProgress(null);
    }

    const hSel = HOURS.find(x => x.value === hours) || HOURS[0];
    const cm = useMemo(() => (data ? GI.corridorModel(view.model, data.days, view.ids, data.evs, data.locs, { hours: hSel.h, evScale: data.evScale }) : null), [data, view.ids, hours]);
    const points = data ? [...data.days.values()].reduce((s, v) => s + (v.points || 0), 0) : 0;

    return html`<div>
      <${Panel} title="Corredores: tránsito, velocidad y riesgo por tramo"
        hint="Para no traer todo el GPS de la flota se toma una muestra: 5 minutos de cada media hora (1 de cada 6 minutos; en flotas de más de 400 vehículos, 5 minutos por hora), de todos los vehículos a la vez. Así todos los días y horas quedan representados y los km se multiplican por 6 (o 12) para estimar el total. Cada tramo es una celda de ~1 km. Las infracciones se ubican todas si son hasta 4.000; si son más, una muestra pareja en el tiempo que se pondera para representar el total. Lo ya procesado queda guardado por día en este navegador."
        actions=${html`<select value=${nDays} onChange=${e => setNDays(+e.target.value)} aria-label="Días a analizar">
            ${[3, 7, 14].map(n => html`<option key=${n} value=${n}>Últimos ${n} días del período</option>`)}
          </select>
          <button className="btn primary" disabled=${progress != null || !dayKeys.length} onClick=${load}>${data ? "Actualizar" : "Analizar corredores"}</button>`}>
        ${progress ? html`<${GI.Progress} value=${progress.p} label=${progress.label} />` : null}
        ${err ? html`<${Info} tone="error">${err}<//>` : null}
        ${!data && !progress ? html`<div className="empty">Se van a analizar ${dayKeys.length} días (${dayKeys[0] || "–"} al ${dayKeys[dayKeys.length - 1] || lastDay}).
          La primera vez cada día lleva ${plan.scopeKey ? "~24 consultas a MyGeotab (una por hora)" : "~48 consultas a MyGeotab (una por media hora)"}; después queda guardado.</div>` : null}
        ${cm ? html`<div className="readouts compact inset">
          <${Kpi} label="Km por día de la flota" value=${n0(cm.kmDay)} hint="Estimado con la muestra de GPS (×6, o ×12 en flotas grandes), solo los vehículos del alcance y las horas elegidas." />
          <${Kpi} label="Tramos recorridos" value=${n0(cm.cells.filter(c => c.km > 0).length)} sub=${html`<span>celdas de ~1 km</span>`} />
          <${Kpi} label="Riesgo promedio" value=${cm.fleetIdx == null ? "–" : n2(cm.fleetIdx)} unit=" pts/100 km" hint="Puntos de infracción (con peso por tipo) cada 100 km en todos los tramos." />
          <${Kpi} label="Puntos negros" value=${n0(cm.black.length)} tone=${cm.black.length ? "bad" : ""} sub=${html`<span>1,5× el promedio o más</span>`} hint="Tramos con al menos 3 infracciones, de 2 o más conductores, y una tasa de 1,5 veces el promedio o más." />
        </div>
        <p className="muted small">${n0(points)} puntos GPS de la muestra · ${n0(cm.nEv)} infracciones ubicadas${data.nEvAll > data.nEvUsed ? " (muestra pareja de " + n0(data.nEvUsed) + " sobre " + n0(data.nEvAll) + "; cada una cuenta por " + n1(data.evScale) + ")" : ""}${plan.scopeKey ? " · Flota grande: muestra de 5 min por hora, guardada para este alcance de grupos" : ""}.</p>` : null}
      <//>
      ${cm ? html`<${CorridorMap} cm=${cm} layer=${layer} setLayer=${setLayer} hours=${hours} setHours=${setHours} sel=${sel} setSel=${setSel} />` : null}
      ${cm && sel ? html`<${CellDetail} cell=${cm.cells.find(c => c.key === sel)} cm=${cm} onClose=${() => setSel(null)} />` : null}
      ${cm ? html`<${BlackSpots} cm=${cm} onFocus=${setSel} hoursLabel=${hSel.label} />` : null}
      ${cm ? html`<${CorridorBandPanel} cm=${cm} view=${view} api=${api} />` : null}
    </div>`;
  }

  function CorridorMap({ cm, layer, setLayer, hours, setHours, sel, setSel }) {
    const ref = useRef(null), mapObj = useRef(null);
    const [zoom, setZoom] = useState(null);
    const color = useMemo(() => {
      if (layer === "riesgo") return c => (c.idx != null && c.n === 0 ? NO_EV : divColor(c.factor));
      const f = quantColor(cm.cells.map(c => layerValue(layer, c)));
      return c => f(layerValue(layer, c));
    }, [cm, layer]);
    useEffect(() => {
      if (!ref.current) return;
      if (!mapObj.current) {
        mapObj.current = L.map(ref.current, { preferCanvas: true });
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(mapObj.current);
        mapObj.current.on("zoomend", () => setZoom(mapObj.current.getZoom()));
      }
      const m = mapObj.current;
      const cells = cm.cells.filter(c => c.km > 0 || c.n > 0);
      if (!m._fitted && cells.length) {
        const b = L.latLngBounds(cells.map(c => c.center));
        m.fitBounds(b, { padding: [20, 20] }); m._fitted = true;
      }
      if (m._cells) m.removeLayer(m._cells);
      // Con poco zoom una celda de 1 km mide 1–2 px: se dibuja como punto de
      // tamaño fijo; acercando, como el cuadrado real del tramo.
      const z = m.getZoom ? m.getZoom() : 10;
      const lat0 = cells.length ? cells[0].center[0] : -38.9;
      const cellPx = 1100 / ((156543.03 * Math.cos((lat0 * Math.PI) / 180)) / Math.pow(2, z));
      const rects = cells.map(c => {
        const col = color(c);
        const st = { stroke: c.key === sel, color: "#111", weight: 2, fillColor: col || "#d9d8d4", fillOpacity: col ? 0.8 : 0.35 };
        const shape = cellPx >= 9 ? L.rectangle(c.bounds, st) : L.circleMarker(c.center, { ...st, radius: Math.max(3, cellPx / 2 + 1) });
        return shape.bindTooltip(cellTip(c), { sticky: true }).on("click", () => setSel(c.key));
      });
      m._cells = L.featureGroup(rects).addTo(m);
      setTimeout(() => m.invalidateSize(), 0);
    }, [cm, color, sel, zoom]);
    useEffect(() => {
      const m = mapObj.current, c = sel && cm.cells.find(x => x.key === sel);
      if (m && c) m.fitBounds(c.bounds, { maxZoom: 14, padding: [80, 80] });
    }, [sel]);
    useEffect(() => () => { if (mapObj.current) { mapObj.current.remove(); mapObj.current = null; } }, []);

    return html`<${Panel} title="Mapa de tramos" hint=${LAYER_HELP[layer]}
      actions=${html`<${Segmented} value=${layer} onChange=${setLayer} options=${LAYERS} />
        <select value=${hours} onChange=${e => setHours(e.target.value)} aria-label="Horario">${HOURS.map(x => html`<option key=${x.value} value=${x.value}>${x.label}</option>`)}</select>`}>
      <div className="hour-slider"><span className="muted small">Hora:</span>
        <input type="range" min="-1" max="23" value=${hours.startsWith("h") ? +hours.slice(1) : -1} aria-label="Hora del día"
          onInput=${e => setHours(+e.target.value < 0 ? "all" : "h" + e.target.value)} />
        <b className="small">${hours.startsWith("h") ? hh(+hours.slice(1)) + " a " + hh(+hours.slice(1) + 1) + " h" : (HOURS.find(x => x.value === hours) || HOURS[0]).label}</b></div>
      <div ref=${ref} className="map"></div>
      <div className="hgrid-legend row">${layer === "riesgo"
        ? [["Mucho menos", DIV_LOW[0]], ["Menos", DIV_LOW[2]], ["Como el promedio", DIV_MID], ["Más", DIV_HIGH[1]], ["Mucho más (×3,5+)", DIV_HIGH[3]], ["Sin infracciones", NO_EV], ["Pocos km", "#d9d8d4"]].map(([l, c]) => html`<div key=${l}><span className="sw" style=${{ background: c }}></span>${l}</div>`)
        : html`<div><span className="sw" style=${{ background: SEQ[0] }}></span>Bajo</div><div><span className="sw" style=${{ background: SEQ[5] }}></span>Alto (5% de los tramos más altos)</div>`}</div>
      <p className="muted small">Hacé click en un tramo para ver su perfil por hora.</p>
    <//>`;
  }

  function CellDetail({ cell, cm, onClose }) {
    if (!cell) return null;
    const rate = cell.byHour.map((km, h) => (km >= 20 ? (cell.evByHour[h] / km) * 100 : null));
    return html`<${Panel} title=${"Tramo en " + cell.center[0].toFixed(4) + ", " + cell.center[1].toFixed(4)}
      actions=${html`<a className="btn" target="_blank" rel="noopener" href=${"https://www.google.com/maps?q=" + cell.center[0].toFixed(5) + "," + cell.center[1].toFixed(5)}>Ver en Google Maps</a>
        <button className="btn" onClick=${onClose}>Cerrar</button>`}>
      <div className="readouts compact inset">
        <${Kpi} label="Km por día" value=${n0(cell.kmDay)} sub=${html`<span>${n0(cell.vehicles)} vehículos distintos</span>`} />
        <${Kpi} label="Velocidad media" value=${cell.speed == null ? "–" : n0(cell.speed)} unit=" km/h" sub=${html`<span>± ${cell.sd == null ? "–" : n0(cell.sd)} km/h</span>`} />
        <${Kpi} label="Pesados" value=${cell.heavyPct == null ? "–" : n0(cell.heavyPct) + "%"} />
        <${Kpi} label="Riesgo" value=${cell.idx == null ? "–" : n2(cell.idx)} unit=" pts/100 km" tone=${cell.factor >= 1.5 ? "bad" : ""} sub=${html`<span>${factorTxt(cell.factor)} el promedio · ${n0(cell.n)} infracciones</span>`} />
      </div>
      ${cell.cats.length ? html`<p className="small">Tipos: ${cell.cats.slice(0, 4).map((x, i) => html`${i ? ", " : ""}<b>${GI.catLabel ? GI.catLabel(x.cat) : x.cat}</b> ${n0(x.n)}`)}</p>` : null}
      <${ChartView} height=${200} config=${{
        type: "bar",
        data: { labels: cell.byHour.map((_, h) => hh(h)), datasets: [
          { type: "bar", label: "Km por día", data: cell.byHour.map(km => GI.round(km / cm.nDays, 1)), backgroundColor: "#9ec5f4", borderRadius: 3, yAxisID: "y" },
          { type: "line", label: "pts/100 km", data: rate.map(r => (r == null ? null : GI.round(r, 2))), borderColor: "#e34948", backgroundColor: "#e34948", spanGaps: false, yAxisID: "y1" },
        ] },
        options: { scales: { y: { beginAtZero: true, title: { display: true, text: "km por día" } }, y1: { beginAtZero: true, position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "pts/100 km" } } } },
      }} />
      <p className="muted small">La línea roja solo se dibuja en las horas con 20 km o más en el período.</p>
    <//>`;
  }

  function BlackSpots({ cm, onFocus, hoursLabel }) {
    const rows = cm.black.slice(0, 50).map((c, i) => ({ ...c, rank: i + 1 }));
    const kml = () => GI.downloadText("puntos-negros.kml", GI.corridorKml(rows, "Puntos negros (" + hoursLabel + ")"), "application/vnd.google-earth.kml+xml");
    return html`<${Panel} title="Puntos negros"
      hint="Tramos de ~1 km con al menos 3 infracciones, de 2 o más conductores, y 1,5 veces o más el riesgo promedio por km. Se ordenan por puntos × factor (pesa tanto la cantidad como la intensidad). El KML se puede importar como zonas en MyGeotab (add-in Import KML Zones) para ponerles una regla o avisar a los conductores al entrar."
      actions=${rows.length ? html`<button className="btn" onClick=${kml}>Descargar KML</button>` : null}>
      ${rows.length ? html`<${DataTable} rowKey=${r => r.key} rows=${rows} limit=${15} defaultSort=${{ key: "rank", dir: "asc" }} onRowClick=${r => onFocus(r.key)} columns=${[
        { key: "rank", label: "#", align: "num" },
        { key: "center", label: "Ubicación", value: r => r.center[0], fmt: r => r.center[0].toFixed(4) + ", " + r.center[1].toFixed(4), help: "Centro del tramo (latitud, longitud). Click en la fila para verlo en el mapa." },
        { key: "factor", label: "Riesgo", align: "num", fmt: r => html`<span className="delta bad">${factorTxt(r.factor)}</span>`, help: "Infracciones por km del tramo respecto del promedio de todos los tramos." },
        { key: "n", label: "Infracciones", align: "num", fmt: r => n0(r.n) },
        { key: "drivers", label: "Conductores", align: "num", fmt: r => n0(r.drivers), help: "Conductores distintos con infracciones en el tramo: si son varios, el problema es del lugar más que de una persona." },
        { key: "cats", label: "Tipo principal", value: r => (r.cats[0] ? r.cats[0].cat : ""), fmt: r => (r.cats[0] ? catLabel(r.cats[0].cat) : "–") },
        { key: "evPeakH", label: "Hora crítica", align: "num", fmt: r => (r.evPeakH == null ? "–" : hh(r.evPeakH) + " h"), help: "Hora del día con más puntos de infracción en el tramo." },
        { key: "kmDay", label: "Km/día", align: "num", fmt: r => n0(r.kmDay), help: "Km por día que la flota recorre en el tramo (estimado con la muestra de GPS)." },
        { key: "speed", label: "Vel. media", align: "num", fmt: r => (r.speed == null ? "–" : n0(r.speed) + " km/h") },
        { key: "sd", label: "Dispersión", align: "num", fmt: r => (r.sd == null ? "–" : "±" + n0(r.sd)), help: "Desvío estándar de la velocidad en el tramo (km/h). Alto = tránsito mezclado." },
        { key: "heavyPct", label: "% pesados", align: "num", fmt: r => (r.heavyPct == null ? "–" : n0(r.heavyPct) + "%") },
      ]} />` : html`<div className="empty">No hay tramos que cumplan las condiciones en este horario.</div>`}
    <//>`;
  }

  // Banda km × hora a lo largo de un recorrido elegido.
  function CorridorBandPanel({ cm, view, api }) {
    const routes = useMemo(() => GI.routeRows(view.model, view.ids).filter(r => !r.noZone && r.km > 0).sort((a, b) => b.km - a.km).slice(0, 40), [view]);
    const [rk, setRk] = useState("");
    const [mode, setMode] = useState("riesgo");
    const [trace, setTrace] = useState(null);
    useEffect(() => {
      setTrace(null);
      if (!rk) return;
      const j = view.model.journeys.filter(j => view.ids.has(j.d) && !j.internal && j.o + "→" + j.dest === rk).sort((a, b) => b.km - a.km)[0];
      if (!j) return;
      let alive = true;
      setTrace({ loading: true, j });
      GI.loadTrace(api, j.d, j.s, j.e).then(pts => alive && setTrace({ pts, j })).catch(e => alive && setTrace({ error: String(e.message || e), j }));
      return () => { alive = false; };
    }, [rk]);
    const band = useMemo(() => (trace && trace.pts ? GI.corridorBand(cm, trace.pts) : null), [trace, cm]);
    const MIN_KM = 15;
    let maxKm = 0;
    if (band) for (const b of band.bins) for (const k of b.km) maxKm = Math.max(maxKm, k);
    const cellColor = (b, h) => {
      if (mode === "transito") { const v = b.km[h]; return v > 0 ? SEQ[Math.min(5, Math.floor((v / (maxKm || 1)) * 6))] : "#fff"; }
      if (b.km[h] < MIN_KM) return "#fff";
      return divColor(cm.fleetIdx ? ((b.w[h] / b.km[h]) * 100) / cm.fleetIdx : null) || "#fff";
    };
    const tip = (b, h) => "km " + n0(b.from) + "–" + n0(b.to) + ", " + hh(h) + " h: " + n0(b.km[h] / cm.nDays) + " km/día de la flota" +
      (b.km[h] >= MIN_KM ? " · " + n2((b.w[h] / b.km[h]) * 100) + " pts/100 km" : " · pocos km para la tasa");
    const r = routes.find(x => x.key === rk);
    return html`<${Panel} title="A qué km y a qué hora del recorrido"
      hint="Se toma como referencia el trazado GPS del viaje más largo del recorrido elegido y se proyectan sobre él los tramos que están a menos de 1,5 km. Cada fila es un tramo del recorrido (2 km; en recorridos largos, más) (desde la salida) y cada columna una hora del día. Sirve para ver, por ejemplo, que entre el km 40 y el 60 el riesgo se dispara de 18 a 21 h."
      actions=${html`<select value=${rk} onChange=${e => setRk(e.target.value)} aria-label="Recorrido">
          <option value="">Elegí un recorrido…</option>${routes.map(x => html`<option key=${x.key} value=${x.key}>${x.from} → ${x.to} (${n0(x.n)} viajes)</option>`)}
        </select>
        <${Segmented} value=${mode} onChange=${setMode} options=${[{ value: "riesgo", label: "Riesgo" }, { value: "transito", label: "Tránsito" }]} />`}>
      ${!rk ? html`<div className="empty">Elegí un recorrido para ver su banda de riesgo por km y hora.</div>`
        : trace && trace.loading ? html`<div className="empty">Trayendo el trazado de referencia…</div>`
        : trace && trace.error ? html`<${Info} tone="error">No se pudo traer el trazado: ${trace.error}<//>`
        : !band ? html`<div className="empty">No hay trazado para este recorrido.</div>`
        : html`<p className="muted small">${r ? r.from + " → " + r.to : ""}: ${n0(band.total)} km (filas de ${n0(band.stepKm)} km) según el viaje del ${new Date(trace.j.s).toLocaleDateString("es-AR")}.</p>
          <div className="hgrid-wrap"><div className="hgrid band" role="table" aria-label="Riesgo por km y hora">
            <div className="hgrid-row hgrid-head" role="row"><span className="hgrid-day">km</span>
              ${Array.from({ length: 24 }, (_, h) => html`<span key=${h} className="hgrid-h" role="columnheader">${h % 3 === 0 ? hh(h) : ""}</span>`)}</div>
            ${band.bins.map((b, i) => html`<div key=${i} className="hgrid-row" role="row"><span className="hgrid-day" role="rowheader">${n0(b.from)}</span>
              ${b.km.map((_, h) => html`<span key=${h} role="cell" className="hgrid-c" style=${{ background: cellColor(b, h) }} title=${tip(b, h)}></span>`)}</div>`)}
          </div></div>
          <p className="muted small">${mode === "riesgo" ? "Rojo: más infracciones por km que el promedio; azul: menos; blanco: menos de " + MIN_KM + " km en el período para calcular." : "Más oscuro: más km de la flota en ese km y hora."}</p>`}
    <//>`;
  }

  Object.assign(GI, { CorridorTab });
})(window.GI);
