// Fatiga: jornadas por conductor con sus señales de riesgo (casos) y
// jornadas en curso con su avance contra los límites (ahora).
//
// Jornada = viajes del conductor separados por pausas de menos de
// rest_split horas (un turno noche es una sola jornada, del día en que
// empezó). Señales de una jornada:
//   larga       jornada (primer arranque → último corte) > max_span
//   manejo      horas de manejo > max_drive_day
//   continuo    manejo sin pausa de 15 min > max_continuous
//   madrugada   ≥ 30 min de manejo entre las 02 y las 05 h (punto más bajo del ritmo circadiano)
//   cambio      cambia de turno día ↔ noche con un solo descanso entremedio
//   descanso    descanso previo < min_rest, o mayormente de día antes de un turno noche
//   seguidos    más de max_days_row días seguidos de trabajo
//   camara      eventos de fatiga, distracción o salida de carril (cámara / ADAS):
//               3 o más en 60 minutos pesa doble
// Nivel: alto con 3 puntos o más (cámara agrupada vale 2), medio con 2.
(function (GI) {
  "use strict";
  const H = 3600000, MIN = 60000;
  const CAM_CATS = new Set(["fatiga", "distraccion", "salida_carril"]);
  const SIGNALS = [
    { key: "larga", label: "Jornada larga" },
    { key: "manejo", label: "Mucho manejo" },
    { key: "continuo", label: "Manejo continuo" },
    { key: "madrugada", label: "Madrugada" },
    { key: "cambio", label: "Cambio de turno" },
    { key: "descanso", label: "Descanso corto o de día" },
    { key: "seguidos", label: "Días seguidos" },
    { key: "camara", label: "Cámara" },
  ];

  // Horas de [a, b] que caen entre las horas locales h0 y h1 (h0 < h1, mismo día).
  function overlapHours(a, b, h0, h1) {
    if (!(b > a)) return 0;
    let tot = 0;
    const d = new Date(a); d.setHours(0, 0, 0, 0);
    for (let day = d.getTime() - 86400000; day < b; day += 86400000) {
      const x0 = new Date(day); x0.setHours(h0, 0, 0, 0);
      const x1 = new Date(day); x1.setHours(h1, 0, 0, 0);
      tot += Math.max(0, Math.min(b, x1.getTime()) - Math.max(a, x0.getTime()));
    }
    return tot / H;
  }
  // Fracción de [a, b] que es "de noche" para turnos (20 a 06 h).
  function nightFrac(a, b) {
    if (!(b > a)) return 0;
    return (overlapHours(a, b, 20, 24) + overlapHours(a, b, 0, 6)) / ((b - a) / H);
  }

  function fatigueLimits(settings) {
    const fz = Object.assign({ max_drive_day: 9, max_span: 12, min_rest: 8, max_continuous: 4, max_days_row: 6, rest_split: 4 }, (settings && settings.fatigue) || {});
    fz.SPLIT = Math.max(1, Math.min(fz.rest_split || 4, fz.min_rest || 8)) * H;
    return fz;
  }

  // Viajes por conductor (sin superposiciones) con su vehículo.
  function tripsByDriver(tripsByDevice, ids, driverOk) {
    const by = new Map();
    for (const [dev, trips] of tripsByDevice) {
      if (!ids.has(dev)) continue;
      for (const t of trips) {
        if (!t.r || t.r === "_unknown" || (driverOk && !driverOk(t.r))) continue;
        if (!by.has(t.r)) by.set(t.r, []);
        by.get(t.r).push(t);
      }
    }
    for (const [id, raw] of by) {
      raw.sort((a, b) => a.s - b.s);
      const out = [];
      let reach = -Infinity;
      for (const t of raw) {
        if (t.e <= reach) continue;
        const s0 = Math.max(t.s, reach), f = t.e > t.s ? (t.e - s0) / (t.e - t.s) : 1;
        out.push({ s: s0, e: t.e, dh: (t.dh || 0) * f, km: (t.km || 0) * f, d: t.d, live: !!t.live });
        reach = t.e;
      }
      by.set(id, out);
    }
    return by;
  }

  function buildShifts(model, ids, driverOk, opts) {
    const fz = fatigueLimits(model.settings);
    const o = Object.assign({ now: Date.now() }, opts || {});
    const byDrv = tripsByDriver(o.tripsByDevice || model.tripsByDevice, ids, driverOk);
    const camByDrv = new Map(), evByDrv = new Map();
    for (const e of model.events) {
      if (!ids.has(e.d) || !e.drv || e.drv === "_unknown") continue;
      if (CAM_CATS.has(e.cat)) { if (!camByDrv.has(e.drv)) camByDrv.set(e.drv, []); camByDrv.get(e.drv).push(e); }
      if (e.w > 0) { if (!evByDrv.has(e.drv)) evByDrv.set(e.drv, []); evByDrv.get(e.drv).push(e); }
    }
    for (const l of camByDrv.values()) l.sort((a, b) => a.t - b.t);
    const shifts = [];
    for (const [drv, trips] of byDrv) {
      const list = [];
      let cur = null;
      for (const t of trips) {
        if (!cur || t.s - cur.e >= fz.SPLIT) { cur = { drv, s: t.s, e: t.e, trips: [] }; list.push(cur); }
        cur.trips.push(t); cur.e = Math.max(cur.e, t.e);
      }
      let prev = null, row = 0;
      for (const j of list) {
        j.dk = GI.dayKey(new Date(j.s));
        j.key = drv + "|" + j.s;
        j.span = (j.e - j.s) / H;
        j.dh = GI.sum(j.trips, t => t.dh); j.km = GI.sum(j.trips, t => t.km);
        j.devices = [...new Set(j.trips.map(t => t.d))];
        // tiradas de manejo continuo (pausas < 15 min no cortan)
        let st = 0, stS = null, lastE = null, maxStint = 0, maxStintS = null, maxStintE = null;
        const pauses = [];
        for (const t of j.trips) {
          if (lastE != null && t.s - lastE >= 15 * MIN) { pauses.push([lastE, t.s]); st = 0; stS = null; }
          if (stS == null) stS = t.s;
          st += t.dh;
          if (st > maxStint) { maxStint = st; maxStintS = stS; maxStintE = t.e; }
          lastE = t.e;
        }
        j.maxStint = maxStint; j.maxStintRange = [maxStintS, maxStintE]; j.pauses = pauses;
        // manejo de madrugada: horas de los viajes (proporcional al manejo) en 00–06 y 02–05
        j.night = 0; j.low = 0;
        for (const t of j.trips) {
          const len = (t.e - t.s) / H || 1, f = t.dh / len;
          j.night += overlapHours(t.s, t.e, 0, 6) * f;
          j.low += overlapHours(t.s, t.e, 2, 5) * f;
        }
        j.type = nightFrac(j.s, j.e) >= 0.5 ? "noche" : "día";
        if (prev) {
          j.prevS = prev.s; j.prevE = prev.e;
          j.restBefore = (j.s - prev.e) / H;
          j.restDayFrac = j.restBefore > 0 ? overlapHours(prev.e, j.s, 8, 19) / j.restBefore : 0;
          j.prevType = prev.type;
          const gap = Math.round((GI.parseDayKey(j.dk) - GI.parseDayKey(prev.dk)) / 86400000);
          row = gap === 1 ? row + 1 : gap === 0 ? row : 1;
        } else row = 1;
        j.daysRow = row;
        // eventos de cámara/ADAS de fatiga en la jornada (hasta 30 min después del último corte)
        const cam = (camByDrv.get(drv) || []).filter(e => e.t >= j.s - 5 * MIN && e.t <= j.e + 30 * MIN);
        let cluster = 0, clusterAt = null;
        for (let a = 0, b = 0; b < cam.length; b++) {
          while (cam[b].t - cam[a].t > 60 * MIN) a++;
          if (b - a + 1 > cluster) { cluster = b - a + 1; clusterAt = [cam[a].t, cam[b].t]; }
        }
        j.cam = cam; j.camCluster = cluster; j.camClusterAt = clusterAt;
        j.events = (evByDrv.get(drv) || []).filter(e => e.t >= j.s - 5 * MIN && e.t <= j.e + 30 * MIN);
        // señales
        const sg = [];
        const add = (key, w, text) => sg.push({ key, w, text, label: SIGNALS.find(x => x.key === key).label });
        if (j.span > fz.max_span) add("larga", 1, GI.fmtNum(j.span, 1) + " h de jornada (límite " + fz.max_span + " h)");
        if (j.dh > fz.max_drive_day) add("manejo", 1, GI.fmtNum(j.dh, 1) + " h de manejo (límite " + fz.max_drive_day + " h)");
        if (j.maxStint > fz.max_continuous) add("continuo", 1, GI.fmtNum(j.maxStint, 1) + " h de manejo sin una pausa de 15 min (límite " + fz.max_continuous + " h)");
        if (j.low >= 0.5) add("madrugada", 1, GI.fmtNum(j.low, 1) + " h de manejo entre las 02 y las 05 h");
        if (prev && j.prevType !== j.type && j.restBefore < 24) add("cambio", 1, "pasó de turno " + j.prevType + " a turno " + j.type + " con un solo descanso de " + GI.fmtNum(j.restBefore, 1) + " h");
        if (prev && j.restBefore < 48 && (j.restBefore < fz.min_rest || (j.type === "noche" && j.restDayFrac >= 0.7)))
          add("descanso", 1, j.restBefore < fz.min_rest ? "descanso previo de " + GI.fmtNum(j.restBefore, 1) + " h (mínimo " + fz.min_rest + " h)" : "descanso previo de " + GI.fmtNum(j.restBefore, 1) + " h, casi todo de día, antes de un turno noche");
        if (j.daysRow > fz.max_days_row) add("seguidos", 1, j.daysRow + " días seguidos de trabajo (máximo " + fz.max_days_row + ")");
        if (cluster >= 3) add("camara", 2, cluster + " eventos de fatiga, distracción o salida de carril en menos de una hora");
        else if (cam.length >= 3) add("camara", 1, cam.length + " eventos de fatiga, distracción o salida de carril en la jornada");
        j.signals = sg;
        j.score = GI.sum(sg, x => x.w);
        j.level = j.score >= 3 ? "alto" : j.score === 2 ? "medio" : "bajo";
        // jornada en curso: el último viaje terminó hace menos de la pausa que cierra la jornada
        j.open = o.now - j.e < fz.SPLIT && o.now >= j.e - 60000;
        j.live = j.trips.some(t => t.live);
        shifts.push(j);
        prev = j;
      }
    }
    shifts.sort((a, b) => b.s - a.s);
    return { shifts, limits: fz };
  }

  // Viajes para "Ahora": los del período hasta hace `hours`, los recientes
  // traídos en vivo y, si el vehículo está manejando, un viaje en curso.
  function liveTrips(model, recent, status, hours, now) {
    const cut = now - hours * H;
    const by = new Map();
    const push = t => { if (!by.has(t.d)) by.set(t.d, []); by.get(t.d).push(t); };
    for (const [, trips] of model.tripsByDevice) for (const t of trips) if (t.s < cut) push(t);
    for (const t of recent || []) if (t.s >= cut) push(t);
    for (const arr of by.values()) arr.sort((a, b) => a.s - b.s);
    for (const st of status || []) {
      if (!st.driving || !(st.since < now)) continue;
      const arr = by.get(st.d) || [];
      const last = arr[arr.length - 1];
      if (last && last.e > st.since) continue; // el viaje ya está registrado
      const r = st.r || (last && st.since - last.e < H ? last.r : null);
      if (!r) continue;
      push({ d: st.d, r, s: st.since, e: now, dh: (now - st.since) / H, km: 0, live: true });
    }
    return by;
  }

  // Avance de una jornada abierta contra los límites, con proyección.
  function shiftProgress(j, fz, now) {
    const spanNow = (now - j.s) / H;
    const ratio = spanNow > 0.5 ? j.dh / spanNow : 0.6; // fracción del tiempo que maneja
    const lastE = j.trips[j.trips.length - 1].e;
    const driving = j.trips[j.trips.length - 1].live;
    const sinceLast = driving ? 0 : (now - lastE) / MIN;
    // tirada continua actual (si el último viaje terminó hace menos de 15 min)
    let stint = 0;
    if (driving || sinceLast < 15) {
      for (let i = j.trips.length - 1; i >= 0; i--) {
        stint += j.trips[i].dh;
        if (i > 0 && j.trips[i].s - j.trips[i - 1].e >= 15 * MIN) break;
      }
    }
    const eta = (remaining, rate) => (remaining <= 0 ? now : rate > 0 ? now + (remaining / rate) * H : null);
    const items = [
      { key: "span", label: "Jornada", v: spanNow, max: fz.max_span, at: j.s + fz.max_span * H },
      { key: "drive", label: "Manejo", v: j.dh, max: fz.max_drive_day, at: eta(fz.max_drive_day - j.dh, ratio) },
      { key: "stint", label: "Manejo continuo", v: stint, max: fz.max_continuous, at: stint > 0 ? eta(fz.max_continuous - stint, 1) : null },
    ].map(x => Object.assign(x, { at: x.at && x.key !== "span" && (x.at > j.s + fz.max_span * H || (!driving && sinceLast > 60)) ? null : x.at })).map(x => Object.assign(x, { pct: x.max > 0 ? x.v / x.max : 0, level: x.v >= x.max ? "rojo" : x.v >= 0.8 * x.max ? "amarillo" : "ok" }));
    // ¿va a manejar en la franja 02–05 h? (turno noche que todavía no llegó a las 02)
    const hNow = new Date(now).getHours();
    const nightAhead = j.type === "noche" && (hNow >= 18 || hNow < 2);
    const worst = items.some(x => x.level === "rojo") ? "rojo" : items.some(x => x.level === "amarillo") ? "amarillo" : "ok";
    return { spanNow, sinceLast, stint, items, nightAhead, worst, driving };
  }

  Object.assign(GI, { FATIGUE_SIGNALS: SIGNALS, FATIGUE_CAM_CATS: CAM_CATS, buildShifts, shiftProgress, liveTrips, fatigueLimits, _fat: { overlapHours, nightFrac } });
})(window.GI);
