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
      ${ex.night.factor != null ? html`<div className=${"verdict-line " + (ex.night.factor >= 1.2 ? "bad" : ex.night.factor <= 0.85 ? "good" : "")}><span className="vtag">Noche</span><span>
        De noche (entre la puesta y la salida del sol, según fecha y lugar) se hace el <b>${GI.fmtPct((ex.night.km / ex.totKm) * 100, 0)}</b> de los km y el riesgo es${" "}<b>${factorTxt(ex.night.factor)}</b> el del día (${n2(ex.night.idx)} vs ${n2(ex.night.dayIdx)} pts/100 km).</span></div>` : null}
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
        { key: "nightPct", label: "De noche", align: "num", title: "% de km entre la puesta y la salida del sol (según fecha y ubicación del viaje)", fmt: r => GI.fmtPct(r.nightPct, 0) },
        { key: "maxStint", label: "Manejo continuo máx.", align: "num", fmt: r => html`${n1(r.maxStint)} h${r.longStints ? html` <span className="delta bad" title="Veces que manejó más de 4 h seguidas">${r.longStints} veces +4 h</span>` : ""}` },
        { key: "top", label: "Tramo principal", value: r => (r.topRoutes[0] ? r.topRoutes[0].name : ""), fmt: r => (r.topRoutes[0] ? html`<span className="small">${r.topRoutes[0].name}</span>` : html`<span className="muted">–</span>`) },
      ]} empty="No hay conductores con suficientes km en el período." />
    <//>`;
  }

  // ---------- Fatiga ----------
  const fatigueLabel = b => (b.to === Infinity ? "+" + b.from + " h" : b.from + "–" + b.to + " h");
  function levelTag(l) { return html`<span className=${"tag expo-" + l}>${l === "alta" ? "Alta" : l === "media" ? "Media" : "Baja"}</span>`; }

  // Lectura de una correlación en palabras.
  function corrWords(r) {
    if (r == null) return null;
    const a = Math.abs(r);
    if (a < 0.2) return { tone: "flat", text: "no se ve relación" };
    const dir = r > 0 ? "a más horas, más infracciones por km" : "a más horas, menos infracciones por km";
    return { tone: r > 0 ? "bad" : "good", text: (a >= 0.4 ? "relación marcada: " : "relación débil: ") + dir };
  }
  const fmtDay = dk => GI.parseDayKey(dk).toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" });
  const fmtHour = ms => new Date(ms).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });

  // Detalle de jornada, descanso y fatiga de un conductor.
  function FatigueDetail({ view, d, limits: L, onClose }) {
    const days = d.dayList;
    const cw = corrWords(d.corr);
    const worst = days.map(x => ({ ...x,
      flags: (x.dh > L.max_drive_day ? 1 : 0) + (x.span > L.max_span ? 1 : 0) + (x.restBefore != null && x.restBefore < L.min_rest ? 1 : 0) }));
    const lvf = d.longIdx != null && d.normalIdx ? d.longIdx / d.normalIdx : null;
    return html`<${GI.Modal} title=${d.name + " · jornada y descanso"} onClose=${onClose} wide>
      <div className="readouts compact">
        <${Kpi} label="Nivel de fatiga" value=${d.level === "alta" ? "Alta" : d.level === "media" ? "Media" : "Baja"} sub=${html`<span>${d.flags} de 5 límites superados</span>`} />
        <${Kpi} label="Días trabajados" value=${n0(d.days)} sub=${html`<span>hasta ${d.maxRow} días seguidos</span>`} />
        <${Kpi} label="Manejo por día" value=${n1(d.avgDay)} unit="h" sub=${html`<span>máximo ${n1(d.maxDay)} h</span>`} />
        <${Kpi} label="Descanso más corto" value=${d.minRest == null ? "–" : n1(d.minRest)} unit=${d.minRest == null ? null : "h"} sub=${html`<span>${d.shortRests} descansos de menos de ${L.min_rest} h</span>`} />
        <${Kpi} label="Manejo continuo máx." value=${n1(d.maxStint)} unit="h" sub=${html`<span>${d.longStints} veces más de ${L.max_continuous} h seguidas</span>`} />
      </div>
      <div className="why-text">
        <p><b>¿Las horas de trabajo influyen en sus infracciones?</b>
        ${cw ? html` Comparando sus ${d.corrN} días, <span className=${"delta " + cw.tone}>${cw.text}</span> (correlación ${GI.fmtNum(d.corr, 2)}).` : html` Todavía hay pocos días con km suficientes para medirlo (hacen falta 8).`}
        ${lvf != null ? html` En sus días de más de ${L.max_drive_day} h de manejo, su riesgo es <b>${factorTxt(lvf)}</b> el de sus días normales (${n2(d.longIdx)} vs ${n2(d.normalIdx)} pts/100 km).` : null}</p>
        <p className="muted small">La correlación va de −1 a 1: cerca de 0 no hay relación; por encima de 0,4 la relación es marcada. Que haya relación no prueba que el cansancio sea la causa, pero es una señal para revisar su jornada.</p>
      </div>
      <div className="grid-2">
        <div><h3>Horas de manejo por día</h3>
          <${ChartView} height=${220} config=${{
            type: "bar",
            data: { labels: days.map(x => fmtDay(x.dk)), datasets: [{ label: "Horas de manejo", data: days.map(x => GI.round(x.dh, 1)),
              backgroundColor: days.map(x => (x.dh > L.max_drive_day ? "#e34948" : "#2a78d6")), borderRadius: 3, borderSkipped: "start" }] },
            options: { plugins: { legend: { display: false }, tooltip: { callbacks: { afterLabel: c => { const x = days[c.dataIndex]; return "Jornada " + n1(x.span) + " h · " + n0(x.n) + " infracciones" + (x.restBefore != null ? " · descanso previo " + n1(x.restBefore) + " h" : ""); } } } },
              scales: { y: { beginAtZero: true, title: { display: true, text: "h de manejo" } } } },
          }} />
          <p className="muted small">En rojo, los días con más de ${L.max_drive_day} h de manejo.</p></div>
        <div><h3>Horas de manejo vs infracciones cada 100 km (cada punto es un día)</h3>
          <${ChartView} height=${220} config=${{
            type: "scatter",
            data: { datasets: [{ label: "Días", data: days.filter(x => x.rate != null).map(x => ({ x: GI.round(x.dh, 1), y: GI.round(x.rate, 2), dk: x.dk })),
              backgroundColor: "#2a78d6cc", pointRadius: 5, pointHoverRadius: 7 }] },
            options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => fmtDay(c.raw.dk) + ": " + n1(c.raw.x) + " h, " + n2(c.raw.y) + " pts/100 km" } } },
              scales: { x: { beginAtZero: true, title: { display: true, text: "h de manejo en el día" } }, y: { beginAtZero: true, title: { display: true, text: "pts/100 km" } } } },
          }} /></div>
      </div>
      <h3 style=${{ marginTop: "14px" }}>Su riesgo según horas acumuladas al volante en el día</h3>
      <${ChartView} height=${180} config=${{
        type: "bar",
        data: { labels: d.cumBuckets.map(fatigueLabel), datasets: [{ label: "pts/100 km", data: d.cumBuckets.map(b => (b.rate == null ? null : GI.round(b.rate, 2))), backgroundColor: "#2a78d6", borderRadius: 3, borderSkipped: "start" }] },
        options: { plugins: { legend: { display: false }, tooltip: { callbacks: { afterLabel: c => { const b = d.cumBuckets[c.dataIndex]; return n0(b.n) + " infracciones en " + n0(b.km) + " km"; } } } },
          scales: { y: { beginAtZero: true, title: { display: true, text: "pts/100 km" } } } },
      }} />
      <h3 style=${{ marginTop: "14px" }}>Jornadas</h3>
      <${DataTable} rowKey=${r => r.dk} rows=${worst} limit=${15} defaultSort=${{ key: "flags", dir: "desc" }} columns=${[
        { key: "dk", label: "Día", value: r => r.s, fmt: r => fmtDay(r.dk) },
        { key: "s", label: "Inicio", align: "num", fmt: r => fmtHour(r.s) },
        { key: "e", label: "Fin", align: "num", fmt: r => fmtHour(r.e) },
        { key: "span", label: "Jornada", align: "num", fmt: r => html`<span className=${r.span > L.max_span ? "delta bad" : ""}>${n1(r.span)} h</span>` },
        { key: "dh", label: "Manejo", align: "num", fmt: r => html`<span className=${r.dh > L.max_drive_day ? "delta bad" : ""}>${n1(r.dh)} h</span>` },
        { key: "restBefore", label: "Descanso previo", align: "num", fmt: r => (r.restBefore == null ? "–" : html`<span className=${r.restBefore < L.min_rest ? "delta bad" : ""}>${n1(r.restBefore)} h</span>`) },
        { key: "km", label: "Km", align: "num", fmt: r => n0(r.km) },
        { key: "n", label: "Infracciones", align: "num" },
        { key: "rate", label: "pts/100 km", align: "num", fmt: r => (r.rate == null ? "–" : n2(r.rate)) },
        { key: "flags", label: "Alertas", align: "num", fmt: r => (r.flags ? html`<span className="delta bad">${r.flags}</span>` : "0") },
      ]} />
    <//>`;
  }

  function FatiguePanel({ view, rf, onDriver }) {
    const f = rf.fatigue, L = f.limits;
    const [sel, setSel] = useState(null);
    const late = f.buckets.filter(b => b.factor != null && b.from >= 2).sort((a, b) => b.factor - a.factor)[0];
    const minKm = view.settings.drivers.min_km_ranking;
    const rows = f.drivers.filter(d => d.days > 0);
    return html`<div>
      <${Panel} title="Riesgo según horas al volante en el día"
        hint="Índice de riesgo (pts/100 km) según cuántas horas de manejo llevaba el vehículo ese día al momento de cada viaje o infracción. Si sube con las horas, hay un efecto de cansancio.">
        ${late && late.factor >= 1.3 ? html`<div className="verdict-line bad"><span className="vtag">Fatiga</span><span>Con <b>${fatigueLabel(late)}</b> de manejo acumulado en el día, el riesgo es <b>${factorTxt(late.factor)}</b> el de las primeras 2 horas.</span></div>`
          : html`<div className="verdict-line"><span className="vtag">Sin efecto claro</span><span>El riesgo no sube de forma marcada con las horas de manejo del día.</span></div>`}
        <${ChartView} height=${220} config=${{
          type: "bar",
          data: { labels: f.buckets.map(fatigueLabel), datasets: [{ label: "pts/100 km", data: f.buckets.map(b => (b.rate == null ? null : GI.round(b.rate, 2))),
            backgroundColor: f.buckets.map(b => (b.factor != null && b.factor >= 1.3 ? "#e34948" : "#2a78d6")), borderRadius: 4, borderSkipped: "start" }] },
          options: { plugins: { legend: { display: false }, tooltip: { callbacks: { afterLabel: c => { const b = f.buckets[c.dataIndex]; return n0(b.n) + " infracciones en " + n0(b.km) + " km" + (b.factor != null ? " (" + factorTxt(b.factor) + ")" : ""); } } } },
            scales: { x: { title: { display: true, text: "horas de manejo acumuladas en el día" } }, y: { beginAtZero: true, title: { display: true, text: "pts/100 km" } } } },
        }} />
      <//>
      <${Panel} title="Jornada y descanso por conductor"
        hint=${"Límites de referencia (se cambian en Configuración → Fatiga y gravedad): manejo máximo " + L.max_drive_day + " h por día, jornada máxima " + L.max_span + " h (del primer arranque al último corte), descanso mínimo " + L.min_rest + " h entre jornadas, hasta " + L.max_days_row + " días seguidos y manejo continuo de hasta " + L.max_continuous + " h (pausas de menos de 15 min no cortan). Nivel: Alta si incumple 3 o más, Media si incumple alguno."}>
        <div className="readouts compact inset">
          <${Kpi} label="Fatiga alta" value=${n0(rows.filter(d => d.level === "alta").length)} sub=${html`<span>3 o más límites superados</span>`} />
          <${Kpi} label=${"Días con más de " + L.max_drive_day + " h de manejo"} value=${n0(GI.sum(rows, d => d.longDays))} sub=${html`<span>en ${n0(rows.filter(d => d.longDays).length)} conductores</span>`} />
          <${Kpi} label=${"Descansos de menos de " + L.min_rest + " h"} value=${n0(GI.sum(rows, d => d.shortRests))} sub=${html`<span>en ${n0(rows.filter(d => d.shortRests).length)} conductores</span>`} />
        </div>
        ${f.longVsNormal != null || f.shortRestVsRested != null ? html`<div className=${"verdict-line " + ((f.longVsNormal || 0) >= 1.2 || (f.shortRestVsRested || 0) >= 1.2 ? "bad" : "")}><span className="vtag">Horas y riesgo</span><span>
          ${f.longVsNormal != null ? html`En los días de más de ${L.max_drive_day} h de manejo, el riesgo de la flota es <b>${factorTxt(f.longVsNormal)}</b> el de los días normales. ` : null}
          ${f.shortRestVsRested != null ? html`Después de un descanso de menos de ${L.min_rest} h, es <b>${factorTxt(f.shortRestVsRested)}</b> el de los días con descanso completo.` : null}</span></div>` : null}
        <${DataTable} rowKey=${r => r.id} rows=${rows} limit=${20} defaultSort=${{ key: "flags", dir: "desc" }} onRowClick=${r => setSel(r)} columns=${[
          { key: "name", label: "Conductor" },
          { key: "flags", label: "Fatiga", value: r => r.flags * 1000 + r.longDays + r.shortRests, fmt: r => levelTag(r.level) },
          { key: "days", label: "Días trabajados", align: "num" },
          { key: "avgDay", label: "Manejo prom./día", align: "num", fmt: r => n1(r.avgDay) + " h" },
          { key: "maxDay", label: "Máx. en un día", align: "num", fmt: r => html`<span className=${r.maxDay > L.max_drive_day ? "delta bad" : ""}>${n1(r.maxDay)} h</span>` },
          { key: "longSpans", label: "Jornadas +" + L.max_span + " h", align: "num", fmt: r => (r.longSpans ? html`<span className="delta bad">${r.longSpans}</span>` : "0") },
          { key: "shortRests", label: "Descansos −" + L.min_rest + " h", align: "num", fmt: r => (r.shortRests ? html`<span className="delta bad">${r.shortRests}</span>` : "0") },
          { key: "minRest", label: "Descanso más corto", align: "num", fmt: r => (r.minRest == null ? "–" : n1(r.minRest) + " h") },
          { key: "maxRow", label: "Días seguidos", align: "num", fmt: r => html`<span className=${r.maxRow >= L.max_days_row ? "delta bad" : ""}>${r.maxRow}</span>` },
          { key: "maxStint", label: "Continuo máx.", align: "num", fmt: r => html`${n1(r.maxStint)} h${r.longStints ? html` <span className="delta bad" title=${"Veces que manejó más de " + L.max_continuous + " h seguidas"}>${r.longStints}×</span>` : ""}` },
          { key: "corr", label: "Horas ↔ infracciones", align: "num", title: "Correlación entre horas de manejo del día e infracciones por km (−1 a 1). Por encima de 0,4: más horas, más infracciones.",
            fmt: r => { const w = corrWords(r.corr); return w ? html`<span className=${"delta " + w.tone} title=${w.text}>${GI.fmtNum(r.corr, 2)}</span>` : html`<span className="muted">–</span>`; } },
        ]} empty="Sin conductores identificados en el período." />
        <p className="muted small">Click en un conductor para ver sus jornadas, descansos y si sus infracciones aumentan con las horas trabajadas.</p>
        ${sel ? html`<${FatigueDetail} view=${view} d=${sel} limits=${L} onClose=${() => setSel(null)} />` : null}
      <//>
    </div>`;
  }

  // ---------- Familiaridad ----------
  function FamiliarityPanel({ rf }) {
    const fm = rf.familiarity;
    const first = fm.buckets[0], rest = fm.buckets[fm.buckets.length - 1];
    return html`<div>
      <${Panel} title="Riesgo según cuántas veces hizo el recorrido"
        hint="Cada pasada de un conductor por un recorrido se compara con el promedio de ese recorrido (1 = igual que la flota en ese tramo). Para no confundir con quien ya lo conocía de antes, no se cuentan los pares conductor-recorrido que aparecen en los primeros 14 días cargados. Cuanto más largo el período, más confiable.">
        ${first.ratio != null && rest.ratio != null && first.ratio > rest.ratio * 1.2 ? html`<div className="verdict-line bad"><span className="vtag">Tramos nuevos</span><span>La <b>primera vez</b> en un recorrido el riesgo es <b>${factorTxt(first.ratio)}</b> el normal del tramo; con experiencia baja a ${factorTxt(rest.ratio)}. Conviene acompañar o capacitar antes de asignar un recorrido nuevo.</span></div>`
          : first.ratio != null ? html`<div className="verdict-line"><span className="vtag">Sin efecto claro</span><span>La primera vez en un recorrido el riesgo es ${factorTxt(first.ratio)} el normal del tramo.</span></div>`
          : html`<${Info}>Todavía no hay suficientes recorridos nuevos en el período para medirlo. Probá con un período más largo.<//>`}
        <${ChartView} height=${200} config=${{
          type: "bar",
          data: { labels: fm.buckets.map(b => b.label), datasets: [{ label: "Real ÷ esperado", data: fm.buckets.map(b => (b.ratio == null ? null : GI.round(b.ratio, 2))),
            backgroundColor: fm.buckets.map(b => (b.ratio != null && b.ratio >= 1.3 ? "#e34948" : "#2a78d6")), borderRadius: 4, borderSkipped: "start" }] },
          options: { plugins: { legend: { display: false }, tooltip: { callbacks: { afterLabel: c => { const b = fm.buckets[c.dataIndex]; return n0(b.n) + " pasadas, " + n0(b.km) + " km"; } } } },
            scales: { x: { title: { display: true, text: "número de pasada por el recorrido" } }, y: { beginAtZero: true, title: { display: true, text: "real ÷ esperado (1 = normal del tramo)" } } } },
        }} />
      <//>
      <${Panel} title="Conductores nuevos en tramos peligrosos" hint="Conductores que en los últimos 21 días hicieron 3 veces o menos un recorrido cuya peligrosidad es ×1,3 o más la de la flota.">
        <${DataTable} rowKey=${r => r.drv + r.route} rows=${fm.newcomers} limit=${15} defaultSort=${{ key: "danger", dir: "desc" }} columns=${[
          { key: "name", label: "Conductor" },
          { key: "route", label: "Recorrido" },
          { key: "times", label: "Veces", align: "num" },
          { key: "danger", label: "Peligrosidad del tramo", align: "num", fmt: r => html`<span className="delta bad">${factorTxt(r.danger)}</span>` },
          { key: "last", label: "Última vez", align: "num", fmt: r => new Date(r.last).toLocaleDateString("es-AR") },
        ]} empty="Ninguno en los últimos 21 días." />
      <//>
    </div>`;
  }

  // ---------- Gravedad ----------
  function SeverityPanel({ view, rf, onDriver }) {
    const p = rf.prolonged;
    const sevOn = view.settings.severity && view.settings.severity.by_duration;
    return html`<div>
      <${Panel} title="Infracciones prolongadas"
        hint=${"No es lo mismo un exceso de velocidad de 5 segundos que uno de 3 minutos. Se considera prolongada la infracción que dura " + p.longMin + " minuto(s) o más. " + (sevOn ? "El índice de riesgo ya pondera cada infracción por su duración (Configuración → Fatiga y gravedad)." : "Podés hacer que el índice pondere cada infracción por su duración en Configuración → Fatiga y gravedad.")}>
        <h3>Por categoría</h3>
        <${DataTable} rowKey=${r => r.cat} rows=${p.cats} defaultSort=${{ key: "long", dir: "desc" }} columns=${[
          { key: "cat", label: "Categoría", value: r => GI.catLabel(r.cat), fmt: r => html`<span className="dot" style=${{ background: GI.catColor(r.cat) }}></span>${GI.catLabel(r.cat)}` },
          { key: "n", label: "Infracciones", align: "num", fmt: r => n0(r.n) },
          { key: "long", label: "Prolongadas", align: "num", fmt: r => n0(r.long) },
          { key: "pct", label: "% prolongadas", align: "num", fmt: r => GI.fmtPct(r.pct, 0) },
          { key: "avgMin", label: "Duración promedio", align: "num", fmt: r => (r.avgMin >= 1 ? n1(r.avgMin) + " min" : n0(r.avgMin * 60) + " s") },
        ]} empty="Sin infracciones en el período." />
        <h3 style=${{ marginTop: "16px" }}>Conductores con más tiempo en infracción</h3>
        <${DataTable} rowKey=${r => r.id} rows=${p.drivers} limit=${15} defaultSort=${{ key: "minutes", dir: "desc" }} onRowClick=${onDriver ? r => onDriver(r.id) : null} columns=${[
          { key: "name", label: "Conductor" },
          { key: "n", label: "Prolongadas", align: "num" },
          { key: "minutes", label: "Minutos en infracción", align: "num", fmt: r => n0(r.minutes) },
          { key: "maxMin", label: "La más larga", align: "num", fmt: r => n1(r.maxMin) + " min" },
          { key: "cats", label: "Tipos", value: r => (r.cats[0] ? r.cats[0].n : 0), fmt: r => html`<span className="small">${r.cats.slice(0, 3).map(c => GI.catLabel(c.cat) + " " + c.n).join(" · ")}</span>` },
        ]} empty="No hay infracciones prolongadas." />
      <//>
    </div>`;
  }

  const SECTIONS = [["horarios", "Horarios y tráfico"], ["conductores", "Conductores"], ["fatiga", "Jornada y fatiga"], ["familiaridad", "Tramos nuevos"], ["gravedad", "Gravedad"]];

  function ExposureTab({ view, onDriver }) {
    const [sec, setSec] = useState("horarios");
    const ex = useMemo(() => GI.exposure(view.model, view.ids, view.driverOk), [view]);
    const rf = useMemo(() => {
      if (!ex.totKm) return null;
      const rmap = new Map(ex.routes.filter(r => r.stable && r.idx != null).map(r => [r.key, r.idx]));
      return GI.riskFactors(view.model, view.ids, view.driverOk, rmap, ex.fleetIdx);
    }, [ex]);
    if (!ex.totKm) return html`<${Info}>No hay viajes en el período para analizar la exposición.<//>`;
    const top = ex.highCells[0];
    const nt = ex.night;
    return html`<div>
      <div className="readouts">
        <${Kpi} label="Hora más riesgosa" value=${top ? DAYS[top.di] + " " + hh(top.h) + " h" : "–"} sub=${html`<span>${top ? factorTxt(top.factor) + " el promedio de " + n2(ex.fleetRate) + " cada 100 km" : "ninguna supera ×1,5"}</span>`} />
        <${Kpi} label="Recorridos con tráfico" value=${n0(ex.routes.filter(r => r.drop >= 25).length)} sub=${html`<span>van 25% o más lento en alguna franja</span>`} />
        <${Kpi} label="Conductores con fatiga alta" value=${n0(rf.fatigue.drivers.filter(d => d.level === "alta").length)} sub=${html`<span>3 o más límites de jornada superados</span>`} />
        <${Kpi} label="Km de noche" value=${GI.fmtPct((nt.km / ex.totKm) * 100, 0)}
          sub=${html`<span>${nt.factor != null ? "riesgo " + factorTxt(nt.factor) + " el del día" : n0(nt.km) + " km"}</span>`}
          hint="Noche real: entre la puesta y la salida del sol en la ubicación y la fecha de cada viaje (cambia con la estación y la latitud)." />
      </div>
      <div className="subnav"><${Segmented} value=${sec} onChange=${setSec} options=${SECTIONS.map(([value, label]) => ({ value, label }))} /></div>
      ${sec === "horarios" ? html`<${HourGrid} ex=${ex} /><${RoutesTraffic} view=${view} ex=${ex} />`
        : sec === "conductores" ? html`<${DriversExposure} view=${view} ex=${ex} onDriver=${onDriver} />`
        : sec === "fatiga" ? html`<${FatiguePanel} view=${view} rf=${rf} onDriver=${onDriver} />`
        : sec === "familiaridad" ? html`<${FamiliarityPanel} rf=${rf} />`
        : html`<${SeverityPanel} view=${view} rf=${rf} onDriver=${onDriver} />`}
    </div>`;
  }

  Object.assign(GI, { ExposureTab });
})(window.GI);
