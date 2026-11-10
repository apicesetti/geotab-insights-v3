// Gestión de la seguridad: concentración del riesgo (Pareto), matriz de exposición y conducta,
// reincidencia y resultado del coaching (antes y después, contra la flota). Funciones puras sobre
// el modelo (model.js); la interfaz está en ui/manage.js.
(function (GI) {
  "use strict";
  const DAY = 86400000;
  const median = xs => { const a = xs.filter(x => x != null && isFinite(x)).sort((p, q) => p - q); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

  // ---------- Pareto ----------
  // rows: [{ id, name, w (puntos de riesgo), km? }]. population: cuántos hay en total (con o sin riesgo).
  // Devuelve cuántos explican la mitad del riesgo, qué parte de la población son, la curva acumulada
  // y cuánto bajaría el riesgo total si esos bajaran a la tasa mediana (cuando hay km).
  function pareto(rows, population) {
    const all = rows.filter(r => r.w > 0).sort((a, b) => b.w - a.w);
    const total = all.reduce((s, r) => s + r.w, 0);
    const pop = Math.max(population || all.length, all.length);
    if (!total || !pop) return null;
    let acc = 0, n50 = 0;
    const curve = all.map((r, i) => { acc += r.w; if (!n50 && acc >= total * 0.5) n50 = i + 1; return { ...r, share: (r.w / total) * 100, cum: (acc / total) * 100 }; });
    const k20 = Math.max(1, Math.round(pop * 0.2));
    const share20 = curve[Math.min(k20, curve.length) - 1].cum;
    const top = curve.slice(0, n50);
    let saving = null;
    const withKm = rows.filter(r => r.km > 0);
    if (withKm.length >= 5) {
      const med = median(withKm.map(r => (r.w || 0) / r.km));
      const excess = top.reduce((s, r) => s + (r.km > 0 ? Math.max(0, r.w - med * r.km) : 0), 0);
      saving = (excess / total) * 100;
    }
    return { total, pop, n50, pct50: (n50 / pop) * 100, share50: curve[n50 - 1].cum, k20, share20, curve, top, saving };
  }

  // ---------- Matriz de exposición y conducta ----------
  // rows: conductores con km y riesgo (pts/100 km). Las medianas de la flota parten en cuatro cuadrantes.
  function matrix(rows) {
    const pts = rows.filter(r => r.km > 0 && r.risk != null);
    if (pts.length < 4) return null;
    // Exposición: mediana de km. Conducta: promedio de la flota (puntos totales / km totales); la
    // mediana del riesgo suele quedar casi en 0 porque muchos conductores no tienen infracciones.
    const mKm = median(pts.map(r => r.km));
    const kmT = pts.reduce((s, r) => s + r.km, 0), wT = pts.reduce((s, r) => s + (r.weighted || 0), 0);
    const mRisk = kmT > 0 ? (wT / kmT) * 100 : median(pts.map(r => r.risk));
    const q = r => (r.km >= mKm ? (r.risk > mRisk ? "prioridad" : "reconocer") : (r.risk > mRisk ? "corregir" : "bajo"));
    const out = { mKm, mRisk, pts: pts.map(r => ({ ...r, q: q(r) })), groups: { prioridad: [], corregir: [], reconocer: [], bajo: [] } };
    for (const p of out.pts) out.groups[p.q].push(p);
    const sum = (list, f) => list.reduce((s, r) => s + (f(r) || 0), 0);
    const kmAll = sum(pts, r => r.km), wAll = sum(pts, r => r.weighted);
    const P = out.groups.prioridad;
    out.prioKmShare = kmAll ? (sum(P, r => r.km) / kmAll) * 100 : null;
    out.prioRiskShare = wAll ? (sum(P, r => r.weighted) / wAll) * 100 : null;
    for (const k in out.groups) out.groups[k].sort((a, b) => (b.weighted || 0) - (a.weighted || 0));
    return out;
  }

  // ---------- Reincidencia ----------
  // La misma regla al menos `min` veces en los últimos `days` días del período, por conductor.
  function recidivism(model, ids, driverOk, end, days, min) {
    const from = end - days * DAY;
    const by = new Map();
    for (const e of model.events) {
      if (!e.drv || e.w <= 0 || e.t < from || e.t > end || !ids.has(e.d)) continue;
      if (driverOk && !driverOk(e.drv)) continue;
      const k = e.drv + "|" + e.rule;
      if (!by.has(k)) by.set(k, { drv: e.drv, rule: e.rule, cat: e.cat, ts: [], w: 0 });
      const g = by.get(k); g.ts.push(e.t); g.w += e.w;
    }
    const rows = [];
    for (const g of by.values()) {
      if (g.ts.length < min) continue;
      g.ts.sort((a, b) => a - b);
      const gap = g.ts.length > 1 ? (g.ts[g.ts.length - 1] - g.ts[0]) / (g.ts.length - 1) / DAY : null;
      rows.push({ ...g, n: g.ts.length, every: gap, last: g.ts[g.ts.length - 1] });
    }
    rows.sort((a, b) => b.n - a.n || b.w - a.w);
    // peso de los reincidentes en el total de infracciones del mismo rango
    let all = 0, theirs = 0;
    const who = new Set(rows.map(r => r.drv));
    for (const e of model.events) {
      if (!e.drv || e.w <= 0 || e.t < from || e.t > end || !ids.has(e.d)) continue;
      if (driverOk && !driverOk(e.drv)) continue;
      all++; if (who.has(e.drv)) theirs++;
    }
    const byRule = new Map();
    for (const r of rows) byRule.set(r.rule, (byRule.get(r.rule) || 0) + 1);
    const topRule = [...byRule.entries()].sort((a, b) => b[1] - a[1])[0] || null;
    return { rows, drivers: who.size, share: all ? (theirs / all) * 100 : null, from, end, days, min, topRule };
  }

  // ---------- Resultado del coaching ----------
  // Compara los `days` días antes del coaching con los `days` días después, para el conductor y para la
  // flota (los mismos vehículos visibles), con lo que hay cargado en el período.
  function windowSum(cells, ids, a, b, cat) {
    const o = { km: 0, w: 0, n: 0, cat: 0, days: new Set() };
    for (const [ck, c] of cells) {
      const [dev, dk] = ck.split("|");
      if (ids && !ids.has(dev)) continue;
      const t = GI.parseDayKey(dk).getTime();
      if (t < a || t >= b) continue;
      o.km += c.km || 0; o.w += c.w || 0; o.n += c.n || 0; if (cat) o.cat += (c.ev || {})[cat] || 0; o.days.add(dk);
    }
    o.rate = o.km > 0 ? (o.w / o.km) * 100 : null;
    return o;
  }
  function coachResult(model, ids, rec, loadedFrom, loadedTo) {
    const days = rec.days || 30, at = new Date(GI.dayKey(rec.at || Date.now()) + "T00:00:00").getTime();
    const a0 = at - days * DAY, b1 = at + days * DAY;
    const cells = model.drvCells.get(rec.drv) || new Map();
    const before = windowSum(cells, ids, a0, at, rec.cat), after = windowSum(cells, ids, at, b1, rec.cat);
    // flota: todos los conductores (incluido el resto), mismas fechas
    const fb = { km: 0, w: 0 }, fa = { km: 0, w: 0 };
    for (const m of model.drvCells.values()) {
      const x = windowSum(m, ids, a0, at), y = windowSum(m, ids, at, b1);
      fb.km += x.km; fb.w += x.w; fa.km += y.km; fa.w += y.w;
    }
    const fRate = o => (o.km > 0 ? (o.w / o.km) * 100 : null);
    const fleetCh = fRate(fb) && fRate(fa) != null ? ((fRate(fa) - fRate(fb)) / fRate(fb)) * 100 : null;
    const ch = before.rate && after.rate != null ? ((after.rate - before.rate) / before.rate) * 100 : null;
    const now = Math.min(Date.now(), loadedTo || Date.now());
    const measuring = b1 > now;
    const partialBefore = loadedFrom != null && a0 < loadedFrom;
    let verdict = "sin_datos";
    if (before.km >= 100 && after.km >= 100 && ch != null) verdict = ch <= -20 ? "mejoro" : ch >= 20 ? "empeoro" : "igual";
    else if (after.km < 100 && !measuring) verdict = "pocos_km";
    if (measuring && verdict !== "sin_datos") verdict = "midiendo_" + verdict;
    else if (measuring) verdict = "midiendo";
    return { at, days, before, after, ch, fleetCh, fleetBefore: fRate(fb), fleetAfter: fRate(fa), measuring, daysLeft: measuring ? Math.ceil((b1 - now) / DAY) : 0, partialBefore, verdict };
  }

  Object.assign(GI, { pareto, matrix, recidivism, coachResult, _median: median });
})(window.GI);
