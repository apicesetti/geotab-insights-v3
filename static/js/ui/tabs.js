// Pestañas de análisis: Resumen, Combustible y ralentí, Seguridad,
// Conductores, Recorridos + modales de detalle.
//
// Criterios de UX que siguen todas las pantallas:
// - Cada indicador muestra valor + variación (flecha, número y palabra) y,
//   cuando hace falta, una frase que dice qué significa.
// - La explicación de cómo se calcula algo va en el ícono "?" (Hint), no en
//   párrafos debajo de cada título.
// - Un solo eje Y por gráfico. Cuando hay que comparar magnitudes distintas
//   (eventos vs km) se indexan a 100.
// - Todo lo que es una fila (vehículo, conductor) se puede abrir con un click.
(function (GI) {
  "use strict";
  const { useState, useMemo, useEffect } = React;
  const html = GI.html;
  const { Kpi, Delta, Panel, Info, DataTable, ChartView, Segmented, Modal } = GI;
  const n0 = v => GI.fmtNum(v, 0), n1 = v => GI.fmtNum(v, 1), n2 = v => GI.fmtNum(v, 2);
  const GRAN_WORD = { day: "día", week: "semana", month: "mes" };
  const GRAN_PLURAL = { day: "días", week: "semanas", month: "meses" };
  const VS = "vs 1.ª mitad";
  // En tasas, un período incompleto (ej. un solo domingo al inicio) da
  // valores engañosos: no se dibuja.
  const rateOf = (s, v) => (s.partial ? null : v);

  // Comparación 1.ª vs 2.ª mitad del período, solo con buckets completos.
  // num/den: funciones sobre un bucket; el resultado es Σnum/Σden de cada mitad.
  function halves(view, num, den) {
    const full = view.series.filter(s => !s.partial && s.km > 0);
    if (full.length < 2) return { a: null, b: null, ch: null };
    const h = Math.floor(full.length / 2);
    const A = full.slice(0, h), B = full.slice(h);
    const ratio = arr => {
      const d = den ? GI.sum(arr, den) : arr.length;
      return d ? GI.sum(arr, num) / d : null;
    };
    const a = ratio(A), b = ratio(B);
    return { a, b, ch: GI.pctChange(a, b) };
  }
  const H = {
    km: v => halves(v, s => s.km),
    risk: v => halves(v, s => s.weighted * 100, s => s.km),
    idlePct: v => halves(v, s => s.idleH * 100, s => s.idleH + s.drivingH),
    l100: v => halves(v, s => (s.l100 != null ? s.l100 : 0), s => (s.l100 != null ? 1 : 0)),
  };

  function changeWords(ch, goodWhenDown) {
    if (ch == null) return null;
    if (Math.abs(ch) < 3) return { tone: "flat", word: "se mantuvo" };
    const down = ch < 0;
    return { tone: (goodWhenDown ? down : !down) ? "good" : "bad", word: (down ? "bajó " : "subió ") + GI.fmtNum(Math.abs(ch), 0) + "%" };
  }

  function Verdict({ tone, tag, children }) {
    return html`<div className=${"verdict-line " + (tone || "")}><span className="vtag">${tag}</span><span>${children}</span></div>`;
  }

  // ======================= RESUMEN =======================
  const METRICS = {
    risk: { label: "Índice de riesgo", unit: "pts/100 km", color: "#2a78d6", dec: 2 },
    idlePct: { label: "Ralentí", unit: "% del tiempo en marcha", color: "#2a78d6", dec: 1 },
    l100: { label: "Consumo", unit: "L/100 km", color: "#2a78d6", dec: 1 },
    km: { label: "Kilómetros", unit: "km", color: "#2a78d6", dec: 0 },
  };

  function TrendChart({ view, metric, height }) {
    const m = METRICS[metric];
    const bar = metric === "km";
    return html`<${ChartView} height=${height || 300} config=${{
      type: bar ? "bar" : "line",
      data: {
        labels: view.series.map(s => s.label),
        datasets: [{ label: m.label + " (" + m.unit + ")", data: view.series.map(s => s[metric] == null ? null : bar ? GI.round(s[metric], m.dec) : rateOf(s, GI.round(s[metric], m.dec))),
          borderColor: m.color, backgroundColor: bar ? m.color : m.color + "1f", fill: !bar, tension: 0.3, spanGaps: true }],
      },
      options: {
        plugins: { legend: { display: false }, milestones: { items: GI.milestoneMarks(view.milestones, view.series, view.gran) } },
        scales: { y: { beginAtZero: true, title: { display: true, text: m.unit } } },
      },
    }} />`;
  }

  function Findings({ items, onGo }) {
    if (!items.length) return html`<div className="empty">Nada fuera de lo esperado en este período.</div>`;
    const order = { oportunidad: 0, logro: 1, dato: 2 };
    const icon = { oportunidad: "!", logro: "✓", dato: "i" };
    const linkText = { combustible: "Ver vehículos", ralenti: "Ver vehículos", seguridad: "Ver eventos", conductores: "Ver conductores", tendencia: null, datos: null };
    return html`<div className="findings">${[...items].sort((a, b) => order[a.type] - order[b.type]).map((f, i) => html`
      <div key=${i} className=${"finding " + f.type}>
        <span className="ficon" aria-hidden="true">${icon[f.type]}</span>
        <div className="finding-title">${f.title}</div>
        <div className="finding-text">${f.text}</div>
        ${f.target && linkText[f.area] ? html`<button className="btn link" onClick=${() => onGo(f.target.tab)}>${linkText[f.area]}</button>` : null}
      </div>`)}</div>`;
  }

  function summarySentence(view) {
    const r = changeWords(H.risk(view).ch, true), i = changeWords(H.idlePct(view).ch, true), k = changeWords(H.km(view).ch, false);
    if (!r) return null;
    const parts = [];
    parts.push(html`El índice de riesgo <b>${r.word}</b>`);
    if (k) parts.push(html`, con km que ${k.tone === "flat" ? "se mantuvieron" : k.word.replace("bajó", "bajaron").replace("subió", "subieron")}`);
    if (i) parts.push(html`. El ralentí <b>${i.word}</b>`);
    parts.push(".");
    const tag = r.tone === "good" ? "Mejora" : r.tone === "bad" ? "Atención" : "Estable";
    return html`<${Verdict} tone=${r.tone} tag=${tag}>${parts} <span className="muted">(${VS} del período)</span><//>`;
  }

  function SummaryTab({ view, onGo }) {
    const [metric, setMetric] = useState("risk");
    const k = view.total;
    const price = view.model.hasPrice;
    return html`<div>
      <div className="readouts">
        <${Kpi} label="Kilómetros" value=${n0(k.km)} sub=${html`<${Delta} value=${H.km(view).ch} /> <span>${VS}</span>`} />
        <${Kpi} label="Índice de riesgo" value=${n2(k.risk)} unit="pts/100 km" sub=${html`<${Delta} value=${H.risk(view).ch} goodWhenDown /> <span>${VS}</span>`}
          hint="Suma de las infracciones (cada una multiplicada por su peso) cada 100 km recorridos. El ralentí no cuenta. Los pesos se editan en Configuración." />
        <${Kpi} label="Ralentí" value=${GI.fmtPct(k.idlePct)} unit="del tiempo" sub=${html`<${Delta} value=${H.idlePct(view).ch} goodWhenDown /> <span>${n0(k.idleH)} h</span>`}
          hint="Horas con motor encendido y vehículo detenido, sobre el total de horas en marcha." />
        <${Kpi} label="Consumo" value=${k.l100 == null ? "–" : n1(k.l100)} unit="L/100 km" sub=${html`<${Delta} value=${H.l100(view).ch} goodWhenDown /> <span>${VS}</span>`}
          hint="Solo vehículos que reportan el contador de combustible." />
        <${Kpi} tone="accent" label="Ahorro posible" value=${price ? GI.fmtMoney(view.savings.cost) : n0(view.savings.totalL)} unit=${price ? null : "L"}
          sub=${price ? n0(view.savings.totalL) + " L sobre objetivo" : html`<span>Cargá el precio del diésel y la nafta en Configuración para verlo en $</span>`}
          hint="Litros por encima del ralentí máximo y del consumo de referencia (más la tolerancia) de cada perfil." />
      </div>
      ${summarySentence(view)}
      <div className="grid-2-1">
        <${Panel} title="Evolución" hint=${"Agrupado por " + GRAN_WORD[view.gran] + ". Las líneas amarillas punteadas son hitos. El asterisco marca " + GRAN_PLURAL[view.gran] + " incompletos (inicio o fin del período)."}
          actions=${html`<${Segmented} value=${metric} onChange=${setMetric} options=${[
            { value: "risk", label: "Riesgo" }, { value: "idlePct", label: "Ralentí" }, { value: "l100", label: "Consumo" }, { value: "km", label: "Km" }]} />`}>
          <${TrendChart} view=${view} metric=${metric} />
        <//>
        <${Panel} title="Qué mirar primero">
          <${Findings} items=${view.findings.filter(f => f.area !== "tendencia")} onGo=${onGo} />
        <//>
      </div>
      <${Panel} title="Por perfil de operación" hint="Cada perfil (tipo de vehículo × corta/larga distancia) se compara contra sus propios objetivos, que se definen en Configuración → Objetivos por perfil.">
        <${DataTable} rowKey=${r => r.profile} rows=${view.pRows} defaultSort=${{ key: "km", dir: "desc" }} columns=${[
          { key: "profile", label: "Perfil", fmt: r => GI.profileLabel(view.settings, r.profile), value: r => r.profile },
          { key: "vehicles", label: "Vehículos", align: "num" },
          { key: "km", label: "Km", align: "num", fmt: r => n0(r.km) },
          { key: "l100", label: "L/100 km", align: "num", fmt: r => html`${n1(r.l100)}${r.target.l100 ? html` <span className="muted">obj. ${n1(r.target.l100)}</span>` : ""}` },
          { key: "idlePct", label: "Ralentí", align: "num", fmt: r => html`<${TargetCell} value=${r.idlePct} max=${r.target.idle_pct_max} fmt=${v => GI.fmtPct(v)} />` },
          { key: "risk", label: "Riesgo", align: "num", fmt: r => html`<${TargetCell} value=${r.risk} max=${r.target.risk_max} fmt=${n2} />` },
          { key: "events", label: "Infracciones", align: "num", fmt: r => n0(r.events) },
        ]} />
      <//>
    </div>`;
  }

  // Valor contra un máximo: texto explícito, no solo color.
  function TargetCell({ value, max, fmt }) {
    if (value == null) return "–";
    const over = value > max;
    return html`<span className=${over ? "bad" : "good"}>${fmt(value)}</span> <span className="muted small">${over ? "sobre" : "dentro de"} ${fmt(max)}</span>`;
  }

  // ======================= COMBUSTIBLE =======================
  function FuelTab({ view, onVehicle }) {
    const k = view.total;
    const price = view.model.hasPrice;
    const tol = view.settings.fuel.tolerance_pct != null ? view.settings.fuel.tolerance_pct : 10;
    const [mode, setMode] = useState("desvio");
    const [idleMode, setIdleMode] = useState("pct");
    const rows = view.vRows.filter(r => r.km > 0 || r.idleH > 0);
    const sortKey = mode === "desvio" ? "excessL" : mode === "ralenti" ? "idleH" : "l100";
    // Color fijo por tipo de vehículo (orden de Configuración), no por posición en el gráfico.
    const vtOrder = [...view.settings.vehicle_types.map(v => v.key), "sin_tipo"];
    const vtypes = vtOrder.filter(vt => rows.some(r => r.vtype === vt));
    const typeSeries = vtypes.map(vt => {
      const ids = new Set(rows.filter(r => r.vtype === vt).map(r => r.id));
      return { vt, s: GI.series(view.model, ids, view.gran), color: GI.SERIES_COLORS[vtOrder.indexOf(vt) % GI.SERIES_COLORS.length] };
    });
    const marks = { items: GI.milestoneMarks(view.milestones, view.series, view.gran) };
    const flagged = rows.filter(r => r.flags.includes("consumo") || r.flags.includes("ralenti")).length;
    return html`<div>
      <div className="readouts">
        <${Kpi} label="Combustible medido" value=${n0(k.fuelL)} unit="L" sub=${view.model.fuelDevices.size + " vehículos con medición"} />
        <${Kpi} label="Consumo promedio" value=${k.l100 == null ? "–" : n1(k.l100)} unit="L/100 km" sub=${html`<${Delta} value=${H.l100(view).ch} goodWhenDown /> <span>${VS}</span>`} />
        <${Kpi} label="Ralentí" value=${n0(k.idleH)} unit="h" sub=${html`<${Delta} value=${H.idlePct(view).ch} goodWhenDown /> <span>${GI.fmtPct(k.idlePct)} del tiempo</span>`} />
        <${Kpi} label="Litros en ralentí" value=${n0(k.idleL)} unit="L" sub=${price ? GI.fmtMoney(k.idleCost) : "sin precio cargado"}
          hint="Medido con el contador de combustible en ralentí; si el vehículo no lo reporta, se estima con horas × L/h de su tipo." />
        <${Kpi} tone="accent" label="Exceso sobre objetivo" value=${n0(view.savings.totalL)} unit="L"
          sub=${(price ? GI.fmtMoney(view.savings.cost) + ": " : "") + n0(view.savings.idleL) + " L ralentí y " + n0(view.savings.fuelL) + " L consumo"}
          hint=${"Ralentí por encima del máximo del perfil, más consumo por encima de la referencia del perfil + " + tol + "% de tolerancia."} />
      </div>
      <div className="grid-2">
        <${Panel} title="Ralentí en el tiempo"
          actions=${html`<${Segmented} value=${idleMode} onChange=${setIdleMode} options=${[{ value: "pct", label: "% del tiempo" }, { value: "l", label: "Litros" }]} />`}>
          <${ChartView} config=${idleMode === "pct" ? {
            type: "line",
            data: { labels: view.series.map(s => s.label), datasets: [
              { label: "% del tiempo en marcha", data: view.series.map(s => s.idlePct == null ? null : rateOf(s, GI.round(s.idlePct, 1))), borderColor: "#2a78d6", backgroundColor: "#2a78d61f", fill: true, tension: 0.3, spanGaps: true }] },
            options: { plugins: { legend: { display: false }, milestones: marks }, scales: { y: { beginAtZero: true, title: { display: true, text: "%" } } } },
          } : {
            type: "bar",
            data: { labels: view.series.map(s => s.label), datasets: [{ label: "Litros en ralentí", data: view.series.map(s => GI.round(s.idleL, 0)), backgroundColor: "#2a78d6" }] },
            options: { plugins: { legend: { display: false }, milestones: marks }, scales: { y: { beginAtZero: true, title: { display: true, text: "L" } } } },
          }} />
        <//>
        <${Panel} title="Consumo por tipo de vehículo" hint="L/100 km de cada tipo de vehículo. Un bitren consume más que un camión: por eso cada uno se compara contra su propio perfil, no contra el promedio de la flota.">
          <${ChartView} config=${{
            type: "line",
            data: { labels: view.series.map(s => s.label), datasets: typeSeries.map(t => ({
              label: GI.vtypeLabel(view.settings, t.vt), data: t.s.map(x => x.l100 == null ? null : rateOf(x, GI.round(x.l100, 1))),
              borderColor: t.color, backgroundColor: t.color, tension: 0.3, spanGaps: true })) },
            options: { plugins: { milestones: marks }, scales: { y: { beginAtZero: true, title: { display: true, text: "L/100 km" } } } },
          }} />
        <//>
      </div>
      <${Panel} title="Vehículos" sub=${flagged ? flagged + " de " + rows.length + " vehículos están fuera de su objetivo de consumo o ralentí. Click en una fila para ver el detalle." : "Click en una fila para ver el detalle."}
        hint=${"Referencia de consumo: objetivo del perfil o, si no hay, la mediana del perfil. Exceso = litros por encima de la referencia + " + tol + "% de tolerancia, más el ralentí por encima del máximo del perfil."}
        actions=${html`<${Segmented} value=${mode} onChange=${setMode} options=${[
          { value: "desvio", label: "Mayor exceso" }, { value: "ralenti", label: "Más ralentí" }, { value: "consumo", label: "Mayor consumo" }]} />`}>
        <${DataTable} rowKey=${r => r.id} rows=${rows} limit=${12} onRowClick=${r => onVehicle(r.id)}
          defaultSort=${{ key: sortKey, dir: "desc" }} columns=${[
          { key: "name", label: "Vehículo" },
          { key: "profile", label: "Perfil", fmt: r => html`${GI.profileLabel(view.settings, r.profile)}${r.fuelType ? html`<span className="tag">${GI.fuelLabel(view.settings, r.fuelType)}</span>` : ""}` },
          { key: "km", label: "Km", align: "num", fmt: r => n0(r.km) },
          { key: "l100", label: "L/100 km", align: "num", fmt: r => r.fuelMeasured ? n1(r.l100) : html`<span className="muted" title="El vehículo no reporta el contador de combustible">sin dato</span>` },
          { key: "fuelDevPct", label: "vs referencia", align: "num", title: "Diferencia contra la referencia de su perfil",
            fmt: r => r.fuelDevPct == null ? "–" : html`<span className=${r.fuelExcessL > 0 ? "bad" : r.fuelDevPct <= -5 ? "good" : ""}>${(r.fuelDevPct > 0 ? "+" : "") + n0(r.fuelDevPct)}%</span> <span className="muted small">ref. ${n1(r.refL100)}</span>` },
          { key: "idlePct", label: "Ralentí", align: "num", fmt: r => html`<${TargetCell} value=${r.idlePct} max=${r.idleMax} fmt=${v => GI.fmtPct(v)} />` },
          { key: "excessL", label: "Exceso", align: "num", value: r => r.fuelExcessL + r.idleExcessL,
            fmt: r => html`${n0(r.fuelExcessL + r.idleExcessL)} L${price ? html` <span className="muted small">${GI.fmtMoney(r.excessCost)}</span>` : ""}` },
        ]} />
      <//>
    </div>`;
  }

  // ======================= SEGURIDAD =======================
  // Evolución de eventos: selector de categorías + 3 vistas.
  function EventsEvolution({ view, riskCats }) {
    const allKeys = riskCats.map(c => c.key);
    const [sel, setSel] = useState(allKeys);
    const [mode, setMode] = useState("rate");
    const [showKm, setShowKm] = useState(true);
    useEffect(() => { setSel(s => (s.length ? s.filter(k => allKeys.includes(k)) : allKeys)); }, [allKeys.join()]);
    const active = riskCats.filter(c => sel.includes(c.key));
    const toggle = k => setSel(s => (s.includes(k) ? s.filter(x => x !== k) : [...s, k]));
    const only = k => setSel([k]);
    const S = view.series;
    const evSel = s => GI.sum(active, c => s.evByCat[c.key] || 0);

    const ev = halves(view, evSel);
    const km = halves(view, s => s.km);
    const rate = halves(view, s => evSel(s) * 100, s => s.km);
    const rw = changeWords(rate.ch, true), ew = changeWords(ev.ch, true), kw = changeWords(km.ch, false);
    const unit = GRAN_WORD[view.gran];

    // Categorías en el gráfico: las 8 principales con color propio, el resto agrupado en "Otras".
    const slotCats = GI.CHART_SLOTS.map(k => active.find(c => c.key === k)).filter(Boolean);
    const otherCats = active.filter(c => !GI.CHART_SLOTS.includes(c.key));
    const stacks = [
      ...slotCats.map(c => ({ label: c.label, color: c.color, get: s => s.evByCat[c.key] || 0 })),
      ...(otherCats.length ? [{ label: otherCats.length === 1 ? otherCats[0].label : "Otras (" + otherCats.length + ")", color: GI.OTHER_COLOR, get: s => GI.sum(otherCats, c => s.evByCat[c.key] || 0) }] : []),
    ];
    const marks = { items: GI.milestoneMarks(view.milestones, S, view.gran) };
    const tipOne = { mode: "nearest", intersect: true };
    const per100 = (s, n) => (s.km > 0 ? GI.round((n / s.km) * 100, 3) : null);

    let config;
    if (mode === "rate") {
      config = { type: "bar", data: { labels: S.map(s => s.label), datasets: stacks.map(st => ({
        label: st.label, data: S.map(s => rateOf(s, per100(s, st.get(s)))), backgroundColor: st.color, borderColor: "#ffffff", borderWidth: { top: 2 }, borderRadius: 0, stack: "r" })) },
        options: { interaction: tipOne, plugins: { legend: { display: false }, tooltip: tipOne, milestones: marks },
          scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, title: { display: true, text: "eventos cada 100 km" } } } } };
    } else if (mode === "index") {
      // Un solo eje: ambas series indexadas a 100 en el primer período completo.
      const base = S.find(s => !s.partial && s.km > 0);
      const bEv = base ? evSel(base) : 0, bKm = base ? base.km : 0;
      const idx = (v, b) => (b > 0 ? GI.round((v / b) * 100, 1) : null);
      config = { type: "line", data: { labels: S.map(s => s.label), datasets: [
        { label: "Kilómetros", data: S.map(s => (s.partial ? null : idx(s.km, bKm))), borderColor: "#2a78d6", backgroundColor: "#2a78d6", tension: 0.3, spanGaps: true },
        { label: "Eventos", data: S.map(s => (s.partial ? null : idx(evSel(s), bEv))), borderColor: "#eb6834", backgroundColor: "#eb6834", tension: 0.3, spanGaps: true },
      ] }, options: { interaction: { mode: "index", intersect: false },
        plugins: { tooltip: { mode: "index", intersect: false, callbacks: { label: c => c.dataset.label + ": " + GI.fmtNum(c.parsed.y, 0) + " (base 100)" } }, milestones: marks },
        scales: { y: { title: { display: true, text: "índice (" + (base ? base.label : "inicio") + " = 100)" } } } } };
    } else {
      config = { type: "bar", data: { labels: S.map(s => s.label), datasets: stacks.map(st => ({
        label: st.label, data: S.map(st.get), backgroundColor: st.color, borderColor: "#ffffff", borderWidth: { top: 2 }, borderRadius: 0, stack: "n" })) },
        options: { interaction: tipOne, plugins: { legend: { display: false }, tooltip: tipOne, milestones: marks },
          scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, title: { display: true, text: "eventos" } } } } };
    }

    // Km recorridos como línea de referencia (eje derecho), a pedido.
    if (showKm && mode !== "index") {
      config.data.datasets.push({ type: "line", label: "Km recorridos", data: S.map(s => (s.partial ? null : GI.round(s.km, 0))), yAxisID: "yKm",
        borderColor: "#1f2a37", backgroundColor: "#1f2a37", borderDash: [5, 4], tension: 0.3, spanGaps: true, pointRadius: 2, order: -1 });
      config.options.scales.yKm = { position: "right", beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: "km" } };
    }

    const tag = !rw ? null : rw.tone === "good" ? "Mejora" : rw.tone === "bad" ? "Empeora" : "Estable";
    return html`<${Panel} title="Evolución de las infracciones"
      hint="Eventos cada 100 km normaliza por lo recorrido: si las infracciones se mantienen y los km suben, la tasa baja y es una mejora. En 'Eventos vs km' ambas líneas arrancan en 100, así se compara cuánto creció cada una."
      actions=${html`<${Segmented} value=${mode} onChange=${setMode} options=${[
        { value: "rate", label: "Cada 100 km" }, { value: "index", label: "Eventos vs km" }, { value: "count", label: "Cantidad" }]} />
        ${mode !== "index" ? html`<label className="inline"><input type="checkbox" checked=${showKm} onChange=${e => setShowKm(e.target.checked)} /> Km recorridos (línea)</label>` : null}`}>
      <div className="catbar" role="group" aria-label="Categorías visibles">
        <button className="btn small" onClick=${() => setSel(allKeys)}>Todas</button>
        <button className="btn small" onClick=${() => setSel([])}>Ninguna</button>
        <span className="sep"></span>
        ${riskCats.map(c => html`<button key=${c.key} className=${"catchip" + (sel.includes(c.key) ? " on" : "")} aria-pressed=${sel.includes(c.key)}
          onClick=${e => (e.altKey ? only(c.key) : toggle(c.key))} onDoubleClick=${() => only(c.key)}
          title="Click: mostrar u ocultar. Doble click: ver solo esta."><span className="dot" style=${{ background: GI.CHART_SLOTS.includes(c.key) ? c.color : GI.OTHER_COLOR }}></span>${c.label}</button>`)}
      </div>
      ${active.length ? html`
        <div className="readouts compact inset">
          <${Kpi} label=${"Infracciones por " + unit} value=${n0(ev.b)} sub=${html`<${Delta} value=${ev.ch} goodWhenDown /> <span>${VS}</span>`} />
          <${Kpi} label=${"Km por " + unit} value=${n0(km.b)} sub=${html`<${Delta} value=${km.ch} /> <span>${VS}</span>`} />
          <${Kpi} tone="accent" label="Infracciones cada 100 km" value=${n2(rate.b)} sub=${html`<${Delta} value=${rate.ch} goodWhenDown /> <span>${VS}</span>`} />
        </div>
        ${rw ? html`<${Verdict} tone=${rw.tone} tag=${tag}>
          Los km ${kw ? (kw.tone === "flat" ? "se mantuvieron" : kw.word.replace("bajó", "bajaron").replace("subió", "subieron")) : "–"} y las infracciones ${ew ? (ew.tone === "flat" ? "se mantuvieron" : ew.word.replace("bajó", "bajaron").replace("subió", "subieron")) : "–"}:
          cada 100 km hay <b>${rw.tone === "flat" ? "la misma cantidad" : GI.fmtNum(Math.abs(rate.ch), 0) + "% " + (rate.ch < 0 ? "menos" : "más")}</b> infracciones.
          <span className="muted"> Comparación de la 2.ª mitad del período contra la 1.ª, sin ${GRAN_PLURAL[view.gran]} incompletos.</span><//>` : null}
        <${ChartView} height=${320} config=${config} />`
      : html`<div className="empty">Elegí al menos una categoría para ver su evolución.</div>`}
    <//>`;
  }

  // ---------- Seguridad: utilidades ----------
  function riskRuleRows(view) {
    const map = view.settings.rule_mapping || {};
    const names = new Map(view.model.cat.rules.map(r => [r.id, r.name]));
    return GI.riskRuleIds(map).map(rid => ({ id: rid, name: names.get(rid) || rid, cat: map[rid] }));
  }

  // Conductores: tasa por período (pts/100 km) y tendencia lineal.
  function driverTrendMap(view) {
    const out = new Map();
    for (const [drv, cells] of view.model.drvCells) {
      if (drv === "_unknown") continue;
      const ser = GI.rateSeries(view.model, view.ids, view.gran, c => c.w, cells).filter(x => !x.partial);
      out.set(drv, { tr: GI.linearTrend(ser.map(x => (x.km >= 50 ? x.rate : null))), ser });
    }
    return out;
  }

  function TrendCell({ tr, unit }) {
    if (!tr || tr.slopePct == null) return html`<span className="muted small">pocos datos</span>`;
    const v = tr.slopePct;
    if (Math.abs(v) < 5) return html`<span className="delta flat">= estable</span>`;
    return html`<span className=${"delta " + (v > 0 ? "bad" : "good")}>${v > 0 ? "▲" : "▼"} ${GI.fmtNum(Math.abs(v), 0)}% por ${unit}</span>`;
  }

  // Abre la página de eventos de MyGeotab con los filtros del caso.
  function openEvents(view, opts) {
    GI.openEventsPage({
      ruleIds: opts.ruleIds, deviceIds: opts.deviceIds, driverIds: opts.driverIds,
      from: view.model.dayKeys[0], to: view.model.dayKeys[view.model.dayKeys.length - 1],
    });
  }

  // ---------- Detalle de una categoría: conductores con esos eventos ----------
  function CategoryDetail({ view, cat, onClose, onDriver }) {
    const ruleIds = riskRuleRows(view).filter(r => r.cat === cat).map(r => r.id);
    const rows = useMemo(() => {
      const out = [];
      for (const [drv, cells] of view.model.drvCells) {
        let n = 0, km = 0;
        const devs = new Set();
        for (const [ck, c] of cells) {
          const dev = ck.split("|")[0];
          if (!view.ids.has(dev)) continue;
          km += c.km; const k = c.ev[cat] || 0; n += k; if (k) devs.add(dev);
        }
        if (n > 0) out.push({ id: drv, name: drv === "_unknown" ? "Sin conductor identificado" : view.model.driverName.get(drv) || drv, unknown: drv === "_unknown", n, km, rate: km > 0 ? (n / km) * 100 : null, devs: [...devs] });
      }
      return out;
    }, [cat, view]);
    const total = GI.sum(rows, r => r.n);
    return html`<${Modal} title=${GI.catLabel(cat)} onClose=${onClose} wide>
      <p className="muted" style=${{ marginBottom: "12px" }}>${n0(total)} eventos de ${rows.filter(r => !r.unknown).length} conductores en el período.
        Reglas que suman a esta categoría: ${ruleIds.map(id => (view.model.cat.rules.find(r => r.id === id) || { name: id }).name).join(", ") || "ninguna"}.</p>
      <${DataTable} rowKey=${r => r.id} rows=${rows} limit=${25} defaultSort=${{ key: "n", dir: "desc" }}
        onRowClick=${r => (r.unknown ? null : onDriver(r.id))} columns=${[
        { key: "name", label: "Conductor" },
        { key: "n", label: "Eventos", align: "num", title: "Click en el número para verlos en MyGeotab",
          fmt: r => html`<button className="btn link" onClick=${e => { e.stopPropagation(); openEvents(view, r.unknown ? { ruleIds, deviceIds: r.devs } : { ruleIds, driverIds: [r.id] }); }}>${n0(r.n)}</button>` },
        { key: "share", label: "% del total", align: "num", value: r => r.n, fmt: r => GI.fmtPct(total ? (r.n / total) * 100 : null, 0) },
        { key: "km", label: "Km", align: "num", fmt: r => n0(r.km) },
        { key: "rate", label: "Cada 100 km", align: "num", fmt: r => n2(r.rate) },
      ]} />
    <//>`;
  }

  // ---------- Pronóstico y objetivos por regla ----------
  function ForecastPanel({ view, driverTrends }) {
    const unit = GRAN_WORD[view.gran];
    const horizon = view.gran === "day" ? 14 : view.gran === "week" ? 4 : 2;
    const targets = view.settings.rule_targets || {};
    const rules = riskRuleRows(view);
    const rows = rules.map(r => {
      const ser = GI.rateSeries(view.model, view.ids, view.gran, c => c.er[r.id] || 0).filter(x => !x.partial);
      const tr = GI.linearTrend(ser.map(x => (x.km >= 100 ? x.rate : null)));
      const n = view.total.evByRule[r.id] || 0;
      const rate = view.total.km > 0 ? (n / view.total.km) * 100 : null;
      const target = targets[r.id] > 0 ? targets[r.id] : null;
      const proj = tr ? tr.at(horizon) : null;
      const cross = tr && target ? tr.periodsTo(target) : null;
      let status = "sin objetivo";
      if (target != null && tr) status = tr.current > target ? (tr.slope <= 0 ? "sobre, bajando" : "sobre y subiendo") : cross != null && cross <= horizon ? "va a superar" : "dentro";
      return { ...r, n, rate, target, tr, proj, cross, status, current: tr ? tr.current : rate };
    }).filter(r => r.n > 0 || r.target);
    const warn = rows.filter(r => r.status === "va a superar" || r.status === "sobre y subiendo");
    // Índice de riesgo total proyectado
    const riskSer = GI.rateSeries(view.model, view.ids, view.gran, c => c.w).filter(x => !x.partial);
    const riskTr = GI.linearTrend(riskSer.map(x => (x.km >= 100 ? x.rate : null)));
    const rising = [...driverTrends.values()].filter(d => d.tr && d.tr.slopePct > 15 && d.tr.current > 0).length;
    const statusCell = r => {
      const map = { "va a superar": "bad", "sobre y subiendo": "bad", "sobre, bajando": "flat", "dentro": "good", "sin objetivo": "flat" };
      let text = r.status;
      if (r.status === "va a superar") text = "supera el objetivo en ~" + r.cross + " " + (r.cross === 1 ? unit : GRAN_PLURAL[view.gran]);
      return html`<span className=${"delta " + map[r.status]}>${text}</span>`;
    };
    return html`<${Panel} title="Pronóstico"
      hint=${"Proyección lineal con los últimos " + GRAN_PLURAL[view.gran] + " completos (hasta 8). Indica hacia dónde va cada regla si nada cambia. Los objetivos por regla se definen en Configuración → Reglas (eventos cada 100 km)."}>
      <div className="readouts compact inset">
        <${Kpi} label=${"Índice de riesgo en " + horizon + " " + GRAN_PLURAL[view.gran]} value=${riskTr ? n2(riskTr.at(horizon)) : "–"} unit="pts/100 km"
          sub=${riskTr ? html`hoy ${n2(riskTr.current)} <${TrendCell} tr=${riskTr} unit=${unit} />` : "pocos datos"} />
        <${Kpi} label="Reglas que van a superar su objetivo" value=${n0(warn.length)} sub=${rows.filter(r => r.target).length ? "de " + rows.filter(r => r.target).length + " con objetivo" : "Cargá objetivos en Configuración → Reglas"} />
        <${Kpi} label="Conductores con riesgo en aumento" value=${n0(rising)} sub="tendencia de más de 15% por período" />
      </div>
      <${DataTable} rowKey=${r => r.id} rows=${rows} limit=${12} defaultSort=${{ key: "prio", dir: "desc" }} columns=${[
        { key: "name", label: "Regla", fmt: r => html`${r.name}<span className="tag">${GI.catLabel(r.cat)}</span>` },
        { key: "n", label: "Eventos", align: "num", title: "Click para verlos en MyGeotab",
          fmt: r => html`<button className="btn link" onClick=${() => openEvents(view, { ruleIds: [r.id], deviceIds: [...view.ids] })}>${n0(r.n)}</button>` },
        { key: "current", label: "Hoy /100 km", align: "num", fmt: r => n2(r.current) },
        { key: "target", label: "Objetivo", align: "num", fmt: r => (r.target != null ? n2(r.target) : html`<span className="muted">–</span>`) },
        { key: "trend", label: "Tendencia", value: r => (r.tr ? r.tr.slopePct : null), fmt: r => html`<${TrendCell} tr=${r.tr} unit=${unit} />` },
        { key: "proj", label: "En " + horizon + " " + GRAN_PLURAL[view.gran], align: "num", fmt: r => n2(r.proj) },
        { key: "prio", label: "Estado", value: r => ({ "va a superar": 4, "sobre y subiendo": 5, "sobre, bajando": 3, "dentro": 1, "sin objetivo": 2 })[r.status] * 1e6 + r.n, fmt: statusCell },
      ]} empty="No hay reglas de riesgo mapeadas. Asignalas en Configuración → Reglas." />
    <//>`;
  }

  function SafetyTab({ view, onVehicle, onDriver }) {
    const [catDetail, setCatDetail] = useState(null);
    const slotIdx = k => (GI.CHART_SLOTS.includes(k) ? GI.CHART_SLOTS.indexOf(k) : 99);
    const riskCats = GI.CATEGORIES.filter(c => c.kind === "riesgo" && view.series.some(s => (s.evByCat[c.key] || 0) > 0))
      .sort((a, b) => slotIdx(a.key) - slotIdx(b.key));
    const total = view.total;
    const unit = GRAN_WORD[view.gran];
    const ruleRows = riskRuleRows(view);
    const catRows = riskCats.map(c => {
      const n = total.evByCat[c.key] || 0;
      const w = n * (view.settings.category_weights[c.key] || 0);
      const tr = halves(view, s => (s.evByCat[c.key] || 0) * 100, s => s.km);
      return { key: c.key, label: c.label, n, per100: total.km ? (n / total.km) * 100 : null,
        share: total.weighted ? (w / total.weighted) * 100 : 0, trend: tr.ch };
    });
    const driverTrends = useMemo(() => driverTrendMap(view), [view]);
    const minKm = view.settings.drivers.min_km_ranking;
    const drivers = view.dRows.filter(r => !r.unknown && r.km >= minKm).map(r => ({ ...r, tr: (driverTrends.get(r.id) || {}).tr }));
    const risingDrivers = drivers.filter(d => d.tr && d.tr.slopePct > 15 && d.tr.current > 0);
    if (!GI.riskRuleIds(view.settings.rule_mapping).length) return html`<${Info} tone="warn">Todavía no hay reglas asignadas a categorías de riesgo, así que no hay infracciones para analizar. Un administrador las asigna en Configuración → Reglas y objetivos.<//>`;
    return html`<div>
      <${EventsEvolution} view=${view} riskCats=${riskCats} />
      <${ForecastPanel} view=${view} driverTrends=${driverTrends} />
      <div className="grid-2">
        <${Panel} title="Qué infracciones pesan más" hint="'% del riesgo' es cuánto aporta cada categoría al índice (cantidad × peso). Click en una categoría para ver qué conductores la generan; click en el número de eventos para verlos en MyGeotab.">
          <${DataTable} rowKey=${r => r.key} rows=${catRows} defaultSort=${{ key: "share", dir: "desc" }} onRowClick=${r => setCatDetail(r.key)} columns=${[
            { key: "label", label: "Categoría", fmt: r => html`<span className="dot" style=${{ background: GI.CHART_SLOTS.includes(r.key) ? GI.catColor(r.key) : GI.OTHER_COLOR }}></span>${r.label}` },
            { key: "n", label: "Eventos", align: "num",
              fmt: r => html`<button className="btn link" title="Ver estos eventos en MyGeotab" onClick=${e => { e.stopPropagation(); openEvents(view, { ruleIds: ruleRows.filter(x => x.cat === r.key).map(x => x.id), deviceIds: [...view.ids] }); }}>${n0(r.n)}</button>` },
            { key: "per100", label: "Cada 100 km", align: "num", fmt: r => n2(r.per100) },
            { key: "share", label: "% del riesgo", align: "num", fmt: r => n0(r.share) + "%" },
            { key: "trend", label: "Tendencia", align: "num", fmt: r => html`<${Delta} value=${r.trend} goodWhenDown />` },
          ]} />
        <//>
        <${Panel} title="Conductores con más infracciones por km" hint=${"Índice de riesgo de cada conductor con al menos " + minKm + " km. La tendencia es la pendiente de su índice en los últimos " + GRAN_PLURAL[view.gran] + ". Click para ver el detalle."}>
          <${DataTable} rowKey=${r => r.id} rows=${drivers} limit=${10} onRowClick=${r => onDriver(r.id)} defaultSort=${{ key: "risk", dir: "desc" }} columns=${[
            { key: "name", label: "Conductor" },
            { key: "km", label: "Km", align: "num", fmt: r => n0(r.km) },
            { key: "events", label: "Infracciones", align: "num" },
            { key: "risk", label: "Riesgo", align: "num", fmt: r => n2(r.risk), title: "Puntos cada 100 km" },
            { key: "trend", label: "Tendencia", value: r => (r.tr ? r.tr.slopePct : null), fmt: r => html`<${TrendCell} tr=${r.tr} unit=${unit} />` },
          ]} empty="No hay conductores identificados con suficientes km." />
        <//>
      </div>
      <div className="grid-2">
        <${Panel} title="Conductores con riesgo en aumento" hint="Alerta temprana: conductores cuyo índice de riesgo viene subiendo más de 15% por período. Conviene intervenir antes de que lleguen al tope del ranking.">
          <${DataTable} rowKey=${r => r.id} rows=${risingDrivers} limit=${10} onRowClick=${r => onDriver(r.id)} defaultSort=${{ key: "proj", dir: "desc" }} columns=${[
            { key: "name", label: "Conductor" },
            { key: "now", label: "Hoy", align: "num", value: r => r.tr.current, fmt: r => n2(r.tr.current) },
            { key: "proj", label: "Proyectado", align: "num", value: r => r.tr.at(view.gran === "day" ? 14 : view.gran === "week" ? 4 : 2), fmt: r => n2(r.tr.at(view.gran === "day" ? 14 : view.gran === "week" ? 4 : 2)) },
            { key: "trend", label: "Tendencia", value: r => r.tr.slopePct, fmt: r => html`<${TrendCell} tr=${r.tr} unit=${unit} />` },
          ]} empty="Ningún conductor muestra una tendencia de aumento clara." />
        <//>
        <${Panel} title="Vehículos con más infracciones por km" hint="Índice de riesgo de cada vehículo con al menos 100 km en el período. Click para ver el detalle.">
          <${DataTable} rowKey=${r => r.id} rows=${view.vRows.filter(r => r.km >= 100)} limit=${10} onRowClick=${r => onVehicle(r.id)}
            defaultSort=${{ key: "risk", dir: "desc" }} columns=${[
            { key: "name", label: "Vehículo" },
            { key: "profile", label: "Perfil", fmt: r => GI.profileLabel(view.settings, r.profile) },
            { key: "km", label: "Km", align: "num", fmt: r => n0(r.km) },
            { key: "events", label: "Infracciones", align: "num" },
            { key: "risk", label: "Riesgo", align: "num", fmt: r => html`<${TargetCell} value=${r.risk} max=${r.riskMax} fmt=${n2} />` },
          ]} />
        <//>
      </div>
      ${catDetail ? html`<${CategoryDetail} view=${view} cat=${catDetail} onClose=${() => setCatDetail(null)} onDriver=${id => { setCatDetail(null); onDriver(id); }} />` : null}
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
    const price = view.model.hasPrice;
    const unknown = view.dRows.find(r => r.unknown);
    const totalKm = GI.sum(view.dRows, r => r.km);
    const coverage = totalKm ? 100 - ((unknown ? unknown.km : 0) / totalKm) * 100 : null;
    const known = view.dRows.filter(r => !r.unknown);
    const rows = known.filter(r => r.km >= minKm && (!svc || r.stype === svc));
    return html`<div>
      <div className="readouts">
        <${Kpi} label="Km con conductor identificado" value=${GI.fmtPct(coverage, 0)} tone=${coverage != null && coverage < 80 ? "" : ""}
          sub=${coverage != null && coverage < 80 ? "Bajo: el ranking no refleja toda la operación" : "Buena cobertura"}
          hint="Viajes donde el conductor se identificó (llave, login o asignación). Los eventos sin conductor se asignan al conductor del viaje en curso cuando es posible." />
        <${Kpi} label="Conductores en el ranking" value=${n0(rows.length)} sub=${"de " + known.length + " con actividad (mín. " + minKm + " km)"} />
        <${Kpi} label="Sin identificar" value=${n0(unknown ? unknown.km : 0)} unit="km" sub=${(unknown ? n0(unknown.events) : 0) + " infracciones sin conductor"} />
      </div>
      <${Panel} title=${mode === "risk" ? "Conductores con más infracciones por km" : "Conductores con más ralentí"}
        hint=${"Solo conductores con al menos " + minKm + " km, para que pocos km no distorsionen el índice. Filtrá por servicio para comparar corta con corta y larga con larga."}
        actions=${html`
          <${Segmented} value=${mode} onChange=${setMode} options=${[{ value: "risk", label: "Más riesgosos" }, { value: "idleH", label: "Más ralentí" }]} />
          <select value=${svc} onChange=${e => setSvc(e.target.value)} aria-label="Servicio">
            <option value="">Todo servicio</option><option value="corta">Corta distancia</option><option value="larga">Larga distancia</option>
          </select>
          <label className="inline">Km mínimos <input type="number" className="num-in" value=${minKm} onChange=${e => setMinKm(+e.target.value || 0)} /></label>`}>
        <${DataTable} rowKey=${r => r.id} rows=${rows} limit=${20} onRowClick=${r => onDriver(r.id)}
          defaultSort=${{ key: mode, dir: "desc" }} columns=${[
          { key: "name", label: "Conductor" },
          { key: "stype", label: "Servicio", fmt: r => GI.stypeLabel(r.stype) },
          { key: "km", label: "Km", align: "num", fmt: r => n0(r.km) },
          { key: "risk", label: "Riesgo", align: "num", fmt: r => n2(r.risk), title: "Puntos cada 100 km" },
          { key: "events", label: "Infracciones", align: "num" },
          { key: "top", label: "Más frecuente", value: r => topCat(r.evByCat, view.settings), fmt: r => topCat(r.evByCat, view.settings) },
          { key: "idleH", label: "Ralentí", align: "num", fmt: r => html`${n1(r.idleH)} h <span className="muted small">${GI.fmtPct(r.idlePct)}</span>` },
          { key: "idleL", label: "Litros ralentí", align: "num", fmt: r => html`${n0(r.idleL)}${price ? html` <span className="muted small">${GI.fmtMoney(r.idleCost)}</span>` : ""}` },
        ]} empty="Ningún conductor identificado llega a esos km mínimos. Bajá el mínimo o ampliá el período." />
      <//>
    </div>`;
  }

  // ======================= RECORRIDOS =======================
  // Mezcla de tipos de infracción: punto de color + nombre + cantidad.
  function CatMix({ cats, max }) {
    if (!cats || !cats.length) return html`<span className="muted">—</span>`;
    const shown = max ? cats.slice(0, max) : cats;
    const rest = cats.length - shown.length;
    const all = cats.map(c => GI.catLabel(c.cat) + ": " + n0(c.n)).join(" · ");
    return html`<span className="catmix" title=${all}>${shown.map(c => html`<span key=${c.cat} className="catmix-i">
        <span className="dot" style=${{ background: GI.catColor(c.cat) }}></span>${GI.catLabel(c.cat)} <b>${n0(c.n)}</b></span>`)}
      ${rest > 0 ? html`<span className="muted small">+${rest} más</span>` : null}</span>`;
  }

  function RoutesTab({ view, api }) {
    const s = view.settings.journeys;
    const [showNoZone, setShowNoZone] = useState(false);
    const [route, setRoute] = useState(null);
    const rows = view.rRows.filter(r => r.n >= s.min_journeys_route && r.km >= s.min_km_route && (showNoZone || !r.noZone));
    return html`<div>
      ${view.model.cat.zones == null ? html`<${Info}>Cargando las zonas del área recorrida para armar los recorridos…<//>` : null}
      ${view.model.cat.zones && !view.model.cat.zones.length ? html`<${Info} tone="warn">No hay zonas en el área recorrida, así que no se pueden armar recorridos de origen a destino. Cargá las zonas de depósitos, clientes y puertos en MyGeotab.<//>` : null}
      <${Panel} title="Recorridos con más infracciones por km"
        hint=${"Un recorrido va desde que el vehículo sale de una zona hasta que llega a otra (o hace una parada de más de " + s.break_hours + " h). Se muestran los que tienen al menos " + s.min_journeys_route + " recorridos y " + s.min_km_route + " km acumulados; se ajusta en Configuración → General."}
        actions=${html`<label className="inline"><input type="checkbox" checked=${showNoZone} onChange=${e => setShowNoZone(e.target.checked)} /> Incluir recorridos que empiezan o terminan fuera de una zona</label>`}>
        <${DataTable} rowKey=${r => r.key} rows=${rows} limit=${15} defaultSort=${{ key: "risk", dir: "desc" }}
          onRowClick=${r => setRoute(route && route.key === r.key ? null : r)} rowClass=${r => (route && route.key === r.key ? "selected" : "")} columns=${[
          { key: "from", label: "Origen" },
          { key: "to", label: "Destino" },
          { key: "n", label: "Recorridos", align: "num" },
          { key: "avgKm", label: "Km promedio", align: "num", fmt: r => n0(r.avgKm) },
          { key: "devices", label: "Vehículos", align: "num" },
          { key: "nEv", label: "Infracciones", align: "num" },
          { key: "cats", label: "Tipos de infracción", value: r => (r.cats[0] ? r.cats[0].n : null),
            title: "Qué infracciones hubo en este recorrido (cantidad), de la más frecuente a la menos",
            fmt: r => html`<${CatMix} cats=${r.cats} max=${3} />` },
          { key: "risk", label: "Riesgo", align: "num", fmt: r => n2(r.risk), title: "Puntos cada 100 km" },
          { key: "idlePct", label: "Ralentí", align: "num", fmt: r => GI.fmtPct(r.idlePct) },
        ]} empty="Ningún recorrido llega a los mínimos. Ampliá el período o bajá los mínimos en Configuración → General." />
      <//>
      <${HeatmapPanel} view=${view} api=${api} route=${route} onClearRoute=${() => setRoute(null)} />
    </div>`;
  }

  // Mapa de calor: se ubica cada evento (LogRecord más cercano) solo al
  // pedirlo, con un tope configurable, y el mapa se va dibujando a medida que
  // llegan los lotes. Las ubicaciones quedan guardadas en el navegador.
  const HEAT_LIMITS = [250, 500, 1000, 2000, 5000];

  function HeatmapPanel({ view, api, route, onClearRoute }) {
    const [cat, setCat] = useState("");
    const [limit, setLimit] = useState(500);
    const [progress, setProgress] = useState(null);
    const [points, setPoints] = useState(null);
    const [err, setErr] = useState(null);
    const mapRef = React.useRef(null);
    const mapObj = React.useRef(null);
    const runRef = React.useRef(0);
    const inRoute = e => !route || (e.j && !e.j.internal && e.j.o + "→" + e.j.dest === route.key);
    const evs = view.events.filter(e => e.w > 0 && (!cat || e.cat === cat) && inRoute(e));
    const sample = [...evs].sort((a, b) => b.t - a.t).slice(0, limit);

    const toPoints = locs => sample.map(e => (locs.get(e.i) ? [...locs.get(e.i), e.w] : null)).filter(Boolean);
    async function load() {
      const id = ++runRef.current;
      setErr(null); setProgress(0); setPoints([]);
      try {
        let last = 0;
        const locs = await GI.loadEventLocations(api, sample, (p, partial) => {
          if (id !== runRef.current) return;
          setProgress(p);
          // Redibuja como máximo cada 10% para no trabar la página.
          if (p - last >= 0.1 || p === 1) { last = p; setPoints(toPoints(partial)); }
        });
        if (id === runRef.current) setPoints(toPoints(locs));
      } catch (e) { setErr("No se pudieron ubicar los eventos: " + (e.message || e)); }
      if (id === runRef.current) setProgress(null);
    }
    useEffect(() => { runRef.current++; setPoints(null); setProgress(null); }, [cat, limit, view, route && route.key]);
    useEffect(() => {
      if (!points || !mapRef.current) return;
      if (!mapObj.current) {
        mapObj.current = L.map(mapRef.current);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(mapObj.current);
        mapObj.current._fitted = false;
      }
      const m = mapObj.current;
      if (m._heat) m.removeLayer(m._heat);
      m._heat = L.heatLayer(points, { radius: 14, blur: 18, maxZoom: 12, max: 2 }).addTo(m);
      if (points.length && (!m._fitted || progress == null)) { m.fitBounds(L.latLngBounds(points.map(p => [p[0], p[1]])), { padding: [20, 20] }); m._fitted = true; }
      else if (!points.length) m.setView([-34.6, -58.4], 5);
      setTimeout(() => m.invalidateSize(), 0);
    }, [points]);

    const cats = GI.CATEGORIES.filter(c => c.kind === "riesgo" && view.events.some(e => e.cat === c.key));
    return html`<${Panel} title="Dónde ocurren las infracciones"
      hint="Cada evento se ubica buscando la posición GPS más cercana a su hora. Es la parte más lenta: por eso se limita a los eventos más recientes y las ubicaciones ya buscadas quedan guardadas en este navegador (la segunda vez es instantáneo)."
      actions=${html`<select value=${cat} onChange=${e => setCat(e.target.value)} aria-label="Categoría">
          <option value="">Todas las categorías</option>${cats.map(c => html`<option key=${c.key} value=${c.key}>${c.label}</option>`)}
        </select>
        <select value=${limit} onChange=${e => setLimit(+e.target.value)} aria-label="Cantidad de eventos">
          ${HEAT_LIMITS.map(n => html`<option key=${n} value=${n}>Últimos ${n0(n)} eventos</option>`)}
        </select>
        <button className="btn primary" disabled=${progress != null || !sample.length} onClick=${load}>${points ? "Actualizar mapa" : "Mostrar mapa"}</button>`}>
      ${route ? html`<div className="filterbar inset" role="status"><span>Solo el recorrido:</span>
        <span className="fchip">${route.from} → ${route.to}<button aria-label="Quitar recorrido" onClick=${onClearRoute}>×</button></span>
        <span className="muted">${n0(evs.length)} infracciones en ${n0(route.n)} recorridos</span>
        ${route.cats && route.cats.length ? html`<${CatMix} cats=${route.cats} />` : null}</div>` : html`<p className="muted small" style=${{ margin: "0 0 10px" }}>Tip: hacé click en un recorrido de la tabla de arriba para ver solo sus infracciones en el mapa.</p>`}
      ${progress != null ? html`<${GI.Progress} value=${progress} label=${"Ubicando " + n0(sample.length) + " eventos"} />` : null}
      ${err ? html`<${Info} tone="error">${err}<//>` : null}
      <div ref=${mapRef} className=${"map" + (points ? "" : " hidden")}></div>
      ${!points && progress == null ? html`<div className="empty">${sample.length
        ? "Se van a ubicar los " + n0(sample.length) + " eventos más recientes" + (evs.length > sample.length ? " de " + n0(evs.length) : "") + ". Para ver un patrón alcanza con 500; más eventos tardan más la primera vez."
        : "No hay infracciones en este período."}</div>` : null}
    <//>`;
  }

  // ======================= DETALLES =======================
  function smallLine(s, key, label, unit, dec) {
    return { type: "line", data: { labels: s.map(x => x.label), datasets: [{ label, data: s.map(x => (x[key] == null ? null : GI.round(x[key], dec))),
      borderColor: "#2a78d6", backgroundColor: "#2a78d61f", fill: true, tension: 0.3, spanGaps: true }] },
      options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, title: { display: true, text: unit } } } } };
  }

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
    const evRows = Object.entries(r.evByCat).filter(([k]) => (GI.CATEGORY_BY_KEY[k] || {}).kind === "riesgo").map(([k, n]) => ({ k, n }));
    return html`<${Modal} title=${r.name} onClose=${onClose} wide>
      <p className="muted" style=${{ marginBottom: "12px" }}>${GI.profileLabel(view.settings, r.profile)}. Servicio ${r.serviceSource === "grupo" ? "asignado por grupo" : r.serviceSource}. Referencia de consumo: ${r.refSource}.</p>
      <div className="readouts compact">
        <${Kpi} label="Km" value=${n0(r.km)} />
        <${Kpi} label="Consumo" value=${r.fuelMeasured ? n1(r.l100) : "sin dato"} unit=${r.fuelMeasured ? "L/100 km" : null} sub=${"referencia " + n1(r.refL100)} />
        <${Kpi} label="Ralentí" value=${GI.fmtPct(r.idlePct)} sub=${html`<${TargetCell} value=${r.idlePct} max=${r.idleMax} fmt=${v => GI.fmtPct(v)} />`} />
        <${Kpi} label="Litros en ralentí" value=${n0(r.idleL)} unit="L" sub=${r.idleMeasured ? "medido" : "estimado por horas"} />
        <${Kpi} label="Riesgo" value=${n2(r.risk)} unit="pts/100 km" sub=${html`<${TargetCell} value=${r.risk} max=${r.riskMax} fmt=${n2} />`} />
      </div>
      <div className="grid-2">
        <div><h3>Consumo</h3><${ChartView} height=${200} config=${smallLine(s, "l100", "Consumo", "L/100 km", 1)} /></div>
        <div><h3>Ralentí</h3><${ChartView} height=${200} config=${smallLine(s, "idlePct", "Ralentí", "% del tiempo", 1)} /></div>
        <div><h3>Infracciones cada 100 km</h3><${ChartView} height=${200} config=${smallLine(s, "risk", "Riesgo", "pts/100 km", 2)} /></div>
        <div><h3>Por categoría</h3><${DataTable} rows=${evRows} rowKey=${x => x.k} defaultSort=${{ key: "n", dir: "desc" }} empty="Sin infracciones en el período." columns=${[
          { key: "k", label: "Categoría", fmt: x => GI.catLabel(x.k) }, { key: "n", label: "Eventos", align: "num" }]} /></div>
      </div>
      <h3>Quién lo manejó</h3>
      <${DataTable} rows=${drivers} rowKey=${x => x.name} defaultSort=${{ key: "km", dir: "desc" }} columns=${[
        { key: "name", label: "Conductor" }, { key: "km", label: "Km", align: "num", fmt: x => n0(x.km) }, { key: "n", label: "Infracciones", align: "num" }]} />
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
      return [...buckets.values()].map(b => ({ ...b, risk: b.km > 0 ? (b.w / b.km) * 100 : null, idlePct: b.dh + b.ih > 0 ? (b.ih / (b.dh + b.ih)) * 100 : null }));
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
    const evRows = Object.entries(r.evByCat).filter(([k]) => (GI.CATEGORY_BY_KEY[k] || {}).kind === "riesgo").map(([k, n]) => ({ k, n }));
    return html`<${Modal} title=${r.name} onClose=${onClose} wide>
      <div className="readouts compact">
        <${Kpi} label="Km" value=${n0(r.km)} />
        <${Kpi} label="Riesgo" value=${n2(r.risk)} unit="pts/100 km" />
        <${Kpi} label="Infracciones" value=${n0(r.events)} />
        <${Kpi} label="Ralentí" value=${n1(r.idleH)} unit="h" sub=${GI.fmtPct(r.idlePct) + " del tiempo"} />
        <${Kpi} label="Litros en ralentí" value=${n0(r.idleL)} unit="L" />
      </div>
      <div className="grid-2">
        <div><h3>Infracciones cada 100 km</h3><${ChartView} height=${200} config=${smallLine(s, "risk", "Riesgo", "pts/100 km", 2)} /></div>
        <div><h3>Ralentí</h3><${ChartView} height=${200} config=${smallLine(s, "idlePct", "Ralentí", "% del tiempo", 1)} /></div>
        <div><h3>Por categoría</h3><${DataTable} rows=${evRows} rowKey=${x => x.k} defaultSort=${{ key: "n", dir: "desc" }} empty="Sin infracciones en el período."
          columns=${[{ key: "k", label: "Categoría", fmt: x => GI.catLabel(x.k) }, { key: "n", label: "Eventos", align: "num" }]} /></div>
        <div><h3>Vehículos que manejó</h3><${DataTable} rows=${vehicles} rowKey=${x => x.name} defaultSort=${{ key: "km", dir: "desc" }} columns=${[
          { key: "name", label: "Vehículo" }, { key: "km", label: "Km", align: "num", fmt: x => n0(x.km) }, { key: "n", label: "Infracciones", align: "num" }]} /></div>
      </div>
    <//>`;
  }

  Object.assign(GI, { SummaryTab, FuelTab, SafetyTab, DriversTab, RoutesTab, VehicleDetail, DriverDetail, TrendChart, METRICS, TargetCell });
})(window.GI);
