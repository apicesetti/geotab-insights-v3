// Pestañas de análisis: Resumen, Combustible y ralentí, Seguridad,
// Conductores, Recorridos + modales de detalle.
(function (GI) {
  "use strict";
  const { useState, useMemo, useEffect } = React;
  const html = GI.html;
  const { Kpi, Delta, Panel, Info, DataTable, ChartView, Segmented, Modal } = GI;
  const n0 = v => GI.fmtNum(v, 0), n1 = v => GI.fmtNum(v, 1), n2 = v => GI.fmtNum(v, 2);

  function halfTrend(view, key) {
    const s = view.series.filter(x => x.km > 0);
    if (s.length < 4) return null;
    const h = Math.floor(s.length / 2);
    const avg = arr => {
      const v = arr.map(x => x[key]).filter(x => x != null);
      return v.length ? GI.sum(v) / v.length : null;
    };
    return GI.pctChange(avg(s.slice(0, h)), avg(s.slice(h)));
  }

  // ======================= RESUMEN =======================
  const METRICS = {
    risk: { label: "Índice de riesgo (pts/100 km)", color: "#dc2626", dec: 2 },
    idlePct: { label: "% ralentí", color: "#16a34a", dec: 1 },
    l100: { label: "Consumo (L/100 km)", color: "#2563eb", dec: 1 },
    events: { label: "Eventos de riesgo", color: "#9333ea", dec: 0 },
    km: { label: "Kilómetros", color: "#475569", dec: 0 },
  };

  function TrendChart({ view, metric, height }) {
    const m = METRICS[metric];
    return html`<${ChartView} height=${height || 280} config=${{
      type: metric === "events" || metric === "km" ? "bar" : "line",
      data: {
        labels: view.series.map(s => s.label),
        datasets: [{ label: m.label, data: view.series.map(s => s[metric] == null ? null : GI.round(s[metric], m.dec)),
          borderColor: m.color, backgroundColor: m.color + "33", fill: true, tension: 0.25, spanGaps: true, pointRadius: 3 }],
      },
      options: {
        plugins: { legend: { display: false }, milestones: { items: GI.milestoneMarks(view.milestones, view.series, view.gran) } },
        scales: { y: { beginAtZero: true } },
      },
    }} />`;
  }

  function Findings({ items, onGo }) {
    if (!items.length) return html`<div className="empty">Sin hallazgos relevantes para este período.</div>`;
    const order = { oportunidad: 0, logro: 1, dato: 2 };
    return html`<div className="findings">${[...items].sort((a, b) => order[a.type] - order[b.type]).map((f, i) => html`
      <div key=${i} className=${"finding " + f.type + " sev-" + f.sev}>
        <div className="finding-tag">${f.type === "logro" ? "Mejora" : f.type === "dato" ? "Calidad de datos" : "Oportunidad"}</div>
        <div className="finding-title">${f.title}</div>
        <div className="finding-text">${f.text}</div>
        ${f.target ? html`<button className="btn link" onClick=${() => onGo(f.target.tab)}>Ver detalle →</button>` : null}
      </div>`)}</div>`;
  }

  function SummaryTab({ view, onGo }) {
    const [metric, setMetric] = useState("risk");
    const k = view.total;
    const price = view.settings.fuel.price_per_liter;
    return html`<div>
      <div className="kpis">
        <${Kpi} label="Kilómetros" value=${n0(k.km)} sub=${view.vRows.filter(r => r.km > 0).length + " vehículos activos"} />
        <${Kpi} label="Índice de riesgo" value=${n2(k.risk)} sub=${html`pts/100 km <${Delta} value=${halfTrend(view, "risk")} goodWhenDown />`}
          hint="Eventos de riesgo ponderados por su peso cada 100 km. Variación: 2.ª mitad vs 1.ª mitad del período." />
        <${Kpi} label="Ralentí" value=${GI.fmtPct(k.idlePct)} sub=${html`${n0(k.idleH)} h <${Delta} value=${halfTrend(view, "idlePct")} goodWhenDown />`} />
        <${Kpi} label="Consumo" value=${k.l100 == null ? "–" : n1(k.l100)} sub=${html`L/100 km <${Delta} value=${halfTrend(view, "l100")} goodWhenDown />`} />
        <${Kpi} label="Costo de ralentí" value=${price ? GI.fmtMoney(k.idleL * price) : n0(k.idleL) + " L"} sub=${price ? n0(k.idleL) + " L" : "Cargá el precio en Configuración"} />
        <${Kpi} tone="accent" label="Ahorro potencial" value=${price ? GI.fmtMoney(view.savings.cost) : n0(view.savings.totalL) + " L"}
          sub=${n0(view.savings.totalL) + " L sobre objetivo"} hint="Litros por encima del ralentí máximo y del consumo de referencia de cada perfil." />
      </div>
      <div className="grid-2-1">
        <${Panel} title="Evolución" sub=${"Agrupado por " + ({ day: "día", week: "semana", month: "mes" })[view.gran] + ". ◆ = hito · * = período incompleto."}
          actions=${html`<${Segmented} value=${metric} onChange=${setMetric} options=${[
            { value: "risk", label: "Riesgo" }, { value: "idlePct", label: "Ralentí" }, { value: "l100", label: "Consumo" }, { value: "km", label: "Km" }]} />`}>
          <${TrendChart} view=${view} metric=${metric} />
        <//>
        <${Panel} title="Hallazgos">
          <${Findings} items=${view.findings} onGo=${onGo} />
        <//>
      </div>
      <${Panel} title="Por perfil de operación" sub="Cada perfil se compara contra sus propios objetivos (Configuración → Objetivos).">
        <${DataTable} rowKey=${r => r.profile} rows=${view.pRows} defaultSort=${{ key: "km", dir: "desc" }} columns=${[
          { key: "profile", label: "Perfil", fmt: r => GI.profileLabel(view.settings, r.profile), value: r => r.profile },
          { key: "vehicles", label: "Vehíc.", align: "num" },
          { key: "km", label: "Km", align: "num", fmt: r => n0(r.km) },
          { key: "l100", label: "L/100 km", align: "num", fmt: r => html`${n1(r.l100)}${r.target.l100 ? html` <span className="muted">/ ${n1(r.target.l100)}</span>` : ""}` },
          { key: "idlePct", label: "% ralentí", align: "num", fmt: r => html`<span className=${r.idlePct > r.target.idle_pct_max ? "bad" : "good"}>${GI.fmtPct(r.idlePct)}</span> <span className="muted">/ ${r.target.idle_pct_max}%</span>` },
          { key: "risk", label: "Riesgo", align: "num", fmt: r => html`<span className=${r.risk > r.target.risk_max ? "bad" : "good"}>${n2(r.risk)}</span> <span className="muted">/ ${n2(r.target.risk_max)}</span>` },
          { key: "events", label: "Eventos", align: "num", fmt: r => n0(r.events) },
        ]} />
      <//>
    </div>`;
  }

  // ======================= COMBUSTIBLE =======================
  function FuelTab({ view, onVehicle }) {
    const k = view.total;
    const price = view.settings.fuel.price_per_liter;
    const [mode, setMode] = useState("desvio");
    const rows = view.vRows.filter(r => r.km > 0 || r.idleH > 0);
    const sortKey = mode === "desvio" ? "excessL" : mode === "ralenti" ? "idleH" : "l100";
    const vtypes = [...new Set(rows.map(r => r.vtype))];
    const typeSeries = vtypes.map(vt => {
      const ids = new Set(rows.filter(r => r.vtype === vt).map(r => r.id));
      return { vt, s: GI.series(view.model, ids, view.gran) };
    });
    const palette = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2"];
    return html`<div>
      <div className="kpis">
        <${Kpi} label="Combustible medido" value=${n0(k.fuelL) + " L"} sub=${view.model.fuelDevices.size + " vehículos con medición"} />
        <${Kpi} label="Consumo promedio" value=${k.l100 == null ? "–" : n1(k.l100)} sub="L/100 km" />
        <${Kpi} label="Horas de ralentí" value=${n0(k.idleH)} sub=${GI.fmtPct(k.idlePct) + " del tiempo en marcha"} />
        <${Kpi} label="Litros en ralentí" value=${n0(k.idleL)} sub=${price ? GI.fmtMoney(k.idleL * price) : "sin precio cargado"} />
        <${Kpi} tone="accent" label="Exceso sobre objetivo" value=${n0(view.savings.totalL) + " L"}
          sub=${(price ? GI.fmtMoney(view.savings.cost) + " · " : "") + n0(view.savings.idleL) + " L ralentí + " + n0(view.savings.fuelL) + " L consumo"} />
      </div>
      <div className="grid-2">
        <${Panel} title="Ralentí" sub="Litros (barras) y % del tiempo en marcha (línea)">
          <${ChartView} config=${{
            type: "bar",
            data: { labels: view.series.map(s => s.label), datasets: [
              { type: "bar", label: "Litros ralentí", data: view.series.map(s => GI.round(s.idleL, 0)), backgroundColor: "#86efac", yAxisID: "y" },
              { type: "line", label: "% ralentí", data: view.series.map(s => s.idlePct == null ? null : GI.round(s.idlePct, 1)), borderColor: "#15803d", yAxisID: "y1", tension: 0.25 },
            ] },
            options: { plugins: { milestones: { items: GI.milestoneMarks(view.milestones, view.series, view.gran) } },
              scales: { y: { beginAtZero: true, title: { display: true, text: "L" } }, y1: { beginAtZero: true, position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "%" } } } },
          }} />
        <//>
        <${Panel} title="Consumo por tipo de vehículo" sub="L/100 km. Cada tipo se compara contra su propio perfil.">
          <${ChartView} config=${{
            type: "line",
            data: { labels: view.series.map(s => s.label), datasets: typeSeries.map((t, i) => ({
              label: GI.vtypeLabel(view.settings, t.vt), data: t.s.map(x => x.l100 == null ? null : GI.round(x.l100, 1)),
              borderColor: palette[i % palette.length], tension: 0.25, spanGaps: true })) },
            options: { plugins: { milestones: { items: GI.milestoneMarks(view.milestones, view.series, view.gran) } } },
          }} />
        <//>
      </div>
      <${Panel} title="Vehículos" sub=${"Exceso = litros por encima de la referencia + " + (view.settings.fuel.tolerance_pct != null ? view.settings.fuel.tolerance_pct : 10) + "% de tolerancia, más ralentí por encima del máximo del perfil. Click en un vehículo para ver su detalle."}
        actions=${html`<${Segmented} value=${mode} onChange=${setMode} options=${[
          { value: "desvio", label: "Mayor exceso" }, { value: "ralenti", label: "Más ralentí" }, { value: "consumo", label: "Mayor consumo" }]} />`}>
        <${DataTable} rowKey=${r => r.id} rows=${rows} limit=${12} onRowClick=${r => onVehicle(r.id)}
          defaultSort=${{ key: sortKey, dir: "desc" }} columns=${[
          { key: "name", label: "Vehículo" },
          { key: "profile", label: "Perfil", fmt: r => GI.profileLabel(view.settings, r.profile) },
          { key: "km", label: "Km", align: "num", fmt: r => n0(r.km) },
          { key: "l100", label: "L/100", align: "num", fmt: r => r.fuelMeasured ? n1(r.l100) : html`<span className="muted" title="Sin medición de combustible">s/d</span>` },
          { key: "refL100", label: "Ref.", align: "num", fmt: r => n1(r.refL100), title: "Objetivo del perfil o mediana del perfil" },
          { key: "fuelDevPct", label: "Desvío", align: "num", fmt: r => r.fuelDevPct == null ? "–" : html`<span className=${r.fuelExcessL > 0 ? "bad" : r.fuelDevPct <= -5 ? "good" : ""}>${(r.fuelDevPct > 0 ? "+" : "") + n0(r.fuelDevPct)}%</span>` },
          { key: "idleH", label: "Ralentí h", align: "num", fmt: r => n1(r.idleH) },
          { key: "idlePct", label: "% ralentí", align: "num", fmt: r => html`<span className=${r.idlePct > r.idleMax ? "bad" : ""}>${GI.fmtPct(r.idlePct)}</span>` },
          { key: "excessL", label: "Exceso L", align: "num", value: r => r.fuelExcessL + r.idleExcessL, fmt: r => n0(r.fuelExcessL + r.idleExcessL) },
          { key: "excessCost", label: "Exceso $", align: "num", fmt: r => price ? GI.fmtMoney(r.excessCost) : "–" },
        ]} />
      <//>
    </div>`;
  }

  // ======================= SEGURIDAD =======================
  function SafetyTab({ view, onVehicle }) {
    const riskCats = GI.CATEGORIES.filter(c => c.kind === "riesgo" && view.series.some(s => (s.evByCat[c.key] || 0) > 0));
    const total = view.total;
    const half = Math.floor(view.series.length / 2);
    const catRows = riskCats.map(c => {
      const n = total.evByCat[c.key] || 0;
      const w = n * (view.settings.category_weights[c.key] || 0);
      const kmA = GI.sum(view.series.slice(0, half), s => s.km), kmB = GI.sum(view.series.slice(half), s => s.km);
      const nA = GI.sum(view.series.slice(0, half), s => s.evByCat[c.key] || 0), nB = GI.sum(view.series.slice(half), s => s.evByCat[c.key] || 0);
      return { key: c.key, label: c.label, n, per100: total.km ? (n / total.km) * 100 : null, weight: view.settings.category_weights[c.key],
        share: total.weighted ? (w / total.weighted) * 100 : 0, trend: kmA && kmB ? GI.pctChange(nA / kmA, nB / kmB) : null };
    });
    const opCats = GI.CATEGORIES.filter(c => c.kind === "operativo" && (total.evByCat[c.key] || 0) > 0);
    return html`<div>
      <${Panel} title="Eventos de riesgo por categoría" sub="Barras: cantidad de eventos. Línea: índice de riesgo (pts/100 km).">
        <${ChartView} height=${320} config=${{
          type: "bar",
          data: { labels: view.series.map(s => s.label), datasets: [
            ...riskCats.map(c => ({ type: "bar", label: c.label, data: view.series.map(s => s.evByCat[c.key] || 0), backgroundColor: c.color, stack: "ev", yAxisID: "y" })),
            { type: "line", label: "Índice de riesgo", data: view.series.map(s => s.risk == null ? null : GI.round(s.risk, 2)), borderColor: "#111827", yAxisID: "y1", tension: 0.25, spanGaps: true },
          ] },
          options: { plugins: { milestones: { items: GI.milestoneMarks(view.milestones, view.series, view.gran) } },
            scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true }, y1: { position: "right", beginAtZero: true, grid: { drawOnChartArea: false } } } },
        }} />
      <//>
      <div className="grid-2">
        <${Panel} title="Categorías" sub="Tendencia: tasa/100 km, 2.ª mitad vs 1.ª mitad del período.">
          <${DataTable} rowKey=${r => r.key} rows=${catRows} defaultSort=${{ key: "share", dir: "desc" }} columns=${[
            { key: "label", label: "Categoría", fmt: r => html`<span className="dot" style=${{ background: GI.catColor(r.key) }}></span>${r.label}` },
            { key: "n", label: "Eventos", align: "num", fmt: r => n0(r.n) },
            { key: "per100", label: "/100 km", align: "num", fmt: r => n2(r.per100) },
            { key: "share", label: "% del riesgo", align: "num", fmt: r => n0(r.share) + "%" },
            { key: "trend", label: "Tendencia", align: "num", fmt: r => html`<${Delta} value=${r.trend} goodWhenDown />` },
          ]} />
          ${opCats.length ? html`<p className="muted small">Operativos (no suman al riesgo): ${opCats.map(c => c.label + " " + n0(total.evByCat[c.key])).join(" · ")}</p>` : null}
        <//>
        <${Panel} title="Vehículos con mayor riesgo" sub="Mínimo 100 km en el período.">
          <${DataTable} rowKey=${r => r.id} rows=${view.vRows.filter(r => r.km >= 100)} limit=${10} onRowClick=${r => onVehicle(r.id)}
            defaultSort=${{ key: "risk", dir: "desc" }} columns=${[
            { key: "name", label: "Vehículo" },
            { key: "profile", label: "Perfil", fmt: r => GI.profileLabel(view.settings, r.profile) },
            { key: "km", label: "Km", align: "num", fmt: r => n0(r.km) },
            { key: "events", label: "Eventos", align: "num" },
            { key: "risk", label: "Riesgo", align: "num", fmt: r => html`<span className=${r.risk > r.riskMax ? "bad" : ""}>${n2(r.risk)}</span>` },
          ]} />
        <//>
      </div>
    </div>`;
  }

  // ======================= CONDUCTORES =======================
  function topCat(evByCat, settings) {
    const e = Object.entries(evByCat).filter(([k]) => (settings.category_weights[k] || 0) > 0).sort((a, b) => b[1] - a[1])[0];
    return e ? GI.catLabel(e[0]) + " (" + e[1] + ")" : "–";
  }

  function DriversTab({ view, onDriver }) {
    const [minKm, setMinKm] = useState(view.settings.drivers.min_km_ranking);
    const [mode, setMode] = useState("risk");
    const [svc, setSvc] = useState("");
    const price = view.settings.fuel.price_per_liter;
    const unknown = view.dRows.find(r => r.unknown);
    const totalKm = GI.sum(view.dRows, r => r.km);
    const coverage = totalKm ? 100 - ((unknown ? unknown.km : 0) / totalKm) * 100 : null;
    const rows = view.dRows.filter(r => !r.unknown && r.km >= minKm && (!svc || r.stype === svc));
    return html`<div>
      <${Info} tone=${coverage != null && coverage < 80 ? "warn" : ""}>
        <b>${GI.fmtPct(coverage, 0)}</b> de los km tiene conductor identificado.
        ${unknown ? html` Sin identificar: ${n0(unknown.km)} km, ${n0(unknown.events)} eventos de riesgo. ` : null}
        Los eventos sin conductor se asignan al conductor del viaje en curso cuando es posible.
      <//>
      <${Panel} title="Ranking de conductores"
        sub=${"Se comparan conductores con al menos " + minKm + " km para evitar que pocos km distorsionen el índice."}
        actions=${html`
          <label className="inline">Km mín. <input type="number" className="num-in" value=${minKm} onChange=${e => setMinKm(+e.target.value || 0)} /></label>
          <select value=${svc} onChange=${e => setSvc(e.target.value)}>
            <option value="">Todo servicio</option><option value="corta">Corta distancia</option><option value="larga">Larga distancia</option>
          </select>
          <${Segmented} value=${mode} onChange=${setMode} options=${[{ value: "risk", label: "Más riesgosos" }, { value: "idleH", label: "Más ralentí" }]} />`}>
        <${DataTable} rowKey=${r => r.id} rows=${rows} limit=${20} onRowClick=${r => onDriver(r.id)}
          defaultSort=${{ key: mode, dir: "desc" }} columns=${[
          { key: "name", label: "Conductor" },
          { key: "stype", label: "Servicio", fmt: r => GI.stypeLabel(r.stype) },
          { key: "km", label: "Km", align: "num", fmt: r => n0(r.km) },
          { key: "risk", label: "Riesgo", align: "num", fmt: r => n2(r.risk), title: "pts/100 km" },
          { key: "events", label: "Eventos", align: "num" },
          { key: "top", label: "Principal", value: r => topCat(r.evByCat, view.settings), fmt: r => topCat(r.evByCat, view.settings) },
          { key: "idleH", label: "Ralentí h", align: "num", fmt: r => n1(r.idleH) },
          { key: "idlePct", label: "% ralentí", align: "num", fmt: r => GI.fmtPct(r.idlePct) },
          { key: "idleL", label: "L ralentí", align: "num", fmt: r => n0(r.idleL) },
          { key: "idleCost", label: "$ ralentí", align: "num", fmt: r => price ? GI.fmtMoney(r.idleCost) : "–" },
        ]} empty="No hay conductores identificados con esos km mínimos." />
      <//>
    </div>`;
  }

  // ======================= RECORRIDOS =======================
  function RoutesTab({ view, api }) {
    const s = view.settings.journeys;
    const [showNoZone, setShowNoZone] = useState(false);
    const rows = view.rRows.filter(r => r.n >= s.min_journeys_route && r.km >= s.min_km_route && (showNoZone || !r.noZone));
    return html`<div>
      ${!view.model.cat.zones.length ? html`<${Info} tone="warn">La base no tiene zonas cargadas: los recorridos solo pueden armarse como "Sin zona".<//>` : null}
      <${Panel} title="Recorridos más riesgosos"
        sub=${"Un recorrido va desde que el vehículo sale de una zona hasta que llega a otra (o para más de " + s.break_hours + " h). Mínimo " + s.min_journeys_route + " recorridos y " + s.min_km_route + " km acumulados."}
        actions=${html`<label className="inline"><input type="checkbox" checked=${showNoZone} onChange=${e => setShowNoZone(e.target.checked)} /> Incluir extremos sin zona</label>`}>
        <${DataTable} rowKey=${r => r.key} rows=${rows} limit=${15} defaultSort=${{ key: "risk", dir: "desc" }} columns=${[
          { key: "from", label: "Origen" },
          { key: "to", label: "Destino" },
          { key: "n", label: "Recorridos", align: "num" },
          { key: "avgKm", label: "Km prom.", align: "num", fmt: r => n0(r.avgKm) },
          { key: "devices", label: "Vehíc.", align: "num" },
          { key: "nEv", label: "Eventos", align: "num" },
          { key: "risk", label: "Riesgo", align: "num", fmt: r => n2(r.risk), title: "pts/100 km" },
          { key: "idlePct", label: "% ralentí", align: "num", fmt: r => GI.fmtPct(r.idlePct) },
        ]} empty="No hay recorridos que cumplan los mínimos. Se pueden ajustar en Configuración → General." />
      <//>
      <${HeatmapPanel} view=${view} api=${api} />
    </div>`;
  }

  function HeatmapPanel({ view, api }) {
    const [cat, setCat] = useState("");
    const [progress, setProgress] = useState(null);
    const [points, setPoints] = useState(null);
    const [err, setErr] = useState(null);
    const mapRef = React.useRef(null);
    const mapObj = React.useRef(null);
    const MAX = 3000;
    const evs = view.events.filter(e => e.w > 0 && (!cat || e.cat === cat));
    const sample = [...evs].sort((a, b) => b.t - a.t).slice(0, MAX);

    async function load() {
      setErr(null); setProgress(0);
      try {
        const locs = await GI.loadEventLocations(api, sample, p => setProgress(p));
        setPoints(sample.map(e => locs.get(e.i) ? [...locs.get(e.i), e.w] : null).filter(Boolean));
      } catch (e) { setErr(e.message || String(e)); }
      setProgress(null);
    }
    useEffect(() => { setPoints(null); }, [cat, view]);
    useEffect(() => {
      if (!points || !mapRef.current) return;
      if (!mapObj.current) {
        mapObj.current = L.map(mapRef.current);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(mapObj.current);
      }
      const m = mapObj.current;
      if (m._heat) m.removeLayer(m._heat);
      m._heat = L.heatLayer(points, { radius: 14, blur: 18, maxZoom: 12, max: 2 }).addTo(m);
      if (points.length) m.fitBounds(L.latLngBounds(points.map(p => [p[0], p[1]])), { padding: [20, 20] });
      else m.setView([-34.6, -58.4], 6);
    }, [points]);

    const cats = GI.CATEGORIES.filter(c => c.kind === "riesgo" && view.events.some(e => e.cat === c.key));
    return html`<${Panel} title="Mapa de calor de eventos de riesgo"
      sub=${"Ubica los " + (evs.length > MAX ? MAX + " más recientes de " : "") + n0(evs.length) + " eventos filtrados. La ubicación se busca una sola vez y queda guardada."}
      actions=${html`<select value=${cat} onChange=${e => setCat(e.target.value)}>
          <option value="">Todas las categorías</option>${cats.map(c => html`<option key=${c.key} value=${c.key}>${c.label}</option>`)}
        </select>
        <button className="btn primary" disabled=${progress != null || !sample.length} onClick=${load}>${points ? "Recargar mapa" : "Cargar mapa"}</button>`}>
      ${progress != null ? html`<${GI.Progress} value=${progress} label="Ubicando eventos…" />` : null}
      ${err ? html`<${Info} tone="error">${err}<//>` : null}
      <div ref=${mapRef} className=${"map" + (points ? "" : " hidden")}></div>
      ${!points && progress == null ? html`<div className="empty">El mapa se carga a pedido para no demorar el resto del tablero.</div>` : null}
    <//>`;
  }

  // ======================= DETALLES =======================
  function VehicleDetail({ view, id, onClose }) {
    const r = view.vRows.find(x => x.id === id);
    const s = useMemo(() => GI.series(view.model, new Set([id]), view.gran), [id, view.gran]);
    const drivers = useMemo(() => {
      const out = [];
      for (const [drv, m] of view.model.drvCells) {
        let km = 0, n = 0;
        for (const [ck, c] of m) if (ck.startsWith(id + "|")) { km += c.km; n += c.n; }
        if (km > 0 || n > 0) out.push({ name: drv === "_unknown" ? "Sin identificar" : view.model.driverName.get(drv) || drv, km, n });
      }
      return out.sort((a, b) => b.km - a.km);
    }, [id]);
    if (!r) return null;
    const evRows = Object.entries(r.evByCat).map(([k, n]) => ({ k, n }));
    return html`<${Modal} title=${r.name} onClose=${onClose} wide>
      <p className="muted">${GI.profileLabel(view.settings, r.profile)} · servicio: ${r.serviceSource} · referencia L/100: ${r.refSource}</p>
      <div className="kpis small">
        <${Kpi} label="Km" value=${n0(r.km)} />
        <${Kpi} label="L/100 km" value=${r.fuelMeasured ? n1(r.l100) : "s/d"} sub=${"ref. " + n1(r.refL100)} />
        <${Kpi} label="% ralentí" value=${GI.fmtPct(r.idlePct)} sub=${"máx. " + r.idleMax + "%"} />
        <${Kpi} label="Litros ralentí" value=${n0(r.idleL)} sub=${r.idleMeasured ? "medido" : "estimado"} />
        <${Kpi} label="Riesgo" value=${n2(r.risk)} sub=${"máx. " + n2(r.riskMax)} />
      </div>
      <div className="grid-2">
        <div><h3>Consumo y ralentí</h3><${ChartView} height=${220} config=${{
          type: "line", data: { labels: s.map(x => x.label), datasets: [
            { label: "L/100 km", data: s.map(x => x.l100 == null ? null : GI.round(x.l100, 1)), borderColor: "#2563eb", spanGaps: true, yAxisID: "y" },
            { label: "% ralentí", data: s.map(x => x.idlePct == null ? null : GI.round(x.idlePct, 1)), borderColor: "#16a34a", spanGaps: true, yAxisID: "y1" }] },
          options: { scales: { y: { beginAtZero: true }, y1: { position: "right", beginAtZero: true, grid: { drawOnChartArea: false } } } } }} /></div>
        <div><h3>Eventos</h3><${ChartView} height=${220} config=${{
          type: "bar", data: { labels: s.map(x => x.label), datasets: [{ label: "Eventos de riesgo", data: s.map(x => x.events), backgroundColor: "#f87171" }] },
          options: { plugins: { legend: { display: false } } } }} /></div>
      </div>
      <div className="grid-2">
        <div><h3>Por categoría</h3><${DataTable} rows=${evRows} rowKey=${x => x.k} defaultSort=${{ key: "n", dir: "desc" }} columns=${[
          { key: "k", label: "Categoría", fmt: x => GI.catLabel(x.k) }, { key: "n", label: "Eventos", align: "num" }]} /></div>
        <div><h3>Conductores</h3><${DataTable} rows=${drivers} rowKey=${x => x.name} defaultSort=${{ key: "km", dir: "desc" }} columns=${[
          { key: "name", label: "Conductor" }, { key: "km", label: "Km", align: "num", fmt: x => n0(x.km) }, { key: "n", label: "Eventos", align: "num" }]} /></div>
      </div>
    <//>`;
  }

  function DriverDetail({ view, id, onClose }) {
    const r = view.dRows.find(x => x.id === id);
    const s = useMemo(() => {
      const m = view.model.drvCells.get(id) || new Map();
      const buckets = new Map(view.series.map(x => [x.key, { label: x.label, km: 0, n: 0, w: 0, ih: 0, dh: 0 }]));
      for (const [ck, c] of m) {
        const [dev, dk] = ck.split("|");
        if (!view.ids.has(dev)) continue;
        const b = buckets.get(GI.bucketKey(dk, view.gran));
        if (b) { b.km += c.km; b.n += c.n; b.w += c.w; b.ih += c.ih; b.dh += c.dh; }
      }
      return [...buckets.values()];
    }, [id, view]);
    const vehicles = useMemo(() => {
      const m = view.model.drvCells.get(id) || new Map();
      const out = new Map();
      for (const [ck, c] of m) {
        const dev = ck.split("|")[0];
        if (!view.ids.has(dev)) continue;
        const o = out.get(dev) || { name: (view.model.devById.get(dev) || {}).name || dev, km: 0, n: 0 };
        o.km += c.km; o.n += c.n; out.set(dev, o);
      }
      return [...out.values()];
    }, [id, view]);
    if (!r) return null;
    return html`<${Modal} title=${r.name} onClose=${onClose} wide>
      <div className="kpis small">
        <${Kpi} label="Km" value=${n0(r.km)} />
        <${Kpi} label="Riesgo" value=${n2(r.risk)} sub="pts/100 km" />
        <${Kpi} label="Eventos" value=${n0(r.events)} />
        <${Kpi} label="Ralentí" value=${n1(r.idleH) + " h"} sub=${GI.fmtPct(r.idlePct)} />
        <${Kpi} label="Litros ralentí" value=${n0(r.idleL)} />
      </div>
      <div className="grid-2">
        <div><h3>Evolución del riesgo</h3><${ChartView} height=${220} config=${{
          type: "bar", data: { labels: s.map(x => x.label), datasets: [
            { type: "line", label: "Riesgo (pts/100 km)", data: s.map(x => (x.km > 0 ? GI.round((x.w / x.km) * 100, 2) : null)), borderColor: "#dc2626", spanGaps: true, yAxisID: "y1" },
            { type: "bar", label: "Km", data: s.map(x => GI.round(x.km, 0)), backgroundColor: "#cbd5e1", yAxisID: "y" }] },
          options: { scales: { y: { beginAtZero: true }, y1: { position: "right", beginAtZero: true, grid: { drawOnChartArea: false } } } } }} /></div>
        <div><h3>Por categoría</h3><${DataTable} rows=${Object.entries(r.evByCat).map(([k, n]) => ({ k, n }))} rowKey=${x => x.k}
          defaultSort=${{ key: "n", dir: "desc" }} columns=${[{ key: "k", label: "Categoría", fmt: x => GI.catLabel(x.k) }, { key: "n", label: "Eventos", align: "num" }]} />
          <h3>Vehículos</h3><${DataTable} rows=${vehicles} rowKey=${x => x.name} defaultSort=${{ key: "km", dir: "desc" }} columns=${[
          { key: "name", label: "Vehículo" }, { key: "km", label: "Km", align: "num", fmt: x => n0(x.km) }, { key: "n", label: "Eventos", align: "num" }]} /></div>
      </div>
    <//>`;
  }

  Object.assign(GI, { SummaryTab, FuelTab, SafetyTab, DriversTab, RoutesTab, VehicleDetail, DriverDetail, TrendChart, METRICS });
})(window.GI);
