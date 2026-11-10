// Gestión de la seguridad: Pareto del riesgo, matriz de exposición y conducta, reincidencia,
// ciclo de coaching (asignar y medir antes y después) e informe mensual imprimible.
(function (GI) {
  "use strict";
  const React = GI.React;
  const { useState, useMemo, useEffect } = React;
  const html = GI.html;
  const { Kpi, Panel, Info, DataTable, ChartView, Segmented, Modal } = GI;
  const n0 = v => GI.fmtNum(v, 0), n1 = v => GI.fmtNum(v, 1), n2 = v => GI.fmtNum(v, 2);
  const DAY = 86400000;
  const ctx = () => GI._ctx || {};
  const dName = (view, id) => (id === "_unknown" ? "Sin conductor identificado" : view.model.driverName.get(id) || id);
  const ruleName = (view, id) => { const r = (view.model.cat.rules || []).find(x => x.id === id); return r ? r.name : id; };
  const periodEnd = view => { const ks = view.model.dayKeys; return ks.length ? GI.parseDayKey(ks[ks.length - 1]).getTime() + DAY - 1 : Date.now(); };
  const periodStart = view => { const ks = view.model.dayKeys; return ks.length ? GI.parseDayKey(ks[0]).getTime() : null; };
  const fmtD = t => new Date(t).toLocaleDateString("es-AR", { day: "numeric", month: "short" });

  // ---------- Coaching: datos compartidos (todos los supervisores ven lo mismo) ----------
  const store = { list: null, loading: null, subs: new Set() };
  function loadCoachList(force) {
    const api = ctx().api;
    if (!api || !GI.loadCoaches) { store.list = store.list || []; return Promise.resolve(store.list); }
    if (store.loading && !force) return store.loading;
    store.loading = GI.loadCoaches(api).then(l => { store.list = l; store.subs.forEach(f => f(l)); return l; })
      .catch(e => { console.warn("[Insights] coaching", e); store.list = store.list || []; store.subs.forEach(f => f(store.list)); return store.list; });
    return store.loading;
  }
  function useCoaches() {
    const [list, setList] = useState(store.list);
    useEffect(() => { store.subs.add(setList); if (store.list == null) loadCoachList(); return () => store.subs.delete(setList); }, []);
    return list || [];
  }
  async function saveCoachRec(rec) {
    const saved = await GI.saveCoach(ctx().api, rec);
    const l = (store.list || []).filter(x => x.id !== saved.id).concat([saved]);
    store.list = l; store.subs.forEach(f => f(l));
    return saved;
  }
  const openCoachOf = (list, drv) => list.filter(c => c.drv === drv && c.status !== "cancelado");
  const COACH_TYPES = [["charla", "Charla con video de los eventos"], ["ruta", "Acompañamiento en ruta"], ["capacitacion", "Capacitación formal"], ["advertencia", "Advertencia escrita"]];
  const STATUS = { asignado: "Asignado", hecho: "Hecho", cancelado: "Cancelado" };
  const VERDICT = {
    mejoro: ["Mejoró", "good"], empeoro: ["Empeoró", "bad"], igual: ["Sin cambio", ""], pocos_km: ["Pocos km para medir", ""], sin_datos: ["Sin datos suficientes", ""],
    midiendo: ["Midiendo", ""], midiendo_mejoro: ["Midiendo · va mejorando", "good"], midiendo_empeoro: ["Midiendo · va empeorando", "bad"], midiendo_igual: ["Midiendo · sin cambio por ahora", ""], midiendo_pocos_km: ["Midiendo", ""],
  };

  // Formulario para asignar (o editar) un coaching.
  function CoachModal({ view, drv, cat, reason, rec, onClose }) {
    const c = ctx();
    const cats = GI.CATEGORIES.filter(x => x.kind === "riesgo");
    const [f, setF] = useState(() => rec ? { ...rec, due: rec.due ? GI.dayKey(rec.due) : "" } : {
      drv, cat: cat || "", reason: reason || "", type: "charla", owner: c.userName || "", due: GI.dayKey(Date.now() + 7 * DAY), days: 30, note: "", status: "asignado", at: null,
    });
    const [busy, setBusy] = useState(false), [msg, setMsg] = useState(null);
    const set = (k, v) => setF(x => ({ ...x, [k]: v }));
    async function save(status) {
      setBusy(true); setMsg(null);
      try {
        const out = { ...f, due: f.due ? GI.parseDayKey(f.due).getTime() : null, days: +f.days || 30, by: rec ? rec.by : c.userName || "" };
        if (status) out.status = status;
        // la medición arranca el día en que se hizo el coaching (o el de la asignación, si no se marcó)
        if (status === "hecho" && !out.at) out.at = Date.now();
        if (!out.created) out.created = Date.now();
        await saveCoachRec(out);
        onClose(true);
      } catch (e) { setMsg("No se pudo guardar: " + ((e && e.message) || e)); }
      setBusy(false);
    }
    return html`<${Modal} title=${(rec ? "Coaching · " : "Asignar coaching · ") + dName(view, f.drv)} onClose=${() => onClose(false)}>
      <div className="mg-form">
        ${reason ? html`<p className="mg-why">${reason}</p>` : null}
        <label>Motivo<select value=${f.cat} onChange=${e => set("cat", e.target.value)}>
          <option value="">Conducta general (todo el índice de riesgo)</option>
          ${cats.map(x => html`<option key=${x.key} value=${x.key}>${x.label}</option>`)}
        </select></label>
        <label>Tipo de intervención<select value=${f.type} onChange=${e => set("type", e.target.value)}>${COACH_TYPES.map(([k, l]) => html`<option key=${k} value=${k}>${l}</option>`)}</select></label>
        <div className="mg-row2">
          <label>Responsable<input value=${f.owner} onInput=${e => set("owner", e.target.value)} /></label>
          <label>Fecha límite<input type="date" value=${f.due || ""} onInput=${e => set("due", e.target.value)} /></label>
        </div>
        <label>Medir el resultado durante<select value=${f.days} onChange=${e => set("days", +e.target.value)}><option value="30">30 días antes y 30 después</option><option value="60">60 días antes y 60 después</option></select></label>
        <label>Nota<textarea rows="2" value=${f.note} onInput=${e => set("note", e.target.value)}></textarea></label>
        <div className="form-actions">
          ${rec && rec.status === "asignado" ? html`<button className="btn primary" disabled=${busy} onClick=${() => save("hecho")}>Marcar como hecho hoy</button>` : null}
          <button className=${"btn" + (rec && rec.status === "asignado" ? "" : " primary")} disabled=${busy} onClick=${() => save(rec ? null : "asignado")}>${rec ? "Guardar cambios" : "Asignar"}</button>
          ${rec && rec.status !== "cancelado" ? html`<button className="btn" disabled=${busy} onClick=${() => save("cancelado")}>Cancelar el coaching</button>` : null}
          <button className="btn ghost" onClick=${() => onClose(false)}>Cerrar</button>
          ${msg ? html`<span className="small">${msg}</span>` : null}
        </div>
        <p className="small muted">Se guarda en los datos del add-in (quién y cuándo), no en MyGeotab. El resultado se mide solo: ${f.days} días antes del coaching contra ${f.days} días después, comparado con la flota.</p>
      </div>
    <//>`;
  }
  // Botón "Asignar coaching" (abre el formulario)
  function CoachButton({ view, drv, cat, reason, label, small }) {
    const [open, setOpen] = useState(false);
    if (!ctx().api || !GI.saveCoach || view.driverMode) return null;
    return html`<span>
      <button className=${"btn" + (small ? " small" : " primary")} onClick=${e => { e.stopPropagation(); setOpen(true); }}>${label || "Asignar coaching"}</button>
      ${open ? html`<${CoachModal} view=${view} drv=${drv} cat=${cat} reason=${reason} onClose=${() => setOpen(false)} />` : null}
    </span>`;
  }
  // Asignar a varios a la vez (desde el Pareto o la matriz)
  function CoachMany({ view, rows, reason, label }) {
    const [busy, setBusy] = useState(false), [done, setDone] = useState(null);
    if (!ctx().api || !GI.saveCoach || !rows.length || view.driverMode) return null;
    async function go() {
      setBusy(true);
      let n = 0;
      for (const r of rows) { try { await saveCoachRec({ drv: r.id, cat: "", reason: reason(r), type: "charla", owner: ctx().userName || "", due: Date.now() + 7 * DAY, days: 30, status: "asignado", created: Date.now(), by: ctx().userName || "" }); n++; } catch (e) { /* sigue con el resto */ } }
      setDone(n); setBusy(false);
    }
    return html`<span className="mg-many">${done != null ? html`<span className="small">${n0(done)} coaching${done === 1 ? "" : "s"} asignado${done === 1 ? "" : "s"}. Se ven en Conductores → Coaching.</span>`
      : html`<button className="btn primary" disabled=${busy} onClick=${go}>${busy ? "Asignando…" : label}</button>`}</span>`;
  }

  // ---------- Pareto ----------
  function paretoRows(view, by) {
    const W = view.settings.category_weights || {};
    if (by === "vehiculos") return { rows: view.vRows.map(r => ({ id: r.id, name: r.name, w: r.weighted, km: r.km })), pop: view.vRows.filter(r => r.km > 0).length, word: ["vehículo", "vehículos"], base: "de la flota" };
    if (by === "reglas") {
      const rows = Object.entries(view.total.evByRule || {}).map(([rid, n]) => { const cat = (view.settings.rule_mapping || {})[rid]; const w = n * (cat && W[cat] != null ? W[cat] : 0); return { id: rid, name: ruleName(view, rid), w }; }).filter(r => r.w > 0);
      return { rows, pop: rows.length, word: ["regla", "reglas"], base: "de las reglas con infracciones" };
    }
    const rows = view.dRows.filter(r => !r.unknown).map(r => ({ id: r.id, name: r.name, w: r.weighted, km: r.km }));
    return { rows, pop: view.dRows.filter(r => !r.unknown && r.km > 0).length, word: ["conductor", "conductores"], base: "de la flota" };
  }
  function ParetoPanel({ view, onDriver, onVehicle }) {
    const [by, setBy] = useState("conductores");
    const coaches = useCoaches();
    const { rows, pop, word, base } = useMemo(() => paretoRows(view, by), [view, by]);
    const p = useMemo(() => GI.pareto(rows, pop), [rows, pop]);
    if (!p) return null;
    const W = n => (n === 1 ? word[0] : word[1]);
    const noCoach = by === "conductores" ? p.top.filter(r => !openCoachOf(coaches, r.id).some(c => c.status === "asignado" || c.status === "hecho")) : [];
    // Curva acumulada de MENOR a MAYOR riesgo: arranca con los que no tienen infracciones y
    // se dispara al final, donde están los pocos que generan la mayor parte.
    const zeros = Math.max(0, p.pop - p.curve.length);
    const asc = [...Array.from({ length: zeros }, () => null), ...[...p.curve].reverse()];
    let acc = 0;
    const pts = asc.map((r, i) => { acc += r ? r.share : 0; return { x: i + 1, y: GI.round(Math.min(100, acc), 1), r }; });
    const N = pts.length, cut = N - p.n50;           // de cut+1 a N: los que generan la mitad
    const lowShare = cut > 0 ? pts[cut - 1].y : 0;
    const big = N <= 120;
    const cfg = {
      type: "line",
      data: { datasets: [
        { label: "Riesgo acumulado", data: pts.map(q => ({ x: q.x, y: q.y })), borderColor: "#0078d3", backgroundColor: "#0078d31f", fill: true, tension: 0.15, borderWidth: 3,
          pointRadius: pts.map((q, i) => (i >= cut && big ? 3.5 : 0)), pointBackgroundColor: "#fe5a3f", pointBorderColor: "#fe5a3f" },
        { label: "Si todos generaran el mismo riesgo", data: [{ x: 1, y: GI.round(100 / N, 1) }, { x: N, y: 100 }], borderColor: "#b3bcc7", borderDash: [6, 5], borderWidth: 1.5, pointRadius: 0, fill: false }] },
      options: { maintainAspectRatio: false, interaction: { mode: "nearest", axis: "x", intersect: false },
        scales: { y: { min: 0, max: 100, title: { display: true, text: "% del riesgo acumulado" }, ticks: { callback: v => v + "%" } },
          x: { type: "linear", min: 1, max: N, title: { display: true, text: W(2) + ", de menor a mayor riesgo →" }, ticks: { precision: 0, callback: v => n0(v) } } },
        plugins: { legend: { display: false }, tooltip: { filter: it => it.datasetIndex === 0, callbacks: {
          title: it => { const q = pts[it[0].dataIndex]; return q.r ? q.r.name : "Sin infracciones"; },
          label: it => { const q = pts[it.dataIndex]; return "acumulado " + n1(q.y) + "%" + (q.r ? " · este " + n1(q.r.share) + "%" : ""); } } } } },
      plugins: [{ id: "n50", beforeDatasetsDraw(ch) {
        const X = ch.scales.x, Y = ch.scales.y, c2 = ch.ctx, x0 = X.getPixelForValue(cut + 0.5);
        c2.save();
        c2.fillStyle = "rgba(254,90,63,0.08)"; c2.fillRect(x0, Y.top, X.right - x0, Y.bottom - Y.top);
        c2.strokeStyle = "#fe5a3f"; c2.setLineDash([4, 4]); c2.beginPath(); c2.moveTo(x0, Y.top); c2.lineTo(x0, Y.bottom); c2.stroke(); c2.setLineDash([]);
        c2.font = "700 13px Roboto, sans-serif"; c2.fillStyle = "#c2381f"; c2.textAlign = "right";
        c2.fillText(n0(p.n50) + " " + W(p.n50) + " → " + n0(p.share50) + "% del riesgo", X.right - 8, Y.top + 16);
        if (cut > 0) { c2.fillStyle = "#3c5164"; c2.textAlign = "left"; c2.font = "500 13px Roboto, sans-serif";
          const mid = pts[Math.max(0, Math.floor(cut * 0.55) - 1)]; c2.fillText("Los otros " + n0(cut) + " " + W(cut) + " suman solo el " + n0(lowShare) + "%", X.getPixelForValue(Math.max(1, cut * 0.25)), Y.getPixelForValue(mid.y) - 34); }
        c2.restore(); } }],
    };
    const openRow = r => (by === "conductores" && onDriver ? onDriver(r.id) : by === "vehiculos" && onVehicle ? onVehicle(r.id) : null);
    return html`<${Panel} title="Dónde se concentra el riesgo" className="mg-pareto-panel"
      hint="Riesgo = infracciones × peso de su categoría. La curva suma el riesgo empezando por los de menor riesgo: queda plana mientras pasan los que casi no tienen infracciones y se dispara al final, donde están los pocos que generan la mayor parte. La zona roja son los que hacen falta para llegar a la mitad del riesgo total."
      actions=${html`<${Segmented} value=${by} onChange=${setBy} options=${[{ value: "conductores", label: "Conductores" }, { value: "vehiculos", label: "Vehículos" }, { value: "reglas", label: "Reglas" }]} />`}>
      <p className="mg-hero"><b>${n0(p.n50)} ${W(p.n50)}</b> <span>(${n0(p.pct50)}% ${base})</span> generan el <b>${n0(p.share50)}%</b> del riesgo.</p>
      <div className="mg-pareto">
        <div className="mg-pareto-chart"><${ChartView} config=${cfg} height=${400} /><p className="small muted">Línea gris punteada: cómo sería la curva si todos generaran el mismo riesgo. Cuanto más se aleja la curva azul hacia abajo, más concentrado está el riesgo en pocos.</p></div>
        <div className="mg-pareto-text">
          <p>El 20% de los ${word[1]} (${n0(p.k20)}) explica el ${n0(p.share20)}%.${p.saving != null && by !== "reglas" ? " Si esos " + n0(p.n50) + " bajaran a la tasa mediana de la flota, el riesgo total bajaría un " + n0(p.saving) + "%." : ""}</p>
          ${by === "conductores" ? html`<p className="small muted">${n0(p.n50 - noCoach.length)} de los ${n0(p.n50)} tienen coaching asignado o hecho.</p>` : null}
          <div className="mg-actions">
            ${by === "conductores" && noCoach.length ? html`<${CoachMany} view=${view} rows=${noCoach} label=${"Asignar coaching a los " + n0(noCoach.length) + " sin acción"} reason=${r => "Está entre los " + p.n50 + " conductores que generan la mitad del riesgo del período."} />` : null}
          </div>
          <ol className="mg-toplist">${p.top.slice(0, 10).map(r => html`<li key=${r.id}><button className="linkish" onClick=${() => openRow(r)}>${r.name}</button> <span className="muted small">${n1(r.share)}%</span></li>`)}
            ${p.top.length > 10 ? html`<li className="muted small">y ${n0(p.top.length - 10)} más</li>` : null}</ol>
        </div>
      </div>
    <//>`;
  }

  // ---------- Matriz de exposición y conducta ----------
  const QLAB = { prioridad: "Prioridad 1 · muchos km y mala conducta", corregir: "Corregir conducta · pocos km", reconocer: "Reconocer · muchos km y buena conducta", bajo: "Bajo riesgo" };
  const QCOL = { prioridad: "#fe5a3f", corregir: "#f9ba00", reconocer: "#0078d3", bajo: "#b3bcc7" };
  function MatrixPanel({ view, onDriver }) {
    const minKm = view.settings.drivers.min_km_ranking;
    const coaches = useCoaches();
    const m = useMemo(() => GI.matrix(view.dRows.filter(r => !r.unknown && r.km >= minKm)), [view]);
    if (!m) return null;
    const P = m.groups.prioridad;
    const noCoach = P.filter(r => !openCoachOf(coaches, r.id).length);
    // Eje vertical: hasta el percentil 95 para que el grueso no quede aplastado contra el 0;
    // los que pasan el tope se dibujan arriba, con un triángulo.
    const risks = m.pts.map(r => r.risk).sort((a, b) => a - b);
    const p95 = risks[Math.floor(risks.length * 0.95)] || 1;
    const yRaw = Math.max(m.mRisk * 2.5, p95 * 1.15, 0.5), yMax = yRaw > 2 ? Math.ceil(yRaw) : Math.ceil(yRaw * 2) / 2;
    const data = q => m.groups[q].map(r => ({ x: GI.round(r.km, 0), y: Math.min(GI.round(r.risk, 2), yMax), real: r.risk, name: r.name, id: r.id }));
    const cfg = {
      type: "scatter",
      data: { datasets: ["prioridad", "corregir", "reconocer", "bajo"].map(q => { const d = data(q); return { label: QLAB[q], data: d, clip: false, backgroundColor: QCOL[q], borderColor: "#ffffff", borderWidth: 1,
        pointRadius: d.map(p => (p.real > yMax ? 7 : q === "prioridad" ? 6 : 5)), pointStyle: d.map(p => (p.real > yMax ? "triangle" : "circle")), pointHoverRadius: 8 }; }) },
      options: { maintainAspectRatio: false,
        scales: { x: { title: { display: true, text: "Km manejados en el período (exposición) →" }, ticks: { callback: v => n0(v) } }, y: { title: { display: true, text: "Riesgo: puntos cada 100 km →" }, min: 0, max: yMax, ticks: { callback: v => GI.fmtNum(v, v % 1 ? 1 : 0) } } },
        interaction: { mode: "nearest", intersect: true }, layout: { padding: { top: 12, right: 10 } },
        onClick: (e, els, ch) => { const el = els && els[0]; if (el && onDriver) onDriver(ch.data.datasets[el.datasetIndex].data[el.index].id); },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: it => it.raw.name + " · " + n0(it.raw.x) + " km · " + n2(it.raw.real) + " pts/100 km" } } } },
      plugins: [{ id: "med", beforeDatasetsDraw(ch) { const { x, y } = ch.scales; const c2 = ch.ctx; c2.save();
        const px = x.getPixelForValue(m.mKm), py = y.getPixelForValue(m.mRisk);
        // fondo suave en el cuadrante de prioridad
        c2.fillStyle = "rgba(254,90,63,0.06)"; c2.fillRect(px, y.top, x.right - px, py - y.top);
        c2.strokeStyle = "#66788c"; c2.setLineDash([5, 4]);
        c2.beginPath(); c2.moveTo(px, y.top); c2.lineTo(px, y.bottom); c2.moveTo(x.left, py); c2.lineTo(x.right, py); c2.stroke(); c2.setLineDash([]);
        c2.font = "500 12px Roboto, sans-serif"; c2.fillStyle = "#3c5164";
        c2.textAlign = "right"; c2.fillText("Promedio de la flota: " + n2(m.mRisk) + " pts/100 km", x.right - 6, py - 6);
        c2.textAlign = "left"; c2.fillText("Mitad de la flota: " + n0(m.mKm) + " km", px + 6, y.top + 14);
        c2.font = "700 12px Roboto, sans-serif";
        c2.fillStyle = "#c2381f"; c2.textAlign = "right"; c2.fillText("PRIORIDAD 1", x.right - 6, y.top + 14);
        c2.fillStyle = "#9a6b00"; c2.textAlign = "left"; c2.fillText("CORREGIR CONDUCTA", x.left + 6, y.top + 14);
        c2.fillStyle = "#0062ad"; c2.textAlign = "right"; c2.fillText("RECONOCER", x.right - 6, y.bottom - 8);
        c2.fillStyle = "#66788c"; c2.textAlign = "left"; c2.fillText("BAJO RIESGO", x.left + 6, y.bottom - 8);
        c2.restore(); } }],
    };
    const over = m.pts.filter(r => r.risk > yMax).length;
    const coachTxt = r => (openCoachOf(coaches, r.id).length ? "con coaching" : null);
    const byRisk = (x, y) => y.risk - x.risk, byKm = (x, y) => y.km - x.km;
    const Q = [
      { q: "prioridad", cls: "prio", title: "Prioridad 1", order: "mayor riesgo total primero", rows: P,
        text: m.prioKmShare != null ? "Muchos km y conducta peor que el promedio. Manejan el " + n0(m.prioKmShare) + "% de los km y generan el " + n0(m.prioRiskShare) + "% del riesgo." : "Muchos km y conducta peor que el promedio.",
        info: coachTxt, act: noCoach.length ? html`<${CoachMany} view=${view} rows=${noCoach} label=${"Asignar coaching a los " + n0(noCoach.length) + " sin acción"} reason=${() => "Prioridad 1 en la matriz: muchos km y riesgo por km sobre el promedio de la flota."} />` : null },
      { q: "corregir", cls: "", title: "Corregir conducta", order: "peor conducta primero", rows: [...m.groups.corregir].sort(byRisk),
        text: "Pocos km pero conducta peor que el promedio: conviene intervenir antes de que sumen km.", info: coachTxt,
        act: (() => { const nc = m.groups.corregir.filter(r => !openCoachOf(coaches, r.id).length); return nc.length ? html`<${CoachMany} view=${view} rows=${nc} label=${"Asignar coaching a los " + n0(nc.length) + " sin acción"} reason=${() => "Corregir conducta en la matriz: riesgo por km sobre el promedio de la flota."} />` : null; })() },
      { q: "reconocer", cls: "", title: "Reconocer", order: "más km primero", rows: [...m.groups.reconocer].sort(byKm),
        text: "Muchos km y conducta mejor que el promedio: buenos tutores para los nuevos.", copy: true },
      { q: "bajo", cls: "", title: "Bajo riesgo", order: "los más cerca del promedio primero", rows: [...m.groups.bajo].sort(byRisk),
        text: "Pocos km y conducta mejor que el promedio: seguimiento normal." },
    ];
    return html`<${Panel} title="A quién intervenir primero"
      sub=${html`Cada punto es un conductor con al menos ${n0(minKm)} km en el período. <b>Hacia la derecha</b> maneja más km; <b>hacia arriba</b> tiene más puntos de riesgo cada 100 km. Click en un punto para abrir su ficha.`}
      hint=${"Los puntos de riesgo son las infracciones ponderadas por su peso (Configuración → Reglas y objetivos). Mala conducta = más puntos cada 100 km que el promedio de la flota (" + n2(m.mRisk) + "), que es el total de puntos dividido el total de km. Muchos km = más km que la mitad de los conductores (" + n0(m.mKm) + " km)."}>
      <div className="mg-matrix-chart"><${ChartView} config=${cfg} height=${420} /></div>
      <p className="small muted mg-crit"><b>Criterio:</b> la línea horizontal es el promedio de la flota (${n2(m.mRisk)} puntos cada 100 km): arriba de esa línea, la conducta es peor que el promedio. La vertical separa a la mitad de los conductores que más km manejó (${n0(m.mKm)} km o más).${over ? " Los " + n0(over) + " triángulos de arriba superan el tope del gráfico; el valor real está en el detalle al pasar el mouse." : ""}</p>
      <div className="mg-quads">${Q.map(x => html`<${QuadCard} key=${x.q} x=${x} view=${view} onDriver=${onDriver} />`)}</div>
    <//>`;
  }

  // Tarjeta de un cuadrante con su lista de conductores (5 visibles, "Ver todos" despliega el resto).
  function QuadCard({ x, view, onDriver }) {
    const [all, setAll] = useState(false), [copied, setCopied] = useState(false);
    const rows = all ? x.rows : x.rows.slice(0, 5);
    function copy() {
      const t = x.rows.map(r => r.name + "\t" + n0(r.km) + " km\t" + n2(r.risk) + " pts/100 km").join("\n");
      try { navigator.clipboard.writeText(t).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }); } catch (e) {}
    }
    return html`<div className=${"mg-q " + x.cls}>
      <h3><span className="mg-qdot" style=${{ background: QCOL[x.q] }}></span>${x.title} · ${n0(x.rows.length)}</h3>
      <p>${x.text}</p>
      ${x.rows.length ? html`<div className="small muted mg-order">Orden: ${x.order}</div>
        <ul className=${"mg-plist" + (all ? " mg-plist-all" : "")}>${rows.map(r => { const inf = x.info && x.info(r); return html`<li key=${r.id} title=${r.name + " · " + n0(r.km) + " km · " + n2(r.risk) + " pts/100 km" + (inf ? " · " + inf : "")}><button className="linkish" onClick=${() => onDriver && onDriver(r.id)}>${r.name}</button><span className="small muted">${n0(r.km)} km · ${n2(r.risk)} pts${inf ? html` · <b>${inf}</b>` : ""}</span></li>`; })}</ul>
        ${x.rows.length > 5 ? html`<button type="button" className="linklike small mg-more" onClick=${() => setAll(!all)}>${all ? "Ver menos" : "Ver los " + n0(x.rows.length)}</button>` : null}
        <div className="mg-actions">${x.act || null}${x.copy ? html`<button className="btn small" onClick=${copy}>${copied ? "Copiada" : "Copiar lista"}</button>` : null}</div>`
      : html`<p className="small muted">Nadie en este grupo.</p>`}
    </div>`;
  }

  // ---------- Reincidencia ----------
  function RecidivismPanel({ view, onDriver }) {
    const [days, setDays] = useState(30), [min, setMin] = useState(3);
    const coaches = useCoaches();
    const end = periodEnd(view);
    const R = useMemo(() => GI.recidivism(view.model, view.ids, view.driverOk, end, days, min), [view, days, min]);
    const from = R.from;
    const coachAfter = coaches.filter(c => c.status === "hecho" && c.at);
    let afterN = 0, afterRe = 0;
    for (const c of coachAfter) {
      const evs = view.model.events.filter(e => e.drv === c.drv && e.w > 0 && e.t >= c.at && e.t <= c.at + 30 * DAY && (!c.cat || e.cat === c.cat));
      if (c.at + 30 * DAY > end) continue;
      afterN++; if (evs.length >= 1 && R.rows.some(r => r.drv === c.drv)) afterRe++;
    }
    const timeline = r => html`<span className="mg-tl" role="img" aria-label=${r.n + " infracciones entre el " + fmtD(r.ts[0]) + " y el " + fmtD(r.last)}>
      ${r.ts.map((t, i) => html`<i key=${i} style=${{ left: ((t - from) / (end - from)) * 100 + "%", background: r.cat === "velocidad" || (GI.CATEGORY_BY_KEY[r.cat] || {}).weight >= 1.4 ? "#fe5a3f" : "#f9ba00" }} title=${new Date(t).toLocaleString("es-AR")}></i>`)}
      ${coaches.filter(c => c.drv === r.drv && c.at && c.at >= from && c.at <= end).map(c => html`<b key=${c.id} style=${{ left: ((c.at - from) / (end - from)) * 100 + "%" }} title=${"Coaching " + fmtD(c.at)}></b>`)}
    </span>`;
    const coachState = r => { const l = openCoachOf(coaches, r.drv); if (!l.length) return "sin acción"; const last = l.sort((a, b) => (b.created || 0) - (a.created || 0))[0]; if (last.status === "hecho" && last.at && r.last > last.at) return "siguió después del coaching"; return last.status === "hecho" ? "hecho " + fmtD(last.at) : "asignado"; };
    return html`<${Panel} title="Reincidencia"
      hint=${"Conductores que repiten la MISMA regla al menos " + min + " veces en los últimos " + days + " días del período. Pesa más que el total: alguien con 3 excesos en ripio necesita una intervención distinta que alguien con 3 infracciones diferentes."}
      actions=${html`<label className="inline small">Repite al menos <select value=${min} onChange=${e => setMin(+e.target.value)}><option value="3">3 veces</option><option value="5">5 veces</option></select></label>
        <label className="inline small">en <select value=${days} onChange=${e => setDays(+e.target.value)}><option value="30">30 días</option><option value="60">60 días</option></select></label>`}>
      <div className="readouts compact inset">
        <${Kpi} label="Conductores reincidentes" value=${n0(R.drivers)} tone=${R.drivers ? "bad" : null} sub=${html`<span>misma regla ${min} veces o más</span>`} />
        <${Kpi} label="Peso en el total" value=${R.share != null ? n0(R.share) + "%" : "–"} sub=${html`<span>de las infracciones del rango</span>`} />
        <${Kpi} label="Repiten después del coaching" value=${afterN ? n0(afterRe) + " de " + n0(afterN) : "–"} sub=${html`<span>${afterN ? "coachings con 30 días medidos" : "todavía no hay coachings medidos"}</span>`} />
        <${Kpi} label="Regla con más reincidencia" value=${R.topRule ? ruleName(view, R.topRule[0]) : "–"} sub=${html`<span>${R.topRule ? n0(R.topRule[1]) + " de " + n0(R.rows.length) : ""}</span>`} />
      </div>
      <${DataTable} rowKey=${r => r.drv + "|" + r.rule} rows=${R.rows} limit=${12} defaultSort=${{ key: "n", dir: "desc" }} onRowClick=${r => onDriver && onDriver(r.drv)} columns=${[
        { key: "drv", label: "Conductor", value: r => dName(view, r.drv), fmt: r => html`<b>${dName(view, r.drv)}</b>` },
        { key: "rule", label: "Infracción que repite", value: r => ruleName(view, r.rule), fmt: r => ruleName(view, r.rule) },
        { key: "n", label: "Veces", align: "num" },
        { key: "tl", label: "En el rango", value: r => r.last, fmt: timeline },
        { key: "every", label: "Cada cuánto", align: "num", fmt: r => (r.every != null ? "cada " + n1(r.every) + " días" : "–") },
        { key: "coach", label: "Coaching", value: r => coachState(r), fmt: coachState },
        { key: "act", label: "", value: () => 0, fmt: r => html`<${CoachButton} view=${view} drv=${r.drv} cat=${r.cat} small=${true} label="Asignar"
            reason=${"Repitió " + ruleName(view, r.rule) + " " + r.n + " veces en " + days + " días."} />` },
      ]} empty=${"Nadie repite la misma regla " + min + " veces en " + days + " días. Buen indicio."} />
      <p className="small muted">Cada punto es una infracción; la marca azul es un coaching.</p>
    <//>`;
  }

  // ---------- Coaching: lista y resultado ----------
  function CoachResultLine({ r }) {
    const [lab, tone] = VERDICT[r.verdict] || ["–", ""];
    return html`<span className=${"delta " + (tone || "flat")}>${lab}</span>`;
  }
  function CoachingPanel({ view, onDriver }) {
    const coaches = useCoaches();
    const [edit, setEdit] = useState(null);
    const [show, setShow] = useState("activos");
    const end = periodEnd(view), start = periodStart(view);
    const rows = useMemo(() => coaches.filter(c => show === "todos" || c.status !== "cancelado").map(c => {
      const res = c.status === "hecho" && c.at ? GI.coachResult(view.model, view.ids, c, start, end) : null;
      return { ...c, name: dName(view, c.drv), res, sortAt: c.at || c.created || 0 };
    }), [coaches, view, show]);
    const measured = rows.filter(r => r.res && !r.res.measuring && /mejoro|empeoro|igual/.test(r.res.verdict));
    const better = measured.filter(r => r.res.verdict === "mejoro");
    const late = rows.filter(r => r.status === "asignado" && r.due && r.due < Date.now());
    const avgCh = measured.length ? measured.reduce((s, r) => s + r.res.ch, 0) / measured.length : null;
    return html`<${Panel} title="Coaching"
      hint="Intervenciones asignadas a conductores y su resultado. Al marcar un coaching como hecho, el add-in compara los días antes y después (índice de riesgo por km y la infracción del motivo) contra lo que hizo la flota en las mismas fechas."
      actions=${html`<${Segmented} value=${show} onChange=${setShow} options=${[{ value: "activos", label: "Activos" }, { value: "todos", label: "Todos" }]} />`}>
      <div className="readouts compact inset">
        <${Kpi} label="Asignados" value=${n0(rows.length)} sub=${html`<span>${n0(rows.filter(r => r.status === "asignado").length)} pendientes</span>`} />
        <${Kpi} label="Vencidos" value=${n0(late.length)} tone=${late.length ? "bad" : null} sub=${html`<span>pasó la fecha límite sin hacerse</span>`} />
        <${Kpi} label="Mejoraron" value=${measured.length ? n0(better.length) + " de " + n0(measured.length) : "–"} sub=${html`<span>coachings con la medición completa</span>`} />
        <${Kpi} label="Riesgo de los intervenidos" value=${avgCh != null ? (avgCh > 0 ? "+" : "") + n0(avgCh) + "%" : "–"} tone=${avgCh != null && avgCh < 0 ? "good" : null} sub=${html`<span>antes contra después, promedio</span>`} />
      </div>
      <${DataTable} rowKey=${r => r.id} rows=${rows} limit=${15} defaultSort=${{ key: "sortAt", dir: "desc" }} onRowClick=${r => setEdit(r)} columns=${[
        { key: "name", label: "Conductor", fmt: r => html`<b>${r.name}</b>${r.reason ? html`<div className="small muted">${r.reason}</div>` : null}` },
        { key: "cat", label: "Motivo", value: r => (r.cat ? GI.catLabel(r.cat) : "general"), fmt: r => (r.cat ? GI.catLabel(r.cat) : "Conducta general") },
        { key: "type", label: "Tipo", value: r => r.type, fmt: r => (COACH_TYPES.find(x => x[0] === r.type) || [0, r.type])[1] },
        { key: "owner", label: "Responsable" },
        { key: "status", label: "Estado", value: r => r.status, fmt: r => html`${STATUS[r.status] || r.status}${r.status === "asignado" && r.due ? html`<div className=${"small" + (r.due < Date.now() ? " bad" : " muted")}>vence ${fmtD(r.due)}</div>` : r.at ? html`<div className="small muted">${fmtD(r.at)}</div>` : null}` },
        { key: "res", label: "Resultado", value: r => (r.res && r.res.ch != null ? r.res.ch : 999), fmt: r => (r.res ? html`<${CoachResultLine} r=${r.res} />
            <div className="small muted">${r.res.before.rate != null ? n2(r.res.before.rate) : "–"} → ${r.res.after.rate != null ? n2(r.res.after.rate) : "–"} pts/100 km${r.res.measuring ? " · faltan " + r.res.daysLeft + " días" : ""}${r.res.fleetCh != null ? " · flota " + (r.res.fleetCh > 0 ? "+" : "") + n0(r.res.fleetCh) + "%" : ""}</div>` : html`<span className="muted small">${r.status === "asignado" ? "se mide al marcarlo hecho" : "–"}</span>`) },
      ]} empty="Todavía no hay coachings. Se asignan desde el Pareto, la matriz, la reincidencia o la ficha de un conductor." />
      ${edit ? html`<${CoachModal} view=${view} rec=${edit} drv=${edit.drv} onClose=${() => setEdit(null)} />` : null}
    <//>`;
  }
  // En la ficha de un conductor: sus coachings y el resultado
  function DriverCoaching({ view, drv }) {
    const coaches = useCoaches().filter(c => c.drv === drv && c.status !== "cancelado");
    const [edit, setEdit] = useState(null);
    const end = periodEnd(view), start = periodStart(view);
    return html`<div className="mg-dcoach">
      <div className="mg-dcoach-head"><h3>Coaching</h3><${CoachButton} view=${view} drv=${drv} small=${true} /></div>
      ${coaches.length ? coaches.map(c => { const res = c.status === "hecho" && c.at ? GI.coachResult(view.model, view.ids, c, start, end) : null;
        return html`<div key=${c.id} className="mg-dcoach-row"><button className="linkish" onClick=${() => setEdit(c)}>${c.cat ? GI.catLabel(c.cat) : "Conducta general"} · ${STATUS[c.status]}${c.at ? " " + fmtD(c.at) : ""}</button>
          ${res ? html`<${CoachResultLine} r=${res} /><span className="small muted">${res.before.rate != null ? n2(res.before.rate) : "–"} → ${res.after.rate != null ? n2(res.after.rate) : "–"} pts/100 km${res.fleetCh != null ? " (flota " + (res.fleetCh > 0 ? "+" : "") + n0(res.fleetCh) + "%)" : ""}</span>` : null}</div>`; })
        : html`<p className="small muted">Sin coaching asignado.</p>`}
      ${edit ? html`<${CoachModal} view=${view} rec=${edit} drv=${drv} onClose=${() => setEdit(null)} />` : null}
    </div>`;
  }

  // ---------- Informe mensual (ventana imprimible: Guardar como PDF) ----------
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function reportHtml(view, opts) {
    const t = view.total, ser = view.series || [];
    const half = Math.floor(ser.length / 2);
    const sumS = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);
    const A = ser.slice(0, half), B = ser.slice(half);
    const rate = a => { const km = sumS(a, x => x.km), w = sumS(a, x => x.weighted); return km ? (w / km) * 100 : null; };
    const rA = rate(A), rB = rate(B);
    const chg = rA && rB != null ? ((rB - rA) / rA) * 100 : null;
    const dP = GI.pareto(view.dRows.filter(r => !r.unknown).map(r => ({ id: r.id, name: r.name, w: r.weighted, km: r.km })), view.dRows.filter(r => !r.unknown && r.km > 0).length);
    const W = view.settings.category_weights || {};
    const cats = Object.entries(t.evByCat || {}).map(([k, n]) => ({ k, n, w: n * (W[k] != null ? W[k] : 0) })).filter(x => x.w > 0).sort((a, b) => b.w - a.w);
    const catTot = cats.reduce((s, x) => s + x.w, 0);
    const end = periodEnd(view), start = periodStart(view);
    const R = GI.recidivism(view.model, view.ids, view.driverOk, end, 30, 3);
    const coaches = (store.list || []).filter(c => c.status !== "cancelado");
    const measured = coaches.filter(c => c.status === "hecho" && c.at).map(c => GI.coachResult(view.model, view.ids, c, start, end)).filter(r => !r.measuring && /mejoro|empeoro|igual/.test(r.verdict));
    const better = measured.filter(r => r.verdict === "mejoro").length;
    const avg = measured.length ? measured.reduce((s, r) => s + r.ch, 0) / measured.length : null;
    const focos = (view.findings || []).slice(0, 3).map(f => f.title);
    const ks = view.model.dayKeys;
    const per = ks.length ? GI.parseDayKey(ks[0]).toLocaleDateString("es-AR") + " al " + GI.parseDayKey(ks[ks.length - 1]).toLocaleDateString("es-AR") : "";
    const drivers = view.dRows.filter(r => !r.unknown && r.km > 0).length;
    const kpi = (label, value, sub, tone) => '<div class="k' + (tone ? " " + tone : "") + '"><span>' + esc(label) + "</span><b>" + esc(value) + "</b><small>" + esc(sub || "") + "</small></div>";
    const pct = v => (v == null ? "–" : (v > 0 ? "▲ " : v < 0 ? "▼ " : "= ") + GI.fmtNum(Math.abs(v), 0) + "%");
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Informe de seguridad vial · ${esc(opts.database)}</title>
<style>
@page { size: A4; margin: 14mm; }
@font-face { font-family: Roboto; font-weight: 400; src: url("${opts.fontBase}roboto-latin-400-normal.woff2") format("woff2"); }
@font-face { font-family: Roboto; font-weight: 500; src: url("${opts.fontBase}roboto-latin-500-normal.woff2") format("woff2"); }
@font-face { font-family: Roboto; font-weight: 700; src: url("${opts.fontBase}roboto-latin-700-normal.woff2") format("woff2"); }
* { box-sizing: border-box; } body { max-width: 182mm; margin: 12px auto; font-family: Roboto, Arial, sans-serif; color: #3c5164; font-size: 10.5pt; line-height: 1.45; }
header { background: #21325e; color: #fff; padding: 16px 20px; border-radius: 4px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
header .b { font-size: 10pt; } header .b span { color: #00aeff; } header h1 { margin: 4px 0 2px; font-size: 18pt; font-weight: 700; } header p { margin: 0; font-size: 10pt; }
h2 { color: #25477b; font-size: 12.5pt; font-weight: 700; margin: 16px 0 6px; }
.ks { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 14px; }
.k { border: 1px solid #d1d6dd; border-radius: 4px; padding: 8px 10px; display: flex; flex-direction: column; } .k span { font-size: 9pt; font-weight: 500; } .k b { color: #25477b; font-size: 15pt; } .k small { font-size: 9pt; }
.k.bad { box-shadow: inset 0 3px 0 #fe5a3f; } .k.good { box-shadow: inset 0 3px 0 #00aa00; }
.bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden; margin: 6px 0 2px; -webkit-print-color-adjust: exact; print-color-adjust: exact; } .bar i { display: block; }
.row { display: flex; justify-content: space-between; font-size: 9pt; }
ol, ul { margin: 0; padding-left: 18px; } li { margin: 2px 0; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; } .box { background: #eff2f7; border-radius: 4px; padding: 10px 12px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.box h3 { margin: 0 0 4px; color: #25477b; font-size: 11pt; }
footer { margin-top: 18px; border-top: 1px solid #d1d6dd; padding-top: 6px; font-size: 8.5pt; color: #5b6d80; display: flex; justify-content: space-between; }
.noprint { margin: 0 0 12px; font-size: 10pt; } @media print { .noprint { display: none; } body { margin: 0 auto; } }
</style></head><body>
<p class="noprint">Para guardarlo como PDF elegí "Guardar como PDF" en la ventana de impresión. <button onclick="window.print()">Imprimir / Guardar PDF</button></p>
<header><div class="b"><b>Insights</b> <span>by Cesetti</span></div><h1>Informe de seguridad vial</h1><p>Base ${esc(opts.database)} · ${esc(per)} · ${GI.fmtNum(drivers, 0)} conductores · ${GI.fmtNum(view.ids.size, 0)} vehículos</p></header>
<div class="ks">
${kpi("Índice de riesgo", t.risk != null ? GI.fmtNum(t.risk, 2) : "–", pct(chg) + " 2.ª mitad vs 1.ª", chg != null ? (chg <= 0 ? "good" : "bad") : "")}
${kpi("Km recorridos", GI.fmtNum(t.km, 0), "")}
${kpi("Infracciones", GI.fmtNum(t.events, 0), t.km ? GI.fmtNum((t.events / t.km) * 100, 2) + " cada 100 km" : "")}
${kpi("Ralentí", t.idlePct != null ? GI.fmtNum(t.idlePct, 1) + "%" : "–", "del tiempo en marcha")}
</div>
${dP ? `<h2>Dónde se concentra el riesgo</h2><p><b>${GI.fmtNum(dP.n50, 0)} conductores (${GI.fmtNum(dP.pct50, 0)}% de la flota) generan el ${GI.fmtNum(dP.share50, 0)}% del riesgo.</b>${cats[0] ? " La categoría que más pesa es " + esc((GI.CATEGORY_BY_KEY[cats[0].k] || { label: cats[0].k }).label.toLowerCase()) + " (" + GI.fmtNum((cats[0].w / catTot) * 100, 0) + "%)." : ""}</p>
<div class="bar"><i style="width:${dP.share50}%;background:#25477b"></i><i style="width:${100 - dP.share50}%;background:#d1d6dd"></i></div>
<div class="row"><span>${GI.fmtNum(dP.n50, 0)} conductores · ${GI.fmtNum(dP.share50, 0)}%</span><span>${GI.fmtNum(dP.pop - dP.n50, 0)} conductores · ${GI.fmtNum(100 - dP.share50, 0)}%</span></div>
<ol>${dP.top.slice(0, 5).map(r => "<li>" + esc(r.name) + " · " + GI.fmtNum(r.share, 1) + "%</li>").join("")}</ol>` : ""}
${focos.length ? `<h2>Focos del período</h2><ol>${focos.map(f => "<li>" + esc(f) + "</li>").join("")}${R.drivers ? "<li>" + GI.fmtNum(R.drivers, 0) + " conductores repiten la misma infracción 3 veces o más en 30 días.</li>" : ""}</ol>` : ""}
<div class="two" style="margin-top:14px">
<div class="box"><h3>Acciones y resultado</h3>${coaches.length ? GI.fmtNum(coaches.length, 0) + " coachings · " + GI.fmtNum(coaches.filter(c => c.status === "hecho").length, 0) + " hechos<br>" + (measured.length ? GI.fmtNum(better, 0) + " de " + GI.fmtNum(measured.length, 0) + " conductores medidos mejoraron<br>Riesgo de los intervenidos: " + (avg > 0 ? "+" : "") + GI.fmtNum(avg, 0) + "%" : "Todavía sin mediciones completas") : "Sin coachings registrados en el add-in"}</div>
<div class="box"><h3>Combustible</h3>${view.model.hasFuel ? "Consumo " + (t.l100 != null ? GI.fmtNum(t.l100, 1) + " L/100 km" : "–") + "<br>" : ""}Ralentí ${t.idlePct != null ? GI.fmtNum(t.idlePct, 1) + "% del tiempo en marcha" : "–"}${view.savings && view.savings.totalL ? "<br>Exceso sobre objetivo: " + GI.fmtNum(view.savings.totalL, 0) + " L" : ""}</div>
</div>
<footer><span>Elaborado por Ingeniero Jorge Cesetti SRL con datos de MyGeotab.</span><span>© ${new Date().getFullYear()} Ingeniero Jorge Cesetti SRL · ${new Date().toLocaleDateString("es-AR")}</span></footer>
</body></html>`;
  }
  function ReportButton({ view }) {
    if (view.driverMode) return null;
    function open() {
      const w = window.open("", "_blank");
      if (!w) { alertBlocked(); return; }
      const base = (GI.STATIC_BASE || (location.origin + "/static/")) + "vendor/fonts/";
      w.document.open(); w.document.write(reportHtml(view, { database: ctx().database || "", fontBase: base })); w.document.close();
      setTimeout(() => { try { w.focus(); w.print(); } catch (e) {} }, 600);
    }
    function alertBlocked() { GI._toast && GI._toast("El navegador bloqueó la ventana del informe: permití las ventanas emergentes para este sitio."); }
    return html`<button className="btn" onClick=${open} title="Abre el informe del período para imprimir o guardar como PDF">Informe mensual (PDF)</button>`;
  }

  Object.assign(GI, { CoachMany, ParetoPanel, MatrixPanel, RecidivismPanel, CoachingPanel, DriverCoaching, CoachButton, ReportButton, loadCoachList, _reportHtml: reportHtml });
})(window.GI);
