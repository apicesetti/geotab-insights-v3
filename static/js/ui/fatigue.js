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

  // ---------- Ahora ----------
  function Bar({ it, now }) {
    const pct = Math.min(1.15, it.pct);
    const fmt = it.fmt || dur;
    const txt = it.v >= it.max ? "superado" : it.at ? (it.at - now < 20 * H ? "llega a las " + hm(it.at) : "") : "";
    return html`<div className="ft-meter" title=${it.label + ": " + fmt(it.v) + " de " + it.max + (it.unit != null ? it.unit : " h")}>
      <div className="ft-meter-head"><span>${it.label}</span><b>${fmt(it.v)} <span className="muted">/ ${it.max}${it.unit != null ? it.unit : " h"}</span></b></div>
      <div className="ft-bar"><div className=${"ft-fill " + it.level} style=${{ width: (pct / 1.15) * 100 + "%" }}></div><i style=${{ left: ((it.warn || 0.8) / 1.15) * 100 + "%" }}></i><i className="max" style=${{ left: (1 / 1.15) * 100 + "%" }}></i></div>
      <div className=${"ft-meter-foot " + it.level}>${txt}</div>
    </div>`;
  }

  function NowSection({ view, res, live, onRefresh, onDriver, onCase }) {
    const { now } = live;
    const fz = res.limits;
    const rows = useMemo(() => {
      const order = { rojo: 2, amarillo: 1, ok: 0 };
      return res.shifts.filter(j => j.open).map(j => {
        const p = GI.shiftProgress(j, fz, now);
        const s = res.sims.get(j.drv);
        const oi = GI.openShiftIndex(j, s ? s.list : [j], j.sim, fz, now);
        if (oi.Fnow != null) {
          const v = oi.Fnow;
          p.items.push({ key: "fi", label: "Índice de fatiga", v, max: fz.fi_high, warn: fz.fi_mod / fz.fi_high, at: oi.crossAt && (p.driving || p.sinceLast <= 60) && oi.crossAt <= j.s + fz.max_span * H ? oi.crossAt : null, unit: "", fmt: x => String(Math.round(x)), pct: v / fz.fi_high,
            level: v >= fz.fi_high ? "rojo" : v >= fz.fi_mod ? "amarillo" : "ok" });
          p.worst = p.items.some(x => x.level === "rojo") ? "rojo" : p.items.some(x => x.level === "amarillo") ? "amarillo" : "ok";
        }
        return { j, p, oi };
      }).sort((a, b) => order[b.p.worst] - order[a.p.worst] || Math.max(...b.p.items.map(x => x.pct)) - Math.max(...a.p.items.map(x => x.pct)));
    }, [res, now]);
    const red = rows.filter(r => r.p.worst === "rojo").length, yellow = rows.filter(r => r.p.worst === "amarillo").length;
    return html`<${Panel} title="Jornadas en curso"
        hint=${"Conductores que están manejando o cuyo último viaje terminó hace menos de " + fz.SPLIT / H + " h (la pausa que cierra una jornada). Cada barra compara lo que lleva contra el límite de Configuración → Fatiga y gravedad: amarillo cerca del límite, rojo al superarlo. La hora estimada supone que sigue al mismo ritmo que en lo que va de la jornada."}
        actions=${html`<span className="muted small">${live.at ? "Datos de las " + hm(live.at) : ""}</span> <button className="btn small" disabled=${live.loading} onClick=${onRefresh}>${live.loading ? "Actualizando…" : "↻ Actualizar"}</button>`}>
        ${live.err ? html`<${Info} tone="warn">No se pudieron traer los viajes de las últimas horas (${live.err}); se muestra lo que hay en el período cargado.<//>` : null}
        <div className="readouts compact inset">
          <${Kpi} label="Jornadas en curso" value=${n0(rows.length)} sub=${html`<span>${n0(rows.filter(r => r.p.driving).length)} manejando ahora</span>`} />
          <${Kpi} label="Superaron un límite" value=${n0(red)} tone=${red ? "bad" : null} sub=${html`<span>jornada, manejo, continuo o índice</span>`} />
          <${Kpi} label="Cerca del límite" value=${n0(yellow)} sub=${html`<span>a punto de superar alguno</span>`} />
        </div>
        ${!rows.length ? html`<p className="muted">${live.loading ? "Buscando jornadas en curso…" : "No hay jornadas en curso en este momento."}</p>` : html`<div className="ft-now">
          ${rows.map(({ j, p, oi }) => html`<div key=${j.key} className=${"ft-now-row " + p.worst}>
            <div className="ft-now-who">
              <${DriverLink} view=${view} id=${j.drv} onDriver=${onDriver} />
              <div className="small muted">${j.devices.map(d => devName(view, d)).join(", ")}</div>
              <div className="small">${p.driving ? html`<span className="ft-live">● Manejando</span>` : "Parado hace " + dur(p.sinceLast / 60)} · empezó ${hm(j.s)} (turno ${j.type})</div>
              <div className="small muted">Descanso previo: ${j.restBefore != null ? dur(j.restBefore) : "–"}${j.daysRow > 1 ? " · día " + j.daysRow + " seguido" : ""}</div>
            </div>
            <div className="ft-now-meters">${p.items.map(it => html`<${Bar} key=${it.key} it=${it} now=${now} />`)}</div>
            <div className="ft-now-sig">
              ${j.signals.length ? sigChips(j, true) : html`<span className="muted small">Sin señales todavía</span>`}
              ${oi.peak != null && oi.peak > oi.Fnow + 1 ? html`<div className="small">Si completa su jornada habitual (${dur(oi.spanH)}) el índice llegaría a ${fiTag(oi.peak, fz)}.</div>` : null}
              ${p.nightAhead ? html`<div className="small ft-warn">Turno noche: va a manejar en la franja de 02 a 05 h.</div>` : null}
              <button className="btn link small" onClick=${() => onCase(j)}>Ver jornada</button>
            </div>
          </div>`)}
        </div>`}
      <//>`;
  }

  // ---------- Próximo turno ----------
  function NextSection({ view, res, live, onDriver }) {
    const fz = res.limits, now = live.now;
    const rows = [...res.sims.entries()].map(([drv, s]) => ({ drv, ...s.next })).filter(r => r.start && r.lastE > now - 72 * H);
    return html`<${Panel} title="Riesgo del próximo turno"
      hint=${"Para cada conductor que trabajó en las últimas 72 h y no está en jornada: si arranca a su hora habitual (la mediana de sus últimas jornadas del mismo tipo) con el descanso que lleva y hace su jornada habitual, a cuánto llegaría el índice de fatiga estimado. El descanso recomendado es el mínimo, contado desde que terminó, para no pasar de " + fz.fi_high + " (el índice se recupera más rápido descansando de noche)."}
      actions=${html`<span className="muted small">${live.at ? "Datos de las " + hm(live.at) : ""}</span>`}>
      <${DataTable} rowKey=${r => r.drv} rows=${rows} limit=${30} defaultSort=${{ key: "peak", dir: "desc" }} columns=${[
        { key: "drv", label: "Conductor", value: r => drvName(view, r.drv), fmt: r => html`<${DriverLink} view=${view} id=${r.drv} onDriver=${onDriver} />` },
        { key: "lastE", label: "Terminó", fmt: r => when(r.lastE) },
        { key: "rest", label: "Descansó hasta ahora", align: "num", value: r => now - r.lastE, fmt: r => dur((now - r.lastE) / H) },
        { key: "start", label: "Próximo arranque (habitual)", fmt: r => html`${when(r.start)} <span className="muted small">turno ${r.hb.type}, ${dur(r.hb.span)}</span>` },
        { key: "Fstart", label: "Índice al arrancar", align: "num", fmt: r => fiTag(r.Fstart, fz) },
        { key: "peak", label: "Índice al terminar", align: "num", fmt: r => fiTag(r.peak, fz) },
        { key: "needRest", label: "Descanso recomendado", align: "num", value: r => (r.needRest == null ? 99 : r.needRest),
          fmt: r => (r.needRest == null ? html`<span className="delta bad" title="Con su jornada habitual supera el umbral aun con 48 h de descanso">acortar la jornada</span>`
            : html`<span className=${r.restAtStart < r.needRest ? "delta bad" : ""}>${dur(r.needRest)}</span><div className="small muted">desde las ${when(r.lastE + r.needRest * H)}</div>`) },
      ]} empty="No hay conductores que hayan trabajado en las últimas 72 h." />
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
  };
  const restKind = (j, fz) => (j.restBefore < fz.min_rest ? "corto" : j.type === "noche" && j.restDayFrac >= 0.7 ? "dia" : "ok");
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
    if (j.restBefore != null) parts.push(html`Antes había descansado <b>${dur(j.restBefore)}</b>. `);
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
        ${["breve", "pausa", "larga", "ok", "dia", "corto"].filter(k => gapKinds.has(k)).map(k => html`<span key=${k}><i style=${{ background: GAP[k].color }}></i>${k === "corto" ? "Descanso de menos de " + fz.min_rest + " h" : GAP[k].label}</span>`)}
        <span><i style=${{ background: "#eff1f8" }}></i>Noche (00–06 h)</span>
        <span><i style=${{ background: "#dfe3f3" }}></i>02–05 h, cuando más cuesta mantenerse despierto</span>
        <span><i className="tri" style=${{ borderBottomColor: CAM_COLORS.fatiga }}></i>Fatiga</span>
        <span><i className="tri" style=${{ borderBottomColor: CAM_COLORS.distraccion }}></i>Distracción</span>
        <span><i className="tri" style=${{ borderBottomColor: CAM_COLORS.salida_carril }}></i>Salida de carril</span>
        <span><i style=${{ background: "#7b8492", width: "3px" }}></i>Otras infracciones</span>
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
        const saved = await GI.saveFatigueCase(api, { id: rec && rec.id, key: j.key, drv: j.drv, s: j.s, dk: j.dk, level: j.level, signals: j.signals.map(x => x.key),
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

  function FatigueDriver({ view, id, res, cases, now, onClose, onCase, onSafety }) {
    const fz = res.limits;
    const [days, setDays] = useState(14);
    const s = res.sims.get(id);
    const list = s ? s.list : [];
    const open = list.find(j => j.open);
    const nx = s && s.next;
    const oi = open ? GI.openShiftIndex(open, list, open.sim, fz, now) : null;
    const Fnow = s && s.sim ? (open ? oi.Fnow : nx ? nx.Fnow : null) : null;
    const done = list.filter(j => !j.open);
    const rests = list.map(j => j.restBefore).filter(v => v != null && v < 48);
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
    ];
    const lastLevel = Fnow != null ? GI.fiLevel(Fnow, fz) : null;
    return html`<${Modal} wide title=${"Fatiga · " + drvName(view, id)} onClose=${onClose}>
      <div className="ft-case-head">
        ${lastLevel ? html`<span>Índice de fatiga ahora: ${fiTag(Fnow, fz)} <span className="muted">(${lastLevel})</span></span>` : null}
        <span className="ft-case-links">
          <button className="btn small" onClick=${() => onSafety(id)}>Ficha de seguridad</button>
          <button className="btn small" onClick=${() => GI.openEventsPage({ driverIds: [id], from: view.model.dayKeys[0], to: view.model.dayKeys[view.model.dayKeys.length - 1] })}>Eventos en MyGeotab ↗</button>
        </span>
      </div>
      ${open ? html`<div className="verdict-line"><span className="vtag">En jornada</span><span>
          Empezó a las <b>${hm(open.s)}</b> (turno ${open.type}), lleva ${dur((now - open.s) / H)} de jornada y ${dur(open.dh)} de manejo.
          ${oi.peak != null ? html` Si completa su jornada habitual de ${dur(oi.spanH)}, el índice llegaría a ${fiTag(oi.peak, fz)}.` : null}
          ${oi.crossAt ? html` Pasaría de ${fz.fi_high} cerca de las <b>${hm(oi.crossAt)}</b>.` : null}</span></div>`
        : nx ? html`<div className=${"verdict-line " + (nx.peak >= fz.fi_high ? "bad" : "")}><span className="vtag">Próximo turno</span><span>
          Terminó el ${when(nx.lastE)}. Si arranca a su hora habitual, el <b>${when(nx.start)}</b> (turno ${nx.hb.type}, ${dur(nx.hb.span)}), con ${dur(nx.restAtStart)} de descanso,
          empezaría con índice ${fiTag(nx.Fstart, fz)} y terminaría en ${fiTag(nx.peak, fz)}.
          ${nx.needRest == null ? html` Con su jornada habitual supera ${fz.fi_high} aun con 48 h de descanso: conviene acortarla.`
            : nx.restAtStart < nx.needRest ? html` Para no pasar de ${fz.fi_high} necesita <b>${dur(nx.needRest)}</b> de descanso: arrancar después del <b>${when(nx.lastE + nx.needRest * H)}</b>.`
            : html` Con ese descanso no pasa de ${fz.fi_high}.`}</span></div>` : null}
      <div className="ft-facts">${facts.map(([l, v, bad]) => html`<div key=${l} className=${bad ? "bad" : ""}><span>${l}</span><b>${v}</b></div>`)}</div>
      <div className="ft-sub-head"><h3>Patrón de jornadas</h3><${Segmented} value=${days} onChange=${setDays} options=${[{ value: 14, label: "14 días" }, { value: 28, label: "28 días" }]} /></div>
      <${ShiftPattern} list=${list} fz=${fz} days=${days} onCase=${onCase} />
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
      hint=${"Cada fila es una jornada (viajes sin una pausa de " + limits.SPLIT / H + " h o más). Señales: jornada de más de " + limits.max_span + " h, más de " + limits.max_drive_day + " h de manejo, más de " + limits.max_continuous + " h sin una pausa de 15 min, manejo entre las 02 y las 05 h, cambio de turno día ↔ noche con un solo descanso, descanso de menos de " + limits.min_rest + " h o casi todo de día antes de un turno noche, más de " + limits.max_days_row + " días seguidos, eventos de fatiga, distracción o salida de carril de cámaras o ADAS (3 o más en una hora valen doble) e índice de fatiga estimado de " + limits.fi_high + " o más. Nivel alto: 3 puntos o más. Medio: 2."}>
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
    else if (few) verdict = html`<div className="verdict-line"><span className="vtag">Pocos eventos</span><span>Hay ${n0(ex.cam)} eventos de fatiga en el período: son pocos para sacar conclusiones. Probá con un período de 90 días o más.</span></div>`;
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

  const SECTIONS = [["ahora", "Ahora"], ["proximo", "Próximo turno"], ["casos", "Casos"], ["conductores", "Conductores"], ["validacion", "Validación del índice"]];
  const BETA_SECTIONS = new Set(["validacion"]);
  const isBeta = () => GI.BUILD === "beta" || /\/dev\//.test(window.location.pathname);

  function FatigueTab({ view, api, onDriver, userName, isAdmin, onSaveSettings }) {
    const [sec, setSec] = useState("ahora");
    const [sel, setSel] = useState(null);
    const [drv, setDrv] = useState(null);
    const [cases, setCases] = useState(new Map());
    const [live, setLive] = useState({ loading: true, now: Date.now() });
    const period = useMemo(() => GI.buildShifts(view.model, view.ids, view.driverOk), [view]);
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
      return () => { off = true; clearInterval(t); };
    }, [api]);
    // Ahora / próximo turno / fichas: período + viajes en vivo de las últimas horas.
    const res = useMemo(() => {
      if (!live.recent) return GI.buildShifts(view.model, view.ids, view.driverOk, { now: live.now });
      const tb = GI.liveTrips(view.model, live.recent, live.status, LIVE_HOURS, live.now);
      return GI.buildShifts(view.model, view.ids, view.driverOk, { now: live.now, tripsByDevice: tb });
    }, [view, live]);
    const { shifts, limits } = period;
    const high = shifts.filter(j => j.level === "alto");
    const pending = shifts.filter(j => j.level !== "bajo" && !((cases.get(j.key) || {}).status && cases.get(j.key).status !== "Detectado"));
    const nextRisk = [...res.sims.values()].filter(s => s.next && s.next.lastE > live.now - 72 * H && s.next.peak >= limits.fi_high);
    const cam = shifts.filter(j => j.camCluster >= 3);
    const findSel = sel && (res.shifts.find(j => j.key === sel.key) || shifts.find(j => j.key === sel.key) || sel);
    const openDriver = id => { setSel(null); setDrv(id); };
    return html`<div>
      <div className="readouts">
        <${Kpi} label="Jornadas de nivel alto" value=${n0(high.length)} sub=${html`<span>en ${n0(new Set(high.map(j => j.drv)).size)} conductores</span>`} />
        <${Kpi} label="Sin revisar" value=${n0(pending.length)} sub=${html`<span>nivel alto o medio en estado Detectado</span>`} />
        <${Kpi} label="Próximo turno con índice alto" value=${n0(nextRisk.length)} tone=${nextRisk.length ? "bad" : null} sub=${html`<span>si arrancan a su hora habitual</span>`} />
        <${Kpi} label="Con eventos de cámara agrupados" value=${n0(cam.length)} sub=${html`<span>3 o más en una hora (fatiga, distracción, carril)</span>`} />
      </div>
      <div className="subnav"><${Segmented} value=${sec} onChange=${setSec} options=${SECTIONS.filter(([k]) => !BETA_SECTIONS.has(k) || isBeta()).map(([value, label]) => ({ value, label }))} /></div>
      ${sec === "validacion" && isBeta() ? html`<${ValidationSection} view=${view} res=${period} isAdmin=${isAdmin} settings=${view.settings} onSaveSettings=${onSaveSettings} />`
        : sec === "ahora" ? html`<${NowSection} view=${view} res=${res} live=${live} onRefresh=${refresh} onDriver=${openDriver} onCase=${setSel} />`
        : sec === "proximo" ? html`<${NextSection} view=${view} res=${res} live=${live} onDriver=${openDriver} />`
        : sec === "casos" ? html`<${CasesSection} view=${view} shifts=${shifts} cases=${cases} limits=${limits} onOpen=${setSel} onDriver=${openDriver} />`
        : html`<${DriversSection} view=${view} onDriver=${openDriver} />`}
      ${drv && !findSel ? html`<${FatigueDriver} key=${drv} view=${view} id=${drv} res=${res} cases=${cases} now=${live.now}
        onClose=${() => setDrv(null)} onCase=${j => setSel(j)} onSafety=${id => { setDrv(null); onDriver(id); }} />` : null}
      ${findSel ? html`<${CaseDetail} key=${findSel.key} view=${view} api=${api} j=${findSel} fz=${limits} rec=${cases.get(findSel.key)} userName=${userName}
        onDriver=${openDriver}
        onSaved=${c => setCases(m => new Map(m).set(c.key, c))} onClose=${() => setSel(null)} />` : null}
    </div>`;
  }

  Object.assign(GI, { FatigueTab });
})(window.GI);
