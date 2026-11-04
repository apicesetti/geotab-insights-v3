// Pestaña "Fatiga": jornadas en curso contra los límites (Ahora), riesgo del
// próximo turno, jornadas con señales de fatiga y su seguimiento (Casos), el
// resumen por conductor y la ficha de fatiga de cada conductor.
(function (GI) {
  "use strict";
  const React = GI.React;
  const { useState, useMemo, useEffect, useRef } = React;
  const html = GI.html;
  const { Kpi, Panel, Info, DataTable, Segmented, Modal } = GI;
  const H = 3600000, MIN = 60000;
  const n0 = v => GI.fmtNum(v, 0);
  const hm = t => new Date(t).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
  const dshort = t => new Date(t).toLocaleDateString("es-AR", { weekday: "short", day: "numeric", month: "short" });
  const dur = h => { if (h == null || !isFinite(h)) return "–"; const m = Math.round(h * 60); return m < 60 ? m + " min" : Math.floor(m / 60) + " h" + (m % 60 ? " " + String(m % 60).padStart(2, "0") : ""); };
  const when = t => dshort(t) + " " + hm(t);
  // Fin de una jornada: fecha y hora, marcando si termina otro día.
  function endCell(j) {
    const days = Math.round((GI.parseDayKey(GI.dayKey(j.e)) - GI.parseDayKey(j.dk)) / 86400000);
    return html`${dshort(j.e)} <span className="muted">${hm(j.e)}</span>${days > 0 ? html` <span className="tag-warn" title=${"Termina " + days + (days === 1 ? " día" : " días") + " después de empezar"}>+${days} ${days === 1 ? "día" : "días"}</span>` : ""}`;
  }
  const STATUS = ["Detectado", "Revisado", "Entrevista", "Cerrado"];
  const ACTIONS = ["", "Charla con el conductor", "Descanso obligatorio", "Cambio de diagrama", "Capacitación", "Derivación a salud ocupacional", "Otra"];
  const CAM_COLORS = { fatiga: "#b93a0f", distraccion: "#7a4dc2", salida_carril: "#c77700" };
  const FI_COLORS = { bajo: "#1f2a37", moderado: "#c99400", alto: "#d4561e", "muy alto": "#a3200f" };
  const LIVE_HOURS = 36;

  const drvName = (view, id) => view.model.driverName.get(id) || id;
  const devName = (view, id) => { const d = view.model.devById.get(id); return d ? d.name : id; };
  function levelTag(l) {
    return html`<span className=${"ft-level ft-" + l}>${l === "alto" ? "Alto" : l === "medio" ? "Medio" : "Bajo"}</span>`;
  }
  function fiTag(v, fz) {
    if (v == null) return html`<span className="muted">–</span>`;
    const l = GI.fiLevel(v, fz);
    return html`<span className=${"ft-fi ft-fi-" + l.replace(" ", "-")} title=${"Índice de fatiga estimado: " + l}>${Math.round(v)}</span>`;
  }
  function sigChips(j, small) {
    return html`<span className="ft-sigs">${j.signals.map(s => html`<span key=${s.key} className=${"ft-sig" + (s.key === "camara" ? " cam" : s.key === "ident" ? " ident" : "") + (small ? " sm" : "")} title=${s.text}>${s.label}</span>`)}</span>`;
  }
  function DriverLink({ view, id, onDriver }) {
    return html`<button className="btn link ft-name" onClick=${e => { e.stopPropagation(); onDriver(id); }}>${drvName(view, id)}</button>`;
  }

  // ---------- Evolución del índice ----------
  // Gráfico del índice: la curva de los últimos días (sólida), la proyección de
  // las próximas horas (punteada), las jornadas abajo y los eventos de cámara
  // como contexto sobre la curva.
  function IndexChart({ entry, proj, fz, now, days, onCase, height, off }) {
    const W = 1000, Hh = height || 250, L = 40, R = 990, T = 20, B = Hh - 62;
    const t0 = now - days * 86400000, t1 = now + 16 * H;
    const x = t => L + ((Math.max(t0, Math.min(t1, t)) - t0) / (t1 - t0)) * (R - L);
    const yMax = 160, y = v => B - (Math.min(yMax, Math.max(0, v)) / yMax) * (B - T);
    const sim = entry.sim;
    const pts = [];
    // sin comunicación: desde la última comunicación la curva es un supuesto (punteada gris)
    const tOff = off ? Math.max(t0, off.at) : null, ptsOff = [];
    for (let t = Math.max(t0, sim.t0); t <= now; t += 30 * MIN) {
      const p = x(t).toFixed(1) + "," + y(sim.at(t)).toFixed(1);
      if (tOff != null && t > tOff) ptsOff.push(p); else pts.push(p);
    }
    if (tOff != null && ptsOff.length) { const p = x(tOff).toFixed(1) + "," + y(sim.at(tOff)).toFixed(1); pts.push(p); ptsOff.unshift(p); }
    const proP = proj ? proj.pts.filter((p, i) => i % 2 === 0 || i === proj.pts.length - 1).map(([t, v]) => x(t).toFixed(1) + "," + y(v).toFixed(1)) : [];
    const shifts = entry.list.filter(j => j.e > t0);
    // descansos entre jornadas (y el que está en curso si no está en jornada)
    const rests = [];
    for (const j of entry.list) if (j.prevE != null && j.s > t0 && j.restBefore < 48) rests.push({ a: j.prevE, b: j.s, h: j.restBefore, k: restKind(j, fz), j });
    const last = entry.list[entry.list.length - 1];
    if (last && !last.open && last.e < now) {
      const cut = off ? Math.max(last.e, off.at) : now;
      if (cut > last.e + MIN) rests.push({ a: last.e, b: cut, h: (cut - last.e) / H, k: "curso", j: null });
      if (off) rests.push({ a: cut, b: now, h: (now - cut) / H, k: "sincom", j: null });
    }
    const cams = [];
    for (const j of shifts) for (const e of j.cam || []) if (e.t >= t0) cams.push(e);
    const ticks = [];
    const d0 = new Date(t0); d0.setHours(0, 0, 0, 0);
    const stepD = days > 10 ? 2 : 1;
    for (let d = d0.getTime() + 86400000; d < t1; d += 86400000 * stepD) ticks.push(d);
    const nights = [];
    for (let d = d0.getTime(); d < t1; d += 86400000) nights.push([d, d + 6 * H]);
    const BY = B + 8, BH = 18; // barra de jornadas y descansos
    // texto dentro de la barra; si no entra, la versión corta ("11h"); si tampoco, solo el tooltip
    const label = (a, b, txt, dark) => {
      const w = x(b) - x(a), m = /(\d+) h/.exec(txt), short = m ? m[1] + "h" : null;
      const t = w > txt.length * 6.2 + 6 ? txt : short && w > short.length * 6.2 + 4 ? short : null;
      return t ? html`<text x=${(x(a) + x(b)) / 2} y=${BY + 13} textAnchor="middle" className=${"ft-tl-bar" + (dark ? " on-dark" : "")}>${t}</text>` : null;
    };
    const restColor = k => (k === "curso" ? "#a9dcbf" : k === "sincom" ? "#b8bec8" : GAP[k].color);
    return html`<div className="ft-tl">
      <svg viewBox=${"0 0 " + W + " " + Hh} role="img" aria-label="Evolución del índice de fatiga">
        ${rests.filter(r => r.b > t0).map((r, i) => html`<rect key=${"rb" + i} x=${x(r.a)} y=${T} width=${Math.max(0, x(r.b) - x(r.a))} height=${B - T} fill=${restColor(r.k)} opacity="0.16" />`)}
        ${nights.filter(([a, b]) => b > t0 && a < t1).map(([a, b], i) => html`<rect key=${"n" + i} x=${x(a)} y=${T - 8} width=${Math.max(0, x(b) - x(a))} height="5" rx="1" fill="#c9cfe3" />`)}
        <rect x=${x(now)} y=${T} width=${R - x(now)} height=${B - T} fill="#f4f5f7" opacity="0.8" />
        ${[0, 40, 80, 120, 160].map(v => html`<g key=${"g" + v}><line x1=${L} x2=${R} y1=${y(v)} y2=${y(v)} stroke="#eceff3" /><text x=${L - 6} y=${y(v) + 4} textAnchor="end" className="ft-tl-tick">${v}</text></g>`)}
        ${[fz.fi_mod, fz.fi_high].map((v, i) => html`<g key=${"th" + v}><line x1=${L} x2=${R} y1=${y(v)} y2=${y(v)} stroke=${i ? "#d4561e" : "#c99400"} strokeDasharray="5 4" /><text x=${L + 4} y=${y(v) - 4} className="ft-tl-lab">${(i ? "alto " : "moderado ") + v}</text></g>`)}

        ${rests.filter(r => r.b > t0).map((r, i) => html`<g key=${"r" + i}><rect x=${x(r.a)} y=${BY} width=${Math.max(1.5, x(r.b) - x(r.a))} height=${BH} fill=${restColor(r.k)} />
          ${label(r.a, r.b, (r.k === "curso" ? "descansa " : r.k === "sincom" ? "sin datos " : "") + dur(r.h), r.k === "sincom")}
          <title>${(r.k === "sincom" ? "Sin comunicación del vehículo desde " + when(r.a) + " (" + dur(r.h) + "): no se sabe si descansa o sigue manejando" : r.k === "curso" ? "Descansando desde " + when(r.a) + " (" + dur(r.h) + " hasta ahora)" : GAP[r.k].label.split(" (")[0] + ": " + dur(r.h) + " · " + when(r.a) + " → " + when(r.b)) + (r.j && r.j.restPlace ? " · " + placeTxt(r.j.restPlace) : "") + (r.j && r.j.restHandover ? " · el vehículo siguió con " + (r.j.restHandover.drv ? (GI.__drvName ? GI.__drvName(r.j.restHandover.drv) : r.j.restHandover.drv) : "otro conductor") + " desde las " + hm(r.j.restHandover.at) : "") + (r.j && r.j.restMicro && r.j.restMicro.length ? " · " + r.j.restMicro.length + " movimiento(s) mínimo(s) ignorado(s): " + r.j.restMicro.map(t => hm(t.s)).join(", ") : "")}</title></g>`)}
        ${shifts.map(j => html`<g key=${j.key} style=${{ cursor: "pointer" }} onClick=${() => onCase && onCase(j)}>
          <rect x=${x(j.s)} y=${BY} width=${Math.max(2, x(j.e) - x(j.s))} height=${BH} fill=${FI_COLORS[GI.fiLevel(j.fiPeak, fz)] || "#1f2a37"} />
          ${label(j.s, j.e, (j.open ? "en curso " : "") + dur(j.open ? (now - j.s) / H : j.span), GI.fiLevel(j.fiPeak, fz) !== "moderado")}
          <title>${"Jornada " + when(j.s) + " → " + (j.open ? "en curso" : when(j.e)) + " · " + dur(j.span) + " (" + dur(j.dh) + " de manejo)"  + " · índice máx. " + Math.round(j.fiPeak) + " (click para ver)"}</title></g>`)}
        ${proj && proj.nextStart && proj.nextStart < t1 ? html`<g><rect x=${x(proj.nextStart)} y=${BY} width=${Math.max(2, x(proj.nextStart + proj.hb.span * H) - x(proj.nextStart))} height=${BH} fill="none" stroke="#1f2a37" strokeDasharray="3 2" />
          ${label(proj.nextStart, proj.nextStart + proj.hb.span * H, "próximo " + dur(proj.hb.span))}<title>${"Próximo turno habitual: " + when(proj.nextStart) + " (" + dur(proj.hb.span) + ")"}</title></g>` : null}

        <path d=${"M" + pts.join("L")} fill="none" stroke="#1f2a37" strokeWidth="2.2" />
        ${ptsOff.length ? html`<path d=${"M" + ptsOff.join("L")} fill="none" stroke="#8a929e" strokeWidth="2" strokeDasharray="2 4"><title>Sin datos: supone que descansa</title></path>` : null}
        ${proP.length ? html`<path d=${"M" + proP.join("L")} fill="none" stroke="#1f2a37" strokeWidth="2" strokeDasharray="5 4" opacity="0.7" />` : null}
        ${cams.map((e, i) => html`<path key=${"c" + i} d=${"M" + x(e.t) + " " + (y(sim.at(e.t)) - 5) + " l-5 -9 h10 z"} fill=${CAM_COLORS[e.cat] || "#b93a0f"} opacity="0.85"><title>${when(e.t) + " · " + GI.catLabel(e.cat) + " · índice " + Math.round(sim.at(e.t))}</title></path>`)}
        <line x1=${x(now)} x2=${x(now)} y1=${T} y2=${BY + BH} stroke="#2a78d6" strokeWidth="1.5" />
        <text x=${x(now) + 4} y=${T + 10} className="ft-tl-lab b" fill="#2a78d6">ahora ${proj ? Math.round(proj.Fnow) + (off ? "?" : "") : ""}</text>
        ${proj && proj.crossAt && proj.crossAt > now ? html`<g><circle cx=${x(proj.crossAt)} cy=${y(fz.fi_high)} r="4.5" fill="#d4561e" /><text x=${x(proj.crossAt) + (x(proj.crossAt) > R - 60 ? -6 : 6)} y=${y(fz.fi_high) - 6} textAnchor=${x(proj.crossAt) > R - 60 ? "end" : "start"} className="ft-tl-lab b">${(GI.dayKey(proj.crossAt) !== GI.dayKey(now) ? dshort(proj.crossAt) + " " : "") + hm(proj.crossAt)}</text></g>` : null}
        ${ticks.map(t => html`<g key=${"k" + t}><line x1=${x(t)} x2=${x(t)} y1=${BY + BH} y2=${BY + BH + 5} stroke="#7b8492" /><text x=${x(t)} y=${Hh - 8} textAnchor="middle" className="ft-tl-tick">${dshort(t)}</text></g>`)}
      </svg>
      <div className="ft-tl-legend small">
        <span><i style=${{ background: "#1f2a37" }}></i>Índice estimado</span>
        <span><i style=${{ background: "repeating-linear-gradient(90deg,#1f2a37 0 4px,transparent 4px 7px)" }}></i>Proyección con su horario habitual</span>
        ${off ? html`<span><i style=${{ background: "#b8bec8" }}></i>Sin comunicación del vehículo (supone descanso)</span>` : null}
        <span><i style=${{ background: "#c9cfe3", height: "5px" }}></i>00–06 h</span>
        <span>· Barra inferior, jornadas por índice máximo:</span>
        <span><i style=${{ background: FI_COLORS.bajo }}></i>bajo</span>
        <span><i style=${{ background: FI_COLORS.moderado }}></i>moderado</span>
        <span><i style=${{ background: FI_COLORS.alto }}></i>alto</span>
        <span><i style=${{ background: FI_COLORS["muy alto"] }}></i>muy alto</span>
        <span>· descansos:</span>
        <span><i style=${{ background: GAP.ok.color }}></i>suficiente</span>
        <span><i style=${{ background: GAP.dia.color }}></i>de día antes de un turno noche</span>
        <span><i style=${{ background: GAP.motor.color }}></i>con motor en marcha</span>
        <span><i style=${{ background: GAP.corto.color }}></i>más corto que ${fz.min_rest} h</span>
        <span><i style=${{ background: "#a9dcbf" }}></i>en curso</span>
        <span>· eventos de cámara (contexto):</span>
        <span><i className="tri" style=${{ borderBottomColor: CAM_COLORS.fatiga }}></i>bostezo / fatiga</span>
        <span><i className="tri" style=${{ borderBottomColor: CAM_COLORS.distraccion }}></i>distracción</span>
        <span><i className="tri" style=${{ borderBottomColor: CAM_COLORS.salida_carril }}></i>salida de carril</span>
      </div>
    </div>`;
  }
  // Mini curva para la lista: últimas 72 h + proyección.
  function Spark({ entry, proj, fz, now, off }) {
    const W = 220, Hh = 44, t0 = now - 72 * H, t1 = now + 16 * H;
    const x = t => ((t - t0) / (t1 - t0)) * W, y = v => Hh - 3 - (Math.min(160, Math.max(0, v)) / 160) * (Hh - 6);
    const sim = entry.sim, pts = [];
    for (let t = Math.max(t0, sim.t0); t <= now; t += H) pts.push(x(t).toFixed(1) + "," + y(sim.at(t)).toFixed(1));
    const pp = proj ? proj.pts.filter((p, i) => i % 4 === 0 || i === proj.pts.length - 1).map(([t, v]) => x(t).toFixed(1) + "," + y(v).toFixed(1)) : [];
    const cams = [];
    for (const j of entry.list) if (j.e > t0) for (const e of j.cam || []) if (e.t >= t0 && e.t <= now) cams.push(e);
    return html`<svg className="ft-spark" viewBox=${"0 0 " + W + " " + Hh} width="220" height="44" aria-hidden="true">
      <rect x=${x(now)} y="0" width=${W - x(now)} height=${Hh} fill="#f4f6f9" />
      ${off && off.at < now ? html`<rect x=${x(Math.max(t0, off.at))} y="0" width=${x(now) - x(Math.max(t0, off.at))} height=${Hh} fill="#b8bec8" opacity="0.35"><title>Sin comunicación del vehículo</title></rect>` : null}
      <line x1="0" x2=${W} y1=${y(fz.fi_high)} y2=${y(fz.fi_high)} stroke="#d4561e" strokeDasharray="3 3" />
      <line x1="0" x2=${W} y1=${y(fz.fi_mod)} y2=${y(fz.fi_mod)} stroke="#c99400" strokeDasharray="2 3" opacity="0.6" />
      ${pts.length ? html`<path d=${"M" + pts.join("L")} fill="none" stroke="#1f2a37" strokeWidth="1.6" />` : null}
      ${pp.length ? html`<path d=${"M" + pp.join("L")} fill="none" stroke="#1f2a37" strokeWidth="1.4" strokeDasharray="3 2" opacity="0.7" />` : null}
      ${cams.map((e, i) => { const cy = Math.max(6, y(sim.at(e.t)) - 2); return html`<path key=${"c" + i} d=${"M" + x(e.t).toFixed(1) + " " + cy.toFixed(1) + " l-3.5 -6 h7 z"} fill=${CAM_COLORS[e.cat] || "#b93a0f"} opacity="0.9"><title>${new Date(e.t).toLocaleString("es-AR", { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) + " · " + GI.catLabel(e.cat) + " · índice " + Math.round(sim.at(e.t))}</title></path>`; })}
      <line x1=${x(now)} x2=${x(now)} y1="0" y2=${Hh} stroke="#2a78d6" />
    </svg>`;
  }

  // ---------- Seguimiento: quién se acerca a un índice alto ----------
  function TrackSection({ view, res, live, onRefresh, onDriver, api }) {
    const status = live.status;
    const [cams, setCams] = useState(null); // vehículo -> cámaras
    const [camErr, setCamErr] = useState(null);
    const [watch, setWatch] = useState(null); // { drv, dev }
    useEffect(() => {
      let off = false;
      if (!api || !GI.loadAllCameras) return;
      GI.loadAllCameras(api, view.model.devices).then(m => { if (!off) setCams(m); }).catch(e => { console.warn("[Geotab Insights] cámaras", e); if (!off) { setCams(new Map()); setCamErr(String((e && (e.message || e.name)) || e)); } });
      return () => { off = true; };
    }, [api]);
    const fz = res.limits, now = live.now;
    const [all, setAll] = useState(false);
    const rows = useMemo(() => {
      const out = [];
      for (const [id, entry] of res.sims) {
        const last = entry.list[entry.list.length - 1];
        if (!last || !entry.sim || (!last.open && last.e < now - 72 * H)) continue;
        const proj = GI.projectIndex(entry, fz, now, 16);
        if (!proj) continue;
        const prog = proj.open ? GI.shiftProgress(proj.open, fz, now) : null;
        // tendencia: cuánto subió el índice en las últimas 2 h (sube mientras trabaja)
        const rise = proj.Fnow - entry.sim.at(now - 2 * H);
        out.push({ id, entry, proj, prog, last, rise, up: rise >= 2, off: GI.commGap(entry, status, now) });
      }
      // primero los críticos (rojo, después amarillo), después los que vienen subiendo y al final
      // el resto; dentro de cada grupo, el índice más alto primero
      const ord = { rojo: 3, amarillo: 2, ok: 0 };
      const rank = r => ord[r.proj.level] || (r.up ? 1 : 0);
      return out.sort((a, b) => rank(b) - rank(a) || b.proj.Fnow - a.proj.Fnow || b.rise - a.rise || b.proj.risk - a.proj.risk);
    }, [res, now, status]);
    const show = all ? rows : rows.filter(r => r.proj.level !== "ok" || r.off);
    const offRows = rows.filter(r => r.off);
    const red = rows.filter(r => r.proj.level === "rojo"), soon = rows.filter(r => r.proj.open && r.proj.crossAt && r.proj.crossAt > now);
    const nextHigh = rows.filter(r => !r.proj.open && r.proj.next && r.proj.next.peak >= fz.fi_high);
    return html`<${Panel} title="¿Quién se acerca a un índice de fatiga alto?"
      hint=${"Conductores que trabajaron en las últimas 72 h o están en jornada. La curva muestra su índice de fatiga estimado de los últimos 3 días y, punteada, la proyección de las próximas 16 h: si está en jornada, sigue al ritmo que lleva hasta completar su jornada habitual; si descansa, arranca a su hora habitual (la mediana de sus últimas jornadas) y hace su jornada habitual. Alto desde " + fz.fi_high + ", moderado desde " + fz.fi_mod + " (Configuración → Fatiga y gravedad)."}
      actions=${html`<span className="muted small">${live.at ? "Datos de las " + hm(live.at) : ""}</span> <button className="btn small" disabled=${live.loading} onClick=${onRefresh}>${live.loading ? "Actualizando…" : "↻ Actualizar"}</button>`}>
      ${live.err ? html`<${Info} tone="warn">No se pudieron traer los viajes de las últimas horas (${live.err}); se usa lo cargado del período.<//>` : null}
      ${offRows.length ? html`<${Info} tone="warn"><b>${offRows.length === 1 ? "1 conductor tiene" : offRows.length + " conductores tienen"} el vehículo sin comunicación</b> (${offRows.map(r => drvName(view, r.id) + " desde " + (GI.dayKey(r.off.at) !== GI.dayKey(now) ? dshort(r.off.at) + " " : "") + hm(r.off.at)).join("; ")}). No se puede confirmar si descansan o siguen manejando: si manejaron, esos viajes aparecen cuando el equipo vuelva a comunicar. Su índice supone que descansan.<//>` : null}
      <div className="readouts compact inset">
        <${Kpi} label="Actuar ahora" value=${n0(red.length)} tone=${red.length ? "bad" : null} sub=${html`<span>en jornada con índice alto, o próximo turno que no llega a descansar lo necesario</span>`} />
        <${Kpi} label=${"En jornada y llegan a " + fz.fi_high} value=${n0(soon.length)} sub=${html`<span>${soon.length ? "el primero a las " + hm(Math.min(...soon.map(r => r.proj.crossAt))) : "en las próximas horas"}</span>`} />
        <${Kpi} label="Próximo turno con índice alto" value=${n0(nextHigh.length)} sub=${html`<span>si arrancan a su hora habitual</span>`} />
        <${Kpi} label="Conductores activos" value=${n0(rows.length)} sub=${html`<span>${n0(rows.filter(r => r.proj.open).length)} en jornada ahora</span>`} />
      </div>
      <div className="ft-filters"><${Segmented} value=${all ? "all" : "risk"} onChange=${v => setAll(v === "all")} options=${[{ value: "risk", label: "Con riesgo (" + rows.filter(r => r.proj.level !== "ok").length + ")" }, { value: "all", label: "Todos (" + rows.length + ")" }]} /></div>
      ${!show.length ? html`<p className="muted">${live.loading ? "Calculando…" : "Ningún conductor activo se acerca a un índice alto."}</p>` : html`<div className="table-wrap"><table className="tbl ft-track">
        <thead><tr><th>Conductor</th><th>Estado</th><th className="num">Índice ahora</th><th>Últimas 72 h y próximas 16 h</th><th className="num">Llega a ${fz.fi_high}</th><th>Qué hacer</th><th>Cámara</th></tr></thead>
        <tbody>${show.map(r => { const p = r.proj; return html`<tr key=${r.id} className=${"ft-track-" + p.level} onClick=${() => onDriver(r.id)} style=${{ cursor: "pointer" }}>
          <td><${DriverLink} view=${view} id=${r.id} onDriver=${onDriver} /><div className="small muted">${r.last.devices.map(d => devName(view, d)).join(", ")}</div></td>
          <td className="small">${p.open ? html`${r.prog && r.prog.driving ? html`<span className="ft-live">● Manejando</span>` : "En jornada, parado hace " + dur(r.prog ? r.prog.sinceLast / 60 : 0)}
              <div className="muted">desde las ${hm(p.open.s)} · ${r.prog ? r.prog.items.map(it => html`<span key=${it.key} className=${"ft-lim " + it.level}>${it.label.replace("Manejo continuo", "Continuo")} ${dur(it.v)}/${it.max} h</span>`) : null}</div>`
            : p.franco ? html`De franco <span className="tag">${p.rs.label}</span><div className="muted">vuelve ${p.rs.backAt ? dshort(p.rs.backAt) : "–"}</div>`
            : r.off ? html`<span className="ft-nocom">Sin comunicación</span><div className="muted">desde ${(GI.dayKey(r.off.at) !== GI.dayKey(now) ? dshort(r.off.at) + " " : "") + hm(r.off.at)} (${dur(r.off.h)}) · no se sabe si descansa</div>`
            : html`Descansando hace ${dur((now - r.last.e) / H)}<div className="muted">${p.nextStart ? "arranque habitual " + when(p.nextStart) : ""}</div>`}
            ${r.off && p.open ? html`<div><span className="ft-nocom">Sin comunicación</span> <span className="muted">desde ${hm(r.off.at)}</span></div>` : null}
            ${p.rs && p.rs.work && !p.franco ? html`<div className="muted">día ${p.rs.curDay} de ${p.rs.work} <span className="tag" title=${p.rs.source === "auto" ? "Detectado de sus vueltas" : "Fijado a mano"}>${p.rs.label}</span></div>` : null}</td>
          <td className="num">${fiTag(p.Fnow, fz)}${r.up ? html`<div className="small ft-up" title="Cuánto subió el índice en las últimas 2 h">↑ +${Math.round(r.rise)} en 2 h</div>` : null}${r.off ? html`<div className="small muted" title="Supone que descansa desde la última comunicación">sin datos</div>` : null}</td>
          <td><${Spark} entry=${r.entry} proj=${p} fz=${fz} now=${now} off=${r.off} /></td>
          <td className="num">${p.crossAt && p.crossAt > now ? html`<b>${(GI.dayKey(p.crossAt) !== GI.dayKey(now) ? dshort(p.crossAt) + " " : "") + hm(p.crossAt)}</b>${p.open ? "" : html`<div className="small muted">en su próximo turno</div>`}` : p.open && p.Fnow >= fz.fi_high ? html`<b className="delta bad">ya</b>` : html`<span className="muted">–</span>`}</td>
          <td><span className=${"ft-act " + p.level}>${p.action}</span>${r.off ? html`<div className="small">Confirmar con el conductor o la base si descansó</div>` : null}</td>
          ${(() => {
            // si Geotab Video no informa las cámaras (o no se pudo consultar), el botón se muestra igual
            // y abre el reproductor de MyGeotab, que sabe qué cámara tiene cada vehículo
            const dev = (r.last.trips[r.last.trips.length - 1] || {}).d, known = cams && cams.size > 0, cs = dev && known && cams.get(dev), on = cs && cs.some(c => /online/i.test(c.status)), unk = cs && cs.every(c => !c.status);
            const btn = html`<button className=${"btn small" + (on ? " primary" : "")} title=${!known ? "Abre el video en vivo de MyGeotab" : on ? "Cámara en línea" : "La cámara no figura en línea"} onClick=${e => { e.stopPropagation(); known ? setWatch({ drv: r.id, dev }) : GI.openLiveVideo(dev); }}>▶ En vivo</button>`;
            return html`<td>${cams == null ? null : !dev ? html`<span className="small muted">–</span>` : !known ? btn : cs ? html`${btn}${on || unk ? null : html`<div className="small muted">sin conexión</div>`}` : html`<span className="small muted">sin cámara</span>`}</td>`; })()}
        </tr>`; })}</tbody></table></div>
        <div className="ft-tl-legend small">
          <span>En la mini curva, eventos de cámara:</span>
          <span><i className="tri" style=${{ borderBottomColor: CAM_COLORS.fatiga }}></i>bostezo / fatiga</span>
          <span><i className="tri" style=${{ borderBottomColor: CAM_COLORS.distraccion }}></i>distracción</span>
          <span><i className="tri" style=${{ borderBottomColor: CAM_COLORS.salida_carril }}></i>salida de carril</span>
          <span>· pasá el mouse por un triángulo para ver hora y tipo</span>
        </div>`}
    ${cams && cams.size && cams.diag && cams.diag.statusErr ? html`<p className="small muted">Cámaras: ${cams.size} vehículos con cámara; el estado de conexión no está disponible (${cams.diag.statusErr}).</p>` : null}
    ${cams && !cams.size ? html`<p className="small muted">Cámaras: ${camErr ? "Geotab Video no respondió (" + camErr + ")" : cams.diag ? "Geotab Video devolvió " + cams.diag.total + " cámara(s), ninguna asociada a un vehículo" + (cams.diag.keys ? " (campos: " + cams.diag.keys + ")" : "") : "sin datos"}. El botón ▶ En vivo abre el reproductor de MyGeotab de cada vehículo.</p>` : null}
    ${watch ? html`<${Modal} wide title=${"Video en vivo · " + drvName(view, watch.drv) + " · " + devName(view, watch.dev)} onClose=${() => setWatch(null)}>
      <${LiveCam} api=${api} view=${view} dev=${watch.dev} auto=${true} />
    <//>` : null}
    <//>`;
  }

  // Tipos de corte entre viajes: parada breve, pausa, pausa larga (espera) y
  // el descanso entre jornadas (suficiente o corto).
  const GAP = {
    breve: { color: "#cfd4db", label: "Parada breve (menos de 15 min, no corta el manejo continuo)", word: "parada" },
    pausa: { color: "#8dbbee", label: "Pausa (15 min a 1 h)", word: "pausa" },
    larga: { color: "#b9a3e3", label: "Pausa larga o espera (1 h o más, sigue en jornada)", word: "espera" },
    ok: { color: "#6cc08f", label: "Descanso entre jornadas", word: "descanso" },
    dia: { color: "#f2c27a", label: "Descanso casi todo de día antes de un turno noche (se recupera menos)", word: "descanso de día" },
    corto: { color: "#ec7a6f", label: "Descanso más corto que el mínimo", word: "descanso corto" },
    motor: { color: "#b39478", label: "Descanso con el motor en marcha (durmió en la cabina: se recupera menos)", word: "descanso con motor" },
  };
  const restKind = (j, fz) => (j.restBefore < fz.min_rest ? "corto" : j.restEngine ? "motor" : j.type === "noche" && j.restDayFrac >= 0.7 ? "dia" : "ok");
  const PLACE_WORD = { base: "en la base", cliente: "en cliente", zona: "en", ruta: "fuera de geocercas" };
  const placeTxt = p => (!p ? "" : p.kind === "ruta" ? "fuera de geocercas (en ruta)" : p.name);
  function shiftGaps(j) {
    const out = [];
    for (let i = 1; i < j.trips.length; i++) {
      const a = j.trips[i - 1].e, b = j.trips[i].s;
      if (b - a < 60000) continue;
      const k = b - a < 15 * MIN ? "breve" : b - a < H ? "pausa" : "larga";
      out.push({ a, b, k });
    }
    return out;
  }

  // ---------- Línea de tiempo de una jornada ----------
  // Relato en palabras de la jornada (para leer antes del gráfico).
  function shiftStory(j, fz) {
    const parts = [];
    parts.push(html`Empezó el <b>${when(j.s)}</b> y terminó el <b>${when(j.e)}</b>: <b>${dur(j.span)}</b> de jornada, de las que manejó <b>${dur(j.dh)}</b> en ${j.trips.length} ${j.trips.length === 1 ? "viaje" : "viajes"} (${n0(j.span > 0 ? (j.dh / j.span) * 100 : 0)} %). `);
    const pz = (j.pauses || []).filter(([a, b]) => b - a >= 30 * MIN).sort((x, y) => (y[1] - y[0]) - (x[1] - x[0]));
    if (pz.length) parts.push(html`Pausas de 30 min o más: ${pz.slice(0, 4).map(([a, b]) => dur((b - a) / H) + " (" + hm(a) + "–" + hm(b) + ")").join(", ")}${pz.length > 4 ? " y otras" : ""}. `);
    if (pz.some(([a, b]) => b - a >= 3 * H)) parts.push(html`Una pausa de menos de ${fz.SPLIT / H} h no corta la jornada (Configuración → Fatiga y gravedad → Pausa que cierra una jornada). `);
    if (j.span > fz.max_span && j.span > 0 && j.dh / j.span < 0.45) parts.push(html`Mucha jornada con poco manejo suele ser espera (carga, descarga, cola): el conductor sigue en servicio y no descansa. `);
    if (j.waits && j.waits.length) parts.push(html`Esperas de 1 h o más: ${j.waits.map(w => dur(w.h) + " en " + placeTxt(w.place) + (w.idleH >= 0.5 ? " (" + dur(w.idleH) + " con motor en marcha)" : "")).join(", ")}. `);
    if (j.restMicro && j.restMicro.length) parts.push(html`Durante el descanso previo hubo ${j.restMicro.length === 1 ? "un movimiento mínimo" : j.restMicro.length + " movimientos mínimos"} (${j.restMicro.map(t => hm(t.s) + ", " + dur((t.e - t.s) / H) + ", " + GI.fmtNum(t.km || 0, 1) + " km").join("; ")}): se ignoran, no cortan el descanso. `);
    if (j.restHandover) parts.push(html`Mientras descansaba, el vehículo siguió trabajando ${j.restHandover.drv ? "con " + (GI.__drvName ? GI.__drvName(j.restHandover.drv) : j.restHandover.drv) : "sin conductor identificado"} desde las ${hm(j.restHandover.at)}: ese tiempo no cuenta como motor en marcha de su descanso. `);
    if (j.restBefore != null) parts.push(html`Antes había descansado <b>${dur(j.restBefore)}</b>${j.restPlace ? " " + (j.restPlace.kind === "ruta" ? "fuera de geocercas (en ruta)" : "en " + j.restPlace.name) : ""}${j.restEngine ? html`, <b>${dur(j.restIdleH)} con el motor en marcha</b>` : ""}. `);
    if (j.fiPeak != null) parts.push(html`Índice de fatiga: empezó en ${fiTag(j.fiStart, fz)} y llegó a ${fiTag(j.fiPeak, fz)} a las ${hm(j.fiPeakAt)}.`);
    return parts;
  }

  function Timeline({ j, fz }) {
    const t0 = j.prevE != null && j.s - j.prevE < 14 * H ? j.prevE - H : j.s - 2 * H;
    const t1 = j.e + 2 * H;
    const W = 1000, L = 112, R = 990, x = t => L + ((t - t0) / (t1 - t0)) * (R - L);
    const span = (t1 - t0) / H, step = span > 30 ? 4 : span > 16 ? 2 : 1;
    const Y = { head: 14, jor: 34, drv: 52, drvH: 22, ev: 92, fi0: 116, fi1: 206, axis: 212 };
    const fiY = v => Y.fi1 - (Math.min(140, v) / 140) * (Y.fi1 - Y.fi0);
    const ticks = [];
    const first = new Date(t0); first.setMinutes(0, 0, 0); first.setHours(first.getHours() + 1);
    for (let t = first.getTime(); t < t1; t += H) if (new Date(t).getHours() % step === 0) ticks.push(t);
    const nights = [];
    const d0 = new Date(t0); d0.setHours(0, 0, 0, 0);
    for (let d = d0.getTime(); d < t1; d += 86400000) {
      const at = h => { const z = new Date(d); z.setHours(h, 0, 0, 0); return z.getTime(); };
      nights.push([at(0), at(6), "n"], [at(2), at(5), "low"]);
    }
    const vis = ([a, b]) => b > t0 && a < t1;
    const clipX = (a, b) => [x(Math.max(a, t0)), x(Math.min(b, t1))];
    const cam = j.cam || [], other = (j.events || []).filter(e => !GI.FATIGUE_CAM_CATS.has(e.cat));
    const gaps = shiftGaps(j);
    const gapKinds = new Set(gaps.map(g => g.k));
    if (j.prevE != null) gapKinds.add(restKind(j, fz));
    // curva del índice
    let fiPath = "";
    if (j.sim) {
      const pts = [];
      for (let t = Math.max(t0, j.sim.t0); t <= t1; t += 15 * MIN) pts.push(x(t).toFixed(1) + "," + fiY(j.sim.at(t)).toFixed(1));
      fiPath = pts.length ? "M" + pts.join("L") : "";
    }
    const lane = (y, txt) => html`<text x="4" y=${y} className="ft-tl-lane">${txt}</text>`;
    const restFrom = j.prevE != null ? Math.max(j.prevE, t0) : null;
    return html`<div className="ft-tl">
      <svg viewBox=${"0 0 " + W + " 238"} role="img" aria-label="Línea de tiempo de la jornada">
        ${nights.filter(vis).map(([a, b, k], i) => { const [xa, xb] = clipX(a, b); return html`<rect key=${"n" + i} x=${xa} y=${Y.head + 6} width=${Math.max(0, xb - xa)} height=${Y.axis - Y.head - 6} fill=${k === "low" ? "#dfe3f3" : "#eff1f8"} />`; })}
        ${nights.filter(vis).map(([a, b, k], i) => { const [xa, xb] = clipX(a, b); return xb - xa > 50 ? html`<text key=${"nl" + i} x=${(xa + xb) / 2} y=${Y.axis - 4} textAnchor="middle" className=${"ft-tl-lab" + (k === "low" ? " b" : "")}>${k === "low" ? "02–05 h" : ""}</text>` : null; })}
        ${lane(Y.jor + 4, "Jornada")}
        ${lane(Y.drv + 15, "Manejo")}
        ${lane(Y.ev + 4, "Eventos")}
        ${lane((Y.fi0 + Y.fi1) / 2, "Índice de")}${lane((Y.fi0 + Y.fi1) / 2 + 13, "fatiga")}
        <line x1=${L} x2=${R} y1=${Y.drv - 8} y2=${Y.drv - 8} stroke="#e3e7ec" />
        <line x1=${L} x2=${R} y1=${Y.ev - 14} y2=${Y.ev - 14} stroke="#e3e7ec" />
        <line x1=${L} x2=${R} y1=${Y.fi0 - 10} y2=${Y.fi0 - 10} stroke="#e3e7ec" />

${restFrom != null && restFrom < j.s ? (() => { const g = GAP[restKind(j, fz)]; const w = x(j.s) - x(restFrom); return html`<g>
          <rect x=${x(restFrom)} y=${Y.drv} width=${Math.max(1, w)} height=${Y.drvH} fill=${g.color} opacity="0.85" />
          ${w > 70 ? html`<text x=${x(restFrom) + w / 2} y=${Y.drv + 15} textAnchor="middle" className="ft-tl-gap">${(j.prevE < t0 ? "← " : "") + g.word + " " + dur(j.restBefore)}</text>` : null}
          <title>${"Descanso previo de " + dur(j.restBefore) + " (" + when(j.prevE) + " a " + when(j.s) + ")" + (restKind(j, fz) === "corto" ? " — menos que el mínimo de " + fz.min_rest + " h" : restKind(j, fz) === "dia" ? " — casi todo de día, antes de un turno noche" : "")}</title></g>`; })() : null}
        <g>
          <line x1=${x(j.s)} x2=${x(j.e)} y1=${Y.jor} y2=${Y.jor} stroke="#1f2a37" strokeWidth="2.5" />
          <line x1=${x(j.s)} x2=${x(j.s)} y1=${Y.jor - 6} y2=${Y.axis} stroke="#1f2a37" strokeDasharray="2 3" />
          <line x1=${x(j.e)} x2=${x(j.e)} y1=${Y.jor - 6} y2=${Y.axis} stroke="#1f2a37" strokeDasharray="2 3" />
          <text x=${(x(j.s) + x(j.e)) / 2} y=${Y.jor - 5} textAnchor="middle" className="ft-tl-lab b">${"Jornada " + dur(j.span) + " · " + (GI.dayKey(j.e) !== j.dk ? when(j.s) + " → " + when(j.e) : hm(j.s) + " a " + hm(j.e))}</text>
        </g>

        ${j.prevE != null && j.prevE > t0 ? html`<g><rect x=${L} y=${Y.drv} width=${Math.max(2, x(j.prevE) - L)} height=${Y.drvH} rx="3" fill="#c3c9d2" /><text x=${L + 4} y=${Y.drv + Y.drvH + 12} className="ft-tl-lab">jornada anterior</text></g>` : null}
        ${gaps.map((g, i) => { const w = x(g.b) - x(g.a), G = GAP[g.k]; return html`<g key=${"p" + i}>
          <rect x=${x(g.a)} y=${Y.drv} width=${Math.max(1.5, w)} height=${Y.drvH} fill=${G.color} />
          ${w > 64 ? html`<text x=${x(g.a) + w / 2} y=${Y.drv + 15} textAnchor="middle" className="ft-tl-gap">${G.word + " " + dur((g.b - g.a) / H)}</text>` : null}
          <title>${G.label.split(" (")[0] + ": " + dur((g.b - g.a) / H) + " (" + hm(g.a) + "–" + hm(g.b) + ")"}</title></g>`; })}
        ${(j.restMicro || []).filter(t => t.e > t0).map((t, i) => html`<g key=${"m" + i}><rect x=${x(Math.max(t.s, t0)) - 1} y=${Y.drv - 3} width=${Math.max(2, x(t.e) - x(Math.max(t.s, t0)))} height=${Y.drvH + 6} fill="#5b6472" opacity="0.55" />
          <title>${"Movimiento mínimo ignorado: " + hm(t.s) + "–" + hm(t.e) + " · " + dur(t.dh) + " de manejo · " + GI.fmtNum(t.km || 0, 1) + " km (no corta el descanso)"}</title></g>`)}
        ${j.trips.map((t, i) => html`<rect key=${"t" + i} x=${x(t.s)} y=${Y.drv} width=${Math.max(2, x(t.e) - x(t.s))} height=${Y.drvH} rx="3" fill=${t.live ? "#2a78d6" : "#1f2a37"}><title>${"Viaje " + hm(t.s) + "–" + hm(t.e) + " · " + dur(t.dh) + " de manejo · " + n0(t.km) + " km"}</title></rect>`)}

        ${other.map((e, i) => html`<line key=${"o" + i} x1=${x(e.t)} x2=${x(e.t)} y1=${Y.ev - 6} y2=${Y.ev + 6} stroke="#7b8492" strokeWidth="2"><title>${hm(e.t) + " " + GI.catLabel(e.cat)}</title></line>`)}
        ${cam.map((e, i) => html`<path key=${"c" + i} d=${"M" + x(e.t) + " " + (Y.ev + 6) + " l-6 -11 h12 z"} fill=${CAM_COLORS[e.cat] || "#b93a0f"}><title>${hm(e.t) + " " + GI.catLabel(e.cat)}</title></path>`)}
        ${!cam.length && !other.length ? html`<text x=${L + 4} y=${Y.ev + 4} className="ft-tl-lab">sin infracciones</text>` : null}

        ${[fz.fi_mod, fz.fi_high].map((v, i) => html`<g key=${"th" + v}><line x1=${L} x2=${R} y1=${fiY(v)} y2=${fiY(v)} stroke=${i ? "#d4561e" : "#c99400"} strokeDasharray="4 4" strokeWidth="1" />
          <text x=${L + 4} y=${i ? fiY(v) - 3 : fiY(v) + 11} className="ft-tl-lab">${(i ? "alto " : "moderado ") + v}</text></g>`)}
        ${fiPath ? html`<path d=${fiPath} fill="none" stroke="#1f2a37" strokeWidth="2" />` : null}
        ${j.fiPeak != null ? html`<g><circle cx=${x(j.fiPeakAt)} cy=${fiY(j.fiPeak)} r="4" fill=${FI_COLORS[GI.fiLevel(j.fiPeak, fz)]} /><text x=${x(j.fiPeakAt) + 6} y=${fiY(j.fiPeak) - 4} className="ft-tl-lab b">${Math.round(j.fiPeak)}</text></g>` : null}

        <line x1=${L} x2=${R} y1=${Y.axis} y2=${Y.axis} stroke="#cdd3db" />
        ${ticks.map(t => html`<g key=${"k" + t}><line x1=${x(t)} x2=${x(t)} y1=${Y.axis} y2=${Y.axis + 5} stroke="#7b8492" /><text x=${x(t)} y=${Y.axis + 20} textAnchor="middle" className="ft-tl-tick">${new Date(t).getHours() === 0 ? dshort(t) : String(new Date(t).getHours()).padStart(2, "0") + " h"}</text></g>`)}
      </svg>
      <div className="ft-tl-legend small">
        <span><i style=${{ background: "#1f2a37" }}></i>Viaje</span>
        ${["breve", "pausa", "larga", "ok", "dia", "motor", "corto"].filter(k => gapKinds.has(k)).map(k => html`<span key=${k}><i style=${{ background: GAP[k].color }}></i>${k === "corto" ? "Descanso de menos de " + fz.min_rest + " h" : GAP[k].label}</span>`)}
        <span><i style=${{ background: "#eff1f8" }}></i>Noche (00–06 h)</span>
        <span><i style=${{ background: "#dfe3f3" }}></i>02–05 h, cuando más cuesta mantenerse despierto</span>
        <span><i className="tri" style=${{ borderBottomColor: CAM_COLORS.fatiga }}></i>Fatiga</span>
        <span><i className="tri" style=${{ borderBottomColor: CAM_COLORS.distraccion }}></i>Distracción</span>
        <span><i className="tri" style=${{ borderBottomColor: CAM_COLORS.salida_carril }}></i>Salida de carril</span>
        <span><i style=${{ background: "#7b8492", width: "3px" }}></i>Otras infracciones</span>
        ${(j.restMicro || []).length ? html`<span><i style=${{ background: "#5b6472", opacity: 0.55, width: "3px" }}></i>Movimiento mínimo ignorado (no corta el descanso)</span>` : null}
      </div>
    </div>`;
  }


  // ---------- Revisar identificación ----------
  // Jornadas de más de 20 h: en camiones con relevo, si un chofer no pasa su
  // llave su turno queda a nombre del anterior. El supervisor confirma qué pasó;
  // un relevo confirmado parte la jornada (solo en los cálculos del add-in).
  const isoLocal = t => { const d = new Date(t); const p = n => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes()); };
  function devHabits(shifts, dev, exceptKey) {
    // cómo trabajan los conductores en este vehículo: inicio típico, jornada típica y cuántas veces
    const by = new Map();
    for (const x of shifts) {
      if (x.key === exceptKey || x.devices[0] !== dev || x.span > 20) continue;
      if (!by.has(x.drv)) by.set(x.drv, []);
      by.get(x.drv).push(x);
    }
    return [...by.entries()].map(([drv, L]) => {
      const mins = L.map(x => { const d = new Date(x.s); return d.getHours() * 60 + d.getMinutes(); });
      const med = GI.median(mins.map(m => (m - 720 + 1440) % 1440));
      return { drv, n: L.length, startMin: (med + 720) % 1440, span: GI.median(L.map(x => x.span)), type: GI.median(L.map(x => (x.type === "noche" ? 1 : 0))) >= 0.5 ? "noche" : "día" };
    }).sort((a, b) => b.n - a.n);
  }
  const minTxt = m => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(Math.round(m % 60)).padStart(2, "0");
  const circDiff = (a, b) => { const d = Math.abs(a - b) % 1440; return Math.min(d, 1440 - d); };

  // Sugerencia por horario habitual (respaldo cuando no hay pruebas): el turno del otro chofer de este
  // vehículo dentro de la jornada; termina cuando se vuelve a pasar la llave del mismo conductor.
  function habitSuggest(j, shifts, keys) {
    const dev = j.devices[0];
    const habits = devHabits(shifts, dev, j.key);
    const others = habits.filter(h => h.drv !== j.drv);
    const sugOther = others.slice().sort((a, b) => b.n - a.n)[0];
    let from = null, to = null, reswipe = null;
    if (sugOther) {
      for (let d = new Date(j.s - 86400000).setHours(0, 0, 0, 0); d < j.e && from == null; d += 86400000) {
        const hs = d + sugOther.startMin * MIN;
        const st = Math.abs(hs - j.s) <= 2 * H ? j.s : hs;
        if (st < j.s || st > j.e - 2 * H) continue;
        reswipe = (keys || []).find(k => k.d === dev && k.r === j.drv && k.t > st + 3 * H && k.t < j.e - H) || null;
        from = st; to = reswipe ? reswipe.t : Math.min(j.e, st + sugOther.span * H);
      }
    }
    return { habits, others, habit: sugOther && from != null ? { drv: sugOther.drv, from, to } : null, reswipe };
  }
  const CONF = { alta: ["Relevo casi seguro", "alta"], media: ["Relevo probable", "media"], baja: ["Sin pruebas claras", "baja"] };
  const confTag = c => html`<span className=${"ft-id-conf " + c}>${c === "alta" ? "Alta" : c === "media" ? "Media" : "Baja"}</span>`;
  function inferFor(view, j, shifts, keys, trips) {
    const hs = habitSuggest(j, shifts, keys);
    let inf = null;
    try { inf = GI.identInfer ? GI.identInfer(j, trips || view.model.tripsByDevice, keys, { habit: hs.habit, others: hs.others }) : null; } catch (e) { console.warn("[Geotab Insights] identInfer", e); }
    return { hs, inf };
  }

  function IdentPanel({ view, api, j, shifts, rec, userName, onSaved, allTrips }) {
    const [keys, setKeys] = useState(null);
    useEffect(() => {
      let off = false;
      const load = GI.loadDriverChangesWindows ? GI.loadDriverChangesWindows(api, [[j.s - 6 * H, j.e + 3 * H]]).then(r => r[0])
        : GI.loadDriverChanges ? GI.loadDriverChanges(api, j.devices, j.s - 6 * H, j.e + 2 * H) : Promise.resolve([]);
      load.then(k => { if (!off) setKeys(k || []); }).catch(e => { console.warn("[Geotab Insights] llaves", e); if (!off) setKeys([]); });
      return () => { off = true; };
    }, [j.key]);
    const trips = allTrips || view.model.tripsByDevice;
    const { hs, inf } = useMemo(() => (keys ? inferFor(view, j, shifts, keys, trips) : { hs: habitSuggest(j, shifts, []), inf: null }), [keys, j.key, shifts]);
    const D = (inf && inf.D) || j.devices[0];
    const A = drvName(view, j.drv);
    const [mode, setMode] = useState("view");
    const [from, setFrom] = useState(rec && rec.outcome === "relevo" && rec.from ? rec.from : null);
    const [to, setTo] = useState(rec && rec.outcome === "relevo" && rec.at ? rec.at : null);
    const [other, setOther] = useState(rec && rec.outcome === "relevo" ? rec.other || "" : null);
    const [touched, setTouched] = useState(!!(rec && rec.outcome === "relevo"));
    const done = !!(rec && rec.outcome === "relevo" && rec.from);
    useEffect(() => {
      if (done) { setFrom(rec.from); setTo(rec.at); setOther(rec.other || ""); setTouched(true); return; }
      if (touched || !inf) return;
      if (inf.from != null) setFrom(inf.from);
      if (inf.to != null) setTo(inf.to);
      setOther(inf.other || "");
    }, [inf, rec]);
    // una jornada ya partida por un relevo guardado conserva la clave: se muestra la jornada original
    const js = done ? rec.s : j.s, je = done ? rec.e : j.e;
    const [busy, setBusy] = useState(false), [msg, setMsg] = useState(null);
    // Cancelar: vuelve a lo guardado o a lo que propone el add-in
    function reset() {
      if (rec && rec.outcome === "relevo" && rec.from) { setFrom(rec.from); setTo(rec.at); setOther(rec.other || ""); setTouched(true); return; }
      setTouched(false); setFrom(inf ? inf.from : null); setTo(inf ? inf.to : null); setOther(inf ? inf.other || "" : null);
    }
    async function save(outcome) {
      setBusy(true); setMsg(null);
      try {
        const relevo = outcome === "relevo";
        const r = { id: rec && rec.id, key: j.key, drv: j.drv, d: D, s: js, e: je, outcome, other: relevo ? other || null : null, from: relevo ? from : null, at: relevo ? to : null,
          conf: inf ? inf.conf : null, auto: relevo && inf && !touched ? true : false, by: userName || "" };
        onSaved(await GI.saveIdent(api, r));
        setMsg(relevo ? "Guardado: la jornada se partió en el relevo." : "Guardado.");
        setMode("view");
      } catch (e) { setMsg("No se pudo guardar: " + ((e && e.message) || e)); }
      setBusy(false);
    }
    const B = other ? drvName(view, other) : "otro conductor (sin identificar)";
    const conf = inf ? inf.conf : "baja";
    // ---- línea de tiempo por vehículo ----
    const t0 = js - 2 * H, t1 = je + 2 * H, span = t1 - t0;
    const pct = t => (((Math.max(t0, Math.min(t1, t)) - t0) / span) * 100);
    const rowsDev = [D, ...j.devices.filter(d => d !== D)];
    if (inf) for (const p of inf.proofs) if (p.dev && !rowsDev.includes(p.dev)) rowsDev.push(p.dev);
    const dTripsAll = (trips.get(D) || []);
    const segsOf = dev => {
      const L = (trips.get(dev) || []).filter(t => t.e > t0 && t.s < t1);
      const blocks = [];
      for (const t of L) {
        const inTramo = dev === D && t.r === j.drv && from != null && to != null && t.s >= from - MIN && t.s < to;
        const who = inTramo ? other || null : t.r || null;
        const cls = inTramo ? "inf" : t.r === j.drv ? "same" : t.r && t.r === other ? "oth" : t.r ? "x" : "none";
        const b = blocks[blocks.length - 1];
        if (b && b.cls === cls && b.who === who && t.s - b.e < 3 * H) { b.e = t.e; b.n++; continue; }
        blocks.push({ cls, who, s: t.s, e: t.e, n: 1 });
      }
      return blocks;
    };
    const segLabel = b => {
      const w = pct(b.e) - pct(b.s);
      const name = b.cls === "none" ? "sin conductor" : b.who ? drvName(view, b.who).split(/[ ,_]/)[0] : "otro";
      const txt = name + (b.cls === "inf" ? " · deducido" : b.cls === "same" || b.cls === "oth" ? "" : "") + " · " + hm(b.s) + " → " + hm(b.e);
      return w > txt.length * 0.62 ? txt : w > name.length * 0.75 ? name : "";
    };
    const tm = t => (GI.dayKey(t) !== GI.dayKey(j.s) ? dshort(t) + " " : "") + hm(t);
    const ticks = [];
    for (let t = new Date(t0).setMinutes(0, 0, 0) + H; t < t1; t += H) if (new Date(t).getHours() % 4 === 0) ticks.push(t);
    // arrastre de los bordes del tramo (se pegan al inicio de un viaje del vehículo)
    const trackRef = useRef(null);
    const snaps = inf && !done ? inf.snaps : dTripsAll.filter(t => t.s >= js - MIN && t.s <= je).map(t => t.s).concat([je]);
    const onDrag = which => e => {
      if (!trackRef.current || !(e.buttons & 1)) return;
      const r = trackRef.current.getBoundingClientRect();
      const t = t0 + ((e.clientX - r.left) / r.width) * span;
      let best = null;
      for (const x of snaps) if (best == null || Math.abs(x - t) < Math.abs(best - t)) best = x;
      if (best == null) return;
      setTouched(true);
      if (which === "from" && (to == null || best < to)) setFrom(best);
      if (which === "to" && (from == null || best > from)) setTo(best);
    };
    const grab = e => { try { e.currentTarget.setPointerCapture(e.pointerId); } catch (x) {} };
    const tramo = from != null && to != null ? dTripsAll.filter(t => t.r === j.drv && t.s >= from - MIN && t.s < to) : [];
    const shownProofs = done ? [] : inf ? inf.proofs : [];
    const tramoKm = tramo.reduce((a, t) => a + (t.km || 0), 0);
    const proofCards = shownProofs.length ? shownProofs.slice().sort((a, b) => (a.t || Infinity) - (b.t || Infinity)).map(p => {
      const dn = d => devName(view, d), nm = r => drvName(view, r);
      const m = p.km != null ? (p.km < 1 ? Math.round(p.km * 1000) + " m" : GI.fmtNum(p.km, 1) + " km") : null;
      if (p.kind === "llegada") return { tag: p.stays ? "Prueba fuerte" : "Pista", strong: p.stays, title: nm(p.drv) + " llegó al vehículo",
        text: tm(p.t) + ": " + dn(p.dev) + " con su llave se detuvo junto al " + dn(D) + (m ? " (a " + m + ")" : "") + ". El " + dn(D) + " arrancó a las " + hm(p.dep) + "." + (p.leftWith ? " " + dn(p.dev) + " se fue después con " + nm(p.leftWith) + "." : !p.stays ? " Después se fue en " + dn(p.dev) + ": puede haber sido solo una visita." : "") };
      if (p.kind === "lejos") return { tag: "Prueba fuerte", strong: true, title: A + " estaba en otro vehículo",
        text: tm(p.t) + ": pasó su llave en " + dn(p.dev) + (p.moving ? " mientras el " + dn(D) + " andaba." : ", a " + m + " del " + dn(D) + ".") };
      if (p.kind === "vuelve") return { tag: "Confirma", title: A + " volvió al vehículo",
        text: p.how === "llave" ? tm(p.t) + ": se volvió a pasar su llave en el " + dn(D) + "." : tm(p.t) + ": llegó al " + dn(D) + " en " + dn(p.dev) + "." };
      if (p.kind === "salida") return { tag: "Confirma", title: nm(p.drv) + " se fue del vehículo",
        text: tm(p.t) + ": pasó su llave en " + dn(p.dev) + ", junto al " + dn(D) + "." };
      if (p.kind === "estilo") return { tag: "Confirma", title: "Cambió la forma de manejar",
        text: "Velocidad media manejando: " + Math.round(p.vOut) + " km/h el resto de la jornada, " + Math.round(p.vIn) + " km/h en el tramo." };
      return { tag: "Pista", title: "Horario habitual", text: "En el " + dn(D) + ", " + nm(p.drv) + " suele trabajar en este horario. No hay otras pruebas: puede ser un relevo o un doble turno real." };
    }) : [];
    // marcas de las pruebas; las que caen muy cerca se juntan en una sola etiqueta
    const marks = [];
    for (const p of shownProofs.filter(p => p.t && p.kind !== "estilo").sort((a, b) => a.t - b.t)) {
      const m = marks[marks.length - 1];
      if (m && pct(p.t) - pct(m.t) < 5) { if (!m.lab.includes(hm(p.t))) m.lab += " · " + hm(p.t); } else marks.push({ t: p.t, lab: hm(p.t) });
    }
    const cands = inf ? inf.candidates : (hs.others || []).map(h => ({ drv: h.drv, why: "habito", h }));
    const whyTxt = c => c.why === "llego" ? "Llegó al vehículo a las " + hm(c.t) + " y se quedó." : c.why === "paso" ? "Pasó por el vehículo a las " + hm(c.t) + ", pero se fue enseguida."
      : c.why === "salio" ? "Se fue del vehículo a las " + hm(c.t) + "." : c.h ? "Suele empezar a las " + minTxt(c.h.startMin) + " en este vehículo (" + c.h.n + " jornadas)." : "";
    const allDrivers = useMemo(() => [...(view.model.driverName || new Map()).entries()].filter(([id]) => id !== j.drv).sort((a, b) => String(a[1]).localeCompare(String(b[1]))), [view]);
    const valid = from != null && to != null && to > from;
    return html`<div className="ft-ident">
      <div className="ft-id-head"><h3>¿Quién manejó esta jornada?</h3>${done ? html`<span className="ft-id-badge alta">Relevo confirmado</span>` : keys == null ? html`<span className="small muted">Buscando pruebas…</span>` : html`<span className=${"ft-id-badge " + conf}>${CONF[conf][0]}</span>`}</div>
      ${rec ? html`<div className="ft-id-done">Revisado${rec.by ? " por " + rec.by : ""}${rec.updated_at ? " el " + new Date(rec.updated_at).toLocaleDateString("es-AR") : ""}: <b>${identWord(view, rec)}</b></div>` : null}
      <p className="ft-id-verdict">El sistema le asignó a ${A} <b>${dur((je - js) / H)}</b> de jornada en el ${devName(view, D)}, sin un corte que la cierre.
        ${done && valid ? html` Confirmado: <b>desde el ${when(from)} hasta el ${when(to)} manejó ${B}</b>.`
          : valid && conf !== "baja" ? html` Lo más probable es que <b>desde el ${when(from)} hasta el ${when(to)} manejó ${B}</b>, sin pasar su llave.`
          : valid ? html` Puede ser un relevo sin identificar o un doble turno real. Si fue relevo, por su horario habitual sería ${B} de ${tm(from)} a ${tm(to)}.`
          : keys == null ? "" : " No se encontraron pruebas de un relevo: puede ser un doble turno real."}</p>
      ${proofCards.length ? html`<div className="ft-id-proofs">${proofCards.map((c, i) => html`<div key=${i} className="ft-id-proof">
        <span className=${"ft-id-tag" + (c.strong ? " strong" : "")}>${c.tag}</span><b>${c.title}</b><span>${c.text}</span></div>`)}</div>` : null}
      <div className="ft-id-tl">
        ${rowsDev.slice(0, 5).map(dev => html`<div key=${dev} className="ft-id-row"><span className="ft-id-lab">${devName(view, dev)}</span>
          <div className="ft-id-track" ref=${dev === D ? trackRef : null}>
            ${segsOf(dev).map((b, i) => html`<span key=${i} className=${"ft-id-seg " + b.cls} style=${{ left: pct(b.s) + "%", width: Math.max(0.3, pct(b.e) - pct(b.s)) + "%" }}
              title=${(b.cls === "none" ? "Sin conductor identificado" : (b.who ? drvName(view, b.who) : "Otro conductor") + (b.cls === "inf" ? " (deducido: sin su llave)" : "")) + " · " + tm(b.s) + " → " + tm(b.e) + " · " + b.n + " viaje" + (b.n === 1 ? "" : "s")}>${segLabel(b)}</span>`)}
            ${dev === D && mode === "adjust" && valid ? html`
              <button type="button" className="ft-id-handle" style=${{ left: pct(from) + "%" }} aria-label="Mover el inicio del tramo" onPointerDown=${grab} onPointerMove=${onDrag("from")}></button>
              <button type="button" className="ft-id-handle" style=${{ left: pct(to) + "%" }} aria-label="Mover el fin del tramo" onPointerDown=${grab} onPointerMove=${onDrag("to")}></button>` : null}
          </div></div>`)}
        ${marks.length ? html`<div className="ft-id-row"><span></span><div className="ft-id-marks">${marks.map((p, i) => html`<span key=${i} className="ft-id-mark" style=${{ left: pct(p.t) + "%" }}><i></i>${p.lab}</span>`)}</div></div>` : null}
        <div className="ft-id-row"><span></span><div className="ft-ident-axis">${ticks.map(t => html`<span key=${t} style=${{ left: pct(t) + "%" }}>${new Date(t).getHours() === 0 ? dshort(t) : String(new Date(t).getHours()).padStart(2, "0") + " h"}</span>`)}</div></div>
        <div className="ft-id-legend small"><span><i className="same"></i>${A.split(/[ ,_]/)[0]} (con llave)</span><span><i className="inf"></i>${other ? drvName(view, other).split(/[ ,_]/)[0] : "Otro"} (deducido)</span><span><i className="oth"></i>${other ? drvName(view, other).split(/[ ,_]/)[0] : "Otro"} (con llave)</span><span><i className="x"></i>otros conductores</span><span><i className="none"></i>sin conductor</span></div>
      </div>
      ${mode === "adjust" ? html`<div className="ft-id-adjust">
        <p className="small muted">Arrastrá los bordes del tramo en la fila del ${devName(view, D)}: se pegan al inicio de un viaje. O escribí la hora.</p>
        <div className="ft-ident-fields">
          <label>Desde<input type="datetime-local" value=${from != null ? isoLocal(from) : ""} min=${isoLocal(js)} max=${isoLocal(je)} onInput=${e => { setTouched(true); setFrom(e.target.value ? new Date(e.target.value).getTime() : null); }} /></label>
          <label>Hasta<input type="datetime-local" value=${to != null ? isoLocal(to) : ""} min=${isoLocal(js)} max=${isoLocal(je)} onInput=${e => { setTouched(true); setTo(e.target.value ? new Date(e.target.value).getTime() : null); }} /></label>
        </div>
        <b>¿Quién manejó?</b>
        <div className="ft-id-cands">
          ${cands.map(c => html`<label key=${c.drv} className=${"ft-id-cand" + (other === c.drv ? " on" : "")}><input type="radio" name=${"who" + j.key} checked=${other === c.drv} onChange=${() => { setTouched(true); setOther(c.drv); }} />
            <span><b>${drvName(view, c.drv)}</b>${inf && inf.other === c.drv ? " · sugerido" : ""}<br /><span className="muted">${whyTxt(c)}</span></span></label>`)}
          <label className=${"ft-id-cand" + (other != null && !cands.some(c => c.drv === other) ? " on" : "")}><input type="radio" name=${"who" + j.key} checked=${other != null && !cands.some(c => c.drv === other)} onChange=${() => { setTouched(true); setOther(""); }} />
            <span><b>Otro conductor</b><br /><select value=${other && !cands.some(c => c.drv === other) ? other : ""} onChange=${e => { setTouched(true); setOther(e.target.value); }}>
              <option value="">Sin identificar</option>${allDrivers.map(([id, n]) => html`<option key=${id} value=${id}>${n}</option>`)}</select></span></label>
        </div>
      </div>` : null}
      <div className="ft-id-actions">
        ${valid && !(done && mode !== "adjust") ? html`<button className="btn primary" disabled=${busy} onClick=${() => save("relevo")}>${mode === "adjust" ? "Guardar" : "Confirmar: " + tm(from) + " → " + tm(to) + " manejó " + (other ? drvName(view, other) : "otro conductor")}</button>` : null}
        <button className="btn" onClick=${() => { if (mode === "adjust") { setMode("view"); reset(); } else { setMode("adjust"); if (!valid) { setFrom(js + (je - js) / 2); setTo(je); setOther(""); } } }}>${mode === "adjust" ? "Cancelar" : valid ? "Ajustar tramo" : "Marcar un relevo a mano"}</button>
        <button className="btn" disabled=${busy} onClick=${() => save("doble")}>No es relevo: hizo doble turno</button>
        <button className="btn" disabled=${busy} onClick=${() => save("nose")}>No sé</button>
        ${msg ? html`<span className="small">${msg}</span>` : null}
      </div>
      ${valid && !done ? html`<p className="small muted">Al confirmar, el tramo (${dur((to - from) / H)}, ${tramo.length} viaje${tramo.length === 1 ? "" : "s"}, ${n0(tramoKm)} km) pasa a <b>${B}</b> y ${A} queda con ${dur((from - j.s) / H)} de jornada antes del relevo. Solo cambia en los cálculos del add-in, no en MyGeotab.</p>` : null}
      <details className="ft-id-more"><summary>Ver llaves y viajes en detalle</summary>
        <${IdentKeys} view=${view} j=${j} D=${D} keys=${keys} from=${valid ? from : null} to=${valid ? to : null} hs=${hs} />
      </details>
    </div>`;
  }
  // Detalle: llaves de los vehículos de la jornada en franjas y lista de cambios (vista anterior)
  function IdentKeys({ view, j, D, keys, from, to, hs }) {
    const t0 = j.s - 2 * H, t1 = j.e + 2 * H, X = t => (((Math.max(t0, Math.min(t1, t)) - t0) / (t1 - t0)) * 100).toFixed(2) + "%";
    const tm = t => (GI.dayKey(t) !== GI.dayKey(j.s) ? dshort(t) + " " : "") + hm(t);
    const allKeys = (keys || []).filter(k => j.devices.includes(k.d) && k.t <= t1).sort((a, b) => a.t - b.t);
    const groups = [];
    for (const k of allKeys) {
      const g = groups[groups.length - 1];
      if (g && g.r === (k.r || null)) continue;
      if (g) g.b = k.t;
      groups.push({ r: k.r || null, a: k.t, b: t1 });
    }
    const shown = groups.filter(g => g.b > t0);
    const otherIds = [...new Set(shown.filter(g => g.r && g.r !== j.drv).map(g => g.r))];
    const lanes = [{ r: j.drv, label: "Llave " + drvName(view, j.drv).split(" ")[0], cls: "same" }, { r: null, label: "Sin conductor", cls: "none" },
      ...otherIds.map(r => ({ r, label: "Llave " + drvName(view, r).split(" ")[0], cls: "other" }))];
    const rows = shown.map(g => ({ t: Math.max(g.a, t0), txt: tm(Math.max(g.a, t0)) + " → " + (g.b >= t1 ? "fin" : tm(g.b)), who: g.r ? drvName(view, g.r) : "Sin conductor" }));
    if (from && to) rows.push({ t: from + 1, txt: tm(from) + " → " + tm(to), who: "Tramo que probablemente manejó otro chofer", doubt: true });
    rows.sort((a, b) => a.t - b.t);
    const habits = hs.habits || [];
    return html`<div className="ft-ident-detail">
      <div className="ft-ident-tl">
        ${keys == null ? html`<span className="muted small">Buscando identificaciones…</span>` : !shown.length ? html`<span className="muted small">Sin registros de identificación en ${j.devices.map(d => devName(view, d)).join(", ")} en este rango.</span>`
          : lanes.map(l => html`<div key=${l.r || "none"} className="ft-ident-lane"><span className="ft-ident-lab">${l.label}</span><div className="ft-ident-track kband">
            ${shown.filter(g => g.r === l.r).map((g, i) => html`<span key=${i} className=${"ft-kband " + l.cls} style=${{ left: X(g.a), width: "calc(" + X(g.b) + " - " + X(g.a) + ")" }} title=${tm(Math.max(g.a, t0)) + " → " + (g.b >= t1 ? "fin" : tm(g.b))}></span>`)}
          </div></div>`)}
        <div className="ft-ident-lane"><span className="ft-ident-lab">Manejo a nombre de ${drvName(view, j.drv).split(" ")[0]}</span><div className="ft-ident-track">
          ${from && to ? html`<span className="ft-ident-doubt" style=${{ left: X(from), width: "calc(" + X(to) + " - " + X(from) + ")" }}></span>` : null}
          ${j.trips.map((t, i) => html`<span key=${i} className="ft-ident-trip" style=${{ left: X(t.s), width: "calc(" + X(t.e) + " - " + X(t.s) + ")" }} title=${devName(view, t.d) + " · " + tm(t.s) + " → " + tm(t.e)}></span>`)}
        </div></div>
      </div>
      ${rows.length ? html`<div className="ft-klist"><b>Cambios de llave (${j.devices.map(d => devName(view, d)).join(", ")})</b>
        ${rows.map((r, i) => html`<div key=${i} className=${"ft-klist-row" + (r.doubt ? " gap" : "")}><span>${r.txt}</span><span>${r.who}</span></div>`)}</div>` : null}
      ${habits.length ? html`<p className="small muted">En ${devName(view, D)}, los otros días: ${habits.slice(0, 3).map(h => drvName(view, h.drv) + " suele empezar a las " + minTxt(h.startMin) + " (turno " + h.type + ", ~" + dur(h.span) + ", " + h.n + " jornadas)").join("; ")}.</p>` : null}
    </div>`;
  }
  const identWord = (view, r) => (!r ? null : r.outcome === "relevo" ? "Relevo: " + (r.other ? drvName(view, r.other) : "sin identificar") + (r.at ? " " + hm(r.from || r.s) + "–" + hm(r.at) : "") : r.outcome === "doble" ? "Doble turno real" : "No se sabe");

  // ---------- Ficha de un caso (una jornada) ----------
  function CaseDetail({ view, api, j, fz, rec, userName, onSaved, onClose, onDriver, shifts, identRec, onIdent, allTrips }) {
    const [f, setF] = useState(() => ({ status: (rec && rec.status) || "Detectado", owner: (rec && rec.owner) || "", action: (rec && rec.action) || "", notes: (rec && rec.notes) || [] }));
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false), [err, setErr] = useState(null), [ok, setOk] = useState(false);
    async function save() {
      setBusy(true); setErr(null); setOk(false);
      try {
        const notes = note.trim() ? [...f.notes, { t: Date.now(), user: userName || "", text: note.trim() }] : f.notes;
        const saved = await GI.saveFatigueCase(api, { id: rec && rec.id, first_at: rec && rec.first_at, key: j.key, drv: j.drv, s: j.s, dk: j.dk, level: j.level, signals: j.signals.map(x => x.key),
          status: f.status, owner: f.owner, action: f.action, notes, by: userName || "" });
        setF(x => ({ ...x, notes })); setNote(""); setOk(true); onSaved(saved);
      } catch (e) { setErr(String((e && e.message) || e)); }
      setBusy(false);
    }
    const has = k => j.signals.some(s => s.key === k);
    const facts = [
      ["Jornada", dur(j.span), has("larga")],
      ["Manejo", dur(j.dh), has("manejo")],
      ["Manejo continuo máx.", dur(j.maxStint), has("continuo")],
      ["Entre 02 y 05 h", dur(j.low), has("madrugada")],
      ["Descanso previo", j.restBefore != null ? dur(j.restBefore) : "–", has("descanso")],
      ["Días seguidos", n0(j.daysRow), has("seguidos")],
      ["Índice de fatiga máx.", j.fiPeak != null ? String(Math.round(j.fiPeak)) : "–", has("indice")],
    ];
    return html`<${Modal} wide title=${drvName(view, j.drv) + " · jornada del " + dshort(j.s)} onClose=${onClose}>
      <div className="ft-case-head">
        ${levelTag(j.level)}
        <span>Turno ${j.type} · ${j.devices.map(d => devName(view, d)).join(", ")} · ${n0(j.km)} km</span>
        <span className="ft-case-links">
          <button className="btn small" onClick=${() => onDriver(j.drv)}>Ficha de fatiga del conductor</button>
          <button className="btn small" onClick=${() => GI.openEventsPage({ driverIds: [j.drv], deviceIds: j.devices, from: j.dk, to: GI.dayKey(j.e) })}>Eventos en MyGeotab ↗</button>
        </span>
      </div>
      ${(j.signals.some(x => x.key === "ident") || identRec) && onIdent ? html`<${IdentPanel} view=${view} api=${api} j=${j} shifts=${shifts || []} rec=${identRec} userName=${userName} onSaved=${onIdent} allTrips=${allTrips} />` : null}
      <p className="ft-story">${shiftStory(j, fz)}</p>
      ${j.signals.length ? html`<ul className="ft-why">${j.signals.map(s => html`<li key=${s.key}><span className=${"ft-sig" + (s.key === "camara" ? " cam" : "")}>${s.label}</span> ${s.text}</li>`)}</ul>` : html`<p className="muted">Esta jornada no tiene señales de fatiga.</p>`}
      <${Timeline} j=${j} fz=${fz} />
      <div className="ft-facts">${facts.map(([l, v, bad]) => html`<div key=${l} className=${bad ? "bad" : ""}><span>${l}</span><b>${v}</b></div>`)}</div>
      <div className="ft-follow">
        <h3>Seguimiento</h3>
        <div className="form">
          <label>Estado <${Segmented} value=${f.status} onChange=${v => setF(x => ({ ...x, status: v }))} options=${STATUS.map(s => ({ value: s, label: s }))} /></label>
          <div className="grid-2">
            <label>Responsable <input value=${f.owner} placeholder=${userName || "Nombre"} onInput=${e => setF(x => ({ ...x, owner: e.target.value }))} /></label>
            <label>Acción <select value=${f.action} onChange=${e => setF(x => ({ ...x, action: e.target.value }))}>${ACTIONS.map(a => html`<option key=${a} value=${a}>${a || "Sin definir"}</option>`)}</select></label>
          </div>
          ${f.notes.length ? html`<ul className="ft-notes">${f.notes.map((n, i) => html`<li key=${i}><span className="muted small">${new Date(n.t).toLocaleString("es-AR")}${n.user ? " · " + n.user : ""}</span><div>${n.text}</div></li>`)}</ul>` : null}
          <label>Comentario <textarea rows="2" value=${note} placeholder="Qué se habló con el conductor, qué se decidió…" onInput=${e => setNote(e.target.value)}></textarea></label>
          <div className="form-actions">
            <button className="btn primary" disabled=${busy} onClick=${save}>${busy ? "Guardando…" : "Guardar seguimiento"}</button>
            ${ok ? html`<span className="delta good">Guardado</span>` : null}
            ${err ? html`<span className="delta bad">No se pudo guardar: ${err}</span>` : null}
          </div>
          <p className="muted small">El seguimiento se guarda en MyGeotab y lo ven los demás usuarios del add-in.</p>
        </div>
      </div>
    <//>`;
  }

  // ---------- Ficha de fatiga del conductor ----------
  // Patrón de jornadas: una fila por día (0 a 24 h); cada viaje coloreado
  // según el índice de fatiga en ese momento.
  function ShiftPattern({ list, fz, days, onCase }) {
    const end = new Date(); end.setHours(0, 0, 0, 0);
    const dayList = [];
    for (let i = days - 1; i >= 0; i--) dayList.push(end.getTime() - i * 86400000);
    const L = 92, R = 940, W = 1000, RH = 20;
    const x = h => L + (h / 24) * (R - L);
    const H0 = 18, Ht = H0 + dayList.length * RH;
    const segs = [];
    for (const j of list) for (const t of j.trips) {
      for (let a = t.s; a < t.e;) {
        const d = new Date(a); d.setHours(0, 0, 0, 0);
        const dayEnd = d.getTime() + 86400000, b = Math.min(t.e, dayEnd);
        const row = dayList.indexOf(d.getTime());
        if (row >= 0) {
          const v = j.sim ? j.sim.at((a + b) / 2) : null;
          segs.push({ row, h0: (a - d.getTime()) / H, h1: (b - d.getTime()) / H, color: v == null ? "#1f2a37" : FI_COLORS[GI.fiLevel(v, fz)], j, v });
        }
        a = b;
      }
    }
    const gsegs = [];
    for (const j of list) for (const g of shiftGaps(j)) {
      if (g.k === "breve") continue;
      for (let a = g.a; a < g.b;) {
        const d = new Date(a); d.setHours(0, 0, 0, 0);
        const b = Math.min(g.b, d.getTime() + 86400000), row = dayList.indexOf(d.getTime());
        if (row >= 0) gsegs.push({ row, h0: (a - d.getTime()) / H, h1: (b - d.getTime()) / H, k: g.k, g });
        a = b;
      }
    }
    const peaks = new Map();
    for (const j of list) { const d = new Date(j.s); d.setHours(0, 0, 0, 0); const r = dayList.indexOf(d.getTime()); if (r >= 0 && j.fiPeak != null) peaks.set(r, Math.max(peaks.get(r) || 0, j.fiPeak)); }
    const cams = [];
    for (const j of list) for (const e of j.cam || []) { const d = new Date(e.t); d.setHours(0, 0, 0, 0); const r = dayList.indexOf(d.getTime()); if (r >= 0) cams.push({ row: r, h: (e.t - d.getTime()) / H, cat: e.cat }); }
    return html`<div className="ft-tl">
      <svg viewBox=${"0 0 " + W + " " + (Ht + 8)} role="img" aria-label="Patrón de jornadas por día">
        <rect x=${x(0)} y=${H0} width=${x(6) - x(0)} height=${Ht - H0} fill="#eff1f8" />
        <rect x=${x(2)} y=${H0} width=${x(5) - x(2)} height=${Ht - H0} fill="#dfe3f3" />
        <rect x=${x(22)} y=${H0} width=${x(24) - x(22)} height=${Ht - H0} fill="#eff1f8" />
        ${[0, 3, 6, 9, 12, 15, 18, 21, 24].map(h => html`<g key=${"h" + h}><line x1=${x(h)} x2=${x(h)} y1=${H0 - 4} y2=${Ht} stroke="#e3e7ec" /><text x=${x(h)} y=${H0 - 6} textAnchor="middle" className="ft-tl-tick">${String(h).padStart(2, "0")} h</text></g>`)}
        <text x=${R + 30} y=${H0 - 6} textAnchor="middle" className="ft-tl-tick">índice</text>
        ${dayList.map((d, i) => html`<g key=${"d" + i}>
          <text x="4" y=${H0 + i * RH + 14} className="ft-tl-lane">${dshort(d)}</text>
          <line x1=${L} x2=${R} y1=${H0 + (i + 1) * RH} y2=${H0 + (i + 1) * RH} stroke="#f0f2f5" />
          ${peaks.has(i) ? html`<text x=${R + 30} y=${H0 + i * RH + 14} textAnchor="middle" className="ft-tl-lab b" fill=${FI_COLORS[GI.fiLevel(peaks.get(i), fz)]}>${Math.round(peaks.get(i))}</text>` : null}
        </g>`)}
        ${gsegs.map((s, i) => html`<rect key=${"g" + i} x=${x(s.h0)} y=${H0 + s.row * RH + 7} width=${Math.max(1.5, x(s.h1) - x(s.h0))} height=${RH - 14} fill=${GAP[s.k].color}><title>${GAP[s.k].label.split(" (")[0] + ": " + dur((s.g.b - s.g.a) / H) + " (" + hm(s.g.a) + "–" + hm(s.g.b) + ")"}</title></rect>`)}
        ${segs.map((s, i) => html`<rect key=${"s" + i} x=${x(s.h0)} y=${H0 + s.row * RH + 4} width=${Math.max(1.5, x(s.h1) - x(s.h0))} height=${RH - 8} rx="2" fill=${s.color} style=${{ cursor: "pointer" }} onClick=${() => onCase(s.j)}>
          <title>${"Jornada del " + dshort(s.j.s) + (s.v != null ? " · índice " + Math.round(s.v) : "") + " (click para ver la jornada)"}</title></rect>`)}
        ${cams.map((c, i) => html`<path key=${"c" + i} d=${"M" + x(c.h) + " " + (H0 + c.row * RH + 3) + " l-4 -7 h8 z"} fill=${CAM_COLORS[c.cat] || "#b93a0f"} />`)}
      </svg>
      <div className="ft-tl-legend small">
        <span>Cada fila es un día y cada barra un viaje, coloreado según el índice de fatiga en ese momento:</span>
        <span><i style=${{ background: FI_COLORS.bajo }}></i>bajo</span>
        <span><i style=${{ background: FI_COLORS.moderado }}></i>moderado (${fz.fi_mod}+)</span>
        <span><i style=${{ background: FI_COLORS.alto }}></i>alto (${fz.fi_high}+)</span>
        <span><i style=${{ background: FI_COLORS["muy alto"] }}></i>muy alto (${fz.fi_high + 20}+)</span>
        <span><i className="tri" style=${{ borderBottomColor: CAM_COLORS.fatiga }}></i>evento de cámara</span>
        <span>· Cortes dentro de la jornada:</span>
        <span><i style=${{ background: GAP.pausa.color }}></i>pausa (15 min a 1 h)</span>
        <span><i style=${{ background: GAP.larga.color }}></i>pausa larga o espera (1 h o más)</span>
      </div>
    </div>`;
  }

  function RosterBox({ api, id, rs, roster, isAdmin, userName, onRoster }) {
    const PRE = ["14x7", "7x7", "21x7", "14x14", "10x5", "7x3", "4x4", "5x2"];
    const cur = roster ? (roster.none ? "none" : roster.work + "x" + roster.off) : "auto";
    const [v, setV] = useState(PRE.includes(cur) || cur === "auto" || cur === "none" ? cur : "otro");
    const [w, setW] = useState(roster && roster.work ? roster.work : 14), [o, setO] = useState(roster && roster.off ? roster.off : 7);
    const [busy, setBusy] = useState(false), [msg, setMsg] = useState(null);
    async function save() {
      setBusy(true); setMsg(null);
      try {
        if (v === "auto") { if (roster && roster.id) await GI.removeRoster(api, roster.id); onRoster({ drv: id, removed: true }); }
        else {
          const [ww, oo] = v === "otro" ? [+w, +o] : v === "none" ? [0, 0] : v.split("x").map(Number);
          onRoster(await GI.saveRoster(api, { id: roster && roster.id, drv: id, work: ww, off: oo, none: v === "none", by: userName }));
        }
        setMsg("Guardado");
      } catch (e) { setMsg("No se pudo guardar: " + ((e && e.message) || e)); }
      setBusy(false);
    }
    const blocks = rs ? rs.blocks.slice(-6).reverse() : [];
    return html`<div className="ft-roster">
      <div><b>Diagrama:</b> ${rs && rs.work ? html`<span className="tag">${rs.label}</span> ${rs.source === "auto" ? html`<span className="muted small">detectado de ${rs.cycles} ${rs.cycles === 1 ? "vuelta" : "vueltas"}</span>` : html`<span className="muted small">fijado a mano</span>`}
        · ${rs.inFranco ? "de franco, vuelve el " + (rs.backAt ? dshort(rs.backAt) : "–") : "día " + rs.curDay + " de " + rs.work}` : html`<span className="muted">${roster && roster.none ? "sin diagrama (fijado a mano)" : "no se detecta un diagrama por vueltas"}</span>`}</div>
      ${isAdmin ? html`<div className="ft-roster-edit">
        <select value=${v} onChange=${e => setV(e.target.value)} aria-label="Diagrama">
          <option value="auto">Automático (según sus viajes)</option>
          ${PRE.map(k => html`<option key=${k} value=${k}>${k}</option>`)}
          <option value="otro">Otro…</option>
          <option value="none">Sin diagrama (semana normal)</option>
        </select>
        ${v === "otro" ? html`<input type="number" min="1" max="60" value=${w} onInput=${e => setW(e.target.value)} aria-label="Días de trabajo" /> x <input type="number" min="0" max="60" value=${o} onInput=${e => setO(e.target.value)} aria-label="Días de franco" />` : null}
        <button className="btn small" disabled=${busy} onClick=${save}>${busy ? "Guardando…" : "Guardar"}</button>
        ${msg ? html`<span className="small">${msg}</span>` : null}
      </div>` : null}
      ${blocks.length > 1 ? html`<div className="small muted ft-roster-blocks">Últimas vueltas: ${blocks.map((b, i) => html`<span key=${i}>${dshort((b.start * 86400000) + new Date(b.start * 86400000).getTimezoneOffset() * 60000)}: ${b.end - b.start + 1} días${b.offBefore != null ? " (franco previo " + b.offBefore + ")" : ""}${i < blocks.length - 1 ? " · " : ""}</span>`)}</div>` : null}
    </div>`;
  }

  function FatigueDriver({ view, id, res, cases, now, status, acks, onClose, onCase, onSafety, api, isAdmin, userName, roster, onRoster }) {
    const fz = res.limits;
    const [days, setDays] = useState(14);
    const s = res.sims.get(id);
    const list = s ? s.list : [];
    const done = list.filter(j => !j.open);
    const rests = list.map(j => j.restBefore).filter(v => v != null && v < 48);
    const withRest = list.filter(j => j.restBefore != null && j.restBefore < 48);
    const knowsBase = list.some(j => j.restPlace && j.restPlace.kind === "base");
    const notes = [];
    for (const j of list) { const c = cases.get(j.key); if (c) for (const n of c.notes || []) notes.push({ ...n, j, st: c.status, action: c.action }); }
    notes.sort((a, b) => b.t - a.t);
    const facts = [
      ["Jornadas", n0(list.length), false],
      ["Turnos noche", n0(list.length ? (list.filter(j => j.type === "noche").length / list.length) * 100 : 0) + " %", false],
      ["Jornada mediana", dur(GI.median(done.map(j => j.span))), false],
      ["Manejo mediano", dur(GI.median(done.map(j => j.dh))), false],
      ["Descanso mediano", dur(GI.median(rests)), false],
      ["Descanso más corto", rests.length ? dur(Math.min(...rests)) : "–", rests.some(r => r < fz.min_rest)],
      ["Manejo entre 02 y 05 h", dur(GI.sum(list, j => j.low)), GI.sum(list, j => j.low) >= 2],
      ["Jornadas nivel alto", n0(list.filter(j => j.level === "alto").length), list.some(j => j.level === "alto")],
      ["Descansos con motor en marcha", n0(withRest.filter(j => j.restEngine).length), withRest.some(j => j.restEngine)],
      ["Descansos fuera de base", withRest.length && knowsBase ? n0((withRest.filter(j => j.restPlace && j.restPlace.kind !== "base").length / withRest.length) * 100) + " %" : "–", false],
      ["Cambios de turno", s && s.rot ? n0(s.rot.changes) + (s.rot.back ? " (" + s.rot.back + " hacia atrás)" : "") : "–", !!(s && s.rot && s.rot.back)],
      ["Variación de la hora de inicio", s && s.rot && s.rot.startSd != null ? "± " + dur(s.rot.startSd) : "–", !!(s && s.rot && s.rot.startSd > 3)],
    ];
    const proj = s && s.sim ? GI.projectIndex(s, fz, now, 16) : null;
    const off = s ? GI.commGap(s, status, now) : null;
    const [cdays, setCdays] = useState(7);
    return html`<${Modal} wide title=${"Fatiga · " + drvName(view, id)} onClose=${onClose}>
      <div className="ft-case-head">
        ${proj ? html`<span>Índice de fatiga ahora: ${fiTag(proj.Fnow, fz)} <span className="muted">(${GI.fiLevel(proj.Fnow, fz)}${off && !proj.open ? ", si descansó" : off ? ", con lo último recibido" : ""})</span></span>` : null}
        <span className="ft-case-links">
          <button className="btn small" onClick=${() => onSafety(id)}>Ficha de seguridad</button>
          <button className="btn small" onClick=${() => GI.openEventsPage({ driverIds: [id], from: view.model.dayKeys[0], to: view.model.dayKeys[view.model.dayKeys.length - 1] })}>Eventos en MyGeotab ↗</button>
        </span>
      </div>
      ${off ? html`<div className="verdict-line warn"><span className="vtag">Sin datos</span><span>
        <b>${proj && proj.open ? "No se sabe si sigue manejando." : "No se sabe si está descansando."}</b> El vehículo ${devName(view, off.d)} no comunica con MyGeotab desde el ${when(off.at)} (${dur(off.h)}). Si siguió manejando, esos viajes van a aparecer cuando el equipo vuelva a comunicar. ${proj && proj.open ? "Lo de abajo usa lo último recibido" : "El índice y el próximo turno de abajo suponen que descansa desde entonces"}: conviene confirmarlo con el conductor o la base.</span></div>` : null}
      ${proj ? html`<div className=${"verdict-line " + (proj.level === "rojo" ? "bad" : "")}><span className="vtag">${proj.open ? "En jornada" : "Próximo turno"}</span><span>
        <b>${off && !proj.open ? "Si descansó: " + proj.action.charAt(0).toLowerCase() + proj.action.slice(1) : proj.action}.</b>
        ${proj.open ? html` Empezó a las ${hm(proj.open.s)} (turno ${proj.open.type}); lleva ${dur((now - proj.open.s) / H)} de jornada y ${dur(proj.open.dh)} de manejo. Si completa su jornada habitual (${dur(proj.hb.span)}) el índice llegaría a ${fiTag(proj.peak, fz)}${proj.crossAt && proj.crossAt > now ? html` y pasaría de ${fz.fi_high} a las <b>${hm(proj.crossAt)}</b>` : ""}.`
          : proj.next ? html` Terminó el ${when(proj.next.lastE)}. Si arranca a su hora habitual, el ${when(proj.next.start)} (turno ${proj.next.hb.type}, ${dur(proj.next.hb.span)}), empezaría con ${fiTag(proj.next.Fstart, fz)} y terminaría en ${fiTag(proj.next.peak, fz)}.` : null}</span></div>` : null}
      <${RosterBox} api=${api} id=${id} rs=${s && s.rs} roster=${roster} isAdmin=${isAdmin} userName=${userName} onRoster=${onRoster} />
      ${s && s.sim ? html`<div className="ft-sub-head"><h3>Evolución del índice de fatiga</h3><${Segmented} value=${cdays} onChange=${setCdays} options=${[{ value: 3, label: "3 días" }, { value: 7, label: "7 días" }, { value: 14, label: "14 días" }]} /></div>
        <${IndexChart} entry=${s} proj=${proj} fz=${fz} now=${now} days=${cdays} onCase=${onCase} height=${250} off=${off} />` : null}
      <div className="ft-facts">${facts.map(([l, v, bad]) => html`<div key=${l} className=${bad ? "bad" : ""}><span>${l}</span><b>${v}</b></div>`)}</div>
      <details className="ft-more"><summary>Patrón de jornadas por día</summary>
        <div className="ft-sub-head"><span></span><${Segmented} value=${days} onChange=${setDays} options=${[{ value: 14, label: "14 días" }, { value: 28, label: "28 días" }]} /></div>
        <${ShiftPattern} list=${list} fz=${fz} days=${days} onCase=${onCase} />
      </details>
      ${(() => { const mine = (acks || []).filter(a => a.drv === id).sort((a, b) => b.at - a.at); return mine.length ? html`<h3 style=${{ marginTop: "14px" }}>Intervenciones por alertas de fatiga</h3>
        <${DataTable} rowKey=${a => a.id || a.at} rows=${mine} limit=${8} defaultSort=${{ key: "at", dir: "desc" }} columns=${[
          { key: "at", label: "Cuándo", fmt: a => html`${dshort(a.at)} <span className="muted">${hm(a.at)}</span>` },
          { key: "level", label: "Alerta", fmt: a => html`<span className=${"ft-act " + (a.level === "critica" ? "rojo" : "amarillo")}>${a.level === "critica" ? "Crítica" : "Alerta"} · ${a.F}</span>` },
          { key: "action", label: "Qué se hizo", fmt: a => html`${a.actionLabel || a.action}${a.note ? html`<div className="small muted">${a.note}</div>` : null}` },
          { key: "by", label: "Registró", fmt: a => a.by || "–" },
        ]} />` : null; })()}
      <h3 style=${{ marginTop: "14px" }}>Jornadas</h3>
      <${DataTable} rowKey=${j => j.key} rows=${list} limit=${12} defaultSort=${{ key: "s", dir: "desc" }} onRowClick=${onCase} columns=${[
        { key: "s", label: "Inicio", fmt: j => html`${dshort(j.s)} <span className="muted">${hm(j.s)}</span>${j.open ? html` <span className="ft-live">● en curso</span>` : ""}` },
        { key: "e", label: "Fin", fmt: j => (j.open ? html`<span className="muted">sigue</span>` : endCell(j)) },
        { key: "type", label: "Turno" },
        { key: "span", label: "Jornada", align: "num", fmt: j => dur(j.span) },
        { key: "dh", label: "Manejo", align: "num", fmt: j => dur(j.dh) },
        { key: "restBefore", label: "Descanso previo", align: "num", fmt: j => (j.restBefore == null ? "–" : html`<span className=${j.restBefore < fz.min_rest ? "delta bad" : ""}>${dur(j.restBefore)}</span>`) },
        { key: "fiPeak", label: "Índice máx.", align: "num", fmt: j => fiTag(j.fiPeak, fz) },
        { key: "sig", label: "Señales", value: j => j.score, fmt: j => sigChips(j, true) },
        { key: "st", label: "Seguimiento", value: j => (cases.get(j.key) || {}).status || "", fmt: j => { const c = cases.get(j.key); return c ? html`<span className=${"ft-st ft-st-" + c.status.toLowerCase()}>${c.status}</span>` : j.level !== "bajo" ? html`<span className="muted small">sin revisar</span>` : ""; } },
      ]} empty="Sin jornadas en el período." />
      <h3 style=${{ marginTop: "14px" }}>Seguimiento</h3>
      ${notes.length ? html`<ul className="ft-notes">${notes.map((n, i) => html`<li key=${i}><span className="muted small">${new Date(n.t).toLocaleString("es-AR")}${n.user ? " · " + n.user : ""} · jornada del ${dshort(n.j.s)} · ${n.st}${n.action ? " · " + n.action : ""}</span><div>${n.text}</div></li>`)}</ul>`
        : html`<p className="muted small">Todavía no hay comentarios sobre las jornadas de este conductor. Se cargan desde cada jornada (click en una fila).</p>`}
    <//>`;
  }

  // ---------- Casos ----------
  function CasesSection({ view, shifts, cases, onOpen, onDriver, limits, idents }) {
    const [lvl, setLvl] = useState("alto");
    const [sig, setSig] = useState([]);
    const [st, setSt] = useState("");
    const [q, setQ] = useState("");
    const statusOf = j => (cases.get(j.key) || {}).status || "Detectado";
    const base = shifts.filter(j => (lvl === "alto" ? j.level === "alto" : lvl === "medio" ? j.level !== "bajo" : j.signals.length > 0));
    const rows = base.filter(j => sig.every(k => j.signals.some(s => s.key === k))
      && (!st || (st === "abiertos" ? statusOf(j) !== "Cerrado" : statusOf(j) === st))
      && (!q || drvName(view, j.drv).toLowerCase().includes(q.toLowerCase())));
    const counts = new Map(GI.FATIGUE_SIGNALS.map(s => [s.key, base.filter(j => j.signals.some(x => x.key === s.key)).length]));
    const byDrv = GI.groupBy(rows, j => j.drv);
    const repeat = [...byDrv.values()].filter(l => l.length >= 2).length;
    return html`<${Panel} title="Jornadas con señales de fatiga"
      hint=${"Cada fila es una jornada (viajes sin una pausa de " + limits.SPLIT / H + " h o más). Señales: jornada de más de " + limits.max_span + " h, más de " + limits.max_drive_day + " h de manejo, más de " + limits.max_continuous + " h sin una pausa de 15 min, manejo entre las 02 y las 05 h, cambio de turno día ↔ noche con un solo descanso, descanso de menos de " + limits.min_rest + " h o casi todo de día antes de un turno noche, más de " + limits.max_days_row + " días seguidos e índice de fatiga estimado de " + limits.fi_high + " o más. Nivel alto: 3 señales o más; medio: 2. Los eventos de cámara (bostezo, distracción, salida de carril) no son señales: se ven en la jornada como contexto y se analizan en Análisis → Validación del índice."}>
      ${(() => { const pend = shifts.filter(j => j.signals.some(x => x.key === "ident") && !(idents && idents.has(j.key))); return pend.length ? html`<div className="ft-identbar">
        <span><b>${pend.length === 1 ? "1 jornada" : pend.length + " jornadas"} de más de 20 h para revisar.</b> Con camiones en relevo, si un chofer no pasa su llave el turno se le carga al anterior: puede ser un doble turno real (grave) o un relevo sin identificar.</span>
        <button className="btn primary small" onClick=${() => { setLvl("todas"); setSig(["ident"]); }}>Ver ${pend.length === 1 ? "la jornada" : "las " + pend.length}</button></div>` : null; })()}
      <div className="ft-filters">
        <${Segmented} value=${lvl} onChange=${setLvl} options=${[{ value: "alto", label: "Nivel alto" }, { value: "medio", label: "Alto y medio" }, { value: "todas", label: "Con alguna señal" }]} />
        <select value=${st} onChange=${e => setSt(e.target.value)} aria-label="Estado">
          <option value="">Todos los estados</option><option value="abiertos">Sin cerrar</option>
          ${STATUS.map(s => html`<option key=${s} value=${s}>${s}</option>`)}
        </select>
        <input type="search" placeholder="Buscar conductor" value=${q} onInput=${e => setQ(e.target.value)} />
      </div>
      <div className="rd-chips ft-sigfilter" role="group" aria-label="Filtrar por señal">
        ${GI.FATIGUE_SIGNALS.map(s => html`<button key=${s.key} className=${"rd-chip" + (sig.includes(s.key) ? " on" : "")} disabled=${!counts.get(s.key) && !sig.includes(s.key)}
          onClick=${() => setSig(x => (x.includes(s.key) ? x.filter(k => k !== s.key) : [...x, s.key]))}>${s.label} <span className="muted">${counts.get(s.key)}</span></button>`)}
      </div>
      <p className="small muted">${n0(rows.length)} jornadas de ${n0(byDrv.size)} conductores${repeat ? html` · <b>${repeat}</b> conductores con 2 o más` : ""}. ${sig.length ? "Se muestran las que tienen todas las señales elegidas." : ""}</p>
      <${DataTable} rowKey=${j => j.key} rows=${rows} limit=${25} defaultSort=${{ key: "s", dir: "desc" }} onRowClick=${onOpen} rowClass=${j => (j.signals.some(x => x.key === "ident") && !(idents && idents.has(j.key)) ? "ft-row-ident" : "")} columns=${[
        { key: "s", label: "Inicio", fmt: j => html`${dshort(j.s)} <span className="muted">${hm(j.s)}</span>` },
        { key: "drv", label: "Conductor", value: j => drvName(view, j.drv), fmt: j => html`<${DriverLink} view=${view} id=${j.drv} onDriver=${onDriver} />${(byDrv.get(j.drv) || []).length >= 2 ? html` <span className="tag" title="Jornadas en esta lista">${byDrv.get(j.drv).length}</span>` : ""}` },
        { key: "dev", label: "Vehículo", value: j => devName(view, j.devices[0]), fmt: j => j.devices.map(d => devName(view, d)).join(", ") },
        { key: "e", label: "Fin", fmt: j => (j.open ? html`<span className="muted">sigue</span>` : endCell(j)) },
        { key: "type", label: "Turno" },
        { key: "span", label: "Jornada", align: "num", fmt: j => dur(j.span) },
        { key: "dh", label: "Manejo", align: "num", fmt: j => dur(j.dh) },
        { key: "fiPeak", label: "Índice máx.", align: "num", fmt: j => fiTag(j.fiPeak, limits) },
        { key: "sig", label: "Señales", value: j => j.score, fmt: j => sigChips(j, true) },
        { key: "score", label: "Nivel", align: "num", fmt: j => levelTag(j.level) },
        { key: "st", label: "Estado", value: statusOf, fmt: j => { const c = cases.get(j.key), ir = idents && idents.get(j.key), dub = j.signals.some(x => x.key === "ident");
          return html`${dub && !ir ? html`<div className="ft-st ft-st-ident">A confirmar</div>` : ir ? html`<div className="small">${identWord(view, ir)}</div>` : null}<span className=${"ft-st ft-st-" + statusOf(j).toLowerCase()}>${statusOf(j)}</span>${c && c.owner ? html`<div className="small muted">${c.owner}</div>` : ""}`; } },
      ]} empty="No hay jornadas con estas señales en el período." />
    <//>`;
  }

  // ---------- Conductores (resumen de jornada y descanso) ----------
  function DriversSection({ view, onDriver }) {
    const rf = useMemo(() => {
      const ex = GI.exposure(view.model, view.ids, view.driverOk);
      if (!ex.totKm) return null;
      const rmap = new Map(ex.routes.filter(r => r.stable && r.idx != null).map(r => [r.key, r.idx]));
      return GI.riskFactors(view.model, view.ids, view.driverOk, rmap, ex.fleetIdx);
    }, [view]);
    if (!rf) return html`<${Info}>No hay viajes en el período.<//>`;
    return html`<${GI.FatiguePanel} view=${view} rf=${rf} onDriver=${onDriver} onRow=${onDriver} />`;
  }


  // ---------- Validación del índice (BETA) ----------
  const pct = v => (v >= 0 ? "+" : "") + GI.fmtNum(v * 100, 0) + " %";
  const MIN_BAND_H = 20; // horas de manejo mínimas en una franja para dar su tasa
  const per10 = (n, h) => (h >= MIN_BAND_H ? (n / h) * 10 : null);
  function bandRows(ex) {
    const base = ex.bands[0];
    const b0 = per10(base.cam, base.hours), o0 = per10(base.other, base.hours);
    const H = ex.hours || 1;
    return ex.bands.map(x => {
      const r = per10(x.cam, x.hours), o = per10(x.other, x.hours);
      return { ...x, share: x.hours / H, rate: r, ratio: r != null && b0 > 0 ? r / b0 : null, orate: o, oratio: o != null && o0 > 0 ? o / o0 : null };
    });
  }
  function fitWords(fit) {
    if (!fit) return null;
    const m = Math.exp(fit.b / 10) - 1;
    const lo = fit.se != null ? Math.exp((fit.b - 1.96 * fit.se) / 10) - 1 : null, hi = fit.se != null ? Math.exp((fit.b + 1.96 * fit.se) / 10) - 1 : null;
    return { m, lo, hi, sig: lo != null && (lo > 0 || hi < 0) };
  }
  function paramWords(P) {
    const D = GI.FI_DEFAULT;
    return [
      ["Cuánto pesa la madrugada (04 h contra 16 h)", "×" + GI.fmtNum(1 + 2 * D.amp, 1), "×" + GI.fmtNum(1 + 2 * P.amp, 1)],
      ["Recuperación por hora de descanso de noche", n0(D.recNight * 100) + " %", n0(P.recNight * 100) + " %"],
      ["Recuperación por hora de descanso de día", n0(D.recDay * 100) + " %", n0(P.recDay * 100) + " %"],
      ["Una hora de espera en jornada equivale a", GI.fmtNum(D.work / D.drive, 2) + " h de manejo", GI.fmtNum(P.work / P.drive, 2) + " h de manejo"],
    ];
  }
  function BandTable({ rows }) {
    return html`<${DataTable} rowKey=${r => r.key} rows=${rows} defaultSort=${{ key: "key", dir: "asc" }} columns=${[
      { key: "key", label: "Índice en ese momento", value: r => GI.FI_BANDS.indexOf(r.key), fmt: r => html`<span className=${"ft-fi ft-fi-" + r.key.replace(" ", "-")}>${r.key}</span>` },
      { key: "hours", label: "Horas de manejo", align: "num", fmt: r => n0(r.hours) + " h" },
      { key: "share", label: "% del manejo", align: "num", fmt: r => n0(r.share * 100) + " %" },
      { key: "cam", label: "Eventos de fatiga", align: "num", title: "Bostezo / fatiga, distracción y salida de carril (cámaras y ADAS)", fmt: r => html`${n0(r.cam)}${r.cam ? html`<div className="small muted">${Object.entries(r.byCat).map(([k, v]) => GI.catLabel(k).split(" /")[0] + " " + v).join(" · ")}</div>` : ""}` },
      { key: "rate", label: "Cada 10 h de manejo", align: "num", fmt: r => (r.rate == null ? html`<span className="muted small" title=${"Menos de " + MIN_BAND_H + " h de manejo en esta franja"}>pocas horas</span>` : GI.fmtNum(r.rate, 2)) },
      { key: "ratio", label: "Contra la franja baja", align: "num", fmt: r => (r.ratio == null ? "–" : html`<b className=${r.ratio >= 1.5 ? "delta bad" : ""}>×${GI.fmtNum(r.ratio, 1)}</b>`) },
      { key: "orate", label: "Otras infracciones cada 10 h", align: "num", title: "Control: el resto de las infracciones de riesgo. Si suben igual que las de fatiga, puede ser el horario o el camino y no el cansancio.", fmt: r => (r.orate == null ? "–" : html`${GI.fmtNum(r.orate, 2)} <span className="muted">×${r.oratio == null ? "–" : GI.fmtNum(r.oratio, 1)}</span>`) },
    ]} empty="Sin manejo en el período." />`;
  }

  function ValidationSection({ view, res, isAdmin, settings, onSaveSettings }) {
    const fz = res.limits;
    const ex = useMemo(() => GI.fiExposure(res, fz), [res]);
    const fit = useMemo(() => GI.poissonFit(ex.bins), [ex]);
    const rows = bandRows(ex);
    const w = fitWords(fit);
    const [cal, setCal] = useState(null);
    const [prog, setProg] = useState(null);
    const [msg, setMsg] = useState(null);
    const custom = !!(settings.fatigue && settings.fatigue.fi_params);
    async function run() {
      setCal(null); setMsg(null); setProg(0);
      try { setCal(await GI.calibrateIndex(view.model, view.ids, view.driverOk, setProg)); } catch (e) { setMsg("No se pudo calibrar: " + ((e && e.message) || e)); }
      setProg(null);
    }
    async function apply(P) {
      setMsg(null);
      try {
        const next = { ...settings, fatigue: { ...settings.fatigue } };
        if (P) next.fatigue.fi_params = P; else delete next.fatigue.fi_params;
        await onSaveSettings(next);
        setCal(null); setMsg(P ? "Listo: el índice de esta base usa los coeficientes calibrados." : "Listo: el índice volvió a los coeficientes de fábrica.");
      } catch (e) { setMsg("No se pudo guardar: " + ((e && e.message) || e)); }
    }
    const hi = [...rows].reverse().find(r => r.key !== "bajo" && r.ratio != null) || rows[1];
    const few = ex.cam < 30;
    let verdict;
    if (!ex.cam) verdict = null;
    else if (few) verdict = html`<div className="verdict-line"><span className="vtag">Pocos eventos</span><span>Hay ${n0(ex.cam)} eventos de fatiga en el período: son pocos para sacar conclusiones. Probá con un período de 3 meses o más.</span></div>`;
    else if (w && w.sig && w.m > 0) verdict = html`<div className="verdict-line good"><span className="vtag">El índice anticipa</span><span>Cada 10 puntos más de índice, los eventos de fatiga aumentan un <b>${pct(w.m)}</b> (entre ${pct(w.lo)} y ${pct(w.hi)}, con 95 % de confianza)${hi.ratio != null ? html`. Con índice ${hi.key} hay <b>×${GI.fmtNum(hi.ratio, 1)}</b> eventos por hora de manejo que con índice bajo` : ""}.${hi.oratio != null && hi.ratio != null && hi.oratio >= hi.ratio * 0.8 ? " Ojo: las otras infracciones también suben casi igual, así que parte del efecto puede ser el horario o el camino." : ""}</span></div>`;
    else if (w && w.sig && w.m < 0) verdict = html`<div className="verdict-line bad"><span className="vtag">Al revés</span><span>Los eventos de fatiga bajan cuando el índice sube (${pct(w.m)} cada 10 puntos). Con estos datos el índice no está capturando el cansancio: conviene calibrarlo o revisar qué reglas cuentan como fatiga.</span></div>`;
    else verdict = html`<div className="verdict-line bad"><span className="vtag">Sin relación clara</span><span>Con ${n0(ex.cam)} eventos no se ve que suban con el índice (${pct(w ? w.m : 0)} cada 10 puntos, no significativo). Probá calibrarlo para esta base.</span></div>`;
    return html`<div>
      <${Panel} title="¿El índice anticipa los eventos de fatiga?"
        hint=${"Para cada tramo de 15 minutos de manejo del período se calcula el índice de fatiga en ese momento y se cuentan las horas de manejo y los eventos de fatiga (bostezo, distracción, salida de carril de cámaras y ADAS) en cada franja del índice. Si el índice mide algo real, los eventos por hora tienen que subir de la franja baja a la muy alta. Las otras infracciones son el control: si suben igual, el efecto puede ser el horario o el camino. La pendiente sale de un ajuste de Poisson sobre el índice (cada 10 puntos)."}>
        ${!ex.cam ? html`<${Info} tone="warn">No hay eventos de fatiga, distracción o salida de carril en el período. Revisá en Configuración → Reglas y objetivos que las reglas de las cámaras tengan esas categorías, o elegí un período más largo.<//>` : null}
        ${verdict}
        ${ex.cam ? html`<${GI.ChartView} height=${220} config=${{
          type: "bar",
          data: { labels: rows.map(r => r.key), datasets: [
            { type: "bar", label: "Eventos de fatiga (× franja baja)", data: rows.map(r => (r.ratio == null ? null : GI.round(r.ratio, 2))), backgroundColor: rows.map(r => FI_COLORS[r.key]), borderRadius: 4, borderSkipped: "start", order: 2 },
            { type: "line", label: "Otras infracciones (× franja baja)", data: rows.map(r => (r.oratio == null ? null : GI.round(r.oratio, 2))), borderColor: "#7b8492", backgroundColor: "#7b8492", pointRadius: 4, order: 1 },
          ] },
          options: { plugins: { tooltip: { callbacks: { afterLabel: c => { const r = rows[c.dataIndex]; return c.datasetIndex === 0 ? n0(r.cam) + " eventos en " + n0(r.hours) + " h de manejo" : n0(r.other) + " infracciones"; } } } },
            scales: { x: { title: { display: true, text: "índice de fatiga en el momento del evento" } }, y: { beginAtZero: true, title: { display: true, text: "veces la franja baja" } } } },
        }} />` : null}
        <${BandTable} rows=${rows} />
        ${ex.cam ? html`<h3 style=${{ marginTop: "14px" }}>¿Qué tipo de evento acompaña al índice?</h3>
          <p className="small muted">Un bostezo aislado no prueba cansancio. Si un tipo de evento sube claramente cuando el índice sube, ese tipo sí está reflejando fatiga en esta base; si no sube, conviene no darle peso.</p>
          <${DataTable} rowKey=${r => r.cat} rows=${[...GI.FATIGUE_CAM_CATS].map(cat => { const f = GI.poissonFit(ex.binsOf(cat)); return { cat, f, w: fitWords(f), n: f ? f.n : 0 }; })} columns=${[
            { key: "cat", label: "Tipo de evento", value: r => GI.catLabel(r.cat), fmt: r => html`<span className="dot" style=${{ background: CAM_COLORS[r.cat] }}></span>${GI.catLabel(r.cat)}` },
            { key: "n", label: "Eventos", align: "num", fmt: r => n0(r.n) },
            { key: "m", label: "Cada 10 puntos de índice", align: "num", value: r => (r.w ? r.w.m : -9), fmt: r => (r.w && r.n >= 10 ? html`${pct(r.w.m)} <span className="muted small">(${pct(r.w.lo)} a ${pct(r.w.hi)})</span>` : "–") },
            { key: "read", label: "Lectura", value: r => (r.w && r.w.sig && r.w.m > 0 ? 2 : r.n < 30 ? 0 : 1), fmt: r => (r.n < 30 ? html`<span className="muted">Pocos eventos para concluir</span>`
              : r.w && r.w.sig && r.w.m > 0 ? html`<span className="delta good">Sube con el índice: refleja fatiga</span>`
              : r.w && r.w.sig && r.w.m < 0 ? html`<span className="delta bad">Baja cuando el índice sube</span>` : html`<span className="delta flat">No se relaciona con el índice</span>`) },
          ]} />` : null}
        <p className="muted small">${n0(ex.hours)} h de manejo y ${n0(ex.cam)} eventos de fatiga en el período. Índice ${custom ? "con coeficientes calibrados para esta base" : "con los coeficientes de fábrica"}.</p>
      <//>
      <${Panel} title="Calibrar el índice para esta base"
        hint="Prueba 72 combinaciones de coeficientes (cuánto pesa la madrugada, cuánto se recupera descansando de noche y de día, cuánto cuentan las esperas) y elige la que mejor anticipa los eventos de fatiga de esta base. Cada combinación se reescala para que una jornada diurna normal siga terminando cerca de 67, así los umbrales moderado y alto conservan su sentido.">
        <p className="small">Usa los mismos datos del período elegido. Con pocos eventos (menos de unos 100) el resultado puede ser casualidad: conviene un período largo.</p>
        <div className="form-actions">
          <button className="btn primary" disabled=${prog != null || !ex.cam} onClick=${run}>${prog != null ? "Probando… " + n0(prog * 100) + " %" : "Buscar coeficientes para esta base"}</button>
          ${custom && isAdmin ? html`<button className="btn" onClick=${() => apply(null)}>Volver a los de fábrica</button>` : null}
          ${msg ? html`<span className="small">${msg}</span>` : null}
        </div>
        ${cal ? (() => {
          const c = cal.current, b = cal.best, wc = fitWords(c.fit), wb = fitWords(b.fit);
          const gain = b.fit && c.fit ? b.fit.ll - c.fit.ll : 0;
          const same = b === c || gain < 2;
          return html`<div style=${{ marginTop: "12px" }}>
            <div className=${"verdict-line " + (same ? "" : "good")}><span className="vtag">${same ? "Sin mejora clara" : "Mejor ajuste"}</span><span>
              ${same ? html`Ninguna combinación anticipa los eventos claramente mejor que la actual. Conviene quedarse con los coeficientes que están.`
                : html`Con los coeficientes calibrados, cada 10 puntos de índice los eventos ${wb.m >= 0 ? "aumentan" : "bajan"} un <b>${pct(wb.m)}</b> (ahora: ${pct(wc ? wc.m : 0)}).${b.fit.n < 100 ? " Son menos de 100 eventos: tomalo con cuidado." : ""}`}</span></div>
            ${!same ? html`
              <table className="tbl ft-cal"><thead><tr><th></th><th className="num">Actual</th><th className="num">Calibrado</th></tr></thead>
                <tbody>${paramWords(b.P).map(([l, , v], i) => html`<tr key=${i}><td>${l}</td><td className="num">${paramWords(c.P)[i][2]}</td><td className="num"><b>${v}</b></td></tr>`)}</tbody></table>
              <h3 style=${{ marginTop: "12px" }}>Con los coeficientes calibrados</h3>
              <${BandTable} rows=${bandRows(b.ex)} />
              ${isAdmin ? html`<div className="form-actions"><button className="btn primary" onClick=${() => apply(b.P)}>Usar estos coeficientes en esta base</button>
                <span className="muted small">Se guardan en la configuración compartida y cambian el índice en toda la pestaña Fatiga.</span></div>`
                : html`<p className="muted small">Solo un administrador puede aplicar los coeficientes.</p>`}` : null}
          </div>`;
        })() : null}
      <//>
    </div>`;
  }


  // ---------- Descanso (BETA) ----------
  const pctTxt = (a, b) => (b > 0 ? (a > 0 && a / b < 0.01 ? "< 1 %" : n0((a / b) * 100) + " %") : "–");
  function groupRows(items, keyOf, init, addTo) {
    const m = new Map();
    for (const it of items) { const k = keyOf(it); if (k == null) continue; if (!m.has(k)) m.set(k, init(it, k)); addTo(m.get(k), it); }
    return [...m.values()];
  }
  function RestSection({ view, res, onDriver }) {
    const fz = res.limits;
    const rests = res.shifts.filter(j => j.restBefore != null && j.restBefore < 48);
    const knowsBase = new Set([...res.sims.entries()].filter(([, x]) => x.list.some(j => j.restPlace && j.restPlace.kind === "base")).map(([d]) => d));
    const short = rests.filter(j => j.restBefore < fz.min_rest), engine = rests.filter(j => j.restEngine), day = rests.filter(j => j.type === "noche" && j.restDayFrac >= 0.7);
    const awayBase = rests.filter(j => knowsBase.has(j.drv)), away = awayBase.filter(j => j.restPlace && j.restPlace.kind !== "base");
    const places = groupRows(rests.filter(j => j.restPlace), j => j.restPlace.kind === "ruta" ? "_ruta" : j.restPlace.id || j.restPlace.name,
      j => ({ key: j.restPlace.id || j.restPlace.name, name: placeTxt(j.restPlace), kind: j.restPlace.kind, n: 0, drv: new Set(), h: [], engine: 0, short: 0 }),
      (x, j) => { x.n++; x.drv.add(j.drv); x.h.push(j.restBefore); if (j.restEngine) x.engine++; if (j.restBefore < fz.min_rest) x.short++; });
    const drivers = groupRows(rests, j => j.drv, j => ({ id: j.drv, n: 0, h: [], short: 0, engine: 0, engineH: 0, away: 0, maxAway: 0, base: knowsBase.has(j.drv) }),
      (x, j) => { x.n++; x.h.push(j.restBefore); if (j.restBefore < fz.min_rest) x.short++; if (j.restEngine) { x.engine++; x.engineH += j.restIdleH; } if (j.restPlace && j.restPlace.kind !== "base") x.away++; x.maxAway = Math.max(x.maxAway, j.awayRow || 0); });
    const KIND = { base: "Base", cliente: "Cliente", zona: "Otra geocerca", ruta: "En ruta" };
    const hasIdle = (view.model.idle || []).length > 0;
    return html`<div>
      <${Panel} title="Calidad del descanso"
        hint=${"Cada descanso es la pausa entre dos jornadas (hasta 48 h). Con el motor en marcha: el vehículo estuvo en ralentí al menos 1 h y un cuarto del descanso (según las reglas de ralentí con categoría Ralentí); casi siempre es dormir en la cabina con el aire o la calefacción, y se recupera la mitad. Fuera de la base: dónde terminó el último viaje antes de descansar, según las geocercas de tipo Oficina o Casa; solo se cuenta para conductores que descansaron en la base al menos una vez en el período."}>
        ${!hasIdle ? html`<${Info} tone="warn">No hay eventos de ralentí en el período, así que no se puede saber si descansaron con el motor en marcha. Para medirlo, un administrador tiene que asignar la categoría Ralentí a la regla de ralentí de MyGeotab en Configuración → Reglas y objetivos (sus eventos se descargan solo para esto).<//>` : null}
        <div className="readouts compact inset">
          <${Kpi} label="Descansos analizados" value=${n0(rests.length)} sub=${html`<span>mediana ${dur(GI.median(rests.map(j => j.restBefore)))}</span>`} />
          <${Kpi} label=${"Más cortos que " + fz.min_rest + " h"} value=${pctTxt(short.length, rests.length)} tone=${short.length ? "bad" : null} sub=${html`<span>${n0(short.length)} descansos</span>`} />
          <${Kpi} label="Con el motor en marcha" value=${pctTxt(engine.length, rests.length)} sub=${html`<span>${n0(engine.length)} descansos, ${dur(GI.sum(engine, j => j.restIdleH))} en ralentí</span>`} />
          <${Kpi} label="Fuera de la base" value=${pctTxt(away.length, awayBase.length)} sub=${html`<span>${n0(day.length)} de día antes de un turno noche</span>`} />
        </div>
        <h3>Dónde descansan</h3>
        <${DataTable} rowKey=${r => r.key} rows=${places} limit=${12} defaultSort=${{ key: "n", dir: "desc" }} columns=${[
          { key: "name", label: "Lugar", fmt: r => html`${r.name} <span className="tag">${KIND[r.kind]}</span>` },
          { key: "n", label: "Descansos", align: "num" },
          { key: "drv", label: "Conductores", align: "num", value: r => r.drv.size, fmt: r => n0(r.drv.size) },
          { key: "med", label: "Duración mediana", align: "num", value: r => GI.median(r.h), fmt: r => dur(GI.median(r.h)) },
          { key: "engine", label: "Con motor en marcha", align: "num", value: r => r.engine / r.n, fmt: r => html`<span className=${r.engine / r.n >= 0.3 ? "delta bad" : ""}>${pctTxt(r.engine, r.n)}</span>` },
          { key: "short", label: "Cortos", align: "num", value: r => r.short / r.n, fmt: r => pctTxt(r.short, r.n) },
        ]} empty="Sin descansos en el período." />
        <h3 style=${{ marginTop: "14px" }}>Por conductor</h3>
        <${DataTable} rowKey=${r => r.id} rows=${drivers} limit=${15} defaultSort=${{ key: "risk", dir: "desc" }} columns=${[
          { key: "id", label: "Conductor", value: r => drvName(view, r.id), fmt: r => html`<${DriverLink} view=${view} id=${r.id} onDriver=${onDriver} />` },
          { key: "n", label: "Descansos", align: "num" },
          { key: "med", label: "Mediana", align: "num", value: r => GI.median(r.h), fmt: r => dur(GI.median(r.h)) },
          { key: "short", label: "Cortos", align: "num", fmt: r => (r.short ? html`<span className="delta bad">${r.short}</span>` : "0") },
          { key: "engine", label: "Con motor en marcha", align: "num", fmt: r => (r.engine ? html`<span className="delta bad">${r.engine}</span> <span className="muted small">${dur(r.engineH)}</span>` : "0") },
          { key: "away", label: "Fuera de base", align: "num", value: r => (r.base ? r.away / r.n : -1), fmt: r => (r.base ? pctTxt(r.away, r.n) : html`<span className="muted small" title="Nunca descansó en una geocerca de base en el período">sin base</span>`) },
          { key: "maxAway", label: "Seguidos fuera", align: "num", fmt: r => (r.base ? html`<span className=${r.maxAway >= 3 ? "delta bad" : ""}>${r.maxAway}</span>` : "–") },
          { key: "risk", label: "", value: r => r.short * 2 + r.engine + (r.base ? r.maxAway : 0), fmt: () => "" },
        ]} empty="Sin descansos en el período." />
      <//>
    </div>`;
  }

  // ---------- Operación (BETA): esperas, madrugada por recorrido, rotación ----------
  function OpsSection({ view, res, onDriver }) {
    const fz = res.limits;
    const waits = [];
    for (const j of res.shifts) for (const w of j.waits || []) waits.push({ ...w, j });
    const byPlace = groupRows(waits.filter(w => w.place), w => (w.place.kind === "ruta" ? "_ruta" : w.place.id || w.place.name),
      w => ({ key: w.place.id || w.place.name, name: placeTxt(w.place), kind: w.place.kind, n: 0, h: [], idle: 0, drv: new Set(), long: new Set() }),
      (x, w) => { x.n++; x.h.push(w.h); x.idle += w.idleH; x.drv.add(w.j.drv); if (w.j.span > fz.max_span) x.long.add(w.j.key); });
    const longJ = res.shifts.filter(j => j.span > fz.max_span);
    const longWithWait = longJ.filter(j => (j.waits || []).length);
    const topP = byPlace.filter(p => p.kind !== "ruta").sort((a, b) => GI.sum(b.h) - GI.sum(a.h))[0];
    // madrugada por recorrido (origen → destino de MyGeotab)
    const routes = new Map();
    for (const jr of view.model.journeys || []) {
      if (!view.ids.has(jr.d) || jr.internal) continue;
      const k = jr.oName + " → " + jr.destName;
      const r = routes.get(k) || { key: k, n: 0, dh: 0, low: 0, night: 0 };
      r.n++;
      for (const t of jr.tr || []) { const len = (t.e - t.s) / H || 1, f = t.dh / len; r.dh += t.dh; r.low += GI._fat.overlapHours(t.s, t.e, 2, 5) * f; r.night += GI._fat.overlapHours(t.s, t.e, 0, 6) * f; }
      routes.set(k, r);
    }
    const rts = [...routes.values()].filter(r => r.low > 0.5);
    const rot = [...res.sims.entries()].map(([id, x]) => ({ id, ...(x.rot || {}) })).filter(r => r.n >= 3);
    const KIND = { base: "Base", cliente: "Cliente", zona: "Otra geocerca", ruta: "En ruta" };
    return html`<div>
      <${Panel} title="¿Dónde se alargan las jornadas?"
        hint=${"Esperas: cortes de 1 h o más entre dos viajes dentro de una jornada (el conductor sigue en servicio, no descansa). El lugar es donde terminó el viaje anterior, según las geocercas. Muchas jornadas largas no se deben al manejo sino a colas de carga o descarga: eso se resuelve con el cliente o con turnos, no con el conductor."}>
        ${topP ? html`<div className="verdict-line bad"><span className="vtag">Donde más se espera</span><span>En <b>${topP.name}</b> se esperaron <b>${dur(GI.sum(topP.h))}</b> en ${n0(topP.n)} esperas (mediana ${dur(GI.median(topP.h))}); aparece en ${n0(topP.long.size)} de las ${n0(longJ.length)} jornadas de más de ${fz.max_span} h.</span></div>` : null}
        <p className="small muted">${n0(longWithWait.length)} de las ${n0(longJ.length)} jornadas de más de ${fz.max_span} h tienen al menos una espera de 1 h o más.</p>
        <${DataTable} rowKey=${r => r.key} rows=${byPlace} limit=${12} defaultSort=${{ key: "tot", dir: "desc" }} columns=${[
          { key: "name", label: "Lugar", fmt: r => html`${r.name} <span className="tag">${KIND[r.kind]}</span>` },
          { key: "n", label: "Esperas", align: "num" },
          { key: "tot", label: "Horas totales", align: "num", value: r => GI.sum(r.h), fmt: r => dur(GI.sum(r.h)) },
          { key: "med", label: "Mediana", align: "num", value: r => GI.median(r.h), fmt: r => dur(GI.median(r.h)) },
          { key: "max", label: "La más larga", align: "num", value: r => Math.max(...r.h), fmt: r => dur(Math.max(...r.h)) },
          { key: "drv", label: "Conductores", align: "num", value: r => r.drv.size, fmt: r => n0(r.drv.size) },
          { key: "long", label: "Jornadas largas", align: "num", value: r => r.long.size, fmt: r => n0(r.long.size), title: "Jornadas de más del máximo que tienen una espera en este lugar" },
          { key: "idle", label: "Con motor en marcha", align: "num", value: r => r.idle / GI.sum(r.h), fmt: r => pctTxt(r.idle, GI.sum(r.h)) },
        ]} empty="No hay esperas de 1 h o más en el período." />
      <//>
      <${Panel} title="Recorridos que obligan a manejar de madrugada"
        hint="Recorridos de MyGeotab (de geocerca a geocerca) con más de media hora de manejo entre las 02 y las 05 h en el período. Si un recorrido se hace siempre de madrugada, conviene revisar el horario de salida con planificación o con el cliente.">
        <${DataTable} rowKey=${r => r.key} rows=${rts} limit=${12} defaultSort=${{ key: "low", dir: "desc" }} columns=${[
          { key: "key", label: "Recorrido" },
          { key: "n", label: "Viajes", align: "num" },
          { key: "dh", label: "Manejo", align: "num", fmt: r => dur(r.dh) },
          { key: "low", label: "Entre 02 y 05 h", align: "num", fmt: r => html`<b>${dur(r.low)}</b>` },
          { key: "share", label: "% de madrugada", align: "num", value: r => r.low / r.dh, fmt: r => html`<span className=${r.low / r.dh >= 0.2 ? "delta bad" : ""}>${pctTxt(r.low, r.dh)}</span>` },
          { key: "night", label: "Entre 00 y 06 h", align: "num", fmt: r => dur(r.night) },
        ]} empty="Ningún recorrido tiene manejo de madrugada en el período." />
      <//>
      <${Panel} title="Rotación de turnos"
        hint="Cambios de turno día ↔ noche con un solo descanso de menos de 24 h. Hacia atrás (de noche a día) es la rotación que más cuesta: el cuerpo tiene que adelantar el reloj. La primera noche después de 36 h o más de franco también es de riesgo, porque el conductor viene de dormir de noche. La variación de la hora de inicio mide cuán irregular es su horario (±1 h es estable; ±4 h o más, el reloj biológico no llega a acomodarse).">
        <div className="readouts compact inset">
          <${Kpi} label="Rotaciones hacia atrás" value=${n0(GI.sum(rot, r => r.back))} sub=${html`<span>en ${n0(rot.filter(r => r.back).length)} conductores</span>`} />
          <${Kpi} label="Primeras noches tras francos" value=${n0(GI.sum(rot, r => r.afterOff))} />
          <${Kpi} label="Horario irregular" value=${n0(rot.filter(r => r.startSd > 3).length)} sub=${html`<span>conductores con inicio ±3 h o más</span>`} />
        </div>
        <${DataTable} rowKey=${r => r.id} rows=${rot} limit=${15} defaultSort=${{ key: "back", dir: "desc" }} columns=${[
          { key: "id", label: "Conductor", value: r => drvName(view, r.id), fmt: r => html`<${DriverLink} view=${view} id=${r.id} onDriver=${onDriver} />` },
          { key: "n", label: "Jornadas", align: "num" },
          { key: "nightPct", label: "Turnos noche", align: "num", fmt: r => n0(r.nightPct * 100) + " %" },
          { key: "changes", label: "Cambios de turno", align: "num" },
          { key: "back", label: "Hacia atrás", align: "num", fmt: r => (r.back ? html`<span className="delta bad">${r.back}</span>` : "0") },
          { key: "afterOff", label: "Noche tras francos", align: "num" },
          { key: "startSd", label: "Variación del inicio", align: "num", value: r => r.startSd || 0, fmt: r => (r.startSd == null ? "–" : html`<span className=${r.startSd > 3 ? "delta bad" : ""}>± ${dur(r.startSd)}</span>`) },
        ]} empty="Sin conductores con 3 jornadas o más." />
      <//>
      <${Panel} title="Diagramas de trabajo"
        hint="Se detectan de los viajes de cada conductor: vueltas de días trabajados separadas por 3 o más días sin trabajar (un día suelto sin viajes no corta la vuelta). El diagrama es la mediana de sus vueltas completas y de sus francos. Se puede fijar a mano desde la ficha de fatiga del conductor. Con diagrama, 'Días seguidos' se mide contra la vuelta (no contra el máximo general) y se marca volver con un franco más corto.">
        ${(() => {
          const rows = [...res.sims.entries()].filter(([, e]) => e.rs && e.rs.work).map(([id, e]) => {
            const rs = e.rs, done = rs.blocks.slice(1, rs.inFranco ? rs.blocks.length : rs.blocks.length - 1);
            return { id, rs, long: done.filter(b => b.end - b.start + 1 > rs.work + 1).length, short: rs.blocks.slice(1).filter(b => b.offBefore < rs.off - 1).length, maxLen: Math.max(...rs.blocks.map(b => b.end - b.start + 1)) };
          });
          const by = GI.groupBy(rows, r => r.rs.label);
          const none = [...res.sims.values()].filter(e => !(e.rs && e.rs.work)).length;
          return html`<p className="small">${[...by.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, l]) => html`<span key=${k} className="tag">${k}: ${l.length}</span>`)} ${none ? html`<span className="muted"> · ${n0(none)} sin diagrama por vueltas</span>` : null}</p>
            <${DataTable} rowKey=${r => r.id} rows=${rows} limit=${15} defaultSort=${{ key: "dev", dir: "desc" }} columns=${[
              { key: "id", label: "Conductor", value: r => drvName(view, r.id), fmt: r => html`<${DriverLink} view=${view} id=${r.id} onDriver=${onDriver} />` },
              { key: "label", label: "Diagrama", value: r => r.rs.label, fmt: r => html`${r.rs.label} <span className="muted small">${r.rs.source === "auto" ? "detectado" : "a mano"}</span>` },
              { key: "cycles", label: "Vueltas completas", align: "num", value: r => r.rs.cycles, fmt: r => n0(r.rs.cycles) },
              { key: "long", label: "Vueltas más largas", align: "num", title: "Vueltas con más días que el diagrama (+1 de tolerancia)", fmt: r => (r.long ? html`<span className="delta bad">${r.long}</span>` : "0") },
              { key: "maxLen", label: "Vuelta más larga", align: "num", fmt: r => r.maxLen + " días" },
              { key: "short", label: "Francos cortos", align: "num", fmt: r => (r.short ? html`<span className="delta bad">${r.short}</span>` : "0") },
              { key: "state", label: "Ahora", value: r => (r.rs.inFranco ? 0 : r.rs.curDay), fmt: r => (r.rs.inFranco ? "de franco" + (r.rs.backAt ? ", vuelve " + dshort(r.rs.backAt) : "") : "día " + r.rs.curDay + " de " + r.rs.work) },
              { key: "dev", label: "", value: r => r.long * 2 + r.short, fmt: () => "" },
            ]} empty="No se detectan diagramas por vueltas en el período (con 1 mes suele no alcanzar: probá con 3 meses o más)." />`;
        })()}
      <//>
    </div>`;
  }

  // ---------- Indicadores (BETA): mensuales para HSE + calidad de los datos ----------
  const monthLabel = mk => { const [y, m] = mk.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString("es-AR", { month: "short", year: "2-digit" }); };
  // Lista de jornadas a revisar: con la conclusión del add-in y su confianza; las de confianza alta
  // se pueden confirmar todas juntas.
  function IdentReview({ view, res, idents, onCase, onDriver, api, userName, onIdent }) {
    const pendJ = useMemo(() => res.shifts.filter(j => j.signals.some(x => x.key === "ident") && !(idents && idents.has(j.key))), [res, idents]);
    const [keys, setKeys] = useState(null); // por jornada
    useEffect(() => {
      let off = false;
      if (!api || !pendJ.length || !GI.loadDriverChangesWindows) { setKeys(new Map()); return; }
      GI.loadDriverChangesWindows(api, pendJ.map(j => [j.s - 6 * H, j.e + 3 * H]))
        .then(L => { if (!off) setKeys(new Map(pendJ.map((j, i) => [j.key, L[i]]))); })
        .catch(e => { console.warn("[Geotab Insights] llaves", e); if (!off) setKeys(new Map()); });
      return () => { off = true; };
    }, [api, pendJ.map(j => j.key).join(",")]);
    const infs = useMemo(() => {
      const m = new Map();
      if (keys) for (const j of pendJ) if (keys.has(j.key)) m.set(j.key, inferFor(view, j, res.shifts, keys.get(j.key), view.model.tripsByDevice));
      return m;
    }, [keys, pendJ]);
    const pend = pendJ.map(j => { const x = infs.get(j.key); return { key: j.key, j, drv: j.drv, s: j.s, e: j.e, d: (x && x.inf && x.inf.D) || j.devices[0], span: j.span, rec: null, inf: x ? x.inf : null }; });
    const done = [...((idents && idents.values()) || [])].map(r => ({ key: r.key, j: null, drv: r.drv, s: r.s, e: r.e, d: r.d, span: (r.e - r.s) / H, rec: r, inf: null }));
    const rows = [...pend, ...done];
    const high = pend.filter(r => r.inf && r.inf.conf === "alta" && r.inf.from != null && r.inf.to > r.inf.from);
    const [busy, setBusy] = useState(false), [msg, setMsg] = useState(null);
    async function confirmAll() {
      setBusy(true); setMsg(null);
      let ok = 0;
      for (const r of high) {
        try {
          const i = r.inf;
          onIdent(await GI.saveIdent(api, { key: r.key, drv: r.drv, d: i.D, s: r.s, e: r.e, outcome: "relevo", other: i.other || null, from: i.from, at: i.to, conf: i.conf, auto: true, by: userName || "" }));
          ok++;
        } catch (e) { setMsg("No se pudo guardar una: " + ((e && e.message) || e)); }
      }
      setMsg(ok + " relevo" + (ok === 1 ? "" : "s") + " confirmado" + (ok === 1 ? "" : "s") + ".");
      setBusy(false);
    }
    const what = r => {
      if (r.rec) return html`<span className=${r.rec.outcome === "doble" ? "delta bad" : r.rec.outcome === "relevo" ? "delta good" : ""}>${identWord(view, r.rec)}</span>${r.rec.by ? html`<div className="small muted">${r.rec.by}</div>` : ""}`;
      if (!keys) return html`<span className="small muted">Buscando pruebas…</span>`;
      const i = r.inf;
      if (!i || i.from == null) return html`<span className="small muted">Sin pruebas de relevo: puede ser un doble turno real</span>`;
      return html`<span>${i.conf === "baja" ? "Por su horario habitual: " : "Relevo a las " + hm(i.from) + ": "}manejó <b>${i.other ? drvName(view, i.other) : "otro conductor"}</b> hasta ${dshort(i.to)} ${hm(i.to)}</span>`;
    };
    return html`<${Panel} title="Jornadas a revisar (identificación)"
      hint="Jornadas de más de 20 h sin un corte que cierre la jornada. Con camiones en relevo suelen ser el turno de otro chofer que no pasó su llave. El add-in busca pruebas en los viajes y las llaves de toda la flota (quién llegó al vehículo, dónde estaba el chofer) y propone quién manejó. Confianza alta: hay una prueba fuerte. Las de confianza media o baja conviene revisarlas una por una.">
      <div className="readouts compact inset">
        <${Kpi} label="A confirmar" value=${n0(pend.length)} tone=${pend.length ? "bad" : null} />
        <${Kpi} label="De confianza alta" value=${keys ? n0(high.length) : "…"} />
        <${Kpi} label="Relevos confirmados" value=${n0(done.filter(r => r.rec.outcome === "relevo").length)} />
        <${Kpi} label="Dobles turnos reales" value=${n0(done.filter(r => r.rec.outcome === "doble").length)} tone=${done.some(r => r.rec.outcome === "doble") ? "bad" : null} />
      </div>
      ${high.length && onIdent ? html`<div className="ft-id-bulk"><button className="btn primary" disabled=${busy} onClick=${confirmAll}>${busy ? "Guardando…" : (high.length === 1 ? "Confirmar la de confianza alta" : "Confirmar las " + high.length + " de confianza alta")}</button>
        <span className="small muted">Se guarda el relevo que propone el add-in en cada una. Se puede cambiar después desde la ficha de la jornada.</span>${msg ? html`<span className="small">${msg}</span>` : null}</div>` : msg ? html`<p className="small">${msg}</p>` : null}
      <${DataTable} rowKey=${r => r.key} rows=${rows} limit=${15} defaultSort=${{ key: "s", dir: "desc" }} onRowClick=${r => (r.j ? onCase(r.j) : onDriver(r.drv))} rowClass=${r => (r.rec ? "" : "ft-row-ident")} columns=${[
        { key: "drv", label: "Conductor", value: r => drvName(view, r.drv), fmt: r => html`<b>${drvName(view, r.drv)}</b><div className="small muted">${devName(view, r.d)}</div>` },
        { key: "s", label: "Jornada", fmt: r => when(r.s) + " → " + when(r.e) },
        { key: "span", label: "Duración", align: "num", fmt: r => html`<b className="delta bad">${dur(r.span)}</b>` },
        { key: "what", label: "Qué pasó", value: r => (r.rec ? r.rec.outcome : "a"), fmt: what },
        { key: "conf", label: "Confianza", value: r => (r.rec ? 9 : r.inf ? { alta: 0, media: 1, baja: 2 }[r.inf.conf] : 3), fmt: r => (r.rec ? html`<span className="small muted">revisada</span>` : r.inf ? confTag(r.inf.conf) : "") },
      ]} empty="No hay jornadas de más de 20 h en el período." />
    <//>`;
  }

  function KpiSection({ view, res, cases, idents, onCase, onDriver, api, userName, onIdent }) {
    const fz = res.limits, model = view.model;
    const months = [...new Set(model.dayKeys.map(dk => dk.slice(0, 7)))];
    const byM = new Map(months.map(m => [m, []]));
    for (const j of res.shifts) if (byM.has(j.dk.slice(0, 7))) byM.get(j.dk.slice(0, 7)).push(j);
    const firstDays = (j, c) => (c && c.first_at ? (new Date(c.first_at).getTime() - j.e) / 86400000 : null);
    const ind = [
      { key: "n", label: "Jornadas", f: L => L.length, fmt: v => n0(v), neutral: true },
      { key: "alto", label: "Jornadas de nivel alto", f: L => (L.length ? L.filter(j => j.level === "alto").length / L.length : null), fmt: v => GI.fmtNum(v * 100, 1) + " %" },
      { key: "am", label: "Nivel alto o medio", f: L => (L.length ? L.filter(j => j.level !== "bajo").length / L.length : null), fmt: v => GI.fmtNum(v * 100, 1) + " %" },
      { key: "low", label: "Manejo entre 02 y 05 h cada 100 h", f: L => { const dh = GI.sum(L, j => j.dh); return dh > 0 ? (GI.sum(L, j => j.low) / dh) * 100 : null; }, fmt: v => GI.fmtNum(v, 1) + " h" },
      { key: "short", label: "Descansos cortos", f: L => { const R = L.filter(j => j.restBefore != null && j.restBefore < 48); return R.length ? R.filter(j => j.restBefore < fz.min_rest).length / R.length : null; }, fmt: v => GI.fmtNum(v * 100, 1) + " %" },
      { key: "eng", label: "Descansos con motor en marcha", f: L => { const R = L.filter(j => j.restBefore != null && j.restBefore < 48); return R.length ? R.filter(j => j.restEngine).length / R.length : null; }, fmt: v => GI.fmtNum(v * 100, 1) + " %" },
      { key: "fi", label: "Jornadas con índice alto (≥ " + fz.fi_high + ")", f: L => (L.length ? L.filter(j => j.fiPeak >= fz.fi_high).length / L.length : null), fmt: v => GI.fmtNum(v * 100, 1) + " %" },
      { key: "rep", label: "Conductores con 2+ jornadas altas", f: L => [...GI.groupBy(L.filter(j => j.level === "alto"), j => j.drv).values()].filter(x => x.length >= 2).length, fmt: v => n0(v) },
      { key: "rev", label: "Casos revisados", up: true, f: L => { const C = L.filter(j => j.level !== "bajo"); return C.length ? C.filter(j => { const c = cases.get(j.key); return c && c.status && c.status !== "Detectado"; }).length / C.length : null; }, fmt: v => GI.fmtNum(v * 100, 0) + " %" },
      { key: "days", label: "Días hasta la primera revisión", f: L => GI.median(L.filter(j => j.level !== "bajo").map(j => firstDays(j, cases.get(j.key))).filter(v => v != null && v >= 0)), fmt: v => GI.fmtNum(v, 1) },
    ];
    const rows = ind.map(x => {
      const vals = months.map(m => x.f(byM.get(m)));
      const a = vals[vals.length - 2], b = vals[vals.length - 1];
      const isPct = /%/.test(x.fmt(0.5));
      // porcentajes: diferencia en puntos; números: cambio relativo
      const delta = a == null || b == null ? null : isPct ? (b - a) * 100 : a !== 0 ? (b - a) / Math.abs(a) : null;
      return { ...x, vals, delta, isPct };
    });
    // calidad de los datos
    const rawTrips = (model.raw && model.raw.trips || []).filter(t => view.ids.has(t.d) && model.devById.has(t.d));
    const idMonth = months.map(m => { const T = rawTrips.filter(t => GI.dayKey(t.s).startsWith(m)); const all = GI.sum(T, t => t.dh); return all > 0 ? GI.sum(T.filter(t => t.r), t => t.dh) / all : null; });
    const byDev = groupRows(rawTrips, t => t.d, t => ({ id: t.d, all: 0, ok: 0 }), (x, t) => { x.all += t.dh; if (t.r) x.ok += t.dh; });
    const lowId = byDev.filter(x => x.all >= 10 && x.ok / x.all < 0.9);
    const allDh = GI.sum(byDev, x => x.all), okDh = GI.sum(byDev, x => x.ok);
    const lastDay = GI.parseDayKey(model.dayKeys[model.dayKeys.length - 1]).getTime() + 86400000;
    const camDev = new Map();
    for (const e of model.events) if (view.ids.has(e.d) && GI.FATIGUE_CAM_CATS.has(e.cat)) { const x = camDev.get(e.d) || { id: e.d, n: 0, last: 0 }; x.n++; x.last = Math.max(x.last, e.t); camDev.set(e.d, x); }
    const silent = [...camDev.values()].filter(x => lastDay - x.last > 14 * 86400000);
    const tamper = groupRows(model.events.filter(e => view.ids.has(e.d) && e.cat === "camara"), e => e.d, e => ({ id: e.d, n: 0 }), x => x.n++);
    return html`<div>
      <${Panel} title="Indicadores mensuales"
        hint="Para el informe de HSE o para el cliente. Cada mes cuenta las jornadas que empezaron en ese mes (dentro del período elegido: para ver varios meses, elegí un período más largo). La última columna compara el último mes con el anterior; el primer y el último mes pueden estar incompletos.">
        <div className="table-wrap"><table className="tbl ft-kpis">
          <thead><tr><th>Indicador</th>${months.map(m => html`<th key=${m} className="num">${monthLabel(m)}</th>`)}<th className="num">Último vs anterior</th></tr></thead>
          <tbody>${rows.map(r => html`<tr key=${r.key}><td>${r.label}</td>${r.vals.map((v, i) => html`<td key=${i} className="num">${v == null ? "–" : r.fmt(v)}</td>`)}
            <td className="num">${r.delta == null || r.neutral ? "–" : Math.abs(r.delta) < (r.isPct ? 0.05 : 0.005) ? html`<span className="delta flat">=</span>`
              : html`<span className=${"delta " + ((r.up ? r.delta > 0 : r.delta < 0) ? "good" : "bad")}>${(r.delta > 0 ? "▲ " : "▼ ") + (r.isPct ? GI.fmtNum(Math.abs(r.delta), 1) + " pts" : GI.fmtNum(Math.abs(r.delta) * 100, 0) + " %")}</span>`}</td></tr>`)}</tbody>
        </table></div>
      <//>
      <${IdentReview} view=${view} res=${res} idents=${idents} onCase=${onCase} onDriver=${onDriver} api=${api} userName=${userName} onIdent=${onIdent} />
      <${Panel} title="Calidad de los datos"
        hint="El módulo solo ve los viajes con el conductor identificado: si un conductor no se identifica, sus jornadas no existen para el análisis y los casos se subestiman. Las cámaras que dejaron de mandar eventos de fatiga, distracción o carril pueden estar desconectadas, tapadas o mal configuradas.">
        <div className="readouts compact inset">
          <${Kpi} label="Manejo con conductor identificado" value=${pctTxt(okDh, allDh)} tone=${allDh && okDh / allDh < 0.9 ? "bad" : null} sub=${html`<span>${months.map((m, i) => monthLabel(m) + " " + (idMonth[i] == null ? "–" : n0(idMonth[i] * 100) + " %")).join(" · ")}</span>`} />
          <${Kpi} label="Vehículos con menos de 90 % identificado" value=${n0(lowId.length)} />
          <${Kpi} label="Cámaras sin eventos en los últimos 14 días" value=${n0(silent.length)} sub=${html`<span>de ${n0(camDev.size)} con eventos en el período</span>`} />
          <${Kpi} label="Avisos de cámara obstruida o manipulada" value=${n0(GI.sum(tamper, x => x.n))} sub=${html`<span>en ${n0(tamper.length)} vehículos</span>`} />
        </div>
        <div className="grid-2">
          <div><h3>Vehículos con poca identificación</h3>
            <${DataTable} rowKey=${r => r.id} rows=${lowId} limit=${10} defaultSort=${{ key: "pct", dir: "asc" }} columns=${[
              { key: "id", label: "Vehículo", value: r => devName(view, r.id), fmt: r => devName(view, r.id) },
              { key: "all", label: "Manejo", align: "num", fmt: r => dur(r.all) },
              { key: "pct", label: "Identificado", align: "num", value: r => r.ok / r.all, fmt: r => html`<span className="delta bad">${pctTxt(r.ok, r.all)}</span>` },
            ]} empty="Todos los vehículos tienen 90 % o más del manejo identificado." /></div>
          <div><h3>Cámaras que dejaron de reportar</h3>
            <${DataTable} rowKey=${r => r.id} rows=${silent} limit=${10} defaultSort=${{ key: "last", dir: "asc" }} columns=${[
              { key: "id", label: "Vehículo", value: r => devName(view, r.id), fmt: r => devName(view, r.id) },
              { key: "n", label: "Eventos en el período", align: "num" },
              { key: "last", label: "Último evento", fmt: r => when(r.last) },
            ]} empty="Todas las cámaras con eventos reportaron en los últimos 14 días." /></div>
        </div>
      <//>
    </div>`;
  }

  // ---------- Validación: ¿las jornadas de nivel alto terminan en incidentes? ----------
  function OutcomePanel({ res }) {
    const lv = ["bajo", "medio", "alto"].map(level => {
      const L = res.shifts.filter(j => j.level === level && !j.open);
      const dh = GI.sum(L, j => j.dh), km = GI.sum(L, j => j.km);
      const cnt = cat => GI.sum(L, j => (j.events || []).filter(e => e.cat === cat).length);
      const w = GI.sum(L, j => GI.sum(j.events || [], e => e.w));
      return { level, n: L.length, dh, km, col: cnt("colision"), brake: cnt("frenado_brusco"), w };
    });
    const r = (n, dh) => (dh >= MIN_BAND_H ? (n / dh) * 100 : null);
    const base = lv[0];
    const x = (v, b) => (v == null || !(b > 0) ? "–" : "×" + GI.fmtNum(v / b, 1));
    const rows = lv.map(l => ({ ...l, colR: r(l.col, l.dh), brR: r(l.brake, l.dh), wR: l.km > 0 ? (l.w / l.km) * 100 : null }));
    const b0 = rows[0], hi = rows[2];
    const rel = hi.colR != null && b0.colR > 0 ? hi.colR / b0.colR : null;
    return html`<${Panel} title="¿Las jornadas de nivel alto terminan en más incidentes?"
      hint="Compara las jornadas según su nivel de fatiga: colisiones y casi colisiones (categoría Colisión), frenadas bruscas (cerca de un choque) y el índice de riesgo general, por cada 100 h de manejo. Si las jornadas de nivel alto tienen claramente más incidentes, los casos que marca el módulo son los que hay que atender. Con pocas colisiones el número cambia mucho por casualidad.">
      ${rel != null ? html`<div className=${"verdict-line " + (rel >= 1.5 ? "bad" : "")}><span className="vtag">${rel >= 1.5 ? "Sí" : "No se ve"}</span><span>En las jornadas de nivel alto hay <b>×${GI.fmtNum(rel, 1)}</b> colisiones y casi colisiones por hora de manejo que en las de nivel bajo (${n0(hi.col)} contra ${n0(b0.col)}).</span></div>` : null}
      <${DataTable} rowKey=${r => r.level} rows=${rows} columns=${[
        { key: "level", label: "Nivel de la jornada", value: r => ["bajo", "medio", "alto"].indexOf(r.level), fmt: r => levelTag(r.level) },
        { key: "n", label: "Jornadas", align: "num", fmt: r => n0(r.n) },
        { key: "dh", label: "Manejo", align: "num", fmt: r => n0(r.dh) + " h" },
        { key: "colR", label: "Colisiones / casi colisiones cada 100 h", align: "num", fmt: r => (r.colR == null ? "–" : html`${GI.fmtNum(r.colR, 2)} <span className="muted">${x(r.colR, b0.colR)}</span>`) },
        { key: "brR", label: "Frenadas bruscas cada 100 h", align: "num", fmt: r => (r.brR == null ? "–" : html`${GI.fmtNum(r.brR, 1)} <span className="muted">${x(r.brR, b0.brR)}</span>`) },
        { key: "wR", label: "Índice de riesgo (pts/100 km)", align: "num", fmt: r => (r.wR == null ? "–" : html`${GI.fmtNum(r.wR, 2)} <span className="muted">${x(r.wR, b0.wR)}</span>`) },
      ]} />
    <//>`;
  }
  const SECTIONS = [["seguimiento", "Seguimiento"], ["casos", "Casos"], ["analisis", "Análisis"]];
  const ANALYSIS = [["conductores", "Conductores"], ["descanso", "Descanso"], ["operacion", "Operación"], ["indicadores", "Indicadores"], ["validacion", "Validación del índice"]];
  const BETA_ANALYSIS = new Set(["descanso", "operacion", "indicadores", "validacion"]);
  const isBeta = () => GI.BUILD === "beta" || /\/dev\//.test(window.location.pathname);

  function FatigueTab({ view, api, onDriver, userName, isAdmin, onSaveSettings, openDriverId, onOpened }) {
    const [sec, setSec] = useState("seguimiento");
    const [sub, setSub] = useState("conductores");
    const [sel, setSel] = useState(null);
    const [drv, setDrv] = useState(null);
    const [cases, setCases] = useState(new Map());
    const [live, setLive] = useState({ loading: true, now: Date.now() });
    const [rosters, setRosters] = useState(new Map()); // diagramas fijados a mano
    const [idents, setIdents] = useState(new Map()); // revisiones de identificación, por jornada
    const fixes = useMemo(() => [...idents.values()].filter(r => r.outcome === "relevo" && r.at).map(r => ({ drv: r.drv, d: r.d, from: r.from || r.s, to: r.at, other: r.other || null })), [idents]);
    const rmap = useMemo(() => new Map([...rosters.values()].map(r => [r.drv, r])), [rosters]);
    GI.__drvName = id => drvName(view, id);
    const period = useMemo(() => GI.buildShifts(view.model, view.ids, view.driverOk, { rosters: rmap, identFixes: fixes }), [view, rmap, fixes]);
    async function refresh() {
      setLive(l => ({ ...l, loading: true }));
      try {
        const [recent, status, acks] = await Promise.all([GI.loadRecentTrips(api, LIVE_HOURS), GI.loadDriveStatus(api).catch(() => []), GI.loadAlertAcks ? GI.loadAlertAcks(api).catch(() => []) : []]);
        setLive({ recent, status, acks, at: Date.now(), now: Date.now() });
      } catch (e) {
        console.warn("[Geotab Insights] fatiga en vivo", e);
        setLive({ err: String((e && e.message) || e), at: Date.now(), now: Date.now() });
      }
    }
    useEffect(() => {
      refresh();
      const t = setInterval(() => setLive(l => ({ ...l, now: Date.now() })), 60000);
      let off = false;
      GI.loadFatigueCases(api).then(list => { if (!off) setCases(new Map(list.map(c => [c.key, c]))); }).catch(e => console.warn("[Geotab Insights] casos de fatiga", e));
      // (si storage.js quedó de una versión anterior en caché, sigue sin diagramas manuales)
      (GI.loadIdents ? GI.loadIdents(api) : Promise.resolve([])).then(list => { if (!off) setIdents(new Map(list.map(r => [r.key, r]))); }).catch(e => console.warn("[Geotab Insights] identificación", e));
      (GI.loadRosters ? GI.loadRosters(api) : Promise.resolve([])).then(list => { if (!off) setRosters(new Map(list.map(r => [r.drv, r]))); }).catch(e => console.warn("[Geotab Insights] diagramas", e));
      return () => { off = true; clearInterval(t); };
    }, [api]);
    // Seguimiento y fichas: período + viajes en vivo de las últimas horas.
    const tb = useMemo(() => (live.recent ? GI.liveTrips(view.model, live.recent, live.status, LIVE_HOURS, live.now) : null), [view, live]);
    const res = useMemo(() => {
      if (!tb) return GI.buildShifts(view.model, view.ids, view.driverOk, { now: live.now, rosters: rmap, identFixes: fixes });
      return GI.buildShifts(view.model, view.ids, view.driverOk, { now: live.now, tripsByDevice: tb, rosters: rmap, identFixes: fixes });
    }, [view, tb, live.now, rmap, fixes]);
    const onIdent = GI.saveIdent ? r => setIdents(m => new Map(m).set(r.key, r)) : null;
    const { shifts, limits } = period;
    const findSel = sel && (res.shifts.find(j => j.key === sel.key) || shifts.find(j => j.key === sel.key) || sel);
    const openDriver = id => { setSel(null); setDrv(id); };
    // abierta desde la ficha de un conductor en otra pestaña
    useEffect(() => { if (openDriverId) { setSel(null); setDrv(openDriverId); setSec("seguimiento"); if (onOpened) onOpened(); } }, [openDriverId]);
    const subs = ANALYSIS.filter(([k]) => !BETA_ANALYSIS.has(k) || isBeta());
    return html`<div>
      <div className="subnav"><${Segmented} value=${sec} onChange=${setSec} options=${SECTIONS.map(([value, label]) => ({ value, label }))} /></div>
      ${sec === "seguimiento" ? html`<${TrackSection} view=${view} res=${res} live=${live} onRefresh=${refresh} onDriver=${openDriver} api=${api} />`
        : sec === "casos" ? html`<${CasesSection} view=${view} shifts=${shifts} cases=${cases} idents=${idents} limits=${limits} onOpen=${setSel} onDriver=${openDriver} />`
        : html`<div>
          <div className="subnav ft-subnav"><${Segmented} value=${sub} onChange=${setSub} options=${subs.map(([value, label]) => ({ value, label }))} /></div>
          ${sub === "validacion" && isBeta() ? html`<${ValidationSection} view=${view} res=${period} isAdmin=${isAdmin} settings=${view.settings} onSaveSettings=${onSaveSettings} /><${OutcomePanel} res=${period} />`
            : sub === "descanso" && isBeta() ? html`<${RestSection} view=${view} res=${period} onDriver=${openDriver} />`
            : sub === "operacion" && isBeta() ? html`<${OpsSection} view=${view} res=${period} onDriver=${openDriver} />`
            : sub === "indicadores" && isBeta() ? html`<${KpiSection} view=${view} res=${period} cases=${cases} idents=${idents} onCase=${setSel} onDriver=${openDriver} api=${api} userName=${userName} onIdent=${onIdent} />`
            : html`<${DriversSection} view=${view} onDriver=${openDriver} />`}
        </div>`}
      ${drv && !findSel ? html`<${FatigueDriver} key=${drv} view=${view} id=${drv} res=${res} cases=${cases} now=${live.now} status=${live.status} acks=${live.acks || []}
        api=${api} isAdmin=${isAdmin} userName=${userName} roster=${rosters.get(drv)} onRoster=${r => setRosters(m => { const n = new Map(m); if (r && !r.removed) n.set(r.drv, r); else n.delete(drv); return n; })}
        onClose=${() => setDrv(null)} onCase=${j => setSel(j)} onSafety=${id => { setDrv(null); onDriver(id); }} />` : null}
      ${findSel ? html`<${CaseDetail} key=${findSel.key} view=${view} api=${api} j=${findSel} fz=${limits} rec=${cases.get(findSel.key)} userName=${userName}
        shifts=${shifts} identRec=${idents.get(findSel.key)} onIdent=${onIdent} allTrips=${tb || view.model.tripsByDevice}
        onDriver=${openDriver}
        onSaved=${c => setCases(m => new Map(m).set(c.key, c))} onClose=${() => setSel(null)} />` : null}
    </div>`;
  }


  // ---------- Alertas de fatiga con intervención obligatoria ----------
  // Corre mientras el add-in está abierto (en cualquier pestaña): cada 3 min recalcula el índice de
  // los conductores en jornada y, si alguno pasa el umbral, muestra una ventana que no se cierra sin
  // registrar la intervención. La intervención queda guardada para todos los supervisores.
  const ALERT_ACTIONS = [
    ["bien", "Llamé al conductor: está bien y sigue con precaución"],
    ["pausa", "Se le indicó una pausa corta (15–30 min)"],
    ["descanso", "Se le indicó detenerse a descansar"],
    ["relevo", "Se coordinó un relevo o cambio de chofer"],
    ["camara", "Verificado por cámara: se lo ve atento"],
    ["nocontesta", "No contesta: se escala a la base o al supervisor de campo"],
    ["error", "Dato erróneo: no está manejando él o el vehículo no comunica"],
    ["otra", "Otra (detallar en la nota)"],
  ];
  const ALERT_POLL_MS = 3 * 60000;
  // Reproductor de video en vivo de MyGeotab (Activos → Cámaras) para un vehículo: sirve para
  // Surfsight y GO Focus, con los permisos, el aviso de consumo de datos y la auditoría de MyGeotab.
  // Se abre en otra pestaña para que esta siga vigilando las alertas.
  GI.openLiveVideo = function (devId) {
    const base = GI.MG_BASE_URL || window.location.href.split("#")[0];
    window.open(base + "#inventory,livestreamDeviceId:" + encodeURIComponent(devId) + ",tab:cameras", "_blank", "noopener");
  };
  GI.openLiveMap = GI.openLiveVideo;
  function beep() {
    try {
      const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
      const c = beep.ctx || (beep.ctx = new C()), o = c.createOscillator(), g = c.createGain();
      o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(c.destination);
      o.start(); o.stop(c.currentTime + 0.35);
    } catch (e) { /* el navegador puede bloquear el sonido hasta que alguien toque la página */ }
  }

  function FatigueAlerts({ view, api, settings, userName }) {
    const cfg = GI.alertConfig(settings);
    const allowed = !String(cfg.users || "").trim() || String(cfg.users).split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean).includes(String(userName || "").toLowerCase());
    const [state, setState] = useState({ items: [], acks: [], at: null });
    const [rosters, setRosters] = useState(null);
    const [idx, setIdx] = useState(0);
    const timer = useRef(null);
    const on = cfg.on && allowed && !!view;
    async function poll() {
      try {
        const now = Date.now();
        const [recent, status, acks, ro, idn] = await Promise.all([GI.loadRecentTrips(api, LIVE_HOURS), GI.loadDriveStatus(api).catch(() => []),
          GI.loadAlertAcks(api, now - 3 * 86400000).catch(() => []),
          rosters ? Promise.resolve(null) : GI.loadRosters ? GI.loadRosters(api).catch(() => []) : Promise.resolve([]),
          rosters ? Promise.resolve(null) : GI.loadIdents ? GI.loadIdents(api).catch(() => []) : Promise.resolve([])]);
        let rs = rosters;
        if (!rs) {
          rs = { rmap: new Map((ro || []).map(r => [r.drv, r])), fixes: (idn || []).filter(r => r.outcome === "relevo" && r.at).map(r => ({ drv: r.drv, d: r.d, from: r.from || r.s, to: r.at, other: r.other || null })) };
          setRosters(rs);
        }
        const tb = GI.liveTrips(view.model, recent, status, LIVE_HOURS, now);
        const res = GI.buildShifts(view.model, view.ids, view.driverOk, { now, tripsByDevice: tb, rosters: rs.rmap, identFixes: rs.fixes });
        const items = [];
        for (const [drv, entry] of res.sims) {
          if (!entry.sim) continue;
          const proj = GI.projectIndex(entry, res.limits, now, 16);
          if (!proj || !proj.open) continue;
          const j = proj.open, lt = j.trips[j.trips.length - 1];
          items.push({ drv, key: j.key, F: proj.Fnow, j, proj, dev: lt.d, prog: GI.shiftProgress(j, res.limits, now), off: GI.commGap(entry, status, now), fz: res.limits });
        }
        setState({ items: GI.alertsDue(items, acks, cfg, now), acks, at: now });
      } catch (e) { console.warn("[Geotab Insights] alertas de fatiga", e); }
    }
    useEffect(() => {
      if (!on) return;
      poll();
      timer.current = setInterval(poll, ALERT_POLL_MS);
      return () => clearInterval(timer.current);
    }, [on, view, cfg.warn, cfg.crit]);
    const due = on ? state.items : [];
    const cur = due[Math.min(idx, due.length - 1)];
    // sonido y título de la pestaña mientras haya alertas sin atender
    useEffect(() => {
      const t0 = document.title.replace(/^⚠ Alerta de fatiga · /, "");
      if (!due.length) { document.title = t0; return; }
      document.title = "⚠ Alerta de fatiga · " + t0;
      const sec = +cfg.beep_sec || 0; // 0 = sin sonido
      if (sec > 0) beep();
      const b = sec > 0 ? setInterval(beep, Math.max(3, sec) * 1000) : null;
      return () => { if (b) clearInterval(b); document.title = t0; };
    }, [due.length, cur && cur.drv, cfg.beep_sec]);
    if (!cur) return null;
    return html`<${AlertModal} key=${cur.drv + cur.key + cur.level} a=${cur} n=${due.length} i=${Math.min(idx, due.length - 1)} setIdx=${setIdx} view=${view} api=${api} userName=${userName} cfg=${cfg}
      onSaved=${ack => setState(st => { const acks = [...st.acks, ack]; return { ...st, acks, items: GI.alertsDue(st.items, acks, cfg, Date.now()) }; })} />`;
  }


  // Video en vivo dentro de la alerta: live.html (misma versión del add-in) con el Video Player de
  // Geotab. Las credenciales de la sesión se pasan por postMessage, nunca en la URL.

  // Video en vivo Surfsight dentro del add-in: token de la organización desde el servicio de cámaras de
  // Geotab (con la sesión de MyGeotab) y el componente <lytx-live-video> de Surfsight, el mismo que usa
  // MyGeotab. Como MyGeotab, informa el consumo de datos cada 30 s (si no se puede, no arranca) y deja
  // un registro en la auditoría de MyGeotab. Se corta solo a los 3 min para no gastar datos de más.
  const SURF_LENSES = { 1: "Camino", 2: "Cabina", 51: "Auxiliar 1", 52: "Auxiliar 2", 53: "Auxiliar 3", 54: "Auxiliar 4" };
  const SURF_UI = "https://ui-components.surfsight.net/latest/build/cloud-ui-components.esm.js";
  const SURF_MAX_S = 180;
  // Carga del componente de Surfsight. Si falla o no responde, se puede reintentar (con otra URL para
  // que el navegador no reuse un intento fallido) y el error dice qué pasó.
  function loadSurfsightUi() {
    if (window.customElements && customElements.get("lytx-live-video")) return Promise.resolve();
    if (!loadSurfsightUi.p) {
      loadSurfsightUi.n = (loadSurfsightUi.n || 0) + 1;
      loadSurfsightUi.p = new Promise((ok, ko) => {
        const fail = msg => { loadSurfsightUi.p = null; ko(new Error(msg)); };
        const sc = document.createElement("script"); sc.type = "module";
        sc.src = SURF_UI + (loadSurfsightUi.n > 1 ? "?r=" + Date.now() : "");
        sc.onerror = () => fail("no se pudo descargar el reproductor de Surfsight (ui-components.surfsight.net)");
        document.head.appendChild(sc);
        customElements.whenDefined("lytx-live-video").then(ok);
        setTimeout(() => { if (!customElements.get("lytx-live-video")) fail("el reproductor de Surfsight se descargó pero no arrancó en 30 s"); }, 30000);
      });
    }
    return loadSurfsightUi.p;
  }
  function SurfsightLive({ api, view, dev, cam, auto }) {
    const imei = cam.imei || cam.serial;
    const [lenses, setLenses] = useState(null), [lens, setLens] = useState(2);
    const [st, setSt] = useState({ phase: "idle" }); // idle | starting | live | paused | error
    const tok = useRef(null), tick = useRef(null), secs = useRef(0);
    useEffect(() => {
      let off = false;
      GI.surfsightLenses(imei).then(l => { if (off) return; setLenses(l); if (l.length && !l.includes(2)) setLens(l[0]); })
        .catch(() => { if (!off) setLenses([1, 2]); });
      return () => { off = true; };
    }, [imei]);
    const stop = phase => { if (tick.current) clearInterval(tick.current); tick.current = null; setSt(s => ({ ...s, phase: phase || "idle" })); };
    useEffect(() => () => { if (tick.current) clearInterval(tick.current); }, []);
    async function start() {
      setSt({ phase: "starting" });
      try {
        if (!tok.current || Date.now() - tok.current.at > 20 * 60000) tok.current = { ...(await GI.surfsightToken()), at: Date.now() };
        const code = await GI.surfsightConsumption(imei, tok.current.token);
        if (code < 200 || code >= 300) throw new Error(code === 403 || code === 429 ? "Surfsight no autorizó el video (puede ser el límite mensual de video en vivo del plan)" : "Surfsight respondió " + code + " al registrar el consumo de datos");
        await loadSurfsightUi();
        try { api.call("Add", { typeName: "Audit", entity: { name: "Video en vivo (Geotab Insights)", comment: devName(view, dev) + " · cámara " + imei + " · lente " + (SURF_LENSES[lens] || lens) } }); } catch (e) { /* la auditoría no frena el video */ }
        secs.current = 0;
        setSt({ phase: "live", token: tok.current.token, org: tok.current.orgId, key: Date.now() });
        tick.current = setInterval(async () => {
          secs.current += 30;
          if (secs.current >= SURF_MAX_S) { stop("paused"); return; }
          try { await GI.surfsightConsumption(imei, tok.current.token); } catch (e) { /* se reintenta en el próximo tramo */ }
        }, 30000);
      } catch (e) { const m = String((e && e.message) || e); stop(); setSt({ phase: "error", err: /failed to fetch|networkerror|load failed/i.test(m) ? "el navegador no pudo conectarse con el servicio de cámaras (" + m + ")" : m }); }
    }
    // Surfsight solo deja cargar su reproductor desde páginas de MyGeotab: en la página independiente
    // (otro dominio) el navegador lo bloquea, así que ahí se usa el reproductor de MyGeotab.
    const standalone = !!GI.MG_BASE_URL;
    useEffect(() => { if (auto && !standalone && /online/i.test(cam.status)) start(); }, []);

    useEffect(() => { if (st.phase === "live") { stop(); start(); } }, [lens]);
    if (standalone) return html`<div className="ft-surf"><div className="ft-cam-bar">
      <span className="small muted">Desde la página independiente no se puede mostrar el video de Surfsight: su servidor solo lo permite dentro de MyGeotab.</span>
      <button className="btn primary" onClick=${() => GI.openLiveVideo(dev)}>Ver en vivo en MyGeotab ↗</button></div></div>`;
    return html`<div className="ft-surf">
      <div className="ft-cam-bar">
        <span className="small">Lente: ${(lenses || [1, 2]).map(l => html`<button key=${l} type="button" className=${"btn small" + (l === lens ? " primary" : "")} aria-pressed=${l === lens} onClick=${() => setLens(l)}>${SURF_LENSES[l] || "Lente " + l}</button>`)}</span>
        ${st.phase === "live" ? html`<button className="btn small" onClick=${() => stop()}>Cortar el video</button>`
          : html`<button className="btn primary" disabled=${st.phase === "starting"} onClick=${start}>${st.phase === "starting" ? "Conectando…" : st.phase === "paused" ? "Seguir viendo" : "Ver en vivo aquí"}</button>`}
      </div>
      ${st.phase === "live" ? html`<div className="ft-cam-frame surf"><lytx-live-video key=${st.key + "-" + lens} auth-token=${st.token} imei=${imei} camera-id=${String(lens)} organization-id=${String(st.org)}></lytx-live-video></div>
        <span className="small muted">Se corta solo a los ${SURF_MAX_S / 60} minutos para no consumir datos de más.</span>` : null}
      ${st.phase === "paused" ? html`<span className="small muted">El video se pausó a los ${SURF_MAX_S / 60} minutos.</span>` : null}
      ${st.phase === "error" ? html`<span className="small delta bad">No se pudo abrir el video acá: ${st.err}. Usá "Ver en vivo en MyGeotab".</span>` : null}
    </div>`;
  }

  function LiveCam({ api, view, dev, auto }) {
    const [cams, setCams] = useState(null), [err, setErr] = useState(null), [sel, setSel] = useState(null), [go, setGo] = useState(false);
    const frame = useRef(null);
    useEffect(() => {
      let off = false;
      GI.loadCameras(api, dev, view.model.devices).then(c => { if (off) return; setCams(c); const on = c.find(x => /online/i.test(x.status)) || c[0]; setSel(on ? on.serial : null); if (auto && on && (/online/i.test(on.status) || !on.status) && !/surfsight|lytx/i.test(on.vendor)) setGo(true); })
        .catch(e => { if (!off) { setCams([]); setErr(String((e && e.message) || e)); } });
      return () => { off = true; };
    }, [dev]);
    const sess = GI._mgSession;
    const src = sel && sess && GI.STATIC_BASE ? GI.STATIC_BASE + "live.html?server=" + encodeURIComponent(sess.server) + "&serial=" + encodeURIComponent(sel) : null;
    useEffect(() => {
      if (!go || !src) return;
      const origin = new URL(src).origin;
      const h = e => { if (frame.current && e.source === frame.current.contentWindow && e.data && e.data.gvpReady) frame.current.contentWindow.postMessage({ gvpCredentials: { database: sess.database, userName: sess.userName, sessionId: sess.sessionId } }, origin); };
      window.addEventListener("message", h);
      return () => window.removeEventListener("message", h);
    }, [go, src]);
    const cam = cams && cams.find(c => c.serial === sel);
    // Surfsight necesita un token de Surfsight que solo maneja MyGeotab: su video se abre en el reproductor
    // de MyGeotab. Las cámaras de Geotab (GO Focus) se ven acá con el Video Player de Geotab.
    const ext = cam && /surfsight|lytx/i.test(cam.vendor);
    return html`<div className="ft-alert-cam">
      ${cams == null ? html`<span className="small muted">Buscando la cámara de ${devName(view, dev)}…</span>`
        : !cams.length ? html`<div className="ft-cam-bar"><span className="small muted">${err ? "No se pudo consultar la cámara en Geotab Video." : "Geotab Video no informa una cámara para este vehículo."}</span>
            <button className="btn primary" onClick=${() => GI.openLiveVideo(dev)}>Ver en vivo en MyGeotab ↗</button></div>`
        : html`<div className="ft-cam-bar">
            ${cams.length > 1 ? html`<select value=${sel || ""} onChange=${e => { setSel(e.target.value); }}>${cams.map(c => html`<option key=${c.serial} value=${c.serial}>${c.name}${c.vendor ? " · " + c.vendor : ""} (${c.status || "estado desconocido"})</option>`)}</select>`
              : html`<span className="small">Cámara ${cam.name}${cam.vendor ? " · " + cam.vendor : ""} ${cam.status ? html` · <b className=${/online/i.test(cam.status) ? "ft-cam-on" : "muted"}>${/online/i.test(cam.status) ? "en línea" : cam.status.toLowerCase()}</b>` : null}${cam.lastConn && !/online/i.test(cam.status) ? html` <span className="muted">· última conexión ${when(Date.parse(cam.lastConn))}</span>` : null}</span>`}
            ${ext ? html`<button className="btn small" onClick=${() => GI.openLiveVideo(dev)}>Ver en vivo en MyGeotab ↗</button>`
              : !go ? html`<button className="btn primary" disabled=${!src} onClick=${() => setGo(true)}>Ver en vivo aquí</button>` : html`<button className="btn small" onClick=${() => setGo(false)}>Cortar el video</button>`}
          </div>
          ${ext ? html`<${SurfsightLive} key=${cam.serial} api=${api} view=${view} dev=${dev} cam=${cam} auto=${auto} />` : null}
          ${go && src && !ext ? html`<div className="ft-cam-frame gvp"><iframe ref=${frame} key=${src} src=${src} title="Video en vivo" allow="autoplay; fullscreen"></iframe></div>` : null}
          ${cam && cam.status && !/online/i.test(cam.status) ? html`<span className="small muted">La cámara no figura en línea: el video en vivo necesita el vehículo encendido y la cámara conectada.</span>` : null}`}
      ${!ext ? html`<button className="btn small" onClick=${() => GI.openLiveVideo(dev)}>Abrir el video en MyGeotab ↗</button>` : null}
    </div>`;
  }

  function AlertModal({ a, n, i, setIdx, view, api, userName, cfg, onSaved }) {
    const fz = a.fz, crit = a.level === "critica", now = Date.now();
    const [action, setAction] = useState("");
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false), [err, setErr] = useState(null);
    const needNote = action === "otra" || action === "nocontesta" || crit;
    const ok = action && (!needNote || note.trim().length >= 3);
    async function save() {
      setBusy(true); setErr(null);
      try {
        const ack = await GI.saveAlertAck(api, { drv: a.drv, key: a.key, d: a.dev, level: a.level, F: Math.round(a.F), at: Date.now(), action, actionLabel: (ALERT_ACTIONS.find(x => x[0] === action) || [])[1], note: note.trim(), by: userName || "" });
        onSaved(ack);
      } catch (e) { setErr("No se pudo guardar: " + ((e && e.message) || e)); }
      setBusy(false);
    }
    const p = a.proj, pr = a.prog;
    return html`<div className="modal-bg ft-alert-bg" role="alertdialog" aria-modal="true" aria-labelledby="ft-alert-t">
      <div className=${"modal wide ft-alert " + (crit ? "crit" : "warn")}>
        <div className="modal-head"><h2 id="ft-alert-t">${crit ? "Alerta crítica de fatiga" : "Alerta de fatiga"} · intervención obligatoria</h2>
          ${n > 1 ? html`<span className="ft-alert-nav"><button className="btn small" disabled=${i === 0} onClick=${() => setIdx(i - 1)}>‹</button> ${i + 1} de ${n} <button className="btn small" disabled=${i >= n - 1} onClick=${() => setIdx(i + 1)}>›</button></span>` : null}</div>
        <div className="modal-body">
          <div className="ft-alert-who"><b>${drvName(view, a.drv)}</b> · ${devName(view, a.dev)}<span className="ft-alert-f">Índice ${fiTag(a.F, fz)} <span className="muted">(${crit ? "crítico desde " + cfg.crit : "alerta desde " + cfg.warn})</span></span></div>
          <p>En jornada desde las <b>${hm(a.j.s)}</b>: lleva ${dur((now - a.j.s) / H)} de jornada y ${dur(a.j.dh)} de manejo${pr && pr.driving ? html`, <span className="ft-live">● manejando ahora</span>` : pr ? ", parado hace " + dur(pr.sinceLast / 60) : ""}.
            ${p.crossAt && p.crossAt > now ? html` Si sigue a este ritmo, pasa de ${fz.fi_high} a las <b>${hm(p.crossAt)}</b>.` : ""}
            ${a.last ? html` <span className="muted">Última intervención: ${hm(a.last.at)} · ${a.last.actionLabel || a.last.action}${a.last.by ? " (" + a.last.by + ")" : ""}.</span>` : ""}</p>
          ${a.off ? html`<${Info} tone="warn">El vehículo no comunica con MyGeotab desde las ${hm(a.off.at)}: el índice usa lo último recibido.<//>` : null}
          <p className="small muted">El índice es una estimación por horarios de trabajo y descanso, no una detección del estado del conductor: verificá cómo está.</p>
          <${LiveCam} api=${api} view=${view} dev=${a.dev} auto=${crit} />
          <fieldset className="ft-alert-acts"><legend>¿Qué se hizo?</legend>
            ${ALERT_ACTIONS.map(([k, l]) => html`<label key=${k} className=${action === k ? "on" : ""}><input type="radio" name="ft-alert-act" value=${k} checked=${action === k} onChange=${() => setAction(k)} /> ${l}</label>`)}
          </fieldset>
          <label className="ft-alert-note">Nota${needNote ? " (obligatoria)" : " (opcional)"}<textarea rows="2" value=${note} onInput=${e => setNote(e.target.value)} placeholder=${crit ? "Qué dijo el conductor, qué se vio en la cámara, qué se decidió" : "Detalle de la intervención"}></textarea></label>
          ${err ? html`<p className="delta bad small">${err}</p>` : null}
          <div className="form-actions"><button className="btn primary" disabled=${busy || !ok} onClick=${save}>${busy ? "Guardando…" : "Registrar intervención"}</button>
            <span className="small muted">${!action ? "Elegí qué se hizo para cerrar la alerta." : needNote && note.trim().length < 3 ? "Agregá una nota para cerrar la alerta." : "Queda registrada a tu nombre, con la hora."}</span></div>
        </div>
      </div>
    </div>`;
  }

  Object.assign(GI, { FatigueTab, FatigueSpark: Spark, FatigueAlerts, ALERT_ACTIONS });
})(window.GI);
