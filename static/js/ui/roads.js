// Pestaña "Corredores" (v2): riesgo del camino y conducta de la flota por
// tramo de ruta. Mapa + "dónde intervenir" + ruta en orden + franjas.
(function (GI) {
  "use strict";
  const React = GI.React;
  const { useState, useMemo, useEffect, useRef } = React;
  const html = GI.html;
  const { Kpi, Panel, Info, ChartView, Segmented } = GI;
  const n0 = v => GI.fmtNum(v, 0), n1 = v => GI.fmtNum(v, 1);
  const fx = v => (v == null ? "–" : "×" + n1(v));
  const pc = v => (v == null ? "–" : GI.fmtPct(v * 100, 0));
  const hh = h => String(h).padStart(2, "0");
  const catLabel = k => { const c = GI.CATEGORIES.find(x => x.key === k); return c ? c.label : k; };
  const EV_CAP = 4000;

  const LV = {
    ok: { label: "Bien", color: "#3f8f5f", bg: "#e3f0e8", fg: "#24603d" },
    at: { label: "Atención", color: "#e3a33b", bg: "#fbefd7", fg: "#6e4a05" },
    cr: { label: "Crítico", color: "#c63f2f", bg: "#c63f2f", fg: "#ffffff" },
    nd: { label: "Pocos datos", color: "#c9d1d9", bg: "#eef1f4", fg: "#4d5864" },
  };
  const pill = l => html`<span className="rd-pill" style=${{ background: LV[l].bg, color: LV[l].fg }}>${LV[l].label}</span>`;
  const FRANJA_OPTS = [{ value: "all", label: "Todo el día", h: null }, ...GI.ROAD_FRANJAS.map(f => ({ value: f.key, label: f.label, h: f.h }))];

  const levelOf = (x, lens) => (lens === "camino" ? x.envLevel : x.condLevel);
  const scoreOf = (x, lens) => (lens === "camino" ? x.envExcess : x.condExcess);

  // ---------- Frases ----------
  function envWhy(x) {
    const parts = [];
    parts.push(html`Quienes pasan por acá tienen <b>${fx(x.envIdx)}</b> frenadas, maniobras bruscas y conducción pegada de lo que esos mismos conductores tienen en otros lugares`);
    const worst = x.franjas.filter(f => f.envConf !== "baja").sort((a, b) => b.envIdx - a.envIdx)[0];
    if (worst && worst.envIdx >= 1.3) parts.push(html`, sobre todo <b>de ${worst.label}</b> (${fx(worst.envIdx)})`);
    parts.push(". ");
    const causes = [];
    if (x.cong != null && x.cong >= 0.12) causes.push(html`se circula <b>${pc(x.cong)} más lento</b> que con la ruta libre (tránsito)`);
    if (x.sgPer10 != null && x.sgPer10 >= 1) causes.push(html`hay <b>${n1(x.sgPer10)}</b> frenadas de anda y para cada 10 km`);
    if (x.sd != null && x.speed > 20 && x.sd / x.speed >= 0.25) causes.push(html`las velocidades están muy mezcladas (±${n0(x.sd)} km/h)`);
    if (x.darkPct != null && x.darkPct >= 0.5) causes.push(html`el ${pc(x.darkPct)} se recorre de noche`);
    if (causes.length) parts.push(html`Señales: ${causes.map((c, i) => html`${i ? (i === causes.length - 1 ? " y " : ", ") : ""}${c}`)}.`);
    return parts;
  }
  function envAction(x) {
    const worst = x.franjas.filter(f => f.envConf !== "baja").sort((a, b) => b.envIdx - a.envIdx)[0];
    if (worst && worst.envIdx >= 1.3) return "Evitar programar el paso por este tramo de " + worst.label + " y reforzar la distancia de seguimiento.";
    return "Reforzar manejo defensivo y distancia de seguimiento en este tramo.";
  }
  function condWhy(x, model) {
    const parts = [];
    if (x.condIdx != null) parts.push(html`Nuestros conductores tienen <b>${fx(x.condIdx)}</b> infracciones de conducta por km que en el resto de la red. `);
    if (x.overPct != null && x.overPct >= 0.03 && x.limit) parts.push(html`El <b>${pc(x.overPct)}</b> del tiempo se circula sobre el límite de ${x.limit} km/h. `);
    const cats = {};
    for (const d of x.drivers) for (const k in d.cats) cats[k] = (cats[k] || 0) + d.cats[k];
    const top = Object.entries(cats).sort((a, b) => b[1] - a[1])[0];
    if (top) parts.push(html`La más común: <b>${catLabel(top[0]).toLowerCase()}</b>. `);
    const named = x.drivers.filter(d => d.id !== "_unknown");
    const tot = named.reduce((s, d) => s + d.n, 0);
    if (named.length >= 4 && tot && named[0].n / tot < 0.35) parts.push(html`Las cometen ${n0(named.length)} conductores distintos: es el lugar, no una persona.`);
    else if (named[0] && tot && named[0].n / tot >= 0.5) parts.push(html`Se concentran en <b>${model.driverName.get(named[0].id) || "un conductor"}</b>.`);
    return parts;
  }
  function condAction(x, model) {
    const named = x.drivers.filter(d => d.id !== "_unknown");
    const tot = named.reduce((s, d) => s + d.n, 0);
    if (x.overPct != null && x.overPct >= 0.12) return "Regla de exceso de velocidad para este tramo (" + (x.limit || "límite") + " km/h) con aviso en cabina.";
    if (named[0] && tot && named[0].n / tot >= 0.5) return "Charla individual con " + (model.driverName.get(named[0].id) || "el conductor") + " sobre este tramo.";
    return "Capacitación sobre este tramo y seguimiento el próximo mes.";
  }

  function RoadsTab({ view, api, database }) {
    const [nDays, setNDays] = useState(14);
    const [franja, setFranja] = useState("all");
    const [lens, setLens] = useState("camino");
    const [route, setRoute] = useState("");
    const [sel, setSel] = useState(null);
    const [data, setData] = useState(null);
    const [progress, setProgress] = useState(null);
    const [err, setErr] = useState(null);
    const runRef = useRef(0);
    const dayKeys = useMemo(() => view.model.dayKeys.filter(dk => dk <= GI.dayKey(new Date())).slice(-nDays), [view.model.dayKeys, nDays]);
    const plan = useMemo(() => GI.roadPlan(view.model, view.ids), [view.model, view.ids]);
    useEffect(() => { runRef.current++; setData(null); setProgress(null); setSel(null); }, [nDays, view.model, plan.scopeKey]);

    async function load() {
      const id = ++runRef.current;
      const alive = () => id === runRef.current;
      setErr(null); setProgress({ p: 0, label: "Muestreando el GPS de la flota" });
      try {
        const days = await GI.loadRoadDays(api, database, dayKeys, p => alive() && setProgress({ p: p * 0.6, label: "Muestreando el GPS de la flota (" + dayKeys.length + " días)" }), plan);
        if (!alive()) return;
        const reps = new Map(), cellsKm = new Map();
        for (const v of days.values()) {
          for (const [c, p] of v.rep || []) if (!reps.has(c)) reps.set(c, p);
          for (const r of v.rows) cellsKm.set(r[1], (cellsKm.get(r[1]) || 0) + r[3]);
        }
        setProgress({ p: 0.6, label: "Identificando rutas y tramos (" + n0(reps.size) + " puntos)" });
        const [addr, zoneNames] = await Promise.all([
          GI.loadCellAddresses(api, database, reps, p => alive() && setProgress({ p: 0.6 + p * 0.15, label: "Identificando rutas y tramos" })),
          GI.loadZoneNames(api, database),
        ]);
        if (!alive()) return;
        let names = zoneNames;
        const missingZone = [...addr.values()].some(a => a.zones.some(z => !names.has(z)));
        if (missingZone) names = await GI.loadZoneNames(api, database, true);
        const built = GI.buildTramos(cellsKm, addr, names, { zones: view.model.cat.zones || [], reps });
        const dset = new Set(dayKeys);
        const all = view.events.filter(e => e.w > 0 && view.ids.has(e.d) && dset.has(GI.dayKey(e.t))).sort((a, b) => a.t - b.t);
        const step = all.length / EV_CAP;
        const evs = step > 1 ? Array.from({ length: EV_CAP }, (_, k) => all[Math.floor(k * step)]) : all;
        setProgress({ p: 0.75, label: "Ubicando " + n0(evs.length) + " infracciones" });
        const locs = await GI.loadEventLocations(api, evs, p => alive() && setProgress({ p: 0.75 + p * 0.25, label: "Ubicando " + n0(evs.length) + " infracciones" }));
        if (!alive()) return;
        setData({ days, built, evs, locs, all, evScale: evs.length ? all.length / evs.length : 1, points: [...days.values()].reduce((s, v) => s + (v.points || 0), 0) });
      } catch (e) { if (alive()) setErr("No se pudo completar el análisis: " + (e.message || e)); }
      if (alive()) setProgress(null);
    }

    const fSel = FRANJA_OPTS.find(f => f.value === franja) || FRANJA_OPTS[0];
    const rm = useMemo(() => (data ? GI.roadModel(view.model, data.days, view.ids, data.built, data.evs, data.locs, { hours: fSel.h, evScale: data.evScale, allEvents: data.all }) : null), [data, view.ids, franja]);
    const routes = rm ? rm.routes.filter(r => !/^Urbano/.test(r.name)).slice(0, 25) : [];
    const curRoute = rm ? routes.find(r => r.name === route) || null : null;
    const pool = rm ? rm.tramos.filter(x => !curRoute || x.route === curRoute.name) : [];
    const ranked = pool.filter(x => ["cr", "at"].includes(levelOf(x, lens)) && scoreOf(x, lens) > 0).sort((a, b) => scoreOf(b, lens) - scoreOf(a, lens));
    const top = ranked.slice(0, 3);
    const selT = rm && sel ? rm.tramos.find(x => x.id === sel) : null;
    const counts = { cr: 0, at: 0, ok: 0, nd: 0 };
    for (const x of pool) counts[levelOf(x, lens)]++;
    const overAll = (() => { let o = 0, l = 0; for (const x of pool) if (x.overPct != null) { o += x.overPct * x.km; l += x.km; } return l ? o / l : null; })();
    const shownRoute = curRoute || routes[0] || null;

    return html`<div className="rd">
      <${Panel} title="Corredores"
        hint="Separa dos cosas: el RIESGO DEL CAMINO (lo que pasa alrededor: tránsito, frenadas y maniobras de otros, noche), medido comparando a cada conductor contra sí mismo; y la CONDUCTA DE LA FLOTA (excesos, celular, cinturón…) en cada tramo. Los tramos salen de la dirección de Geotab (GetAddresses): en ruta, la geocerca de control que los contiene; en zona urbana, la calle y la ciudad. Se muestrea el GPS de toda la flota (en flotas chicas, la mitad del tiempo; en grandes, 5 minutos de cada media hora u hora) y se guarda por día en este navegador."
        actions=${html`<select value=${nDays} onChange=${e => setNDays(+e.target.value)} aria-label="Días a analizar">
            ${[7, 14, 30].map(n => html`<option key=${n} value=${n}>Últimos ${n} días</option>`)}
          </select>
          <button className="btn primary" disabled=${progress != null || !dayKeys.length} onClick=${load}>${data ? "Actualizar" : "Analizar corredores"}</button>`}>
        ${progress ? html`<${GI.Progress} value=${progress.p} label=${progress.label} />` : null}
        ${err ? html`<${Info} tone="error">${err}<//>` : null}
        ${!data && !progress ? html`<div className="empty">Se van a analizar ${dayKeys.length} días. La primera vez lleva unos minutos (GPS de muestra, direcciones de Geotab y ubicación de las infracciones); después queda guardado.</div>` : null}
        ${rm ? html`<div className="rd-controls">
            <${Segmented} value=${lens} onChange=${v => { setLens(v); }} options=${[{ value: "camino", label: "Riesgo del camino" }, { value: "conducta", label: "Conducta de la flota" }]} />
            <div className="rd-chips" role="group" aria-label="Franja horaria">${FRANJA_OPTS.map(f => html`<button key=${f.value} className=${"rd-chip" + (franja === f.value ? " on" : "")} aria-pressed=${franja === f.value} onClick=${() => setFranja(f.value)}>${f.label}</button>`)}</div>
            <label className="inline small">Ruta <select value=${route} onChange=${e => { setRoute(e.target.value); setSel(null); }} aria-label="Ruta">
              <option value="">Todas</option>${routes.map(r => html`<option key=${r.name} value=${r.name}>${r.name} (${n0(r.kmDay)} km/día)</option>`)}
            </select></label>
          </div>
          <p className="muted small" style=${{ margin: "8px 0 0" }}>${lens === "camino"
            ? "Riesgo del camino: frenadas, aceleraciones y giros bruscos, conducción pegada y colisiones, comparados con lo que cada conductor tiene en otros lugares. Un conductor infractor no vuelve riesgosa una franja: se lo compara consigo mismo."
            : "Conducta de la flota: excesos, celular, cinturón, distracción y fatiga por km, frente al promedio de toda la red" + (rm.posted ? ", y tiempo sobre el límite de la vía (Geotab)." : ", y tiempo sobre el límite de la geocerca.")}</p>` : null}
      <//>

      ${rm ? html`<div className="readouts compact">
        <${Kpi} label="Tramos analizados" value=${n0(pool.length)} sub=${html`<span>${curRoute ? curRoute.name : n0(routes.length) + " rutas"}</span>`} />
        <${Kpi} label="Críticos" value=${n0(counts.cr)} tone=${counts.cr ? "bad" : ""} sub=${html`<span>${lens === "camino" ? "riesgo del camino ×1,5 o más" : "conducta ×1,6 o 25% sobre el límite"}</span>`} />
        <${Kpi} label="Atención" value=${n0(counts.at)} sub=${html`<span>${n0(counts.ok)} bien · ${n0(counts.nd)} con pocos datos</span>`} />
        ${lens === "camino"
          ? html`<${Kpi} label=${"Mejor franja" + (shownRoute ? " · " + shownRoute.name : "")} value=${shownRoute && shownRoute.best ? shownRoute.best.label : "–"} sub=${html`<span>${shownRoute && shownRoute.worst && shownRoute.best && shownRoute.worst.key !== shownRoute.best.key ? "la peor: " + shownRoute.worst.label + " (" + fx(shownRoute.worst.idx) + ")" : "sin diferencias claras"}</span>`} hint="Franja con menor riesgo del camino en la ruta, ponderada por km. Sale del entorno, no de quién maneja a esa hora." />`
          : html`<${Kpi} label="Tiempo sobre el límite" value=${pc(overAll)} sub=${html`<span>${rm.posted ? "límite de la vía según Geotab" : "límite de la geocerca"}</span>`} />`}
      </div>` : null}

      ${rm ? html`<div className="rd-main">
        <${RoadMap} rm=${rm} pool=${pool} lens=${lens} top=${top} sel=${sel} onPick=${setSel} />
        <section className="rd-side">
          <h2 className="rd-h2">Dónde intervenir</h2>
          ${top.length ? top.map((x, i) => html`<article key=${x.id} className="rd-card">
              <div className="rd-num" style=${{ background: LV[levelOf(x, lens)].color }}>${i + 1}</div>
              <div className="rd-card-body">
                <div className="rd-card-head"><h3>${x.name}</h3>${pill(levelOf(x, lens))}</div>
                <div className="muted small">${x.route || ""}${x.limit ? " · " + x.limit + " km/h" : ""} · ${n0(x.kmDay)} km/día de la flota</div>
                <p>${lens === "camino" ? envWhy(x) : condWhy(x, view.model)}</p>
                <p><b>Acción:</b> ${lens === "camino" ? envAction(x) : condAction(x, view.model)}</p>
                <div><button className="btn" onClick=${() => setSel(x.id)}>Ver ficha</button></div>
              </div>
            </article>`)
            : html`<div className="rd-card"><div className="rd-card-body"><p>${lens === "camino" ? "Ningún tramo con datos suficientes tiene riesgo del camino por encima de lo normal" : "Ningún tramo tiene conducta por encima de lo normal"}${fSel.h ? " en esta franja" : ""}.</p></div></div>`}
          ${ranked.length > 3 ? html`<p className="muted small">${ranked.length === 4 ? "1 tramo más" : n0(ranked.length - 3) + " tramos más"} en ${lens === "camino" ? "atención o críticos" : "atención o críticos"}: ${ranked.slice(3, 8).map((x, i) => html`${i ? ", " : ""}<a href="#" onClick=${e => { e.preventDefault(); setSel(x.id); }}>${x.name}</a>`)}${ranked.length > 8 ? "…" : ""}</p>` : null}
        </section>
      </div>` : null}

      ${selT ? html`<${TramoDetail} x=${selT} rm=${rm} lens=${lens} model=${view.model} onClose=${() => setSel(null)} />` : null}
      ${rm && shownRoute ? html`<${RouteView} r=${shownRoute} lens=${lens} sel=${sel} onPick=${setSel} explicit=${!!curRoute} nDays=${rm.nDays} />` : null}
      ${rm ? html`<p className="muted small">${n0(data.points)} puntos GPS de muestra · ${n0(rm.envEvents)} eventos de interacción y ${n0(data.all.length)} infracciones en el período${data.evScale > 1 ? " (se ubicó una muestra pareja de " + n0(data.evs.length) + ")" : ""} · velocidad libre = p85 del tramo · ${rm.posted ? "límites de la vía: GetPostedRoadSpeedsForDevice" : "límites: geocercas"}.</p>` : null}
    </div>`;
  }

  function RoadMap({ rm, pool, lens, top, sel, onPick }) {
    const ref = useRef(null), mapObj = useRef(null);
    useEffect(() => {
      if (!ref.current) return;
      if (!mapObj.current) {
        mapObj.current = L.map(ref.current, { preferCanvas: true });
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(mapObj.current);
        mapObj.current.on("zoomend", () => mapObj.current._redraw && mapObj.current._redraw());
      }
      const m = mapObj.current;
      const draw = () => {
        if (m._l) m.removeLayer(m._l);
        const z = m.getZoom ? m.getZoom() : 9;
        const layers = [];
        const lat0 = pool[0] ? pool[0].center[0] : -38.6;
        const cellPx = 1100 / ((156543.03 * Math.cos((lat0 * Math.PI) / 180)) / Math.pow(2, z));
        for (const x of pool) {
          const lv = levelOf(x, lens), col = LV[lv].color, on = x.id === sel;
          for (const c of x.cells) {
            const b = GI._road.cellBounds(c), ctr = GI._road.cellCenter(c);
            const st = { stroke: on, color: "#18212b", weight: 2, fillColor: col, fillOpacity: lv === "nd" ? 0.45 : 0.85 };
            const shp = cellPx >= 9 ? L.rectangle(b, st) : L.circleMarker(ctr, { ...st, radius: Math.max(3, cellPx / 2 + 1) });
            layers.push(shp.bindTooltip("<b>" + x.name + "</b><br>" + LV[lv].label + (lens === "camino" ? " · riesgo del camino " + fx(x.envIdx) : " · conducta " + fx(x.condIdx)), { sticky: true }).on("click", () => onPick(x.id)));
          }
        }
        top.forEach((x, i) => layers.push(L.marker(x.center, { icon: L.divIcon({ className: "rd-mk", html: "<span>" + (i + 1) + "</span>", iconSize: [26, 26] }) }).on("click", () => onPick(x.id))));
        m._l = L.featureGroup(layers).addTo(m);
      };
      m._redraw = draw;
      if (!m._fitted && pool.length) { m.fitBounds(L.latLngBounds(pool.map(x => x.center)), { padding: [30, 30] }); m._fitted = true; }
      draw();
      setTimeout(() => m.invalidateSize(), 0);
    }, [rm, pool.length, lens, sel, top.map(x => x.id).join()]);
    useEffect(() => {
      const m = mapObj.current, x = sel && rm.tramos.find(t => t.id === sel);
      if (m && x) m.fitBounds(L.latLngBounds(x.cells.map(c => GI._road.cellCenter(c))), { padding: [60, 60], maxZoom: 13 });
    }, [sel]);
    useEffect(() => () => { if (mapObj.current) { mapObj.current.remove(); mapObj.current = null; } }, []);
    return html`<section className="rd-mapbox">
      <div ref=${ref} className="map rd-map"></div>
      <div className="rd-legend">${["ok", "at", "cr", "nd"].map(l => html`<span key=${l}><i style=${{ background: LV[l].color }}></i>${LV[l].label}</span>`)}</div>
    </section>`;
  }

  function RouteView({ r, lens, sel, onPick, explicit, nDays }) {
    const total = r.tramos.reduce((s, x) => s + x.cells.length, 0) || 1;
    return html`<${Panel} title=${(explicit ? "" : "Ruta con más tránsito: ") + r.name}
      sub=${n0(r.tramos.length) + " tramos en el orden de la ruta · " + n0(r.kmDay) + " km por día de la flota"}
      hint="Cada bloque es un tramo, en el orden en que aparece sobre la ruta; el ancho es proporcional a su largo. Debajo, el riesgo del camino de cada tramo por franja horaria: sirve para decidir a qué hora conviene circular, porque no depende de qué conductores manejan a esa hora.">
      <div className="rd-strip" role="list">
        ${r.tramos.map(x => { const lv = levelOf(x, lens); return html`<button key=${x.id} role="listitem" className=${"rd-seg" + (sel === x.id ? " on" : "")} style=${{ flexGrow: x.cells.length, background: LV[lv].color }} title=${x.name + " · " + LV[lv].label} aria-label=${x.name + ": " + LV[lv].label} onClick=${() => onPick(x.id)}>${x.limit && x.cells.length / total > 0.04 ? x.limit : ""}</button>`; })}
      </div>
      ${!r.franjas.some(f => f.idx != null) ? html`<${Info} tone="warn">Con ${n0(nDays)} días todavía no hay suficientes frenadas, maniobras y eventos de distancia en ${r.name} para comparar franjas (hacen falta al menos 3 esperables por tramo y franja). Probá con 30 días; mientras tanto, cada celda muestra cuánto se circula.<//>` : null}
      ${r.best && r.worst && r.best.key !== r.worst.key ? html`<div className="verdict-line"><span className="vtag">Horario</span><span>En ${r.name} el riesgo del camino es menor de <b>${r.best.label}</b> (${fx(r.best.idx)}) y mayor de <b>${r.worst.label}</b> (${fx(r.worst.idx)}).</span></div>` : null}
      <div className="rd-matrix-wrap">
        <table className="rd-matrix">
          <thead><tr><th scope="col">Tramo</th><th scope="col">Límite</th>${GI.ROAD_FRANJAS.map(f => html`<th key=${f.key} scope="col">${f.label}</th>`)}<th scope="col">Conducta</th></tr></thead>
          <tbody><tr className="rd-total"><th scope="row">Toda la ruta</th><td></td>${r.franjas.map(f => { const lv = f.idx == null ? "nd" : f.idx >= 1.5 ? "cr" : f.idx >= 1.2 ? "at" : "ok"; return html`<td key=${f.key}><span className="rd-cell" title=${n0(f.km / nDays) + " km por día de la flota"} style=${{ background: LV[lv].bg, color: LV[lv].fg }}>${f.idx == null ? html`<span className="rd-nd">${f.km > 0 ? n0(f.km / nDays) + " km/día" : "sin tránsito"}</span>` : fx(f.idx)}</span></td>`; })}<td></td></tr>
          ${r.tramos.map(x => html`<tr key=${x.id} className=${sel === x.id ? "on" : ""} onClick=${() => onPick(x.id)}>
            <th scope="row"><a href="#" onClick=${e => { e.preventDefault(); onPick(x.id); }}>${x.name}</a></th>
            <td>${x.limit ? x.limit + " km/h" : "–"}</td>
            ${x.franjas.map(f => html`<td key=${f.key}><span className="rd-cell" title=${n0(f.km / nDays) + " km por día de la flota · " + n1(f.obs) + " eventos de interacción (esperables " + n1(f.exp) + ")"} style=${{ background: LV[f.envLevel].bg, color: LV[f.envLevel].fg }}>${f.envConf === "baja" ? html`<span className="rd-nd">${f.km > 0 ? n0(f.km / nDays) + " km/día" : "sin tránsito"}</span>` : fx(f.envIdx)}</span></td>`)}
            <td>${pill(x.condLevel)}</td>
          </tr>`)}</tbody>
        </table>
      </div>
    <//>`;
  }

  function TramoDetail({ x, rm, lens, model, onClose }) {
    const hours = x.byHour;
    return html`<${Panel} title=${x.name} sub=${(x.route || "") + (x.limit ? " · límite " + x.limit + " km/h" : "") + " · " + (x.kind === "geocerca" ? "geocerca de control" : x.kind === "urbano" ? "calle urbana" : "ruta sin geocerca")}
      actions=${html`<a className="btn" target="_blank" rel="noopener" href=${"https://www.google.com/maps?q=" + x.center[0].toFixed(5) + "," + x.center[1].toFixed(5)}>Google Maps</a><button className="btn" onClick=${onClose}>Cerrar</button>`}>
      <div className="readouts compact inset">
        <${Kpi} label="Riesgo del camino" value=${fx(x.envIdx)} tone=${x.envLevel === "cr" ? "bad" : ""} sub=${html`<span>${n1(x.obs)} eventos de interacción · esperables ${n1(x.exp)}</span>`} hint="Frenadas, aceleraciones y giros bruscos, distancia y colisiones, frente a lo que tendrían esos mismos conductores en otros lugares (×1 = igual que el resto de la red)." />
        <${Kpi} label="Conducta de la flota" value=${fx(x.condIdx)} tone=${x.condLevel === "cr" ? "bad" : ""} sub=${html`<span>${n0(x.condN)} infracciones · ${x.overPct != null ? pc(x.overPct) + " sobre el límite" : "sin dato de límite"}</span>`} />
        <${Kpi} label="Congestión" value=${x.cong == null ? "–" : pc(x.cong)} sub=${html`<span>${x.vmed != null ? n0(x.vmed) + " km/h vs " + n0(x.vfree) + " libre" : ""}${x.cls === "p" ? " (pesados)" : ""}</span>`} hint="Cuánto más lento que la velocidad libre (p85 del tramo) se circula. Lento suele ser tránsito." />
        <${Kpi} label="Anda y para" value=${x.sgPer10 == null ? "–" : n1(x.sgPer10)} unit=" c/10 km" sub=${html`<span>noche: ${pc(x.darkPct)} de los km</span>`} />
      </div>
      <h3>Por hora del día</h3>
      <${ChartView} height=${220} config=${{
        type: "bar",
        data: { labels: hours.map(h => hh(h.h)), datasets: [
          { type: "bar", label: "Km por día de la flota", data: hours.map(h => GI.round(h.km, 1)), backgroundColor: "#c9d6e5", borderRadius: 3, yAxisID: "y" },
          { type: "line", label: "Velocidad mediana (km/h)", data: hours.map(h => (h.vmed == null ? null : GI.round(h.vmed, 0))), borderColor: "#18212b", backgroundColor: "#18212b", spanGaps: false, yAxisID: "y1" },
          { type: "line", label: "Riesgo del camino (×)", data: hours.map(h => (h.expEnv >= 1 && h.env != null ? GI.round(h.env * 50, 0) : null)), borderColor: "#c63f2f", backgroundColor: "#c63f2f", borderDash: [4, 3], spanGaps: false, yAxisID: "y1" },
        ] },
        options: { plugins: { tooltip: { callbacks: { label: c => (c.dataset.label.startsWith("Riesgo") ? "Riesgo del camino " + fx(c.raw / 50) : c.dataset.label + ": " + c.formattedValue) } } },
          scales: { y: { beginAtZero: true, title: { display: true, text: "km por día" } }, y1: { beginAtZero: true, position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "km/h · riesgo ×50" } } } },
      }} />
      <p className="muted small">Línea punteada roja: riesgo del camino por hora (×1 = 50 en el eje derecho), solo donde hay datos suficientes. Si coincide con la caída de velocidad, el riesgo viene del tránsito.</p>
      ${x.drivers.length ? html`<h3>Conductores con infracciones de conducta acá</h3>
        <p className="small">${x.drivers.filter(d => d.id !== "_unknown").slice(0, 8).map((d, i) => html`${i ? " · " : ""}<b>${model.driverName.get(d.id) || d.id}</b> ${n0(d.n)}`)}${x.drivers.some(d => d.id === "_unknown") ? " · sin conductor identificado " + n0(x.drivers.find(d => d.id === "_unknown").n) : ""}</p>` : null}
    <//>`;
  }

  Object.assign(GI, { RoadsTab });
})(window.GI);
