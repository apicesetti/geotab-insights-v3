// Pestaña Corredores: tramos que define la empresa (geocercas con límite, horario y paradas autorizadas)
// medidos por cumplimiento. Solo se pide el GPS de los viajes que pasan cerca de cada corredor.
(function (GI) {
  "use strict";
  const React = GI.React;
  const { useState, useMemo, useEffect, useRef } = React;
  const html = GI.html;
  const { Kpi, Panel, Info, DataTable, ChartView, Segmented, Modal } = GI;
  const n0 = v => GI.fmtNum(v, 0);
  const DAY = 86400000;
  const hh = h => String(h == null ? 0 : h).padStart(2, "0") + ":00";
  const dName = (view, id) => (!id || id === "_unknown" ? "Sin conductor identificado" : view.model.driverName.get(id) || id);
  const vName = (view, id) => (view.model.devById.get(id) || {}).name || id;
  const fmtDT = t => new Date(t).toLocaleString("es-AR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const minTxt = m => (m == null ? "–" : m >= 90 ? GI.fmtNum(m / 60, 1) + " h" : n0(m) + " min");
  const okTone = v => (v == null ? "" : v >= 90 ? "good" : v >= 75 ? "warn" : "bad");
  const hoursTxt = c => (c.from == null || c.to == null || (c.from === 0 && c.to === 24) ? "Todo el día" : hh(c.from) + " a " + hh(c.to));

  // Resultados en memoria mientras la pestaña está abierta (cambiar de pestaña no recalcula).
  const memo = new Map();

  function CorridorsTab({ view, api, isAdmin, onSaveSettings }) {
    const cfg = view.settings.corridors || [];
    const zones = view.model.cat.zones;
    const zoneById = useMemo(() => new Map((zones || []).map(z => [z.id, z])), [zones]);
    const corrs = useMemo(() => cfg.map(c => ({ ...c, zone: zoneById.get(c.id) })).filter(c => c.zone && c.zone.pts && c.zone.pts.length >= 3 && c.zone.bbox), [cfg, zoneById]);
    const missing = zones ? cfg.filter(c => !zoneById.get(c.id)) : [];
    const [range, setRange] = useState("all");
    const [edit, setEdit] = useState(false);
    const [selId, setSelId] = useState(null);
    const [progress, setProgress] = useState(null), [err, setErr] = useState(null);
    const ks = view.model.dayKeys;
    const end = ks.length ? GI.parseDayKey(ks[ks.length - 1]).getTime() + DAY - 1 : Date.now();
    const start0 = ks.length ? GI.parseDayKey(ks[0]).getTime() : end - 30 * DAY;
    const from = range === "all" ? start0 : Math.max(start0, end - (+range) * DAY);
    const cand = useMemo(() => (corrs.length ? GI.corridorCandidates(view.model, view.ids, corrs, from, end) : { trips: [], total: 0 }), [corrs, view.model, view.ids, from, end]);
    const key = corrs.map(c => [c.id, c.limit, c.from, c.to, (c.stops || []).join("+"), c.stopMin].join(":")).join("|") + "#" + from + "-" + end + "#" + cand.trips.length + "#" + (cand.trips[0] ? cand.trips[0].s : "");
    const [res, setRes] = useState(memo.get(key) || null);
    const runRef = useRef(0);
    useEffect(() => { setRes(memo.get(key) || null); setErr(null); }, [key]);
    async function run() {
      const id = ++runRef.current;
      setErr(null); setProgress(0);
      try {
        const trips = await GI.loadCorridorLogs(api, cand.trips, p => { if (id === runRef.current) setProgress(p); });
        if (id !== runRef.current) return;
        const r = GI.analyzeCorridors(corrs, trips, zoneById);
        memo.set(key, r); setRes(r);
      } catch (e) { if (id === runRef.current) setErr(String((e && e.message) || e)); }
      if (id === runRef.current) setProgress(null);
    }
    // Arranca solo si son pocos viajes; si son muchos, espera el click (y avisa cuántos).
    useEffect(() => { if (!res && corrs.length && cand.trips.length && cand.trips.length <= 150 && progress == null) run(); }, [key]);

    const editor = edit ? html`<${CorridorEditor} view=${view} zones=${zones || []} cfg=${cfg} onClose=${() => setEdit(false)} onSave=${async list => { await onSaveSettings({ ...view.settings, corridors: list }); setEdit(false); }} />` : null;
    const editBtn = isAdmin && onSaveSettings ? html`<button className="btn" onClick=${() => setEdit(true)}>${cfg.length ? "Editar corredores" : "Definir corredores"}</button>` : null;

    if (zones == null) return html`<${Info}>Cargando las geocercas del área recorrida…<//>`;
    if (!cfg.length) return html`<div>
      <${Panel} title="Corredores de la empresa" sub="Un corredor es una geocerca de MyGeotab (un tramo de ruta, un acceso a planta) con las reglas que la empresa quiere que se cumplan ahí.">
        <div className="cr-empty">
          <p>Para cada corredor se define <b>el límite de velocidad</b>, <b>el horario permitido</b> y <b>las paradas autorizadas</b>. El add-in mide cada pasada y muestra el porcentaje de cumplimiento, dónde se incumple y quién.</p>
          <ol>
            <li>Dibujá el tramo como geocerca en MyGeotab (o creala desde <b>Mapa de calor → Tramos</b>).</li>
            <li>Volvé acá y tocá <b>Definir corredores</b> para elegir la geocerca y sus reglas.</li>
          </ol>
          ${editBtn || html`<${Info}>Solo un administrador puede definir los corredores.<//>`}
        </div>
      <//>${editor}</div>`;

    const R = res || [];
    const sel = selId ? R.find(r => r.id === selId) : null;
    const tot = R.reduce((a, r) => ({ n: a.n + r.n, bad: a.bad + r.passes.filter(p => p.bad).length, grave: a.grave + r.nGrave, off: a.off + r.nOff, stops: a.stops + r.nStops }), { n: 0, bad: 0, grave: 0, off: 0, stops: 0 });
    const okAll = tot.n ? ((tot.n - tot.bad) / tot.n) * 100 : null;
    const focus = res ? GI.corridorFocus(R) : [];

    return html`<div className="cr">
      <div className="cr-bar">
        <${Segmented} value=${range} onChange=${setRange} options=${[{ value: "7", label: "Últimos 7 días" }, { value: "14", label: "14 días" }, { value: "all", label: "Todo el período" }]} />
        <span className="muted small">${n0(cand.total)} viajes pasan cerca ${corrs.length === 1 ? "del corredor" : "de los " + corrs.length + " corredores"}${cand.total > cand.trips.length ? "; se analizan los " + n0(cand.trips.length) + " más recientes" : ""}. Se pide el GPS solo de esos viajes.</span>
        <span className="cr-bar-act">${!res && progress == null && cand.trips.length ? html`<button className="btn primary" onClick=${run}>Analizar ${n0(cand.trips.length)} viajes</button>` : null}${editBtn}</span>
      </div>
      ${missing.length ? html`<${Info} tone="warn">${missing.length === 1 ? "La geocerca de " + (missing[0].name || "un corredor") + " no está" : missing.length + " geocercas de corredores no están"} en el área que recorrió la flota en el período (o fueron borradas en MyGeotab).<//>` : null}
      ${progress != null ? html`<${GI.Progress} value=${progress} label=${"Leyendo el GPS de " + n0(cand.trips.length) + " viajes"} />` : null}
      ${err ? html`<${Info} tone="error">No se pudo analizar: ${err}<//>` : null}
      ${!cand.trips.length ? html`<${Info}>Ningún viaje del período pasó cerca de los corredores definidos.<//>` : null}
      ${res && !sel ? html`<div>
        <div className="readouts">
          <${Kpi} label="Cumplimiento" value=${okAll == null ? "–" : n0(okAll)} unit="%" tone=${okTone(okAll)} sub=${n0(tot.n - tot.bad) + " de " + n0(tot.n) + " pasadas sin incumplimientos"} hint="Una pasada cumple si no superó el límite (+5 km/h de tolerancia), entró dentro del horario permitido y no se detuvo fuera de las paradas autorizadas." />
          <${Kpi} label="Pasadas" value=${n0(tot.n)} sub=${n0(new Set(R.flatMap(r => r.passes.map(p => p.d))).size) + " vehículos"} />
          <${Kpi} label="Excesos graves" value=${n0(tot.grave)} tone=${tot.grave ? "bad" : ""} sub="más de 20 km/h sobre el límite" />
          <${Kpi} label="Fuera de horario" value=${n0(tot.off)} tone=${tot.off ? "warn" : ""} sub="pasadas que entraron fuera del horario" />
          <${Kpi} label="Detenciones no autorizadas" value=${n0(tot.stops)} tone=${tot.stops ? "warn" : ""} sub="paradas fuera de las autorizadas" />
        </div>
        ${focus.length ? html`<${Panel} title="Dónde intervenir" sub="Lo que más pesa en el incumplimiento, ordenado por gravedad.">
          <ul className="cr-focus">${focus.map((f, i) => html`<li key=${i}><button type="button" className="linklike" onClick=${() => setSelId(f.r.id)}>${f.r.name}</button>: ${f.text}</li>`)}</ul><//>` : null}
        <${Panel} title="Corredores" sub="Click en un corredor para ver dónde, cuándo y quién incumple.">
          <${DataTable} rowKey=${r => r.id} onRowClick=${r => setSelId(r.id)} defaultSort=${{ key: "ok", dir: "asc" }} empty="Sin pasadas en el período." rows=${R}
            columns=${[
              { key: "name", label: "Corredor", fmt: r => html`<b>${r.name}</b><div className="small muted">${r.cfg.limit ? r.cfg.limit + " km/h" : "sin límite"} · ${hoursTxt(r.cfg)}${(r.cfg.stops || []).length ? " · " + r.cfg.stops.length + " parada" + (r.cfg.stops.length === 1 ? "" : "s") : ""}</div>` },
              { key: "n", label: "Pasadas", align: "right", fmt: r => n0(r.n) },
              { key: "ok", label: "Cumplimiento", value: r => (r.ok == null ? null : r.ok), fmt: r => (r.ok == null ? "–" : html`<span className="cr-okbar"><span className=${"cr-okfill " + okTone(r.ok)} style=${{ width: r.ok + "%" }}></span></span> ${n0(r.ok)}%`) },
              { key: "nGrave", label: "Excesos graves", align: "right", fmt: r => n0(r.nGrave) },
              { key: "nOver", label: "Con exceso", align: "right", fmt: r => n0(r.nOver) },
              { key: "nOff", label: "Fuera de horario", align: "right", fmt: r => n0(r.nOff) },
              { key: "nStops", label: "Detenciones", align: "right", fmt: r => n0(r.nStops) },
              { key: "tMed", label: "Tiempo típico", align: "right", fmt: r => minTxt(r.tMed), title: "Mediana del tiempo dentro del corredor" },
            ]} />
        <//>
      </div>` : null}
      ${res && sel ? html`<${CorridorDetail} view=${view} r=${sel} onBack=${() => setSelId(null)} />` : null}
      ${editor}
    </div>`;
  }

  function CorridorMap({ r }) {
    const ref = useRef(null), mapObj = useRef(null);
    useEffect(() => {
      if (!ref.current || typeof L === "undefined") return;
      if (!mapObj.current) { mapObj.current = L.map(ref.current, { preferCanvas: true, scrollWheelZoom: false }); L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(mapObj.current); }
      const m = mapObj.current;
      if (m._g) m.removeLayer(m._g);
      const poly = L.polygon(r.zone.pts.map(([x, y]) => [y, x]), { color: "#0078d3", weight: 2, fillOpacity: 0.08 });
      const pts = [];
      for (const p of r.passes) {
        if (p.wp) pts.push(L.circleMarker(p.wp, { radius: p.grave ? 6 : 4.5, color: "#fff", weight: 1, fillColor: p.grave ? "#fe5a3f" : "#f9ba00", fillOpacity: 0.95 }).bindTooltip((p.grave ? "Exceso grave" : "Exceso") + ": " + n0(p.vmax) + " km/h · " + fmtDT(p.a)));
        for (const s of p.sp || []) pts.push(L.circleMarker([s[0], s[1]], { radius: 5, color: "#fff", weight: 1, fillColor: "#25477b", fillOpacity: 0.95 }).bindTooltip("Detención de " + minTxt(s[2]) + " · " + fmtDT(p.a)));
      }
      m._g = L.layerGroup([poly, ...pts]).addTo(m);
      m.fitBounds(poly.getBounds(), { padding: [16, 16] });
      setTimeout(() => m.invalidateSize(), 0);
    }, [r]);
    useEffect(() => () => { if (mapObj.current) { mapObj.current.remove(); mapObj.current = null; } }, []);
    return html`<div><div ref=${ref} className="cr-map"></div>
      <div className="hm-legend small"><span><span className="hm-dot" style=${{ background: "#fe5a3f" }}></span>Exceso grave</span><span><span className="hm-dot" style=${{ background: "#f9ba00" }}></span>Exceso</span><span><span className="hm-dot" style=${{ background: "#25477b" }}></span>Detención no autorizada</span></div></div>`;
  }

  function CorridorDetail({ view, r, onBack }) {
    const B = GI.CORRIDOR_BINS;
    const along = { type: "bar", data: { labels: r.bins.map((_, i) => "Tramo " + (i + 1)), datasets: [
      { label: "Excesos graves", data: r.bins.map(b => b.grave), backgroundColor: "#fe5a3f", stack: "s" },
      { label: "Excesos", data: r.bins.map(b => b.over), backgroundColor: "#f9ba00", stack: "s" },
      { label: "Detenciones", data: r.bins.map(b => b.stop), backgroundColor: "#25477b", stack: "s" }] },
      options: { plugins: { legend: { position: "bottom" } }, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, title: { display: true, text: "pasadas / detenciones" } } } } };
    const hours = { type: "bar", data: { labels: r.hours.map((_, i) => String(i).padStart(2, "0")), datasets: [
      { label: "Cumplen", data: r.hours.map(h => h.n - h.bad), backgroundColor: "#99c9ed", stack: "s" },
      { label: "Incumplen", data: r.hours.map(h => h.bad), backgroundColor: r.hours.map((h, i) => (GI._inHours(new Date(2000, 0, 1, i, 30).getTime(), r.cfg.from, r.cfg.to) ? "#fe5a3f" : "#25477b")), stack: "s" }] },
      options: { plugins: { legend: { display: false } }, scales: { x: { stacked: true, title: { display: true, text: "hora de entrada" } }, y: { stacked: true, beginAtZero: true, title: { display: true, text: "pasadas" } } } } };
    const drv = r.byDriver.filter(x => x.bad > 0);
    const top = drv.filter(x => x.id !== "_unknown").slice(0, 5).map(x => ({ id: x.id }));
    return html`<div className="cr-detail">
      <div className="cr-detail-head"><button className="btn small" onClick=${onBack}>← Todos los corredores</button>
        <h2>${r.name}</h2><span className="muted">${r.cfg.limit ? "Límite " + r.cfg.limit + " km/h" : "Sin límite"} · Horario ${hoursTxt(r.cfg).toLowerCase()} · ${(r.cfg.stops || []).length ? r.cfg.stops.length + " parada" + (r.cfg.stops.length === 1 ? "" : "s") + " autorizada" + (r.cfg.stops.length === 1 ? "" : "s") : "sin paradas autorizadas"} (detención de ${r.cfg.stopMin || 5} min o más)</span></div>
      <div className="readouts">
        <${Kpi} label="Cumplimiento" value=${r.ok == null ? "–" : n0(r.ok)} unit="%" tone=${okTone(r.ok)} sub=${n0(r.n) + " pasadas"} />
        <${Kpi} label="Excesos graves" value=${n0(r.nGrave)} tone=${r.nGrave ? "bad" : ""} sub=${n0(r.nOver) + " pasadas con algún exceso"} />
        <${Kpi} label="Fuera de horario" value=${n0(r.nOff)} tone=${r.nOff ? "warn" : ""} />
        <${Kpi} label="Detenciones no autorizadas" value=${n0(r.nStops)} tone=${r.nStops ? "warn" : ""} />
        <${Kpi} label="Tiempo típico" value=${minTxt(r.tMed)} sub=${"el 90% tarda hasta " + minTxt(r.tP90)} />
      </div>
      <div className="grid-2">
        <${Panel} title="Dónde pasa" sub=${"Pasadas con exceso y detenciones en cada parte del corredor (dividido en " + B + " partes iguales sobre su eje más largo)."}>
          <${CorridorMap} r=${r} />
          <${ChartView} config=${along} height=${200} />
        <//>
        <${Panel} title="Cuándo pasa" sub=${"Pasadas por hora de entrada. En azul oscuro, las que entraron fuera del horario permitido (" + hoursTxt(r.cfg).toLowerCase() + ")."}>
          <${ChartView} config=${hours} height=${220} />
        <//>
      </div>
      <${Panel} title="Quién incumple" sub=${r.top5Share != null && drv.length > 5 ? "Los 5 primeros explican el " + n0(r.top5Share) + "% de las pasadas con incumplimientos." : "Conductores con pasadas que no cumplieron."}
        actions=${GI.CoachMany && top.length ? html`<${GI.CoachMany} view=${view} rows=${top} label=${"Asignar coaching a los " + top.length + " primeros"} reason=${() => "Incumplimientos repetidos en el corredor " + r.name + "."} />` : null}>
        <${DataTable} rowKey=${x => x.id} defaultSort=${{ key: "bad", dir: "desc" }} limit=${10} rows=${drv} empty="Todas las pasadas cumplieron."
          columns=${[
            { key: "name", label: "Conductor", value: x => dName(view, x.id), fmt: x => dName(view, x.id) },
            { key: "n", label: "Pasadas", align: "right", fmt: x => n0(x.n) },
            { key: "bad", label: "Incumplen", align: "right", fmt: x => n0(x.bad) + " (" + n0((x.bad / x.n) * 100) + "%)" },
            { key: "grave", label: "Graves", align: "right", fmt: x => n0(x.grave) },
            { key: "off", label: "Fuera de horario", align: "right", fmt: x => n0(x.off) },
            { key: "stops", label: "Detenciones", align: "right", fmt: x => n0(x.stops) },
            { key: "act", label: "", fmt: x => (x.id !== "_unknown" && GI.CoachButton ? html`<${GI.CoachButton} view=${view} drv=${x.id} cat="velocidad" small=${true} reason=${"Incumplimientos en el corredor " + r.name + "."} />` : null) },
          ]} />
      <//>
      <${Panel} title="Últimos incumplimientos">
        <ul className="cr-last">${r.last.map((p, i) => html`<li key=${i}><b>${fmtDT(p.a)}</b> · ${dName(view, p.r)} · ${vName(view, p.d)}<br/><span className="small">
          ${[p.grave ? "exceso grave (" + n0(p.vmax) + " km/h)" : p.over ? "exceso (" + n0(p.vmax) + " km/h, " + minTxt(p.overS / 60) + " sobre el límite)" : null, p.offHours ? "entró fuera de horario" : null, p.stops ? p.stops + " detención" + (p.stops === 1 ? "" : "es") + " no autorizada" + (p.stops === 1 ? "" : "s") : null].filter(Boolean).join(" · ")}</span></li>`)}</ul>
      <//>
    </div>`;
  }

  // Editor (solo administradores): elegir la geocerca y sus reglas.
  function CorridorEditor({ view, zones, cfg, onClose, onSave }) {
    const [list, setList] = useState(cfg.map(c => ({ ...c })));
    const [q, setQ] = useState(""), [busy, setBusy] = useState(false), [err, setErr] = useState(null);
    const used = new Set(list.map(c => c.id));
    const zName = id => (zones.find(z => z.id === id) || {}).name || id;
    const found = q.trim().length >= 2 ? zones.filter(z => !used.has(z.id) && z.pts && z.pts.length >= 3 && (z.name || "").toLowerCase().includes(q.trim().toLowerCase())).slice(0, 12) : [];
    const upd = (i, k, v) => setList(l => l.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
    const add = z => { setList(l => [...l, { id: z.id, name: z.name, limit: 80, from: 0, to: 24, stops: [], stopMin: 5 }]); setQ(""); };
    // Paradas: geocercas chicas que tocan la caja del corredor
    const nearStops = c => { const z = zones.find(x => x.id === c.id); if (!z || !z.bbox) return []; const b = z.bbox; return zones.filter(s => s.id !== z.id && s.bbox && s.bbox[0] <= b[2] && s.bbox[2] >= b[0] && s.bbox[1] <= b[3] && s.bbox[3] >= b[1] && (s.bbox[2] - s.bbox[0]) * (s.bbox[3] - s.bbox[1]) < (b[2] - b[0]) * (b[3] - b[1]) / 4).slice(0, 30); };
    async function save() { setBusy(true); setErr(null); try { await onSave(list.map(c => ({ ...c, limit: c.limit ? +c.limit : null, from: +c.from, to: +c.to, stopMin: +c.stopMin || 5 }))); } catch (e) { setErr(String((e && e.message) || e)); setBusy(false); } }
    const hours = Array.from({ length: 25 }, (_, i) => i);
    return html`<${Modal} title="Corredores de la empresa" wide=${true} onClose=${onClose}>
      <p className="small muted">Elegí geocercas de MyGeotab y definí las reglas de cada una. Se guarda en la configuración del add-in (no cambia nada en MyGeotab) y la ven todos los usuarios.</p>
      <label className="ctl">Agregar una geocerca<input type="search" placeholder="Buscar por nombre…" value=${q} onInput=${e => setQ(e.target.value)} /></label>
      ${found.length ? html`<ul className="cr-found">${found.map(z => html`<li key=${z.id}><button type="button" className="btn small" onClick=${() => add(z)}>+ ${z.name}</button></li>`)}</ul>` : q.trim().length >= 2 ? html`<p className="small muted">Ninguna geocerca del área recorrida coincide.</p>` : null}
      ${list.length ? html`<table className="cr-edit"><thead><tr><th>Corredor</th><th>Límite (km/h)</th><th>Horario permitido</th><th>Paradas autorizadas</th><th>Detención desde</th><th></th></tr></thead><tbody>
        ${list.map((c, i) => html`<tr key=${c.id}>
          <td><input value=${c.name || ""} onInput=${e => upd(i, "name", e.target.value)} aria-label="Nombre" /><div className="small muted">Geocerca: ${zName(c.id)}</div></td>
          <td><input type="number" min="10" max="150" step="5" value=${c.limit || ""} onInput=${e => upd(i, "limit", e.target.value)} aria-label="Límite" /></td>
          <td><select value=${c.from} onChange=${e => upd(i, "from", +e.target.value)} aria-label="Desde">${hours.slice(0, 24).map(h => html`<option key=${h} value=${h}>${hh(h)}</option>`)}</select> a <select value=${c.to} onChange=${e => upd(i, "to", +e.target.value)} aria-label="Hasta">${hours.slice(1).map(h => html`<option key=${h} value=${h}>${h === 24 ? "24:00" : hh(h)}</option>`)}</select></td>
          <td>${(() => { const opts = nearStops(c); return opts.length ? html`<select multiple size=${Math.min(4, opts.length)} value=${c.stops || []} onChange=${e => upd(i, "stops", [...e.target.selectedOptions].map(o => o.value))} aria-label="Paradas">${opts.map(s => html`<option key=${s.id} value=${s.id}>${s.name}</option>`)}</select>` : html`<span className="small muted">No hay geocercas chicas dentro del corredor.</span>`; })()}</td>
          <td><select value=${c.stopMin || 5} onChange=${e => upd(i, "stopMin", +e.target.value)} aria-label="Minutos">${[3, 5, 10, 15, 30].map(m => html`<option key=${m} value=${m}>${m} min</option>`)}</select></td>
          <td><button className="btn small ghost" onClick=${() => setList(l => l.filter((_, j) => j !== i))} aria-label="Quitar">Quitar</button></td>
        </tr>`)}</tbody></table>` : html`<p className="small muted">Todavía no hay corredores.</p>`}
      ${err ? html`<${Info} tone="error">No se pudo guardar: ${err}<//>` : null}
      <div className="modal-actions"><button className="btn" onClick=${onClose}>Cancelar</button><button className="btn primary" disabled=${busy} onClick=${save}>${busy ? "Guardando…" : "Guardar corredores"}</button></div>
    <//>`;
  }

  Object.assign(GI, { CorridorsTab });
})(window.GI);
