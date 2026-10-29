// Pestaña "Fatiga": jornadas en curso contra los límites (Ahora), riesgo del
// próximo turno, jornadas con señales de fatiga y su seguimiento (Casos), el
// resumen por conductor y la ficha de fatiga de cada conductor.
(function (GI) {
  "use strict";
  const React = GI.React;
  const { useState, useMemo, useEffect } = React;
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
    return html`<span className="ft-sigs">${j.signals.map(s => html`<span key=${s.key} className=${"ft-sig" + (s.key === "camara" ? " cam" : "") + (small ? " sm" : "")} title=${s.text}>${s.label}</span>`)}</span>`;
  }
  function DriverLink({ view, id, onDriver }) {
    return html`<button className="btn link ft-name" onClick=${e => { e.stopPropagation(); onDriver(id); }}>${drvName(view, id)}</button>`;
  }

  // ---------- Evolución del índice ----------
  // Gráfico del índice: la curva de los últimos días (sólida), la proyección de
  // las próximas horas (punteada), las jornadas abajo y los eventos de cámara
  // como contexto sobre la curva.
  function IndexChart({ entry, proj, fz, now, days, onCase, height }) {
    const W = 1000, Hh = height || 250, L = 40, R = 990, T = 20, B = Hh - 62;
    const t0 = now - days * 86400000, t1 = now + 16 * H;
    const x = t => L + ((Math.max(t0, Math.min(t1, t)) - t0) / (t1 - t0)) * (R - L);
    const yMax = 160, y = v => B - (Math.min(yMax, Math.max(0, v)) / yMax) * (B - T);
    const sim = entry.sim;
    const pts = [];
    for (let t = Math.max(t0, sim.t0); t <= now; t += 30 * MIN) pts.push(x(t).toFixed(1) + "," + y(sim.at(t)).toFixed(1));
    const proP = proj ? proj.pts.filter((p, i) => i % 2 === 0 || i === proj.pts.length - 1).map(([t, v]) => x(t).toFixed(1) + "," + y(v).toFixed(1)) : [];
    const shifts = entry.list.filter(j => j.e > t0);
    // descansos entre jornadas (y el que está en curso si no está en jornada)
    const rests = [];
    for (const j of entry.list) if (j.prevE != null && j.s > t0 && j.restBefore < 48) rests.push({ a: j.prevE, b: j.s, h: j.restBefore, k: restKind(j, fz), j });
    const last = entry.list[entry.list.length - 1];
    if (last && !last.open && last.e < now) rests.push({ a: last.e, b: now, h: (now - last.e) / H, k: "curso", j: null });
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
    const restColor = k => (k === "curso" ? "#a9dcbf" : GAP[k].color);
    return html`<div className="ft-tl">
      <svg viewBox=${"0 0 " + W + " " + Hh} role="img" aria-label="Evolución del índice de fatiga">
        ${rests.filter(r => r.b > t0).map((r, i) => html`<rect key=${"rb" + i} x=${x(r.a)} y=${T} width=${Math.max(0, x(r.b) - x(r.a))} height=${B - T} fill=${restColor(r.k)} opacity="0.16" />`)}
        ${nights.filter(([a, b]) => b > t0 && a < t1).map(([a, b], i) => html`<rect key=${"n" + i} x=${x(a)} y=${T - 8} width=${Math.max(0, x(b) - x(a))} height="5" rx="1" fill="#c9cfe3" />`)}
        <rect x=${x(now)} y=${T} width=${R - x(now)} height=${B - T} fill="#f4f5f7" opacity="0.8" />
        ${[0, 40, 80, 120, 160].map(v => html`<g key=${"g" + v}><line x1=${L} x2=${R} y1=${y(v)} y2=${y(v)} stroke="#eceff3" /><text x=${L - 6} y=${y(v) + 4} textAnchor="end" className="ft-tl-tick">${v}</text></g>`)}
        ${[fz.fi_mod, fz.fi_high].map((v, i) => html`<g key=${"th" + v}><line x1=${L} x2=${R} y1=${y(v)} y2=${y(v)} stroke=${i ? "#d4561e" : "#c99400"} strokeDasharray="5 4" /><text x=${L + 4} y=${y(v) - 4} className="ft-tl-lab">${(i ? "alto " : "moderado ") + v}</text></g>`)}

        ${rests.filter(r => r.b > t0).map((r, i) => html`<g key=${"r" + i}><rect x=${x(r.a)} y=${BY} width=${Math.max(1.5, x(r.b) - x(r.a))} height=${BH} fill=${restColor(r.k)} />
          ${label(r.a, r.b, (r.k === "curso" ? "descansa " : "") + dur(r.h))}
          <title>${(r.k === "curso" ? "Descansando desde " + when(r.a) + " (" + dur(r.h) + " hasta ahora)" : GAP[r.k].label.split(" (")[0] + ": " + dur(r.h) + " · " + when(r.a) + " → " + when(r.b)) + (r.j && r.j.restPlace ? " · " + placeTxt(r.j.restPlace) : "") + (r.j && r.j.restMicro && r.j.restMicro.length ? " · " + r.j.restMicro.length + " movimiento(s) mínimo(s) ignorado(s): " + r.j.restMicro.map(t => hm(t.s)).join(", ") : "")}</title></g>`)}
        ${shifts.map(j => html`<g key=${j.key} style=${{ cursor: "pointer" }} onClick=${() => onCase && onCase(j)}>
          <rect x=${x(j.s)} y=${BY} width=${Math.max(2, x(j.e) - x(j.s))} height=${BH} fill=${FI_COLORS[GI.fiLevel(j.fiPeak, fz)] || "#1f2a37"} />
          ${label(j.s, j.e, (j.open ? "en curso " : "") + dur(j.open ? (now - j.s) / H : j.span), GI.fiLevel(j.fiPeak, fz) !== "moderado")}
          <title>${"Jornada " + when(j.s) + " → " + (j.open ? "en curso" : when(j.e)) + " · " + dur(j.span) + " (" + dur(j.dh) + " de manejo)"  + " · índice máx. " + Math.round(j.fiPeak) + " (click para ver)"}</title></g>`)}
        ${proj && proj.nextStart && proj.nextStart < t1 ? html`<g><rect x=${x(proj.nextStart)} y=${BY} width=${Math.max(2, x(proj.nextStart + proj.hb.span * H) - x(proj.nextStart))} height=${BH} fill="none" stroke="#1f2a37" strokeDasharray="3 2" />
          ${label(proj.nextStart, proj.nextStart + proj.hb.span * H, "próximo " + dur(proj.hb.span))}<title>${"Próximo turno habitual: " + when(proj.nextStart) + " (" + dur(proj.hb.span) + ")"}</title></g>` : null}

        <path d=${"M" + pts.join("L")} fill="none" stroke="#1f2a37" strokeWidth="2.2" />
        ${proP.length ? html`<path d=${"M" + proP.join("L")} fill="none" stroke="#1f2a37" strokeWidth="2" strokeDasharray="5 4" opacity="0.7" />` : null}
        ${cams.map((e, i) => html`<path key=${"c" + i} d=${"M" + x(e.t) + " " + (y(sim.at(e.t)) - 5) + " l-5 -9 h10 z"} fill=${CAM_COLORS[e.cat] || "#b93a0f"} opacity="0.85"><title>${when(e.t) + " · " + GI.catLabel(e.cat) + " · índice " + Math.round(sim.at(e.t))}</title></path>`)}
        <line x1=${x(now)} x2=${x(now)} y1=${T} y2=${BY + BH} stroke="#2a78d6" strokeWidth="1.5" />
        <text x=${x(now) + 4} y=${T + 10} className="ft-tl-lab b" fill="#2a78d6">ahora ${proj ? Math.round(proj.Fnow) : ""}</text>
        ${proj && proj.crossAt && proj.crossAt > now ? html`<g><circle cx=${x(proj.crossAt)} cy=${y(fz.fi_high)} r="4.5" fill="#d4561e" /><text x=${x(proj.crossAt) + (x(proj.crossAt) > R - 60 ? -6 : 6)} y=${y(fz.fi_high) - 6} textAnchor=${x(proj.crossAt) > R - 60 ? "end" : "start"} className="ft-tl-lab b">${(GI.dayKey(proj.crossAt) !== GI.dayKey(now) ? dshort(proj.crossAt) + " " : "") + hm(proj.crossAt)}</text></g>` : null}
        ${ticks.map(t => html`<g key=${"k" + t}><line x1=${x(t)} x2=${x(t)} y1=${BY + BH} y2=${BY + BH + 5} stroke="#7b8492" /><text x=${x(t)} y=${Hh - 8} textAnchor="middle" className="ft-tl-tick">${dshort(t)}</text></g>`)}
      </svg>
      <div className="ft-tl-legend small">
        <span><i style=${{ background: "#1f2a37" }}></i>Índice estimado</span>
        <span><i style=${{ background: "repeating-linear-gradient(90deg,#1f2a37 0 4px,transparent 4px 7px)" }}></i>Proyección con su horario habitual</span>
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
  function Spark({ entry, proj, fz, now }) {
    const W = 220, Hh = 44, t0 = now - 72 * H, t1 = now + 16 * H;
    const x = t => ((t - t0) / (t1 - t0)) * W, y = v => Hh - 3 - (Math.min(160, Math.max(0, v)) / 160) * (Hh - 6);
    const sim = entry.sim, pts = [];
    for (let t = Math.max(t0, sim.t0); t <= now; t += H) pts.push(x(t).toFixed(1) + "," + y(sim.at(t)).toFixed(1));
    const pp = proj ? proj.pts.filter((p, i) => i % 4 === 0 || i === proj.pts.length - 1).map(([t, v]) => x(t).toFixed(1) + "," + y(v).toFixed(1)) : [];
    return html`<svg className="ft-spark" viewBox=${"0 0 " + W + " " + Hh} width="220" height="44" aria-hidden="true">
      <rect x=${x(now)} y="0" width=${W - x(now)} height=${Hh} fill="#f4f6f9" />
      <line x1="0" x2=${W} y1=${y(fz.fi_high)} y2=${y(fz.fi_high)} stroke="#d4561e" strokeDasharray="3 3" />
      <line x1="0" x2=${W} y1=${y(fz.fi_mod)} y2=${y(fz.fi_mod)} stroke="#c99400" strokeDasharray="2 3" opacity="0.6" />
      ${pts.length ? html`<path d=${"M" + pts.join("L")} fill="none" stroke="#1f2a37" strokeWidth="1.6" />` : null}
      ${pp.length ? html`<path d=${"M" + pp.join("L")} fill="none" stroke="#1f2a37" strokeWidth="1.4" strokeDasharray="3 2" opacity="0.7" />` : null}
      <line x1=${x(now)} x2=${x(now)} y1="0" y2=${Hh} stroke="#2a78d6" />
    </svg>`;
  }

  // ---------- Seguimiento: quién se acerca a un índice alto ----------
  function TrackSection({ view, res, live, onRefresh, onDriver }) {
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
        out.push({ id, entry, proj, prog, last });
      }
      const ord = { rojo: 2, amarillo: 1, ok: 0 };
      return out.sort((a, b) => ord[b.proj.level] - ord[a.proj.level] || b.proj.risk - a.proj.risk);
    }, [res, now]);
    const show = all ? rows : rows.filter(r => r.proj.level !== "ok");
    const red = rows.filter(r => r.proj.level === "rojo"), soon = rows.filter(r => r.proj.open && r.proj.crossAt && r.proj.crossAt > now);
    const nextHigh = rows.filter(r => !r.proj.open && r.proj.next && r.proj.next.peak >= fz.fi_high);
    return html`<${Panel} title="¿Quién se acerca a un índice de fatiga alto?"
      hint=${"Conductores que trabajaron en las últimas 72 h o están en jornada. La curva muestra su índice de fatiga estimado de los últimos 3 días y, punteada, la proyección de las próximas 16 h: si está en jornada, sigue al ritmo que lleva hasta completar su jornada habitual; si descansa, arranca a su hora habitual (la mediana de sus últimas jornadas) y hace su jornada habitual. Alto desde " + fz.fi_high + ", moderado desde " + fz.fi_mod + " (Configuración → Fatiga y gravedad)."}
      actions=${html`<span className="muted small">${live.at ? "Datos de las " + hm(live.at) : ""}</span> <button className="btn small" disabled=${live.loading} onClick=${onRefresh}>${live.loading ? "Actualizando…" : "↻ Actualizar"}</button>`}>
      ${live.err ? html`<${Info} tone="warn">No se pudieron traer los viajes de las últimas horas (${live.err}); se usa lo cargado del período.<//>` : null}
      <div className="readouts compact inset">
        <${Kpi} label="Actuar ahora" value=${n0(red.length)} tone=${red.length ? "bad" : null} sub=${html`<span>en jornada con índice alto, o próximo turno que no llega a descansar lo necesario</span>`} />
        <${Kpi} label=${"En jornada y llegan a " + fz.fi_high} value=${n0(soon.length)} sub=${html`<span>${soon.length ? "el primero a las " + hm(Math.min(...soon.map(r => r.proj.crossAt))) : "en las próximas horas"}</span>`} />
        <${Kpi} label="Próximo turno con índice alto" value=${n0(nextHigh.length)} sub=${html`<span>si arrancan a su hora habitual</span>`} />
        <${Kpi} label="Conductores activos" value=${n0(rows.length)} sub=${html`<span>${n0(rows.filter(r => r.proj.open).length)} en jornada ahora</span>`} />
      </div>
      <div className="ft-filters"><${Segmented} value=${all ? "all" : "risk"} onChange=${v => setAll(v === "all")} options=${[{ value: "risk", label: "Con riesgo (" + rows.filter(r => r.proj.level !== "ok").length + ")" }, { value: "all", label: "Todos (" + rows.length + ")" }]} /></div>
      ${!show.length ? html`<p className="muted">${live.loading ? "Calculando…" : "Ningún conductor activo se acerca a un índice alto."}</p>` : html`<div className="table-wrap"><table className="tbl ft-track">
        <thead><tr><th>Conductor</th><th>Estado</th><th className="num">Índice ahora</th><th>Últimas 72 h y próximas 16 h</th><th className="num">Llega a ${fz.fi_high}</th><th>Qué hacer</th></tr></thead>
        <tbody>${show.map(r => { const p = r.proj; return html`<tr key=${r.id} className=${"ft-track-" + p.level} onClick=${() => onDriver(r.id)} style=${{ cursor: "pointer" }}>
          <td><${DriverLink} view=${view} id=${r.id} onDriver=${onDriver} /><div className="small muted">${r.last.devices.map(d => devName(view, d)).join(", ")}</div></td>
          <td className="small">${p.open ? html`${r.prog && r.prog.driving ? html`<span className="ft-live">● Manejando</span>` : "En jornada, parado hace " + dur(r.prog ? r.prog.sinceLast / 60 : 0)}
              <div className="muted">desde las ${hm(p.open.s)} · ${r.prog ? r.prog.items.map(it => html`<span key=${it.key} className=${"ft-lim " + it.level}>${it.label.replace("Manejo continuo", "Continuo")} ${dur(it.v)}/${it.max} h</span>`) : null}</div>`
            : p.franco ? html`De franco <span className="tag">${p.rs.label}</span><div className="muted">vuelve ${p.rs.backAt ? dshort(p.rs.backAt) : "–"}</div>`
            : html`Descansando hace ${dur((now - r.last.e) / H)}<div className="muted">${p.nextStart ? "arranque habitual " + when(p.nextStart) : ""}</div>`}
            ${p.rs && p.rs.work && !p.franco ? html`<div className="muted">día ${p.rs.curDay} de ${p.rs.work} <span className="tag" title=${p.rs.source === "auto" ? "Detectado de sus vueltas" : "Fijado a mano"}>${p.rs.label}</span></div>` : null}</td>
          <td className="num">${fiTag(p.Fnow, fz)}</td>
          <td><${Spark} entry=${r.entry} proj=${p} fz=${fz} now=${now} /></td>
          <td className="num">${p.crossAt && p.crossAt > now ? html`<b>${(GI.dayKey(p.crossAt) !== GI.dayKey(now) ? dshort(p.crossAt) + " " : "") + hm(p.crossAt)}</b>${p.open ? "" : html`<div className="small muted">en su próximo turno</div>`}` : p.open && p.Fnow >= fz.fi_high ? html`<b className="delta bad">ya</b>` : html`<span className="muted">–</span>`}</td>
          <td><span className=${"ft-act " + p.level}>${p.action}</span></td>
        </tr>`; })}</tbody></table></div>`}
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

  // ---------- Ficha de un caso (una jornada) ----------
  function CaseDetail({ view, api, j, fz, rec, userName, onSaved, onClose, onDriver }) {
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

  function FatigueDriver({ view, id, res, cases, now, onClose, onCase, onSafety, api, isAdmin, userName, roster, onRoster }) {
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
    const [cdays, setCdays] = useState(7);
    return html`<${Modal} wide title=${"Fatiga · " + drvName(view, id)} onClose=${onClose}>
      <div className="ft-case-head">
        ${proj ? html`<span>Índice de fatiga ahora: ${fiTag(proj.Fnow, fz)} <span className="muted">(${GI.fiLevel(proj.Fnow, fz)})</span></span>` : null}
        <span className="ft-case-links">
          <button className="btn small" onClick=${() => onSafety(id)}>Ficha de seguridad</button>
          <button className="btn small" onClick=${() => GI.openEventsPage({ driverIds: [id], from: view.model.dayKeys[0], to: view.model.dayKeys[view.model.dayKeys.length - 1] })}>Eventos en MyGeotab ↗</button>
        </span>
      </div>
      ${proj ? html`<div className=${"verdict-line " + (proj.level === "rojo" ? "bad" : "")}><span className="vtag">${proj.open ? "En jornada" : "Próximo turno"}</span><span>
        <b>${proj.action}.</b>
        ${proj.open ? html` Empezó a las ${hm(proj.open.s)} (turno ${proj.open.type}); lleva ${dur((now - proj.open.s) / H)} de jornada y ${dur(proj.open.dh)} de manejo. Si completa su jornada habitual (${dur(proj.hb.span)}) el índice llegaría a ${fiTag(proj.peak, fz)}${proj.crossAt && proj.crossAt > now ? html` y pasaría de ${fz.fi_high} a las <b>${hm(proj.crossAt)}</b>` : ""}.`
          : proj.next ? html` Terminó el ${when(proj.next.lastE)}. Si arranca a su hora habitual, el ${when(proj.next.start)} (turno ${proj.next.hb.type}, ${dur(proj.next.hb.span)}), empezaría con ${fiTag(proj.next.Fstart, fz)} y terminaría en ${fiTag(proj.next.peak, fz)}.` : null}</span></div>` : null}
      <${RosterBox} api=${api} id=${id} rs=${s && s.rs} roster=${roster} isAdmin=${isAdmin} userName=${userName} onRoster=${onRoster} />
      ${s && s.sim ? html`<div className="ft-sub-head"><h3>Evolución del índice de fatiga</h3><${Segmented} value=${cdays} onChange=${setCdays} options=${[{ value: 3, label: "3 días" }, { value: 7, label: "7 días" }, { value: 14, label: "14 días" }]} /></div>
        <${IndexChart} entry=${s} proj=${proj} fz=${fz} now=${now} days=${cdays} onCase=${onCase} height=${250} />` : null}
      <div className="ft-facts">${facts.map(([l, v, bad]) => html`<div key=${l} className=${bad ? "bad" : ""}><span>${l}</span><b>${v}</b></div>`)}</div>
      <details className="ft-more"><summary>Patrón de jornadas por día</summary>
        <div className="ft-sub-head"><span></span><${Segmented} value=${days} onChange=${setDays} options=${[{ value: 14, label: "14 días" }, { value: 28, label: "28 días" }]} /></div>
        <${ShiftPattern} list=${list} fz=${fz} days=${days} onCase=${onCase} />
      </details>
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
  function CasesSection({ view, shifts, cases, onOpen, onDriver, limits }) {
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
      <${DataTable} rowKey=${j => j.key} rows=${rows} limit=${25} defaultSort=${{ key: "s", dir: "desc" }} onRowClick=${onOpen} columns=${[
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
        { key: "st", label: "Estado", value: statusOf, fmt: j => { const c = cases.get(j.key); return html`<span className=${"ft-st ft-st-" + statusOf(j).toLowerCase()}>${statusOf(j)}</span>${c && c.owner ? html`<div className="small muted">${c.owner}</div>` : ""}`; } },
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
  function KpiSection({ view, res, cases }) {
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

  function FatigueTab({ view, api, onDriver, userName, isAdmin, onSaveSettings }) {
    const [sec, setSec] = useState("seguimiento");
    const [sub, setSub] = useState("conductores");
    const [sel, setSel] = useState(null);
    const [drv, setDrv] = useState(null);
    const [cases, setCases] = useState(new Map());
    const [live, setLive] = useState({ loading: true, now: Date.now() });
    const [rosters, setRosters] = useState(new Map()); // diagramas fijados a mano
    const rmap = useMemo(() => new Map([...rosters.values()].map(r => [r.drv, r])), [rosters]);
    const period = useMemo(() => GI.buildShifts(view.model, view.ids, view.driverOk, { rosters: rmap }), [view, rmap]);
    async function refresh() {
      setLive(l => ({ ...l, loading: true }));
      try {
        const [recent, status] = await Promise.all([GI.loadRecentTrips(api, LIVE_HOURS), GI.loadDriveStatus(api).catch(() => [])]);
        setLive({ recent, status, at: Date.now(), now: Date.now() });
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
      (GI.loadRosters ? GI.loadRosters(api) : Promise.resolve([])).then(list => { if (!off) setRosters(new Map(list.map(r => [r.drv, r]))); }).catch(e => console.warn("[Geotab Insights] diagramas", e));
      return () => { off = true; clearInterval(t); };
    }, [api]);
    // Seguimiento y fichas: período + viajes en vivo de las últimas horas.
    const res = useMemo(() => {
      if (!live.recent) return GI.buildShifts(view.model, view.ids, view.driverOk, { now: live.now, rosters: rmap });
      const tb = GI.liveTrips(view.model, live.recent, live.status, LIVE_HOURS, live.now);
      return GI.buildShifts(view.model, view.ids, view.driverOk, { now: live.now, tripsByDevice: tb, rosters: rmap });
    }, [view, live, rmap]);
    const { shifts, limits } = period;
    const findSel = sel && (res.shifts.find(j => j.key === sel.key) || shifts.find(j => j.key === sel.key) || sel);
    const openDriver = id => { setSel(null); setDrv(id); };
    const subs = ANALYSIS.filter(([k]) => !BETA_ANALYSIS.has(k) || isBeta());
    return html`<div>
      <div className="subnav"><${Segmented} value=${sec} onChange=${setSec} options=${SECTIONS.map(([value, label]) => ({ value, label }))} /></div>
      ${sec === "seguimiento" ? html`<${TrackSection} view=${view} res=${res} live=${live} onRefresh=${refresh} onDriver=${openDriver} />`
        : sec === "casos" ? html`<${CasesSection} view=${view} shifts=${shifts} cases=${cases} limits=${limits} onOpen=${setSel} onDriver=${openDriver} />`
        : html`<div>
          <div className="subnav ft-subnav"><${Segmented} value=${sub} onChange=${setSub} options=${subs.map(([value, label]) => ({ value, label }))} /></div>
          ${sub === "validacion" && isBeta() ? html`<${ValidationSection} view=${view} res=${period} isAdmin=${isAdmin} settings=${view.settings} onSaveSettings=${onSaveSettings} /><${OutcomePanel} res=${period} />`
            : sub === "descanso" && isBeta() ? html`<${RestSection} view=${view} res=${period} onDriver=${openDriver} />`
            : sub === "operacion" && isBeta() ? html`<${OpsSection} view=${view} res=${period} onDriver=${openDriver} />`
            : sub === "indicadores" && isBeta() ? html`<${KpiSection} view=${view} res=${period} cases=${cases} />`
            : html`<${DriversSection} view=${view} onDriver=${openDriver} />`}
        </div>`}
      ${drv && !findSel ? html`<${FatigueDriver} key=${drv} view=${view} id=${drv} res=${res} cases=${cases} now=${live.now}
        api=${api} isAdmin=${isAdmin} userName=${userName} roster=${rosters.get(drv)} onRoster=${r => setRosters(m => { const n = new Map(m); if (r && !r.removed) n.set(r.drv, r); else n.delete(drv); return n; })}
        onClose=${() => setDrv(null)} onCase=${j => setSel(j)} onSafety=${id => { setDrv(null); onDriver(id); }} />` : null}
      ${findSel ? html`<${CaseDetail} key=${findSel.key} view=${view} api=${api} j=${findSel} fz=${limits} rec=${cases.get(findSel.key)} userName=${userName}
        onDriver=${openDriver}
        onSaved=${c => setCases(m => new Map(m).set(c.key, c))} onClose=${() => setSel(null)} />` : null}
    </div>`;
  }

  Object.assign(GI, { FatigueTab });
})(window.GI);
