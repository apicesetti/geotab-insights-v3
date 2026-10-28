// Valores de referencia de la empresa (benchmark): promedios de toda la flota
// cargada, sin nombres de conductores ni vehículos. Los publica un
// administrador y los usan supervisores y conductores para compararse.
(function (GI) {
  "use strict";

  function buildBenchmark(model) {
    const ids = new Set(model.devices.map(d => d.id));
    const ex = GI.exposure(model, ids, null);
    const rmap = new Map(ex.routes.filter(r => r.stable && r.idx != null).map(r => [r.key, r.idx]));
    const rf = GI.riskFactors(model, ids, null, rmap, ex.fleetIdx);
    const k = GI.kpis(GI.aggregate(model, ids));
    const byCat = {};
    for (const [cat, n] of Object.entries(k.evByCat || {})) {
      if ((GI.CATEGORY_BY_KEY[cat] || {}).kind === "riesgo" && k.km > 0) byCat[cat] = (n / k.km) * 100;
    }
    const profiles = {};
    for (const p of GI.profileRows(model, ids)) profiles[p.profile] = { risk: p.risk, l100: p.l100, idlePct: p.idlePct, vehicles: p.vehicles };
    const round = (v, d) => (v == null ? null : GI.round(v, d == null ? 4 : d));
    return {
      version: 1,
      from: model.dayKeys[0], to: model.dayKeys[model.dayKeys.length - 1],
      vehicles: ids.size, km: round(ex.totKm, 0),
      fleetIdx: round(ex.fleetIdx), fleetRate: round(ex.fleetRate),
      idlePct: round(k.idlePct, 2), l100: round(k.l100, 2),
      byCat: Object.fromEntries(Object.entries(byCat).map(([c, v]) => [c, round(v)])),
      profiles,
      byHour: ex.byHour.map(h => ({ h: h.h, rate: round(h.rate) })),
      highCells: ex.highCells.map(c => ({ di: c.di, h: c.h, factor: round(c.factor, 2), share: round(ex.totKm ? c.km / ex.totKm : 0, 5) })),
      night: { share: round(ex.totKm ? ex.night.km / ex.totKm : null, 4), idx: round(ex.night.idx), dayIdx: round(ex.night.dayIdx) },
      routes: ex.routes.filter(r => r.stable && r.idx != null).sort((a, b) => b.km - a.km).slice(0, 600)
        .map(r => ({ key: r.key, name: r.from + " → " + r.to, idx: round(r.idx), danger: round(r.danger, 3), speed: round(r.speed, 1) })),
      fatigue: rf.fatigue.buckets.map(b => ({ from: b.from, to: b.to === Infinity ? null : b.to, rate: round(b.rate) })),
      longVsNormal: round(rf.fatigue.longVsNormal, 3), shortRestVsRested: round(rf.fatigue.shortRestVsRested, 3),
    };
  }

  // Objeto con la forma de exposure() armado desde el benchmark, para
  // reutilizar los cálculos y pantallas de exposición de un conductor.
  function benchAsExposure(b) {
    const totKm = 1; // las celdas guardan su proporción de km (share)
    return {
      fleetIdx: b.fleetIdx, fleetRate: b.fleetRate, totKm,
      highCells: (b.highCells || []).map(c => ({ di: c.di, h: c.h, factor: c.factor, km: c.share || 0 })),
      byHour: Array.from({ length: 24 }, (_, h) => ({ h, rate: ((b.byHour || [])[h] || {}).rate == null ? null : b.byHour[h].rate })),
      routes: (b.routes || []).map(r => ({ ...r, stable: true })),
      night: { km: b.night && b.night.share != null ? b.night.share : 0, idx: b.night && b.night.idx, dayIdx: b.night && b.night.dayIdx },
    };
  }

  // Fila del conductor (como las de exposure().drivers) contra el benchmark.
  function driverVsBenchmark(model, ids, drv, b) {
    const rIdx = new Map((b.routes || []).map(r => [r.key, r.idx]));
    let km = 0, w = 0, n = 0, expW = 0;
    const routes = new Map();
    for (const j of model.journeys) {
      if (!ids.has(j.d) || !(j.drvKm && j.drvKm[drv])) continue;
      const dk = j.drvKm[drv];
      const known = !j.internal && j.o !== "_unknown" && j.km >= 1;
      const key = j.o + "→" + j.dest;
      const idx = known && rIdx.has(key) ? rIdx.get(key) : b.fleetIdx;
      km += dk; expW += (dk * (idx || 0)) / 100;
      const bd = (j.byDrv || {})[drv];
      if (bd) { w += bd.w; n += bd.n; }
      if (known) { const r = routes.get(key) || { key, name: j.oName + " → " + j.destName, km: 0 }; r.km += dk; routes.set(key, r); }
    }
    const actual = km > 0 ? (w / km) * 100 : null, expected = km > 0 ? (expW / km) * 100 : null;
    return {
      id: drv, name: model.driverName.get(drv) || drv, km, n, actual, expected,
      conduct: expected > 0 && actual != null ? actual / expected : null,
      exposure: b.fleetIdx ? expected / b.fleetIdx : null,
      topRoutes: [...routes.values()].sort((a, c) => c.km - a.km).slice(0, 3),
    };
  }

  Object.assign(GI, { buildBenchmark, benchAsExposure, driverVsBenchmark });
})(window.GI);
