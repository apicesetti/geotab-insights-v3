// Mi jornada (Geotab Drive) — lógica pura, sin DOM ni API: testeable en Node.
//
// Reutiliza el núcleo de Insights (util.js, catalog.js, fatigue.js) para que el
// conductor vea exactamente los mismos números que el área de seguridad:
//   - límites de jornada, manejo, manejo continuo y descanso: settings.fatigue
//   - índice de riesgo: Σ(eventos × peso de su categoría) / km × 100, con el
//     mismo mapeo de reglas, pesos y gravedad por duración de Insights
//   - fatiga: GI.buildShifts / shiftProgress / openShiftIndex / nextShiftRisk
//
// Alerta de alejamiento: el teléfono se aleja del vehículo en el que el
// conductor sigue identificado (DeviceStatusInfo.driver = yo).
(function (GI) {
  "use strict";
  const H = 3600000, MIN = 60000, DAY = 86400000;

  // Valores propios del add-in de Drive. Se pueden sobreescribir desde la
  // configuración de Insights con una clave "drive" (opcional).
  const DRIVE_DEFAULTS = {
    risk_weeks: 8,          // semanas de historia para el índice de riesgo (4 actuales + 4 anteriores)
    fatigue_days: 14,       // días de viajes para simular el índice de fatiga
    config_refresh_min: 60, // relectura de la configuración de Insights
    trips_refresh_min: 10,  // viajes recientes (jornada en curso)
    events_refresh_min: 60, // excepciones (índice de riesgo)
    warn_pct: 0.8,          // aviso previo al límite (80 %)
    away: {
      enabled: true,
      distance_m: 200,      // distancia teléfono ↔ vehículo para avisar
      max_accuracy_m: 150,  // lecturas del teléfono menos precisas se descartan
      poll_min: 2,          // cada cuánto se compara la posición
      confirm_checks: 2,    // lecturas seguidas lejos antes de avisar
      cooldown_min: 30,     // no repetir el aviso antes de esto
    },
  };

  function merge(base, over) {
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    for (const k of Object.keys(over || {})) {
      const v = over[k];
      out[k] = v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" ? merge(base[k], v) : v;
    }
    return out;
  }

  // Configuración efectiva a partir de la guardada por Insights (o null).
  function settingsFrom(shared) {
    const s = shared || {};
    const def = GI.defaultSettings([], []);
    return {
      fromInsights: !!shared,
      rev: s._rev || null,
      fatigue: GI.fatigueLimits({ fatigue: s.fatigue }),
      rule_mapping: s.rule_mapping || {},
      categories: s.categories && s.categories.length ? s.categories : def.categories,
      category_weights: Object.assign({}, def.category_weights, s.category_weights || {}),
      severity: Object.assign({}, def.severity, s.severity || {}),
      drive: merge(DRIVE_DEFAULTS, s.drive || {}),
    };
  }

  // ---------- Compactadores (formato de Insights, con regla en la excepción) ----------
  const realDriver = id => (id && id !== "UnknownDriverId" && id !== "NoDriverId" ? id : null);
  function compactTrip(t) {
    return {
      i: t.id, d: GI.idOf(t.device), r: realDriver(GI.idOf(t.driver)),
      s: new Date(t.start).getTime(), e: new Date(t.stop).getTime(),
      km: GI.round(t.distance || 0, 3), dh: GI.round(GI.durationToHours(t.drivingDuration), 4),
    };
  }
  function compactException(ev) {
    if (/Invalid/i.test(ev.state || "")) return null;
    return {
      i: ev.id, d: GI.idOf(ev.device), r: realDriver(GI.idOf(ev.driver)), rule: GI.idOf(ev.rule),
      t: new Date(ev.activeFrom).getTime(), h: GI.round(GI.durationToHours(ev.duration), 4),
    };
  }
  // Une listas por id (las nuevas pisan a las viejas) y descarta lo anterior a `since`.
  function mergeById(oldList, newList, since, timeKey) {
    const by = new Map();
    for (const x of oldList || []) if (x[timeKey] >= since) by.set(x.i, x);
    for (const x of newList || []) if (x && x[timeKey] >= since) by.set(x.i, x);
    return [...by.values()].sort((a, b) => a[timeKey] - b[timeKey]);
  }

  function findContaining(trips, t) {
    for (const tr of trips) if (tr.s <= t && t <= tr.e) return tr;
    return null;
  }

  // Excepciones del conductor con categoría y peso (igual que buildModel de Insights).
  function myEvents(events, trips, me, cfg) {
    GI.applyCategories(cfg.categories);
    const riskCats = new Set(GI.CATEGORIES.filter(c => c.kind === "riesgo").map(c => c.key));
    const byDev = GI.groupBy(trips, t => t.d);
    const sev = cfg.severity;
    const out = [];
    for (const ev of events) {
      const cat = cfg.rule_mapping[ev.rule];
      if (!cat) continue;
      let drv = ev.r;
      if (!drv) { const tr = findContaining(byDev.get(ev.d) || [], ev.t); if (tr) drv = tr.r; }
      if (drv !== me) continue;
      let w = riskCats.has(cat) ? (cfg.category_weights[cat] != null ? cfg.category_weights[cat] : 1) : 0;
      if (w > 0 && sev.by_duration && ev.h > 0) w *= Math.min(sev.max || 3, 1 + (sev.per_minute || 0) * ev.h * 60);
      out.push(Object.assign({}, ev, { cat, drv, w }));
    }
    return out;
  }

  // ---------- Índice de riesgo ----------
  function riskSummary(trips, evs, cfg, now) {
    const weeks = cfg.drive.risk_weeks;
    const half = Math.max(1, Math.floor(weeks / 2));
    const curFrom = now - half * 7 * DAY, prevFrom = now - 2 * half * 7 * DAY;
    const acc = (from, to) => {
      const km = GI.sum(trips.filter(t => t.s >= from && t.s < to), t => t.km);
      const sel = evs.filter(e => e.t >= from && e.t < to && e.w > 0);
      const w = GI.sum(sel, e => e.w);
      return { km, w, n: sel.length, risk: km > 0 ? (w / km) * 100 : null };
    };
    const cur = acc(curFrom, now + 1), prev = acc(prevFrom, curFrom);
    // semanas (lunes a domingo)
    const wk = new Map();
    const thisWeek = GI.bucketKey(GI.dayKey(now), "week");
    for (let i = weeks - 1; i >= 0; i--) {
      const k = GI.dayKey(GI.addDays(GI.parseDayKey(thisWeek), -7 * i));
      wk.set(k, { key: k, label: GI.bucketLabel(k, "week"), km: 0, w: 0, n: 0 });
    }
    for (const t of trips) { const b = wk.get(GI.bucketKey(GI.dayKey(t.s), "week")); if (b) b.km += t.km; }
    for (const e of evs) { if (!(e.w > 0)) continue; const b = wk.get(GI.bucketKey(GI.dayKey(e.t), "week")); if (b) { b.w += e.w; b.n++; } }
    const series = [...wk.values()].map(b => Object.assign(b, { risk: b.km > 0 ? (b.w / b.km) * 100 : null }));
    // categorías del período actual
    const cats = new Map();
    for (const e of evs) {
      if (e.t < curFrom || !(e.w > 0)) continue;
      const c = cats.get(e.cat) || { key: e.cat, label: (GI.CATEGORY_BY_KEY[e.cat] || {}).label || e.cat, n: 0, w: 0 };
      c.n++; c.w += e.w; cats.set(e.cat, c);
    }
    return {
      days: half * 7, cur, prev,
      change: cur.risk != null && prev.risk != null && prev.risk > 0 ? (cur.risk - prev.risk) / prev.risk : null,
      series, byCat: [...cats.values()].sort((a, b) => b.w - a.w),
    };
  }

  // ---------- Jornada y fatiga ----------
  // live: { d, driving, since } del vehículo en el que está identificado.
  function fatigueState(trips, evs, cfg, me, now, live) {
    const fz = cfg.fatigue;
    const from = now - cfg.drive.fatigue_days * DAY;
    const mine = trips.filter(t => t.e >= from && t.s <= now).map(t => Object.assign({}, t, { r: me }));
    // viaje en curso que todavía no llegó al servidor (mismo criterio que GI.liveTrips)
    if (live && live.driving && live.since < now) {
      const last = mine.filter(t => t.d === live.d).pop();
      if (!(last && last.e > live.since)) mine.push({ i: "_live", d: live.d, r: me, s: live.since, e: now, dh: (now - live.since) / H, km: 0, live: true });
    }
    const tripsByDevice = GI.groupBy(mine.sort((a, b) => a.s - b.s), t => t.d);
    const model = { settings: { fatigue: fz }, tripsByDevice, events: evs.filter(e => e.t >= from) };
    const res = GI.buildShifts(model, new Set(tripsByDevice.keys()), id => id === me, { now, tripsByDevice });
    const info = res.sims.get(me);
    const list = info ? info.list : [];
    const last = list[list.length - 1] || null;
    const out = { limits: fz, list, last, open: null, rest: null, next: info ? info.next : null, recent: list.slice(-5).reverse() };
    if (last && last.open) {
      const p = GI.shiftProgress(last, fz, now);
      const fi = GI.openShiftIndex(last, list, last.sim, fz, now);
      for (const x of p.items) { x.left = Math.max(0, x.max - x.v); }
      out.open = { shift: last, progress: p, index: fi, daysRow: last.daysRow };
      const rides = mine.filter(t => t.ride && t.e >= last.s);
      out.open.ride = rides.length ? { only: !mine.some(t => !t.ride && t.e >= last.s), crewKey: rides[rides.length - 1].crewKey } : null;
    } else if (last) {
      const restH = (now - last.e) / H;
      out.rest = { since: last.e, hours: restH, min: fz.min_rest, left: Math.max(0, fz.min_rest - restH), fiNow: last.sim ? last.sim.at(now - 1) : null };
      out.rest.level = GI.fiLevel(out.rest.fiNow, fz);
    }
    return out;
  }

  // Avisos de límite que corresponde lanzar ahora (una sola vez por jornada,
  // umbral y límite). sent: { "<jornada>|<límite>|<warn|max>": ms }.
  function limitAlerts(fs, cfg, sent) {
    const out = [];
    if (!fs.open) return out;
    const j = fs.open.shift;
    for (const x of fs.open.progress.items) {
      const lvl = x.v >= x.max ? "max" : x.v >= cfg.drive.warn_pct * x.max ? "warn" : null;
      if (!lvl) continue;
      const key = j.s + "|" + x.key + "|" + lvl;
      if (sent && sent[key]) continue;
      // si ya pasó el límite, no avisar también el 80 %
      if (lvl === "warn" && sent && sent[j.s + "|" + x.key + "|max"]) continue;
      out.push({ key, item: x, level: lvl });
    }
    return out;
  }

  // ---------- Alejamiento del vehículo ----------
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Evalúa una lectura. prev: { far, since, notifiedAt } (estado anterior).
  // vehicle: { d, name, driver, lat, lon, driving, at }; phone: { lat, lon, acc, at } o null.
  // Devuelve el estado nuevo y, si corresponde, el aviso a lanzar.
  function awayCheck(prev, vehicle, phone, me, cfg, now) {
    const a = cfg.drive.away;
    const st = Object.assign({ far: 0, notifiedAt: 0 }, prev || {});
    const base = { far: 0, notifiedAt: st.notifiedAt };
    if (!a.enabled) return { state: base, status: "off" };
    if (!vehicle || vehicle.driver !== me) return { state: Object.assign(base, { notifiedAt: 0 }), status: "sin_vehiculo" };
    if (!phone) return { state: st, status: "sin_gps" };
    if (vehicle.lat == null || vehicle.lon == null) return { state: st, status: "sin_posicion_vehiculo" };
    const dist = haversine(phone.lat, phone.lon, vehicle.lat, vehicle.lon);
    const acc = phone.acc || 0;
    if (acc > a.max_accuracy_m) return { state: st, status: "impreciso", dist, acc };
    // margen: la distancia tiene que superar el umbral aun restando el error de la lectura
    if (dist - acc <= a.distance_m) return { state: Object.assign(base, { notifiedAt: st.notifiedAt }), status: "cerca", dist, acc };
    const far = st.far + 1;
    const state = { far, since: st.since || now, notifiedAt: st.notifiedAt };
    let alert = null;
    if (far >= a.confirm_checks && now - (st.notifiedAt || 0) >= a.cooldown_min * MIN) {
      alert = { kind: vehicle.driving ? "en_movimiento" : "estacionado", dist, vehicle };
      state.notifiedAt = now;
    }
    return { state, status: "lejos", dist, acc, alert };
  }

  // ---------- Acompañante (tripulación de Horas de trabajo) ----------
  // Tramos en los que viajé de acompañante en el vehículo de otro chofer, según las
  // tripulaciones cargadas en Horas de trabajo. No cuentan los que rechacé ("No viajo").
  // S = WorkingHoursShared (scripts/shared.js de apicesetti/workinghours).
  function rideIntervals(records, me, now, S) {
    if (!S) return [];
    const idx = S.ackIndex(records);
    const out = [];
    for (const c of records || []) {
      if (!c || c.type !== S.CREW || c.driverId === me) continue;
      for (const m of c.members || []) {
        if (m.userId !== me || S.memberStatus(c, m, idx) === "no") continue;
        const from = S.toMs(m.from);
        const to = Math.min(m.to ? S.toMs(m.to) : S.dayEnd(c.date), now);
        if (!(to > from)) continue;
        // desde Horas de trabajo 1.5 cada acompañante va en un vehículo (m.deviceId)
        out.push({ from, to, driverId: c.driverId, devices: (m.deviceId ? [m.deviceId] : c.deviceIds && c.deviceIds.length ? c.deviceIds : [c.deviceId]).filter(Boolean),
          crewKey: c.key, driverName: c.driverName || "", deviceName: c.deviceName || "", status: S.memberStatus(c, m, idx) });
      }
    }
    return out.sort((a, b) => a.from - b.from);
  }
  // Viajes del vehículo dentro de esos tramos, como trabajo sin manejo (dh = 0). Se descartan
  // los pedazos que se superponen con viajes que manejé yo (manejar gana).
  function rideTrips(intervals, vehTrips, me, ownTrips) {
    const out = [];
    const own = (ownTrips || []).slice().sort((a, b) => a.s - b.s);
    const overlapsOwn = (s, e) => own.some(t => t.s < e && t.e > s);
    for (const iv of intervals) {
      for (const t of vehTrips || []) {
        if (!iv.devices.includes(t.d) || t.e <= iv.from || t.s >= iv.to) continue;
        if (iv.driverId && t.r && t.r !== iv.driverId) continue;   // ese vehículo ya lo manejaba otro
        const s = Math.max(t.s, iv.from), e = Math.min(t.e, iv.to);
        if (!(e > s) || overlapsOwn(s, e)) continue;
        const f = t.e > t.s ? (e - s) / (t.e - t.s) : 1;
        out.push({ i: "ride|" + t.i, d: t.d, r: me, s, e, km: GI.round((t.km || 0) * f, 3), dh: 0, ride: true, crewKey: iv.crewKey });
      }
    }
    return out.sort((a, b) => a.s - b.s);
  }

  // ---------- Relevo ----------
  const userName = u => [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.name || u.id;
  // Conductores activos que comparten algún grupo de conductor conmigo (si no
  // comparte ninguno, todos los activos). Ordenados por nombre.
  function reliefCandidates(users, me, now) {
    const active = (users || []).filter(u => u && u.id !== me.id && u.isDriver !== false && !(u.activeTo && new Date(u.activeTo).getTime() < now))
      .map(u => ({ id: u.id, name: userName(u), groups: (u.driverGroups || []).map(GI.idOf) }));
    const mine = new Set((me.groups || []).filter(g => g && g !== "GroupCompanyId"));
    const same = mine.size ? active.filter(u => u.groups.some(g => mine.has(g))) : [];
    return (same.length ? same : active).sort((a, b) => a.name.localeCompare(b.name, "es"));
  }
  const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  function filterUsers(list, q) {
    const w = norm(q).split(/\s+/).filter(Boolean);
    return w.length ? list.filter(u => w.every(x => norm(u.name).includes(x))) : list;
  }
  function reliefMessage(meName, vehicle, t) {
    const where = vehicle && vehicle.lat != null ? " Ubicación: https://maps.google.com/?q=" + GI.round(vehicle.lat, 5) + "," + GI.round(vehicle.lon, 5) : "";
    return meName + " te entregó " + ((vehicle && vehicle.name) || "el vehículo") + " a las " + hm(t) + "." + where + " Identificate con tu llavero al subir.";
  }

  // ---------- Formato ----------
  function dur(h) {
    if (h == null || !isFinite(h)) return "–";
    const m = Math.max(0, Math.round(h * 60));
    return m < 60 ? m + " min" : Math.floor(m / 60) + " h" + (m % 60 ? " " + String(m % 60).padStart(2, "0") + " min" : "");
  }
  const hm = t => new Date(t).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
  function meters(m) { return m == null ? "–" : m < 1000 ? Math.round(m) + " m" : GI.fmtNum(m / 1000, 1) + " km"; }

  GI.Drive = {
    DRIVE_DEFAULTS, settingsFrom, compactTrip, compactException, mergeById, myEvents,
    riskSummary, fatigueState, limitAlerts, haversine, awayCheck, dur, hm, meters, realDriver,
    reliefCandidates, filterUsers, reliefMessage, userName, rideIntervals, rideTrips,
  };
})(window.GI);
