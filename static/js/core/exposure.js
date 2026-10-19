// Exposición al riesgo: cuándo y dónde ocurren las infracciones, velocidad
// por franja horaria (tráfico) y riesgo de cada conductor ajustado por los
// tramos que maneja. Todo sale de lo ya cargado (viajes, recorridos y
// eventos): no hace consultas nuevas a MyGeotab.
(function (GI) {
  "use strict";

  const DAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
  // Franjas horarias para velocidad y tráfico.
  const SLOTS = [
    { key: "madrugada", label: "Madrugada", from: 0, to: 6 },
    { key: "temprano", label: "06–09 h", from: 6, to: 9 },
    { key: "manana", label: "09–12 h", from: 9, to: 12 },
    { key: "mediodia", label: "12–15 h", from: 12, to: 15 },
    { key: "tarde", label: "15–18 h", from: 15, to: 18 },
    { key: "tardenoche", label: "18–21 h", from: 18, to: 21 },
    { key: "noche", label: "21–24 h", from: 21, to: 24 },
  ];
  const slotOf = h => SLOTS.findIndex(s => h >= s.from && h < s.to);
  const dayIdx = d => (d.getDay() + 6) % 7; // lunes = 0
  const isNight = h => h >= 22 || h < 6; // respaldo si el viaje no tiene ubicación
  const HOUR = 3600000;
  const RAD = Math.PI / 180;

  // Salida y puesta del sol (ecuación del amanecer, precisión ~2 min) para el
  // día solar que contiene "ms" en la longitud dada. La noche real cambia con
  // la estación y la latitud: en Neuquén el sol se pone ~18:20 en junio y
  // ~21:00 en diciembre.
  function sunTimes(ms, lat, lng) {
    const Jdate = ms / 86400000 + 2440587.5;
    const n = Math.round(Jdate - 2451545.0 - 0.0009 + lng / 360);
    const Jstar = 2451545.0 + 0.0009 - lng / 360 + n;
    const M = (((357.5291 + 0.98560028 * (Jstar - 2451545)) % 360) + 360) % 360;
    const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
    const L = (((M + C + 180 + 102.9372) % 360) + 360) % 360;
    const Jt = Jstar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * L * RAD);
    const d = Math.asin(Math.sin(L * RAD) * Math.sin(23.44 * RAD));
    const cw = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * Math.sin(d)) / (Math.cos(lat * RAD) * Math.cos(d));
    const toMs = J => (J - 2440587.5) * 86400000;
    if (cw >= 1) return { rise: toMs(Jt), set: toMs(Jt) };       // noche polar
    if (cw <= -1) return { rise: toMs(Jt - 0.5), set: toMs(Jt + 0.5) }; // día polar
    const w = Math.acos(cw) / RAD;
    return { rise: toMs(Jt - w / 360), set: toMs(Jt + w / 360) };
  }
  const sunCache = new Map();
  function sunFor(dayMs, lat, lng) {
    const k = Math.floor(dayMs / 86400000) + "|" + Math.round(lat * 2) + "|" + Math.round(lng * 2);
    let v = sunCache.get(k);
    if (!v) { v = sunTimes(dayMs, Math.round(lat * 2) / 2, Math.round(lng * 2) / 2); sunCache.set(k, v); if (sunCache.size > 50000) sunCache.clear(); }
    return v;
  }
  // Fracción de [a, b] que transcurre de noche (entre la puesta y la salida del sol).
  function darkFraction(a, b, lat, lng) {
    if (lat == null || lng == null) return null;
    if (b <= a) return isDark(a, lat, lng) ? 1 : 0;
    let dark = 0;
    const noonOf = ms => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime(); };
    for (let day = noonOf(a) - 86400000; day <= noonOf(b) + 86400000; day += 86400000) {
      const prev = sunFor(day - 86400000, lat, lng), cur = sunFor(day, lat, lng);
      const s = Math.max(a, prev.set), e = Math.min(b, cur.rise);
      if (e > s) dark += e - s;
    }
    return Math.min(1, dark / (b - a));
  }
  function isDark(t, lat, lng) {
    if (lat == null || lng == null) return isNight(new Date(t).getHours());
    const day = new Date(t); const noon = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12).getTime();
    const s = sunFor(noon, lat, lng);
    return t < s.rise || t > s.set;
  }
  // Noche de un viaje: fracción oscura en su punto de llegada; si no tiene
  // ubicación, se usa el horario fijo 22–6 h.
  function tripDark(t) {
    if (t.y != null && t.x != null) return darkFraction(t.s, Math.max(t.e, t.s + 1), t.y, t.x);
    let night = 0, tot = 0;
    spreadTrip(t, (di, h, km) => { tot += km; if (isNight(h)) night += km; });
    return tot > 0 ? night / tot : 0;
  }

  // Reparte los km de un viaje entre las horas que abarca (uniforme).
  function spreadTrip(t, fn) {
    const s = t.s, e = Math.max(t.e, t.s + 1);
    const total = e - s;
    let cur = s;
    while (cur < e) {
      const d = new Date(cur);
      const next = Math.min(e, new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime());
      const f = (next - cur) / total;
      fn(dayIdx(d), d.getHours(), t.km * f, t.dh * f);
      cur = next;
    }
  }

  function exposure(model, ids, driverOk, opts) {
    const o = Object.assign({ gapMin: 15, longStintH: 4, highFactor: 1.5 }, opts || {});
    const ok = drv => drv && drv !== "_unknown" && (!driverOk || driverOk(drv));

    // ---------- Matriz día × hora ----------
    const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ km: 0, n: 0, w: 0 })));
    let totKm = 0, nightKm = 0;
    const darkOf = new Map();
    for (const [dev, trips] of model.tripsByDevice) {
      if (!ids.has(dev)) continue;
      for (const t of trips) {
        if (!(t.km > 0)) continue;
        totKm += t.km;
        const df = tripDark(t);
        darkOf.set(t, df);
        nightKm += t.km * df;
        spreadTrip(t, (di, h, km) => { grid[di][h].km += km; });
      }
    }
    let totN = 0, totW = 0, nightN = 0, nightW = 0;
    for (const e of model.events) {
      if (!(e.w > 0) || !ids.has(e.d)) continue;
      // ¿De noche? Con la ubicación del viaje que contiene la infracción.
      const trips = model.tripsByDevice.get(e.d);
      const ti = trips && GI._findTrip ? GI._findTrip(trips, e.t) : -1;
      const tp = ti >= 0 ? trips[ti] : null;
      if (isDark(e.t, tp ? tp.y : null, tp ? tp.x : null)) { nightN++; nightW += e.w; }
      const d = new Date(e.t);
      const c = grid[dayIdx(d)][d.getHours()];
      c.n++; c.w += e.w; totN++; totW += e.w;
    }
    const fleetRate = totKm > 0 ? (totN / totKm) * 100 : null; // infracciones / 100 km
    const fleetIdx = totKm > 0 ? (totW / totKm) * 100 : null;   // índice (ponderado)
    const minKmCell = Math.max(100, totKm * 0.002);
    const high = new Set();
    for (let di = 0; di < 7; di++) for (let h = 0; h < 24; h++) {
      const c = grid[di][h];
      c.rate = c.km >= minKmCell ? (c.n / c.km) * 100 : null;
      c.factor = c.rate != null && fleetRate ? c.rate / fleetRate : null;
      if (c.factor != null && c.factor >= o.highFactor && c.n >= 3) high.add(di * 24 + h);
    }
    // Por hora del día (todas las semanas juntas) para el gráfico de barras.
    const byHour = Array.from({ length: 24 }, (_, h) => {
      let km = 0, n = 0;
      for (let di = 0; di < 7; di++) { km += grid[di][h].km; n += grid[di][h].n; }
      return { h, km, n, rate: km >= minKmCell ? (n / km) * 100 : null };
    });

    // ---------- Recorridos: velocidad y riesgo por franja ----------
    const minRouteKm = (model.settings.journeys && model.settings.journeys.min_km_route) || 300;
    const routes = new Map();
    for (const j of model.journeys) {
      if (!ids.has(j.d) || j.internal || j.km < 1 || j.o === "_unknown") continue;
      const key = j.o + "→" + j.dest;
      const r = routes.get(key) || { key, from: j.oName, to: j.destName, noZone: j.o === "_none" || j.dest === "_none", km: 0, dh: 0, n: 0, w: 0, trips: 0, slots: SLOTS.map(() => ({ km: 0, dh: 0, n: 0 })) };
      r.km += j.km; r.dh += j.dh; r.trips++;
      for (const t of j.tr || []) {
        const si = slotOf(new Date(t.s).getHours());
        r.slots[si].km += t.km; r.slots[si].dh += t.dh;
      }
      routes.set(key, r);
    }
    for (const e of model.events) {
      if (!(e.w > 0) || !e.j || !ids.has(e.d)) continue;
      const j = e.j;
      if (j.internal || j.o === "_unknown") continue;
      const r = routes.get(j.o + "→" + j.dest);
      if (!r) continue;
      r.n++; r.w += e.w;
      r.slots[slotOf(new Date(e.t).getHours())].n++;
    }
    const routeRows = [...routes.values()].map(r => {
      const speed = r.dh > 0 ? r.km / r.dh : null;
      const minSlotKm = Math.max(50, r.km * 0.05);
      const slots = r.slots.map((s, i) => ({
        ...SLOTS[i], km: s.km, n: s.n,
        speed: s.dh > 0 && s.km >= minSlotKm ? s.km / s.dh : null,
        rate: s.km >= minSlotKm ? (s.n / s.km) * 100 : null,
      }));
      const withSpeed = slots.filter(s => s.speed != null);
      const fastest = withSpeed.reduce((a, s) => (!a || s.speed > a.speed ? s : a), null);
      const slowest = withSpeed.reduce((a, s) => (!a || s.speed < a.speed ? s : a), null);
      const drop = fastest && slowest && fastest.speed > 0 ? (1 - slowest.speed / fastest.speed) * 100 : null;
      const rate = r.km > 0 ? (r.n / r.km) * 100 : null;
      const idx = r.km > 0 ? (r.w / r.km) * 100 : null;
      return {
        ...r, speed, slots, fastest, slowest, drop, rate, idx,
        danger: idx != null && fleetIdx ? idx / fleetIdx : null,
        stable: r.km >= minRouteKm,
      };
    });
    const routeIdx = new Map(routeRows.filter(r => r.stable && r.idx != null).map(r => [r.key, r.idx]));

    // ---------- Conductores ----------
    const drv = new Map();
    const D = id => drv.get(id) || (drv.set(id, { id, km: 0, w: 0, n: 0, expW: 0, tripKm: 0, nightKm: 0, riskKm: 0, maxStint: 0, longStints: 0, routes: new Map() }), drv.get(id));
    // Real y esperado sobre los recorridos (mismo universo de km).
    for (const j of model.journeys) {
      if (!ids.has(j.d)) continue;
      const known = !j.internal && j.o !== "_unknown" && j.km >= 1;
      const rIdx = known && routeIdx.has(j.o + "→" + j.dest) ? routeIdx.get(j.o + "→" + j.dest) : fleetIdx;
      for (const [id, km] of Object.entries(j.drvKm || {})) {
        if (!ok(id)) continue;
        const x = D(id);
        x.km += km; x.expW += (km * (rIdx || 0)) / 100;
        if (known) {
          const k = j.o + "→" + j.dest;
          const rr = x.routes.get(k) || { key: k, name: j.oName + " → " + j.destName, km: 0 };
          rr.km += km; x.routes.set(k, rr);
        }
      }
      for (const [id, bd] of Object.entries(j.byDrv || {})) {
        if (!ok(id)) continue;
        const x = D(id); x.w += bd.w; x.n += bd.n;
      }
    }
    // Nocturno, horarios de riesgo y manejo continuo, desde los viajes.
    const gapMs = o.gapMin * 60000;
    for (const [dev, trips] of model.tripsByDevice) {
      if (!ids.has(dev)) continue;
      let stintDrv = null, stintH = 0, lastE = null;
      const close = () => {
        if (stintDrv && drv.has(stintDrv)) {
          const x = drv.get(stintDrv);
          x.maxStint = Math.max(x.maxStint, stintH);
          if (stintH >= o.longStintH) x.longStints++;
        }
      };
      for (const t of trips) {
        const id = t.r;
        if (ok(id) && drv.has(id) && t.km > 0) {
          const x = drv.get(id);
          x.tripKm += t.km;
          x.nightKm += t.km * (darkOf.has(t) ? darkOf.get(t) : tripDark(t));
          spreadTrip(t, (di, h, km) => {
            if (high.has(di * 24 + h)) x.riskKm += km;
          });
        }
        if (id !== stintDrv || (lastE != null && t.s - lastE > gapMs)) { close(); stintDrv = id; stintH = 0; }
        stintH += t.dh || 0; lastE = t.e;
      }
      close();
    }
    const drivers = [...drv.values()].filter(x => x.km > 0).map(x => {
      const actual = (x.w / x.km) * 100, expected = (x.expW / x.km) * 100;
      const tripsKm = x.tripKm;
      return {
        id: x.id, name: model.driverName.get(x.id) || x.id, km: x.km, n: x.n,
        actual, expected,
        conduct: expected > 0 ? actual / expected : null,
        exposure: fleetIdx ? expected / fleetIdx : null,
        nightPct: tripsKm > 0 ? Math.min(100, (x.nightKm / tripsKm) * 100) : null,
        riskPct: tripsKm > 0 ? Math.min(100, (x.riskKm / tripsKm) * 100) : null,
        maxStint: x.maxStint, longStints: x.longStints,
        topRoutes: [...x.routes.values()].sort((a, b) => b.km - a.km).slice(0, 3),
      };
    });

    // Franjas de mayor riesgo, para el resumen en palabras.
    const cells = [];
    for (let di = 0; di < 7; di++) for (let h = 0; h < 24; h++) if (high.has(di * 24 + h)) cells.push({ di, h, ...grid[di][h] });
    cells.sort((a, b) => b.factor - a.factor);

    const dayKm = totKm - nightKm;
    const night = {
      km: nightKm, dayKm, n: nightN, dayN: totN - nightN,
      idx: nightKm >= 200 ? (nightW / nightKm) * 100 : null,
      dayIdx: dayKm >= 200 ? ((totW - nightW) / dayKm) * 100 : null,
    };
    night.factor = night.idx != null && night.dayIdx ? night.idx / night.dayIdx : null;
    return { grid, byHour, fleetRate, fleetIdx, totKm, totN, minKmCell, highCells: cells, routes: routeRows, drivers, night };
  }

  // Exposición de un conductor: cuándo y por dónde maneja, y cómo le va en
  // cada caso comparado con la flota. ex = resultado de exposure().
  function exposureDriver(model, ids, drv, ex) {
    const hours = Array.from({ length: 24 }, (_, h) => ({ h, km: 0, n: 0, w: 0 }));
    const highSet = new Set(ex.highCells.map(c => c.di * 24 + c.h));
    let km = 0, highKm = 0, nightKm = 0, nightW = 0, nightN = 0, totW = 0, totN = 0;
    const routeKm = new Map();
    for (const [dev, trips] of model.tripsByDevice) {
      if (!ids.has(dev)) continue;
      for (const t of trips) {
        if (t.r !== drv || !(t.km > 0)) continue;
        km += t.km;
        nightKm += t.km * tripDark(t);
        spreadTrip(t, (di, h, k) => { hours[h].km += k; if (highSet.has(di * 24 + h)) highKm += k; });
      }
    }
    for (const j of model.journeys) {
      if (!ids.has(j.d) || j.internal || j.o === "_unknown" || !(j.drvKm && j.drvKm[drv])) continue;
      const k = j.o + "→" + j.dest;
      const r = routeKm.get(k) || { key: k, name: j.oName + " → " + j.destName, km: 0, trips: 0, w: 0, n: 0 };
      r.km += j.drvKm[drv]; r.trips++;
      const bd = (j.byDrv || {})[drv];
      if (bd) { r.w += bd.w; r.n += bd.n; }
      routeKm.set(k, r);
    }
    for (const e of model.events) {
      if (e.drv !== drv || !(e.w > 0) || !ids.has(e.d)) continue;
      totW += e.w; totN++;
      const h = new Date(e.t).getHours();
      hours[h].n++; hours[h].w += e.w;
      const trips = model.tripsByDevice.get(e.d);
      const ti = trips && GI._findTrip ? GI._findTrip(trips, e.t) : -1;
      const tp = ti >= 0 ? trips[ti] : null;
      if (isDark(e.t, tp ? tp.y : null, tp ? tp.x : null)) { nightW += e.w; nightN++; }
    }
    hours.forEach(x => { x.rate = x.km >= 50 ? (x.n / x.km) * 100 : null; x.fleet = ex.byHour[x.h].rate; x.high = ex.highCells.some(c => c.h === x.h); });
    const rIdx = new Map(ex.routes.map(r => [r.key, r]));
    const routes = [...routeKm.values()].map(r => {
      const fr = rIdx.get(r.key);
      const idx = r.km > 0 ? (r.w / r.km) * 100 : null;
      return { ...r, idx, routeIdx: fr ? fr.idx : null, danger: fr ? fr.danger : null,
        conduct: fr && fr.idx > 0 && r.km >= 100 ? idx / fr.idx : null };
    }).sort((a, b) => b.km - a.km);
    const dayKm = km - nightKm;
    return {
      km, n: totN, hours, routes,
      highPct: km > 0 ? (highKm / km) * 100 : null,
      fleetHighPct: ex.totKm > 0 ? (ex.highCells.reduce((s, c) => s + c.km, 0) / ex.totKm) * 100 : null,
      night: { km: nightKm, pct: km > 0 ? (nightKm / km) * 100 : null, idx: nightKm >= 50 ? (nightW / nightKm) * 100 : null, n: nightN,
        dayIdx: dayKm >= 50 ? ((totW - nightW) / dayKm) * 100 : null },
      fleetNightPct: ex.totKm > 0 ? (ex.night.km / ex.totKm) * 100 : null,
    };
  }

  Object.assign(GI, { exposure, exposureDriver, EXPO_DAYS: DAYS, EXPO_SLOTS: SLOTS, _spreadTrip: spreadTrip, sunTimes, _darkFraction: darkFraction });
})(window.GI);
