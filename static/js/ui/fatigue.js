// Pestaña "Fatiga": jornadas en curso contra los límites (Ahora), jornadas
// con señales de fatiga y su seguimiento (Casos) y el resumen por conductor.
(function (GI) {
  "use strict";
  const React = GI.React;
  const { useState, useMemo, useEffect } = React;
  const html = GI.html;
  const { Kpi, Panel, Info, DataTable, Segmented, Modal } = GI;
  const H = 3600000, MIN = 60000;
  const n0 = v => GI.fmtNum(v, 0), n1 = v => GI.fmtNum(v, 1);
  const hm = t => new Date(t).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
  const dshort = t => new Date(t).toLocaleDateString("es-AR", { weekday: "short", day: "numeric", month: "short" });
  const dur = h => { if (h == null || !isFinite(h)) return "–"; const m = Math.round(h * 60); return m < 60 ? m + " min" : Math.floor(m / 60) + " h" + (m % 60 ? " " + String(m % 60).padStart(2, "0") : ""); };
  const STATUS = ["Detectado", "Revisado", "Entrevista", "Cerrado"];
  const ACTIONS = ["", "Charla con el conductor", "Descanso obligatorio", "Cambio de diagrama", "Capacitación", "Derivación a salud ocupacional", "Otra"];
  const CAM_COLORS = { fatiga: "#b93a0f", distraccion: "#7a4dc2", salida_carril: "#c77700" };

  const drvName = (view, id) => view.model.driverName.get(id) || id;
  const devName = (view, id) => { const d = view.model.devById.get(id); return d ? d.name : id; };
  function levelTag(l) {
    return html`<span className=${"ft-level ft-" + l}>${l === "alto" ? "Alto" : l === "medio" ? "Medio" : "Bajo"}</span>`;
  }
  function sigChips(j, small) {
    return html`<span className="ft-sigs">${j.signals.map(s => html`<span key=${s.key} className=${"ft-sig" + (s.key === "camara" ? " cam" : "") + (small ? " sm" : "")} title=${s.text}>${s.label}</span>`)}</span>`;
  }

  // ---------- Ahora ----------
  function Bar({ it, now }) {
    const pct = Math.min(1.15, it.pct);
    const when = it.v >= it.max ? "superado" : it.at ? (it.at - now < 20 * H ? "llega a las " + hm(it.at) : "") : "";
    return html`<div className="ft-meter" title=${it.label + ": " + dur(it.v) + " de " + it.max + " h"}>
      <div className="ft-meter-head"><span>${it.label}</span><b>${dur(it.v)} <span className="muted">/ ${it.max} h</span></b></div>
      <div className="ft-bar"><div className=${"ft-fill " + it.level} style=${{ width: (pct / 1.15) * 100 + "%" }}></div><i style=${{ left: (0.8 / 1.15) * 100 + "%" }}></i><i className="max" style=${{ left: (1 / 1.15) * 100 + "%" }}></i></div>
      <div className=${"ft-meter-foot " + it.level}>${when}</div>
    </div>`;
  }

  function NowSection({ view, api, shifts0, onDriver, onCase }) {
    const [live, setLive] = useState({ loading: true });
    const [now, setNow] = useState(Date.now());
    async function refresh() {
      setLive(l => ({ ...l, loading: true }));
      try {
        const [recent, status] = await Promise.all([GI.loadRecentTrips(api, 36), GI.loadDriveStatus(api).catch(() => [])]);
        setLive({ recent, status, at: Date.now() }); setNow(Date.now());
      } catch (e) {
        console.warn("[Geotab Insights] fatiga en vivo", e);
        setLive({ err: GI.errText ? GI.errText(e) : String(e), at: Date.now() }); setNow(Date.now());
      }
    }
    useEffect(() => { refresh(); const t = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(t); }, []);
    const fz = GI.fatigueLimits(view.settings);
    const rows = useMemo(() => {
      const tb = live.recent ? GI.liveTrips(view.model, live.recent, live.status, 36, now) : null;
      const { shifts } = tb ? GI.buildShifts(view.model, view.ids, view.driverOk, { now, tripsByDevice: tb }) : { shifts: shifts0.map(j => Object.assign({}, j, { open: now - j.e < fz.SPLIT && now >= j.e - MIN })) };
      const order = { rojo: 2, amarillo: 1, ok: 0 };
      return shifts.filter(j => j.open).map(j => ({ j, p: GI.shiftProgress(j, fz, now) }))
        .sort((a, b) => order[b.p.worst] - order[a.p.worst] || Math.max(...b.p.items.map(x => x.pct)) - Math.max(...a.p.items.map(x => x.pct)));
    }, [live, now, view]);
    const red = rows.filter(r => r.p.worst === "rojo").length, yellow = rows.filter(r => r.p.worst === "amarillo").length;
    return html`<div>
      <${Panel} title="Jornadas en curso"
        hint=${"Conductores cuyo último viaje terminó hace menos de " + (fz.SPLIT / H) + " h (la pausa que cierra una jornada) o que están manejando ahora. Cada barra compara lo que lleva contra el límite de Configuración → Fatiga y gravedad: amarillo desde el 80 %, rojo al superarlo. La hora estimada supone que sigue manejando al mismo ritmo que en lo que va de la jornada."}
        actions=${html`<span className="muted small">${live.at ? "Datos de las " + hm(live.at) : ""}</span> <button className="btn small" disabled=${live.loading} onClick=${refresh}>${live.loading ? "Actualizando…" : "↻ Actualizar"}</button>`}>
        ${live.err ? html`<${Info} tone="warn">No se pudieron traer los viajes de las últimas horas (${live.err}); se muestra lo que hay en el período cargado.<//>` : null}
        <div className="readouts compact inset">
          <${Kpi} label="Jornadas en curso" value=${n0(rows.length)} sub=${html`<span>${n0(rows.filter(r => r.p.driving).length)} manejando ahora</span>`} />
          <${Kpi} label="Superaron un límite" value=${n0(red)} tone=${red ? "bad" : null} sub=${html`<span>jornada, manejo o continuo</span>`} />
          <${Kpi} label="Cerca del límite" value=${n0(yellow)} sub=${html`<span>80 % o más de algún límite</span>`} />
        </div>
        ${!rows.length ? html`<p className="muted">${live.loading ? "Buscando jornadas en curso…" : "No hay jornadas en curso en este momento."}</p>` : html`<div className="ft-now">
          ${rows.map(({ j, p }) => html`<div key=${j.key} className=${"ft-now-row " + p.worst}>
            <div className="ft-now-who">
              <button className="btn link" onClick=${() => onDriver(j.drv)}><b>${drvName(view, j.drv)}</b></button>
              <div className="small muted">${j.devices.map(d => devName(view, d)).join(", ")}</div>
              <div className="small">${p.driving ? html`<span className="ft-live">● Manejando</span>` : "Parado hace " + dur(p.sinceLast / 60)} · empezó ${hm(j.s)} (turno ${j.type})</div>
              <div className="small muted">Descanso previo: ${j.restBefore != null ? dur(j.restBefore) : "–"}${j.daysRow > 1 ? " · día " + j.daysRow + " seguido" : ""}</div>
            </div>
            <div className="ft-now-meters">${p.items.map(it => html`<${Bar} key=${it.key} it=${it} now=${now} />`)}</div>
            <div className="ft-now-sig">
              ${j.signals.length ? sigChips(j, true) : html`<span className="muted small">Sin señales todavía</span>`}
              ${p.nightAhead ? html`<div className="small ft-warn">Turno noche: va a manejar en la franja de 02 a 05 h.</div>` : null}
              ${j.signals.length ? html`<button className="btn link small" onClick=${() => onCase(j)}>Ver jornada</button>` : null}
            </div>
          </div>`)}
        </div>`}
      <//>
    </div>`;
  }

  // ---------- Línea de tiempo de una jornada ----------
  function Timeline({ view, j }) {
    const t0 = j.prevE != null && j.s - j.prevE < 20 * H ? j.prevE - H : j.s - 3 * H;
    const t1 = j.e + H;
    const W = 1000, L = 8, R = 992, x = t => L + ((t - t0) / (t1 - t0)) * (R - L);
    const span = (t1 - t0) / H, step = span > 30 ? 4 : span > 16 ? 2 : 1;
    const ticks = [];
    const first = new Date(t0); first.setMinutes(0, 0, 0); first.setHours(first.getHours() + 1);
    for (let t = first.getTime(); t < t1; t += H) if (new Date(t).getHours() % step === 0) ticks.push(t);
    const nights = [];
    const d0 = new Date(t0); d0.setHours(0, 0, 0, 0);
    for (let d = d0.getTime(); d < t1; d += 86400000) {
      const at = h => { const z = new Date(d); z.setHours(h, 0, 0, 0); return z.getTime(); };
      nights.push([at(0), at(6), "n"], [at(2), at(5), "low"]);
    }
    const cam = j.cam || [], other = (j.events || []).filter(e => !GI.FATIGUE_CAM_CATS.has(e.cat));
    const [ms0, ms1] = j.maxStintRange || [];
    return html`<div className="ft-tl">
      <svg viewBox=${"0 0 " + W + " 150"} role="img" aria-label="Línea de tiempo de la jornada">
        ${nights.map(([a, b, k], i) => (b > t0 && a < t1 ? html`<rect key=${"n" + i} x=${x(Math.max(a, t0))} y="0" width=${Math.max(0, x(Math.min(b, t1)) - x(Math.max(a, t0)))} height="122" fill=${k === "low" ? "#d9def0" : "#eef0f7"} />` : null))}
        ${nights.filter(([a, b, k]) => k === "low" && b > t0 && a < t1).map(([a, b], i) => html`<text key=${"nl" + i} x=${(x(Math.max(a, t0)) + x(Math.min(b, t1))) / 2} y="12" textAnchor="middle" className="ft-tl-lab">02–05 h</text>`)}
        ${j.prevE != null && j.prevE > t0 ? html`<rect x=${L} y="62" width=${Math.max(2, x(j.prevE) - L)} height="22" rx="3" fill="#b8c0cc" /><text x=${L + 4} y="56" className="ft-tl-lab">jornada anterior</text>` : null}
        ${j.prevE != null && j.prevE > t0 ? html`<g><line x1=${x(j.prevE)} x2=${x(j.s)} y1="96" y2="96" stroke="#5b6472" strokeDasharray="3 3" /><text x=${(x(j.prevE) + x(j.s)) / 2} y="110" textAnchor="middle" className="ft-tl-lab">descanso ${dur(j.restBefore)}</text></g>` : null}
        ${ms1 > ms0 && j.maxStint > 0 ? html`<g><line x1=${x(ms0)} x2=${x(ms1)} y1="54" y2="54" stroke="#1f2a37" strokeWidth="2" /><text x=${(x(ms0) + x(ms1)) / 2} y="48" textAnchor="middle" className="ft-tl-lab b">${dur(j.maxStint)} seguidas</text></g>` : null}
        ${j.trips.map((t, i) => html`<rect key=${"t" + i} x=${x(t.s)} y="62" width=${Math.max(2, x(t.e) - x(t.s))} height="22" rx="3" fill=${t.live ? "#2a78d6" : "#1f2a37"}><title>${hm(t.s) + "–" + hm(t.e) + " · " + dur(t.dh) + " de manejo · " + n0(t.km) + " km"}</title></rect>`)}
        ${(j.pauses || []).filter(([a, b]) => b - a >= 30 * MIN && x(b) - x(a) > 44).map(([a, b], i) => html`<text key=${"p" + i} x=${(x(a) + x(b)) / 2} y="78" textAnchor="middle" className="ft-tl-lab">${dur((b - a) / H)}</text>`)}
        ${other.map((e, i) => html`<line key=${"o" + i} x1=${x(e.t)} x2=${x(e.t)} y1="88" y2="94" stroke="#7b8492" strokeWidth="2"><title>${hm(e.t) + " " + GI.catLabel(e.cat)}</title></line>`)}
        ${cam.map((e, i) => html`<path key=${"c" + i} d=${"M" + x(e.t) + " 36 l-6 -10 h12 z"} fill=${CAM_COLORS[e.cat] || "#b93a0f"}><title>${hm(e.t) + " " + GI.catLabel(e.cat)}</title></path>`)}
        <line x1=${L} x2=${R} y1="122" y2="122" stroke="#cdd3db" />
        ${ticks.map(t => html`<g key=${"k" + t}><line x1=${x(t)} x2=${x(t)} y1="122" y2="127" stroke="#7b8492" /><text x=${x(t)} y="142" textAnchor="middle" className="ft-tl-tick">${new Date(t).getHours() === 0 ? dshort(t) : String(new Date(t).getHours()).padStart(2, "0") + " h"}</text></g>`)}
      </svg>
      <div className="ft-tl-legend small">
        <span><i style=${{ background: "#1f2a37" }}></i>Viaje</span>
        <span><i style=${{ background: "#eef0f7" }}></i>00–06 h</span>
        <span><i style=${{ background: "#d9def0" }}></i>02–05 h (más riesgo)</span>
        <span><i className="tri" style=${{ borderBottomColor: CAM_COLORS.fatiga }}></i>Fatiga</span>
        <span><i className="tri" style=${{ borderBottomColor: CAM_COLORS.distraccion }}></i>Distracción</span>
        <span><i className="tri" style=${{ borderBottomColor: CAM_COLORS.salida_carril }}></i>Salida de carril</span>
        <span><i style=${{ background: "#7b8492", width: "3px" }}></i>Otras infracciones</span>
      </div>
    </div>`;
  }

  // ---------- Ficha de un caso ----------
  function CaseDetail({ view, api, j, rec, userName, onSaved, onClose, onDriver }) {
    const [f, setF] = useState(() => ({ status: (rec && rec.status) || "Detectado", owner: (rec && rec.owner) || "", action: (rec && rec.action) || "", notes: (rec && rec.notes) || [] }));
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false), [err, setErr] = useState(null), [ok, setOk] = useState(false);
    async function save() {
      setBusy(true); setErr(null); setOk(false);
      try {
        const notes = note.trim() ? [...f.notes, { t: Date.now(), user: userName || "", text: note.trim() }] : f.notes;
        const saved = await GI.saveFatigueCase(api, { id: rec && rec.id, key: j.key, drv: j.drv, s: j.s, dk: j.dk, level: j.level, signals: j.signals.map(x => x.key),
          status: f.status, owner: f.owner, action: f.action, notes, by: userName || "" });
        setF(x => ({ ...x, notes })); setNote(""); setOk(true); onSaved(saved);
      } catch (e) { setErr(GI.errText ? GI.errText(e) : String(e)); }
      setBusy(false);
    }
    const facts = [
      ["Jornada", dur(j.span), j.signals.some(s => s.key === "larga")],
      ["Manejo", dur(j.dh), j.signals.some(s => s.key === "manejo")],
      ["Manejo continuo máx.", dur(j.maxStint), j.signals.some(s => s.key === "continuo")],
      ["Entre 02 y 05 h", dur(j.low), j.signals.some(s => s.key === "madrugada")],
      ["Descanso previo", j.restBefore != null ? dur(j.restBefore) : "–", j.signals.some(s => s.key === "descanso")],
      ["Días seguidos", n0(j.daysRow), j.signals.some(s => s.key === "seguidos")],
      ["Km", n0(j.km), false],
    ];
    return html`<${Modal} wide title=${drvName(view, j.drv) + " · " + dshort(j.s) + " " + hm(j.s) + " a " + (GI.dayKey(j.e) !== j.dk ? dshort(j.e) + " " : "") + hm(j.e)} onClose=${onClose}>
      <div className="ft-case-head">
        ${levelTag(j.level)}
        <span>Turno ${j.type} · ${j.devices.map(d => devName(view, d)).join(", ")}</span>
        <span className="ft-case-links">
          <button className="btn small" onClick=${() => onDriver(j.drv)}>Ficha del conductor</button>
          <button className="btn small" onClick=${() => GI.openEventsPage({ driverIds: [j.drv], deviceIds: j.devices, from: j.dk, to: GI.dayKey(j.e) })}>Eventos en MyGeotab ↗</button>
        </span>
      </div>
      ${j.signals.length ? html`<ul className="ft-why">${j.signals.map(s => html`<li key=${s.key}><span className=${"ft-sig" + (s.key === "camara" ? " cam" : "")}>${s.label}</span> ${s.text}</li>`)}</ul>` : html`<p className="muted">Esta jornada no tiene señales de fatiga.</p>`}
      <${Timeline} view=${view} j=${j} />
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

  // ---------- Casos ----------
  function CasesSection({ view, shifts, cases, onOpen, limits }) {
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
      hint=${"Cada fila es una jornada (viajes sin una pausa de " + (limits.SPLIT / H) + " h o más). Señales: jornada de más de " + limits.max_span + " h, más de " + limits.max_drive_day + " h de manejo, más de " + limits.max_continuous + " h sin una pausa de 15 min, manejo entre las 02 y las 05 h, cambio de turno día ↔ noche con un solo descanso, descanso de menos de " + limits.min_rest + " h o casi todo de día antes de un turno noche, más de " + limits.max_days_row + " días seguidos, y eventos de fatiga, distracción o salida de carril de cámaras o ADAS (3 o más en una hora valen doble). Nivel alto: 3 puntos o más. Medio: 2."}>
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
        { key: "drv", label: "Conductor", value: j => drvName(view, j.drv), fmt: j => html`${drvName(view, j.drv)}${(byDrv.get(j.drv) || []).length >= 2 ? html` <span className="tag" title="Jornadas en esta lista">${byDrv.get(j.drv).length}</span>` : ""}` },
        { key: "dev", label: "Vehículo", value: j => devName(view, j.devices[0]), fmt: j => j.devices.map(d => devName(view, d)).join(", ") },
        { key: "type", label: "Turno" },
        { key: "span", label: "Jornada", align: "num", fmt: j => dur(j.span) },
        { key: "dh", label: "Manejo", align: "num", fmt: j => dur(j.dh) },
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
    return html`<${GI.FatiguePanel} view=${view} rf=${rf} onDriver=${onDriver} />`;
  }

  const SECTIONS = [["ahora", "Ahora"], ["casos", "Casos"], ["conductores", "Conductores"]];

  function FatigueTab({ view, api, onDriver, userName }) {
    const [sec, setSec] = useState("ahora");
    const [sel, setSel] = useState(null);
    const [cases, setCases] = useState(new Map());
    const { shifts, limits } = useMemo(() => GI.buildShifts(view.model, view.ids, view.driverOk), [view]);
    useEffect(() => {
      let off = false;
      GI.loadFatigueCases(api).then(list => { if (!off) setCases(new Map(list.map(c => [c.key, c]))); }).catch(e => console.warn("[Geotab Insights] casos de fatiga", e));
      return () => { off = true; };
    }, [api]);
    const high = shifts.filter(j => j.level === "alto");
    const pending = shifts.filter(j => j.level !== "bajo" && !((cases.get(j.key) || {}).status && cases.get(j.key).status !== "Detectado"));
    const cam = shifts.filter(j => j.camCluster >= 3);
    const findSel = sel && (shifts.find(j => j.key === sel.key) || sel);
    return html`<div>
      <div className="readouts">
        <${Kpi} label="Jornadas de nivel alto" value=${n0(high.length)} sub=${html`<span>en ${n0(new Set(high.map(j => j.drv)).size)} conductores</span>`} />
        <${Kpi} label="Sin revisar" value=${n0(pending.length)} sub=${html`<span>nivel alto o medio en estado Detectado</span>`} />
        <${Kpi} label="Con eventos de cámara agrupados" value=${n0(cam.length)} sub=${html`<span>3 o más en una hora (fatiga, distracción, carril)</span>`} />
        <${Kpi} label="Manejo entre 02 y 05 h" value=${dur(GI.sum(shifts, j => j.low))} sub=${html`<span>en ${n0(shifts.filter(j => j.low >= 0.5).length)} jornadas</span>`} />
      </div>
      <div className="subnav"><${Segmented} value=${sec} onChange=${setSec} options=${SECTIONS.map(([value, label]) => ({ value, label }))} /></div>
      ${sec === "ahora" ? html`<${NowSection} view=${view} api=${api} shifts0=${shifts} onDriver=${onDriver} onCase=${setSel} />`
        : sec === "casos" ? html`<${CasesSection} view=${view} shifts=${shifts} cases=${cases} limits=${limits} onOpen=${setSel} />`
        : html`<${DriversSection} view=${view} onDriver=${onDriver} />`}
      ${findSel ? html`<${CaseDetail} key=${findSel.key} view=${view} api=${api} j=${findSel} rec=${cases.get(findSel.key)} userName=${userName}
        onDriver=${id => { setSel(null); onDriver(id); }}
        onSaved=${c => setCases(m => new Map(m).set(c.key, c))} onClose=${() => setSel(null)} />` : null}
    </div>`;
  }

  Object.assign(GI, { FatigueTab });
})(window.GI);
