// Pestaña "Exposición": horarios de riesgo, velocidad (tráfico) por recorrido
// y franja, y conductores con riesgo ajustado por los tramos que manejan.
(function (GI) {
  "use strict";
  const React = GI.React, ReactDOM = GI.ReactDOM;
  const { useState, useMemo } = React;
  const html = GI.html;
  const { Kpi, Panel, Info, DataTable, ChartView, Segmented } = GI;
  const n0 = v => GI.fmtNum(v, 0), n1 = v => GI.fmtNum(v, 1), n2 = v => GI.fmtNum(v, 2);
  const DAYS = GI.EXPO_DAYS;
  const DAYS_LONG = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

  // Escalas (paleta validada): secuencial azul para magnitudes; divergente
  // azul ↔ rojo con gris al medio para "respecto del promedio de la flota".
  const SEQ = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95"];
  const DIV_LOW = ["#256abf", "#5598e7", "#9ec5f4"];
  const DIV_MID = "#f0efec";
  const DIV_HIGH = ["#f4c3c2", "#ec8a89", "#e34948", "#b02f2e"];
  const NODATA = "#ffffff";

  function seqColor(v, max) {
    if (!(v > 0) || !(max > 0)) return DIV_MID;
    const i = Math.min(SEQ.length - 1, Math.floor((v / max) * SEQ.length));
    return SEQ[i];
  }
  // factor = tasa de la celda / tasa de la flota.
  function divColor(f) {
    if (f == null) return NODATA;
    if (f < 0.5) return DIV_LOW[0];
    if (f < 0.75) return DIV_LOW[1];
    if (f < 0.9) return DIV_LOW[2];
    if (f <= 1.1) return DIV_MID;
    if (f <= 1.3) return DIV_HIGH[0];
    if (f <= 1.6) return DIV_HIGH[1];
    if (f <= 2.2) return DIV_HIGH[2];
    return DIV_HIGH[3];
  }
  const hh = h => String(h).padStart(2, "0");
  const factorTxt = f => (f == null ? "–" : "×" + n1(f));

  // ---------- Matriz día × hora ----------
  function HourGrid({ ex }) {
    const [mode, setMode] = useState("factor");
    const [hover, setHover] = useState(null);
    let max = 0;
    for (const row of ex.grid) for (const c of row) max = Math.max(max, mode === "n" ? c.n : c.km);
    const color = c => (mode === "factor" ? divColor(c.factor) : seqColor(mode === "n" ? c.n : c.km, max));
    const tip = (di, h) => {
      const c = ex.grid[di][h];
      return DAYS_LONG[di] + " " + hh(h) + "–" + hh(h + 1) + " h: " + n0(c.n) + " infracciones en " + n0(c.km) + " km" +
        (c.rate != null ? " · " + n2(c.rate) + " cada 100 km (" + factorTxt(c.factor) + " la flota)" : " · pocos km para calcular la tasa");
    };
    const top = ex.highCells.slice(0, 3);
    return html`<${Panel} title="Cuándo ocurren las infracciones"
      hint=${"Cada celda es un día de la semana y una hora. 'Respecto de la flota' compara las infracciones cada 100 km de esa hora con el promedio (" + n2(ex.fleetRate) + "): rojo es más riesgoso, azul menos. Las horas con menos de " + n0(ex.minKmCell) + " km quedan en blanco porque la tasa no sería confiable. Los km de cada viaje se reparten entre las horas que dura."}
      actions=${html`<${Segmented} value=${mode} onChange=${setMode} options=${[
        { value: "factor", label: "Respecto de la flota" }, { value: "n", label: "Cantidad" }, { value: "km", label: "Km recorridos" }]} />`}>
      ${top.length ? html`<div className="verdict-line bad"><span className="vtag">Horarios de riesgo</span><span>
        ${top.map((c, i) => html`${i ? (i === top.length - 1 ? " y " : ", ") : ""}<b>${DAYS_LONG[c.di]} de ${hh(c.h)} a ${hh(c.h + 1)} h</b> (${factorTxt(c.factor)})`)}${" "}tienen más infracciones por km que el promedio de la flota.
        ${ex.highCells.length > 3 ? html` <span className="muted">${ex.highCells.length} horas en total superan ×1,5.</span>` : null}</span></div>`
        : html`<div className="verdict-line"><span className="vtag">Sin horarios críticos</span><span>Ninguna hora supera ×1,5 el promedio de infracciones por km de la flota.</span></div>`}
      <div className="hgrid-wrap">
        <div className="hgrid" role="table" aria-label="Infracciones por día y hora">
          <div className="hgrid-row hgrid-head" role="row"><span className="hgrid-day"></span>
            ${Array.from({ length: 24 }, (_, h) => html`<span key=${h} className="hgrid-h" role="columnheader">${h % 3 === 0 ? hh(h) : ""}</span>`)}</div>
          ${ex.grid.map((row, di) => html`<div key=${di} className="hgrid-row" role="row"><span className="hgrid-day" role="rowheader">${DAYS[di]}</span>
            ${row.map((c, h) => html`<span key=${h} role="cell" className=${"hgrid-c" + (c.rate == null && mode === "factor" ? " nodata" : "") + (hover && hover[0] === di && hover[1] === h ? " on" : "")}
              style=${{ background: color(c) }} title=${tip(di, h)} aria-label=${tip(di, h)}
              onMouseEnter=${() => setHover([di, h])} onMouseLeave=${() => setHover(null)}></span>`)}</div>`)}
        </div>
        <div className="hgrid-side">
          ${hover ? html`<div className="hgrid-tip"><b>${DAYS_LONG[hover[0]]} ${hh(hover[1])}–${hh(hover[1] + 1)} h</b>
            <div>${n0(ex.grid[hover[0]][hover[1]].n)} infracciones</div><div>${n0(ex.grid[hover[0]][hover[1]].km)} km</div>
            <div>${ex.grid[hover[0]][hover[1]].rate != null ? n2(ex.grid[hover[0]][hover[1]].rate) + " cada 100 km (" + factorTxt(ex.grid[hover[0]][hover[1]].factor) + ")" : "Pocos km para calcular la tasa"}</div></div>`
            : html`<div className="hgrid-tip muted">Pasá el mouse por una celda para ver el detalle.</div>`}
          ${mode === "factor" ? html`<div className="hgrid-legend">
            ${[["Mucho menos", DIV_LOW[0]], ["Menos", DIV_LOW[2]], ["Como la flota", DIV_MID], ["Más", DIV_HIGH[1]], ["Mucho más (×2,2+)", DIV_HIGH[3]], ["Sin datos suficientes", NODATA]].map(([l, c]) =>
              html`<div key=${l}><span className="sw" style=${{ background: c }}></span>${l}</div>`)}</div>`
            : html`<div className="hgrid-legend"><div><span className="sw" style=${{ background: SEQ[0] }}></span>Poco</div><div><span className="sw" style=${{ background: SEQ[5] }}></span>Mucho (${n0(max)}${mode === "km" ? " km" : ""})</div></div>`}
        </div>
      </div>
      <h3 style=${{ marginTop: "18px" }}>Por hora del día (todos los días)</h3>
      <${ChartView} height=${220} config=${{
        type: "bar",
        data: { labels: ex.byHour.map(x => hh(x.h) + " h"), datasets: [{ label: "Infracciones cada 100 km", data: ex.byHour.map(x => (x.rate == null ? null : GI.round(x.rate, 2))),
          backgroundColor: ex.byHour.map(x => (x.rate != null && ex.fleetRate && x.rate / ex.fleetRate >= 1.5 ? "#e34948" : "#2a78d6")), borderRadius: 4, borderSkipped: "start" }] },
        options: { plugins: { legend: { display: false }, tooltip: { callbacks: { afterLabel: c => { const x = ex.byHour[c.dataIndex]; return n0(x.n) + " infracciones en " + n0(x.km) + " km"; } } } },
          scales: { y: { beginAtZero: true, title: { display: true, text: "infracciones / 100 km" } } } },
      }} />
      <p className="muted small">En rojo, las horas con 1,5 veces o más el promedio de la flota.</p>
    <//>`;
  }

  // ---------- Velocidad y tráfico por recorrido ----------
  function speedColor(v, max) {
    if (v == null || !(max > 0)) return NODATA;
    const f = v / max; // 1 = la franja más rápida del recorrido
    if (f >= 0.95) return DIV_MID;
    if (f >= 0.85) return DIV_HIGH[0];
    if (f >= 0.75) return DIV_HIGH[1];
    if (f >= 0.6) return DIV_HIGH[2];
    return DIV_HIGH[3];
  }

  function RoutesTraffic({ view, ex }) {
    const s = view.settings.journeys;
    const [showNoZone, setShowNoZone] = useState(false);
    const rows = ex.routes.filter(r => r.trips >= s.min_journeys_route && r.km >= s.min_km_route && (showNoZone || !r.noZone));
    const slowRisky = rows.filter(r => r.slowest && r.drop >= 20 && r.slowest.rate != null && r.rate && r.slowest.rate > r.rate * 1.2)
      .sort((a, b) => b.drop - a.drop).slice(0, 3);
    const cols = [
      { key: "name", label: "Recorrido", value: r => r.from + " → " + r.to, fmt: r => html`<b>${r.from}</b> → ${r.to}` },
      { key: "speed", label: "Vel. media", align: "num", title: "Km recorridos / horas en movimiento (no cuenta el ralentí)", fmt: r => (r.speed == null ? "–" : n0(r.speed) + " km/h") },
      ...GI.EXPO_SLOTS.map((sl, i) => ({ key: "s" + i, label: sl.label, align: "num", value: r => r.slots[i].speed,
        title: "Velocidad media saliendo en esa franja. Más rojo = más lento que la franja más rápida del recorrido (posible tráfico).",
        fmt: r => {
          const x = r.slots[i];
          const max = r.fastest ? r.fastest.speed : null;
          return x.speed == null ? html`<span className="muted">–</span>` : html`<span className="spd" style=${{ background: speedColor(x.speed, max) }}
            title=${sl.label + ": " + n0(x.speed) + " km/h, " + n0(x.km) + " km, " + n0(x.n) + " infracciones" + (x.rate != null ? " (" + n2(x.rate) + " cada 100 km)" : "")}>${n0(x.speed)}</span>`;
        } })),
      { key: "drop", label: "Caída", align: "num", title: "Cuánto más lento es el recorrido en su franja más lenta respecto de la más rápida", fmt: r => (r.drop == null || r.drop < 1 ? html`<span className="muted">–</span>` : "−" + n0(r.drop) + "%") },
      { key: "danger", label: "Peligrosidad", align: "num", title: "Índice de riesgo del recorrido respecto del promedio de la flota (×1 = igual)",
        fmt: r => (r.danger == null ? "–" : html`<span className=${"delta " + (r.danger >= 1.3 ? "bad" : r.danger <= 0.8 ? "good" : "flat")}>${factorTxt(r.danger)}</span>`) },
    ];
    return html`<${Panel} title="Velocidad y tráfico por recorrido"
      hint="Velocidad media de cada recorrido según la franja horaria en que sale cada viaje. Una velocidad menor que la de la franja más rápida del mismo recorrido suele indicar tráfico (o más paradas). Peligrosidad compara el índice de riesgo del recorrido con el de toda la flota."
      actions=${html`<label className="inline"><input type="checkbox" checked=${showNoZone} onChange=${e => setShowNoZone(e.target.checked)} /> Incluir recorridos fuera de zona</label>`}>
      ${slowRisky.length ? html`<div className="verdict-line bad"><span className="vtag">Tráfico y riesgo</span><span>
        ${slowRisky.map((r, i) => html`${i ? "; " : ""}<b>${r.from} → ${r.to}</b> va ${n0(r.drop)}% más lento en ${r.slowest.label} y ahí tiene ${n1(r.slowest.rate / r.rate)} veces más infracciones por km`)}.
        Conviene evitar esas salidas.</span></div>` : null}
      <${DataTable} rowKey=${r => r.key} rows=${rows} limit=${15} defaultSort=${{ key: "drop", dir: "desc" }} columns=${cols}
        empty="Ningún recorrido llega a los mínimos. Ampliá el período o bajá los mínimos en Configuración → Recorridos." />
      <p className="muted small">Sin color: la franja más rápida del recorrido. Más rojo: más lento respecto de ella. "–": pocos km en esa franja.</p>
    <//>`;
  }

  // ---------- Conductores: conducta vs exposición ----------
  function conductTag(c) {
    if (c == null) return html`<span className="muted">–</span>`;
    const tone = c >= 1.3 ? "bad" : c <= 0.8 ? "good" : "flat";
    const word = c >= 1.3 ? "Peor que lo esperable" : c <= 0.8 ? "Mejor que lo esperable" : "Como lo esperable";
    return html`<span className=${"delta " + tone} title=${word}>${factorTxt(c)}</span> <span className="muted small">${word}</span>`;
  }
  function exposureTag(e) {
    if (e == null) return "–";
    const label = e >= 1.2 ? "Alta" : e <= 0.8 ? "Baja" : "Media";
    return html`<span className=${"tag expo-" + label.toLowerCase()}>${label}</span> <span className="muted small">${factorTxt(e)}</span>`;
  }

  function DriversExposure({ view, ex, onDriver }) {
    const minKm = view.settings.drivers.min_km_ranking;
    const rows = ex.drivers.filter(d => d.km >= minKm);
    const worse = rows.filter(d => d.conduct != null && d.conduct >= 1.3).length;
    const exposed = rows.filter(d => d.exposure != null && d.exposure >= 1.2).length;
    const tired = rows.filter(d => d.longStints > 0).length;
    return html`<${Panel} title="Conductores: conducta y exposición"
      hint=${"Riesgo esperado = el índice que tendría el conductor si manejara como el promedio de la flota en los mismos recorridos que hizo. Conducta = real ÷ esperado: por encima de 1 maneja peor que lo normal en esos tramos. Exposición = esperado ÷ promedio de la flota: alta significa que sus tramos son más riesgosos que el promedio. Horario de riesgo = % de sus km en las horas marcadas en rojo arriba. Manejo continuo = horas de manejo seguidas con pausas de menos de 15 min. Solo conductores con " + minKm + " km o más."}>
      <div className="readouts compact inset">
        <${Kpi} label="Manejan peor de lo esperable" value=${n0(worse)} sub=${html`<span>conducta ×1,3 o más</span>`} />
        <${Kpi} label="Con exposición alta" value=${n0(exposed)} sub=${html`<span>sus tramos son 20% más riesgosos que la flota</span>`} />
        <${Kpi} label="Con tramos de más de 4 h seguidas" value=${n0(tired)} sub=${html`<span>riesgo de fatiga</span>`} />
      </div>
      <${DataTable} rowKey=${r => r.id} rows=${rows} limit=${20} defaultSort=${{ key: "conduct", dir: "desc" }}
        onRowClick=${onDriver ? r => onDriver(r.id) : null} columns=${[
        { key: "name", label: "Conductor" },
        { key: "km", label: "Km", align: "num", fmt: r => n0(r.km) },
        { key: "actual", label: "Riesgo real", align: "num", title: "pts/100 km", fmt: r => n2(r.actual) },
        { key: "expected", label: "Esperado", align: "num", title: "pts/100 km que tendría manejando como la flota en sus mismos recorridos", fmt: r => n2(r.expected) },
        { key: "conduct", label: "Conducta", fmt: r => conductTag(r.conduct) },
        { key: "exposure", label: "Exposición", fmt: r => exposureTag(r.exposure) },
        { key: "riskPct", label: "Horario de riesgo", align: "num", fmt: r => GI.fmtPct(r.riskPct, 0) },
        { key: "nightPct", label: "Nocturno", align: "num", title: "% de km entre las 22 y las 6 h", fmt: r => GI.fmtPct(r.nightPct, 0) },
        { key: "maxStint", label: "Manejo continuo máx.", align: "num", fmt: r => html`${n1(r.maxStint)} h${r.longStints ? html` <span className="delta bad" title="Veces que manejó más de 4 h seguidas">${r.longStints} veces +4 h</span>` : ""}` },
        { key: "top", label: "Tramo principal", value: r => (r.topRoutes[0] ? r.topRoutes[0].name : ""), fmt: r => (r.topRoutes[0] ? html`<span className="small">${r.topRoutes[0].name}</span>` : html`<span className="muted">–</span>`) },
      ]} empty="No hay conductores con suficientes km en el período." />
    <//>`;
  }

  function ExposureTab({ view, onDriver }) {
    const ex = useMemo(() => GI.exposure(view.model, view.ids, view.driverOk), [view]);
    if (!ex.totKm) return html`<${Info}>No hay viajes en el período para analizar la exposición.<//>`;
    const top = ex.highCells[0];
    let nk = 0;
    ex.grid.forEach(row => row.forEach((c, h) => { if (h >= 22 || h < 6) nk += c.km; }));
    return html`<div>
      <div className="readouts">
        <${Kpi} label="Infracciones cada 100 km" value=${n2(ex.fleetRate)} sub=${html`<span>promedio de la flota en el período</span>`} />
        <${Kpi} label="Hora más riesgosa" value=${top ? DAYS[top.di] + " " + hh(top.h) + " h" : "–"} sub=${html`<span>${top ? factorTxt(top.factor) + " el promedio" : "ninguna supera ×1,5"}</span>`} />
        <${Kpi} label="Km nocturnos" value=${GI.fmtPct((nk / ex.totKm) * 100, 0)} sub=${html`<span>${n0(nk)} km entre las 22 y las 6 h</span>`} />
        <${Kpi} label="Recorridos con tráfico" value=${n0(ex.routes.filter(r => r.drop >= 25).length)} sub=${html`<span>van 25% o más lento en alguna franja</span>`} />
      </div>
      <${HourGrid} ex=${ex} />
      <${RoutesTraffic} view=${view} ex=${ex} />
      <${DriversExposure} view=${view} ex=${ex} onDriver=${onDriver} />
    </div>`;
  }

  Object.assign(GI, { ExposureTab });
})(window.GI);
