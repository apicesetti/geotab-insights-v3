// Factores de riesgo del conductor: jornada y fatiga, familiaridad con el
// recorrido e infracciones prolongadas (gravedad). Usa lo ya cargado.
(function (GI) {
  "use strict";
  const H = 3600000;
  const FATIGUE_BUCKETS = [[0, 2], [2, 4], [4, 6], [6, 8], [8, 10], [10, Infinity]];
  const FAMILIARITY_BUCKETS = [[1, 1, "1.ª vez"], [2, 3, "2.ª–3.ª"], [4, 10, "4.ª–10.ª"], [11, Infinity, "11 o más"]];

  // Busca el viaje que contiene el instante t (viajes ordenados por inicio).
  function findTrip(trips, t) {
    let lo = 0, hi = trips.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (trips[mid].s <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best < 0) return -1;
    return t <= trips[best].e + 60000 ? best : -1;
  }

  function riskFactors(model, ids, driverOk, routeIdxMap, fleetIdx) {
    const s = model.settings;
    const fz = Object.assign({ max_drive_day: 9, max_span: 12, min_rest: 8, max_continuous: 4, max_days_row: 6 }, s.fatigue || {});
    const sev = Object.assign({ long_minutes: 1 }, s.severity || {});
    const ok = drv => drv && drv !== "_unknown" && (!driverOk || driverOk(drv));

    // ---------- Riesgo según horas acumuladas al volante en el día ----------
    // Por vehículo y día: horas de manejo acumuladas al empezar cada viaje.
    const fb = FATIGUE_BUCKETS.map(([a, b]) => ({ from: a, to: b, km: 0, n: 0, w: 0 }));
    const bucketOf = h => fb.findIndex(x => h >= x.from && h < x.to);
    const tripCum = new Map(); // viaje -> horas acumuladas al inicio
    for (const [dev, trips] of model.tripsByDevice) {
      if (!ids.has(dev)) continue;
      let day = null, cum = 0;
      for (const t of trips) {
        const dk = GI.dayKey(new Date(t.s));
        if (dk !== day) { day = dk; cum = 0; }
        tripCum.set(t, cum);
        const b = fb[bucketOf(cum)];
        b.km += t.km || 0;
        cum += t.dh || 0;
      }
    }
    for (const e of model.events) {
      if (!(e.w > 0) || !ids.has(e.d)) continue;
      const trips = model.tripsByDevice.get(e.d);
      if (!trips) continue;
      const i = findTrip(trips, e.t);
      if (i < 0) continue;
      const t = trips[i];
      const cum = tripCum.get(t) + Math.max(0, Math.min(t.dh || 0, (e.t - t.s) / H));
      const b = fb[bucketOf(cum)];
      b.n++; b.w += e.w;
    }
    fb.forEach(b => { b.rate = b.km >= 200 ? (b.w / b.km) * 100 : null; });
    const base = fb[0].rate || fb[1].rate;
    fb.forEach(b => { b.factor = b.rate != null && base ? b.rate / base : null; });

    // ---------- Jornada por conductor y día ----------
    const byDrv = new Map();
    for (const [dev, trips] of model.tripsByDevice) {
      if (!ids.has(dev)) continue;
      for (const t of trips) {
        if (!ok(t.r)) continue;
        if (!byDrv.has(t.r)) byDrv.set(t.r, []);
        byDrv.get(t.r).push(t);
      }
    }
    const drivers = [];
    for (const [id, raw] of byDrv) {
      raw.sort((a, b) => a.s - b.s);
      // El mismo conductor puede figurar en viajes superpuestos de dos
      // vehículos (llave o asignación duplicada): se cuenta una sola vez el
      // tiempo superpuesto, recortando proporcionalmente las horas de manejo.
      const trips = [];
      let reach = -Infinity;
      for (const t of raw) {
        if (t.e <= reach) continue;
        const s0 = Math.max(t.s, reach);
        const f = t.e > t.s ? (t.e - s0) / (t.e - t.s) : 1;
        trips.push({ s: s0, e: t.e, dh: (t.dh || 0) * f, km: (t.km || 0) * f });
        reach = t.e;
      }
      const days = new Map();
      for (const t of trips) {
        const dk = GI.dayKey(new Date(t.s));
        const d = days.get(dk) || { dk, s: t.s, e: t.e, dh: 0, km: 0 };
        d.e = Math.max(d.e, t.e); d.dh += t.dh || 0; d.km += t.km || 0;
        days.set(dk, d);
      }
      const list = [...days.values()].sort((a, b) => a.s - b.s);
      let longDays = 0, longSpans = 0, shortRests = 0, maxRow = 0, row = 0, prev = null, minRest = null, maxDay = 0;
      for (const d of list) {
        const span = (d.e - d.s) / H;
        maxDay = Math.max(maxDay, d.dh);
        if (d.dh > fz.max_drive_day) longDays++;
        if (span > fz.max_span) longSpans++;
        if (prev) {
          const gapDays = Math.round((GI.parseDayKey(d.dk) - GI.parseDayKey(prev.dk)) / 86400000);
          row = gapDays === 1 ? row + 1 : 1;
          const rest = (d.s - prev.e) / H;
          if (gapDays <= 1 && rest >= 0) {
            minRest = minRest == null ? rest : Math.min(minRest, rest);
            if (rest < fz.min_rest) shortRests++;
          }
        } else row = 1;
        maxRow = Math.max(maxRow, row);
        prev = d;
      }
      // Manejo continuo (pausas < 15 min) sobre todos sus viajes.
      let stint = 0, maxStint = 0, longStints = 0, lastE = null;
      for (const t of trips) {
        if (lastE != null && t.s - lastE > 15 * 60000) { if (stint >= fz.max_continuous) longStints++; stint = 0; }
        stint += t.dh || 0; maxStint = Math.max(maxStint, stint); lastE = t.e;
      }
      if (stint >= fz.max_continuous) longStints++;
      const flags = (longDays ? 1 : 0) + (longSpans ? 1 : 0) + (shortRests ? 1 : 0) + (maxRow >= fz.max_days_row ? 1 : 0) + (longStints ? 1 : 0);
      drivers.push({
        id, name: model.driverName.get(id) || id, days: list.length,
        avgDay: list.length ? GI.sum(list, d => d.dh) / list.length : 0, maxDay,
        longDays, longSpans, shortRests, minRest, maxRow, maxStint, longStints,
        level: flags >= 3 ? "alta" : flags >= 1 ? "media" : "baja", flags,
      });
    }

    // ---------- Familiaridad con el recorrido ----------
    // Para cada conductor y recorrido se numeran sus pasadas. Se ignoran los
    // pares que ya aparecen en los primeros 14 días cargados (podían conocerlo
    // de antes). Real vs esperado (índice del recorrido) por número de pasada.
    const firstDay = model.dayKeys[0] ? GI.parseDayKey(model.dayKeys[0]).getTime() : 0;
    const warm = firstDay + 14 * 86400000;
    const pairs = new Map();
    for (const j of model.journeys) {
      if (!ids.has(j.d) || j.internal || j.o === "_unknown" || j.km < 1) continue;
      const main = Object.entries(j.drvKm || {}).sort((a, b) => b[1] - a[1])[0];
      if (!main || !ok(main[0])) continue;
      const key = main[0] + "|" + j.o + "→" + j.dest;
      if (!pairs.has(key)) pairs.set(key, { drv: main[0], route: j.o + "→" + j.dest, name: j.oName + " → " + j.destName, list: [] });
      pairs.get(key).list.push(j);
    }
    const famB = FAMILIARITY_BUCKETS.map(([a, b, label]) => ({ from: a, to: b, label, km: 0, w: 0, exp: 0, n: 0 }));
    const newcomers = [];
    const now = Date.now();
    for (const p of pairs.values()) {
      p.list.sort((a, b) => a.s - b.s);
      if (p.list[0].s < warm) continue;
      const rIdx = routeIdxMap.get(p.route);
      if (rIdx == null) continue;
      p.list.forEach((j, k) => {
        const nth = k + 1;
        const b = famB.find(x => nth >= x.from && nth <= x.to);
        const km = j.drvKm[p.drv] || 0;
        const bd = (j.byDrv || {})[p.drv];
        b.km += km; b.exp += (km * rIdx) / 100; b.w += bd ? bd.w : 0; b.n++;
      });
      const danger = fleetIdx ? rIdx / fleetIdx : null;
      const last = p.list[p.list.length - 1];
      if (p.list.length <= 3 && danger != null && danger >= 1.3 && now - last.e < 21 * 86400000) {
        newcomers.push({ drv: p.drv, name: model.driverName.get(p.drv) || p.drv, route: p.name, times: p.list.length, danger, last: last.e });
      }
    }
    famB.forEach(b => { b.ratio = b.exp > 0 && b.km >= 200 ? b.w / b.exp : null; });
    newcomers.sort((a, b) => b.danger - a.danger);

    // ---------- Infracciones prolongadas ----------
    const longMin = sev.long_minutes || 1;
    const prolonged = new Map();
    const catLong = new Map();
    for (const e of model.events) {
      if (!(e.w > 0) || !ids.has(e.d)) continue;
      const min = (e.h || 0) * 60;
      const c = catLong.get(e.cat) || { cat: e.cat, n: 0, long: 0, minutes: 0 };
      c.n++; c.minutes += min; if (min >= longMin) c.long++;
      catLong.set(e.cat, c);
      if (min < longMin || !ok(e.drv)) continue;
      const x = prolonged.get(e.drv) || { id: e.drv, name: model.driverName.get(e.drv) || e.drv, n: 0, minutes: 0, maxMin: 0, cats: {} };
      x.n++; x.minutes += min; x.maxMin = Math.max(x.maxMin, min); x.cats[e.cat] = (x.cats[e.cat] || 0) + 1;
      prolonged.set(e.drv, x);
    }

    return {
      fatigue: { buckets: fb, drivers, limits: fz },
      familiarity: { buckets: famB, newcomers },
      prolonged: {
        longMin,
        drivers: [...prolonged.values()].map(x => ({ ...x, cats: Object.entries(x.cats).sort((a, b) => b[1] - a[1]).map(([cat, n]) => ({ cat, n })) })),
        cats: [...catLong.values()].filter(c => c.n > 0).map(c => ({ ...c, pct: (c.long / c.n) * 100, avgMin: c.minutes / c.n })),
      },
    };
  }

  Object.assign(GI, { riskFactors, _findTrip: findTrip });
})(window.GI);
