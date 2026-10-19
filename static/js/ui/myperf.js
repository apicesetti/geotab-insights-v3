// "Mi desempeño": lo único que ve un conductor. Sus propios datos comparados
// con los valores de referencia de la empresa (promedios sin nombres que
// publica un administrador). Nunca muestra a otros conductores.
(function (GI) {
  "use strict";
  const React = GI.React;
  const { useMemo, useState } = React;
  const html = GI.html;
  const { Kpi, Panel, Info, DataTable, ChartView, Segmented } = GI;
  const n0 = v => GI.fmtNum(v, 0), n1 = v => GI.fmtNum(v, 1), n2 = v => GI.fmtNum(v, 2);
  const fx = f => (f == null ? "–" : "×" + GI.fmtNum(f, 1));

  function MyPerformanceTab({ view }) {
    const [sec, setSec] = useState("resumen");
    const { model, ids, me, benchmark: b } = view;
    const data = useMemo(() => {
      const own = id => id === me.id;
      const rf = GI.riskFactors(model, ids, own, new Map(((b && b.routes) || []).map(r => [r.key, r.idx])), b ? b.fleetIdx : null);
      const fat = rf.fatigue.drivers.find(x => x.id === me.id) || null;
      const row = b ? { ...GI.driverVsBenchmark(model, ids, me.id, b), maxStint: fat ? fat.maxStint : 0, longStints: fat ? fat.longStints : 0 } : null;
      // Totales del conductor (sus celdas): km, horas, infracciones por categoría, ralentí.
      const cells = model.drvCells.get(me.id) || new Map();
      const tot = { km: 0, dh: 0, ih: 0, n: 0, w: 0, ev: {} };
      const byBucket = new Map();
      for (const [ck, c] of cells) {
        const dk = ck.split("|")[1];
        tot.km += c.km; tot.dh += c.dh; tot.ih += c.ih; tot.n += c.n; tot.w += c.w;
        for (const k in c.ev) tot.ev[k] = (tot.ev[k] || 0) + c.ev[k];
        const bk = GI.bucketKey(dk, view.gran);
        const x = byBucket.get(bk) || { key: bk, km: 0, w: 0, n: 0 };
        x.km += c.km; x.w += c.w; x.n += c.n; byBucket.set(bk, x);
      }
      const series = [...new Set(model.dayKeys.map(dk => GI.bucketKey(dk, view.gran)))].map(bk => {
        const x = byBucket.get(bk) || { key: bk, km: 0, w: 0, n: 0 };
        return { ...x, label: GI.bucketLabel(bk, view.gran), risk: x.km >= 30 ? (x.w / x.km) * 100 : null };
      });
      return { rf, fat, row, tot, series };
    }, [view]);
    const { fat, row, tot, series } = data;
    const risk = tot.km > 0 ? (tot.w / tot.km) * 100 : null;
    const idlePct = tot.dh + tot.ih > 0 ? (tot.ih / (tot.dh + tot.ih)) * 100 : null;

    if (!tot.km) return html`<${Info}>No hay viajes a tu nombre en el período elegido. Si manejaste, revisá que tu llave o tarjeta de identificación esté asignada en MyGeotab.<//>`;
    const cats = Object.entries(tot.ev).filter(([k]) => (GI.CATEGORY_BY_KEY[k] || {}).kind === "riesgo")
      .map(([k, n]) => ({ k, n, mine: (n / tot.km) * 100, fleet: b && b.byCat ? b.byCat[k] : null }))
      .map(x => ({ ...x, factor: x.fleet ? x.mine / x.fleet : null }));
    return html`<div>
      ${!b ? html`<${Info} tone="warn">Todavía no hay valores de referencia de la empresa, así que no podemos compararte con el promedio. Un administrador los publica en Configuración → Conductores y referencias.<//>`
        : html`<p className="muted small" style=${{ margin: "0 0 10px" }}>Te comparamos con el promedio de la empresa (${n0(b.vehicles)} vehículos, del ${b.from} al ${b.to}). Solo ves tus propios datos.</p>`}
      <div className="readouts">
        <${Kpi} label="Km recorridos" value=${n0(tot.km)} sub=${html`<span>${n1(tot.dh)} h de manejo</span>`} />
        <${Kpi} label="Mi índice de riesgo" value=${n2(risk)} unit="pts/100 km"
          sub=${html`<span>${b ? "empresa: " + n2(b.fleetIdx) + " (" + fx(risk / b.fleetIdx) + ")" : "–"}</span>`}
          hint="Suma de tus infracciones (cada una por el peso de su categoría) cada 100 km. El ralentí no cuenta." />
        <${Kpi} label="Infracciones" value=${n0(tot.n)} sub=${html`<span>${n2((tot.n / tot.km) * 100)} cada 100 km</span>`} />
        <${Kpi} label="Ralentí" value=${GI.fmtPct(idlePct)} unit="del tiempo" sub=${html`<span>${b && b.idlePct != null ? "empresa: " + GI.fmtPct(b.idlePct) : "–"}</span>`} />
        ${fat ? html`<${Kpi} label="Fatiga" value=${fat.level === "alta" ? "Alta" : fat.level === "media" ? "Media" : "Baja"} sub=${html`<span>${fat.flags} de 5 límites superados</span>`} />` : null}
      </div>
      <div className="subnav"><${Segmented} value=${sec} onChange=${setSec} options=${[
        { value: "resumen", label: "Resumen" }, { value: "exposicion", label: "Horarios y tramos" }, { value: "fatiga", label: "Jornada y fatiga" }]} /></div>
      ${sec === "resumen" ? html`
        <${Panel} title="Mi evolución" hint="Tu índice de riesgo en cada período (los períodos con menos de 30 km quedan vacíos). La línea punteada es el promedio de la empresa.">
          <${ChartView} height=${240} config=${{
            type: "line",
            data: { labels: series.map(s => s.label), datasets: [
              { label: "Mi riesgo", data: series.map(s => (s.risk == null ? null : GI.round(s.risk, 2))), borderColor: "#2a78d6", backgroundColor: "#2a78d61f", fill: true, tension: 0.3, spanGaps: true },
              ...(b ? [{ label: "Empresa", data: series.map(() => GI.round(b.fleetIdx, 2)), borderColor: "#9a9893", borderDash: [6, 4], pointRadius: 0, fill: false }] : []),
            ] },
            options: { plugins: { legend: { display: !!b } }, scales: { y: { beginAtZero: true, title: { display: true, text: "pts/100 km" } } } },
          }} />
        <//>
        <${Panel} title="Mis infracciones por tipo" hint="Tus infracciones cada 100 km de cada categoría comparadas con el promedio de la empresa. Por encima de ×1, tenés más que el promedio.">
          <${DataTable} rowKey=${r => r.k} rows=${cats} defaultSort=${{ key: "n", dir: "desc" }} columns=${[
            { key: "k", label: "Categoría", value: r => GI.catLabel(r.k), fmt: r => html`<span className="dot" style=${{ background: GI.catColor(r.k) }}></span>${GI.catLabel(r.k)}` },
            { key: "n", label: "Eventos", align: "num" },
            { key: "mine", label: "Cada 100 km", align: "num", fmt: r => n2(r.mine) },
            { key: "fleet", label: "Empresa", align: "num", help: "Promedio de la empresa: infracciones de esa categoría cada 100 km.", fmt: r => (r.fleet == null ? "–" : n2(r.fleet)) },
            { key: "factor", label: "Vs empresa", align: "num", help: "Tus infracciones cada 100 km ÷ las de la empresa. ×1 = igual al promedio.",
              fmt: r => (r.factor == null ? "–" : html`<span className=${"delta " + (r.factor >= 1.3 ? "bad" : r.factor <= 0.8 ? "good" : "flat")}>${fx(r.factor)}</span>`) },
          ]} empty="No tenés infracciones en el período." />
        <//>`
      : sec === "exposicion" ? (b && row ? html`<${Panel} title="Mis horarios y tramos" hint="Cuándo y por dónde manejás, y cómo te va comparado con la empresa en esos mismos horarios y tramos.">
          <${GI.ExposureDetail} inline view=${view} ex=${GI.benchAsExposure(b)} row=${row} onClose=${() => {}} />
        <//>` : html`<${Info}>Se necesita que un administrador publique los valores de referencia para comparar tus horarios y tramos.<//>`)
      : fat ? html`<${Panel} title="Mi jornada y descanso" hint="Tus horas de manejo, jornadas y descansos, y si tus infracciones aumentan con las horas trabajadas.">
          <${GI.FatigueDetail} inline view=${view} d=${fat} limits=${data.rf.fatigue.limits} onClose=${() => {}} />
        <//>` : html`<${Info}>No hay suficientes jornadas a tu nombre en el período.<//>`}
    </div>`;
  }

  Object.assign(GI, { MyPerformanceTab });
})(window.GI);
