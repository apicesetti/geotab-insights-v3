// Corredores definidos por la empresa: geocercas con límite de velocidad, horario permitido y paradas
// autorizadas (settings.corridors). Para cada viaje que pasa cerca de un corredor se pide el GPS de ese
// viaje (LogRecord, solo de esos viajes) y se arman las "pasadas": entrada, salida, velocidad máxima,
// tiempo sobre el límite, horario y detenciones fuera de las paradas autorizadas.
(function (GI) {
  "use strict";
  const H = 3600000, MIN = 60000;
  const TOL = 5;            // km/h de tolerancia sobre el límite
  const GRAVE = 20;         // km/h sobre el límite = exceso grave
  const PAD = 0.05;         // ~5 km alrededor del corredor para elegir viajes candidatos
  const MAX_TRIPS = 400;    // tope de viajes con GPS por análisis
  const LOG_LIMIT = 5000;

  const inHours = (t, from, to) => { const h = new Date(t).getHours() + new Date(t).getMinutes() / 60; if (from == null || to == null || (from === 0 && to === 24)) return true; return from <= to ? h >= from && h < to : h >= from || h < to; };
  function boxHit(a, b) { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }

  // Viajes que pueden pasar por algún corredor: el segmento inicio→fin (o sus extremos) cerca de la caja.
  function candidateTrips(model, ids, corrs, from, to) {
    const boxes = corrs.map(c => [c.zone.bbox[0] - PAD, c.zone.bbox[1] - PAD, c.zone.bbox[2] + PAD, c.zone.bbox[3] + PAD]);
    const out = [];
    for (const [dev, trips] of model.tripsByDevice) {
      if (!ids.has(dev)) continue;
      let prev = null;
      for (const t of trips) {
        const sx = prev ? prev.x : t.x, sy = prev ? prev.y : t.y;
        prev = t;
        if (t.s < from || t.s > to || (t.km || 0) < 0.3 || t.x == null || sx == null) continue;
        const seg = [Math.min(sx, t.x), Math.min(sy, t.y), Math.max(sx, t.x), Math.max(sy, t.y)];
        // un viaje que sale y vuelve al mismo lugar tiene un segmento corto: se agranda según sus km
        const grow = Math.min(0.5, (t.km || 0) / 222);
        const segG = [seg[0] - grow, seg[1] - grow, seg[2] + grow, seg[3] + grow];
        if (boxes.some(b => boxHit(segG, b))) out.push({ d: dev, s: t.s, e: t.e, r: t.r || null, km: t.km });
      }
    }
    out.sort((a, b) => b.s - a.s);
    return { trips: out.slice(0, MAX_TRIPS), total: out.length };
  }

  const _logCache = new Map();
  async function loadTripLogs(api, trips, onProgress) {
    const need = trips.filter(t => !_logCache.has(t.d + "|" + t.s));
    const BATCH = 25;
    for (let i = 0; i < need.length; i += BATCH) {
      const part = need.slice(i, i + BATCH);
      const res = await api.multiCall(part.map(t => ["Get", { typeName: "LogRecord", resultsLimit: LOG_LIMIT,
        search: { deviceSearch: { id: t.d }, fromDate: new Date(t.s - MIN).toISOString(), toDate: new Date(t.e + MIN).toISOString() } }]));
      part.forEach((t, k) => {
        const pts = ((res && res[k]) || []).map(p => ({ t: new Date(p.dateTime).getTime(), x: p.longitude, y: p.latitude, v: p.speed || 0 }))
          .filter(p => p.x != null && p.y != null).sort((a, b) => a.t - b.t);
        _logCache.set(t.d + "|" + t.s, pts);
      });
      if (onProgress) onProgress(Math.min(1, (i + part.length) / Math.max(1, need.length)));
    }
    return trips.map(t => ({ ...t, pts: _logCache.get(t.d + "|" + t.s) || [] }));
  }

  // Eje principal del corredor (el lado más largo de su caja), para ubicar dónde pasan las cosas.
  function axisOf(z) { const w = z.bbox[2] - z.bbox[0], h = (z.bbox[3] - z.bbox[1]) * 1.2; return w >= h ? { k: "x", a: z.bbox[0], b: z.bbox[2] } : { k: "y", a: z.bbox[1], b: z.bbox[3] }; }
  const BINS = 10;

  // Analiza los viajes (con GPS) contra cada corredor.
  function analyze(corrs, trips, stopZones) {
    const inStop = (x, y, c) => (c.stops || []).some(id => { const z = stopZones.get(id); return z && x >= z.bbox[0] && x <= z.bbox[2] && y >= z.bbox[1] && y <= z.bbox[3] && GI.pointInPolygon(x, y, z.pts); });
    return corrs.map(c => {
      const z = c.zone, lim = +c.limit || null, ax = axisOf(z), stopMin = c.stopMin || 5;
      const r = { id: c.id, name: c.name || z.name, cfg: c, zone: z, passes: [], bins: Array.from({ length: BINS }, () => ({ over: 0, grave: 0, stop: 0 })), hours: Array.from({ length: 24 }, () => ({ n: 0, bad: 0 })) };
      for (const t of trips) {
        const P = t.pts;
        let cur = null;
        const close = () => { if (cur && cur.pts.length >= 2) r.passes.push(finish(cur, t)); cur = null; };
        for (let i = 0; i < P.length; i++) {
          const p = P[i];
          const ins = p.x >= z.bbox[0] && p.x <= z.bbox[2] && p.y >= z.bbox[1] && p.y <= z.bbox[3] && GI.pointInPolygon(p.x, p.y, z.pts);
          if (ins) {
            if (cur && p.t - cur.pts[cur.pts.length - 1].t > 20 * MIN) close();
            if (!cur) cur = { pts: [] };
            cur.pts.push(p);
          } else if (cur) close();
        }
        close();
      }
      function finish(cur, t) {
        const pts = cur.pts, a = pts[0].t, b = pts[pts.length - 1].t;
        let vmax = 0, overS = 0, grave = false, over = false, stops = 0, wp = null; const sp = [], bO = new Set(), bG = new Set();
        const bin = p => { const f = (p[ax.k] - ax.a) / Math.max(1e-9, ax.b - ax.a); return Math.max(0, Math.min(BINS - 1, Math.floor(f * BINS))); };
        let stopStart = null, stopP = null;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i], nx = pts[i + 1];
          if (p.v > vmax) { vmax = p.v; wp = [p.y, p.x]; }
          if (lim && p.v > lim + TOL) {
            over = true; const dt = nx ? Math.min(120, (nx.t - p.t) / 1000) : 0; overS += dt;
            if (p.v > lim + GRAVE) { grave = true; bG.add(bin(p)); } else bO.add(bin(p));
          }
          if (p.v < 3) { if (stopStart == null) { stopStart = p.t; stopP = p; } }
          else if (stopStart != null) {
            if (p.t - stopStart >= stopMin * MIN && !inStop(stopP.x, stopP.y, c)) { stops++; r.bins[bin(stopP)].stop++; sp.push([stopP.y, stopP.x, (p.t - stopStart) / MIN]); }
            stopStart = null;
          }
        }
        if (stopStart != null && b - stopStart >= stopMin * MIN && !inStop(stopP.x, stopP.y, c)) { stops++; r.bins[bin(stopP)].stop++; sp.push([stopP.y, stopP.x, (b - stopStart) / MIN]); }
        bG.forEach(i => r.bins[i].grave++); bO.forEach(i => { if (!bG.has(i)) r.bins[i].over++; });
        const offHours = !inHours(a, c.from, c.to);
        const bad = over || offHours || stops > 0;
        const hh = new Date(a).getHours(); r.hours[hh].n++; if (bad) r.hours[hh].bad++;
        return { d: t.d, r: t.r, a, b, min: (b - a) / MIN, vmax, overS, over, grave, offHours, stops, bad, wp: over ? wp : null, sp };
      }
      const P = r.passes;
      r.n = P.length; r.nOver = P.filter(p => p.over).length; r.nGrave = P.filter(p => p.grave).length;
      r.nOff = P.filter(p => p.offHours).length; r.nStops = P.reduce((s, p) => s + p.stops, 0);
      r.ok = r.n ? ((r.n - P.filter(p => p.bad).length) / r.n) * 100 : null;
      const ds = P.map(p => p.min).filter(m => m > 0.5).sort((x, y) => x - y);
      r.tMed = ds.length ? ds[ds.length >> 1] : null; r.tP90 = ds.length ? ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.9))] : null;
      r.vehicles = new Set(P.map(p => p.d)).size; r.drivers = new Set(P.filter(p => p.r).map(p => p.r)).size;
      const byDrv = new Map();
      for (const p of P) { const k = p.r || "_unknown"; if (!byDrv.has(k)) byDrv.set(k, { id: k, n: 0, over: 0, grave: 0, off: 0, stops: 0, bad: 0 }); const x = byDrv.get(k); x.n++; x.over += p.over ? 1 : 0; x.grave += p.grave ? 1 : 0; x.off += p.offHours ? 1 : 0; x.stops += p.stops; x.bad += p.bad ? 1 : 0; }
      r.byDriver = [...byDrv.values()].sort((x, y) => y.bad - x.bad || y.grave - x.grave);
      const badTot = P.filter(p => p.bad).length;
      const topBad = r.byDriver.filter(x => x.id !== "_unknown").slice(0, 5).reduce((s, x) => s + x.bad, 0);
      r.top5Share = badTot ? (topBad / badTot) * 100 : null;
      r.last = P.filter(p => p.bad).sort((x, y) => y.a - x.a).slice(0, 8);
      return r;
    });
  }

  // "Dónde intervenir": frases cortas a partir de los resultados.
  function focusOf(results) {
    const out = [];
    for (const r of results) {
      if (!r.n) continue;
      if (r.nOff >= 3) { const hs = r.hours.map((h, i) => ({ i, bad: h.bad })).filter(h => h.bad && !inHours(new Date(2000, 0, 1, h.i, 30).getTime(), r.cfg.from, r.cfg.to)).sort((a, b) => b.bad - a.bad); out.push({ r, score: r.nOff * 1.2, text: r.nOff + " pasadas fuera del horario permitido" + (hs[0] ? ", sobre todo a las " + String(hs[0].i).padStart(2, "0") + " h" : "") + "." }); }
      if (r.nGrave >= 2) out.push({ r, score: r.nGrave * 2, text: r.nGrave + " excesos graves (más de " + GRAVE + " km/h sobre " + r.cfg.limit + ")" + (r.top5Share ? "; 5 conductores explican el " + GI.fmtNum(r.top5Share, 0) + "% de los incumplimientos" : "") + "." });
      if (r.nStops >= 2) { const b = r.bins.map((x, i) => ({ i, n: x.stop })).sort((a, c) => c.n - a.n)[0]; out.push({ r, score: r.nStops, text: r.nStops + " detenciones fuera de las paradas autorizadas" + (b && b.n ? ", la mayoría en el tramo " + (b.i + 1) + " de " + BINS : "") + "." }); }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 4);
  }

  // Vista "Tramos" del Mapa de calor: agrupa los eventos ubicados por geocerca (la más chica que los
  // contiene, sin contar las enormes) o, si no caen en ninguna, por celda de ~2 km. Se ordenan por graves.
  function tramos(events, locs, zones, corridorIds) {
    const zs = (zones || []).filter(z => z.bbox && z.pts && z.pts.length >= 3 && (z.bbox[2] - z.bbox[0]) * (z.bbox[3] - z.bbox[1]) < 4);
    const C = 0.02, groups = new Map();
    for (const e of events) {
      const ll = locs.get(e.i); if (!ll) continue;
      const y = ll[0], x = ll[1];
      let best = null, area = Infinity;
      for (const z of zs) { const b = z.bbox; if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue; const a = (b[2] - b[0]) * (b[3] - b[1]); if (a < area && GI.pointInPolygon(x, y, z.pts)) { best = z; area = a; } }
      let k, g;
      if (best) { k = "z:" + best.id; if (!groups.has(k)) groups.set(k, { key: k, zone: best, name: best.name, bounds: [[best.bbox[1], best.bbox[0]], [best.bbox[3], best.bbox[2]]] }); }
      else { const ci = Math.floor(y / C), cj = Math.floor(x / C); k = "c:" + ci + ":" + cj; if (!groups.has(k)) groups.set(k, { key: k, zone: null, name: null, bounds: [[ci * C, cj * C], [(ci + 1) * C, (cj + 1) * C]] }); }
      g = groups.get(k);
      g.n = (g.n || 0) + 1; g.w = (g.w || 0) + (e.w || 0); g.grave = (g.grave || 0) + (e.sev === "grave" ? 1 : 0);
      (g.drv = g.drv || new Set()).add(e.drv || e.d); (g.cats = g.cats || {})[e.cat] = (g.cats[e.cat] || 0) + 1;
    }
    return [...groups.values()].filter(g => g.n >= 3)
      .map(g => ({ ...g, drivers: g.drv.size, cats: Object.entries(g.cats).map(([cat, n]) => ({ cat, n })).sort((a, b) => b.n - a.n), isCorridor: !!(g.zone && corridorIds && corridorIds.has(g.zone.id)) }))
      .sort((a, b) => b.grave - a.grave || b.w - a.w).slice(0, 20);
  }
  // Límite sugerido a partir del nombre de la geocerca ("... 80kmh", "60 km/h").
  function limitFromName(n) { const m = /(\d{2,3})\s*(km\s*\/?\s*h|kmh)/i.exec(n || ""); return m ? +m[1] : 80; }

  Object.assign(GI, { corridorCandidates: candidateTrips, loadCorridorLogs: loadTripLogs, analyzeCorridors: analyze, corridorFocus: focusOf, CORRIDOR_BINS: BINS, _inHours: inHours, tramosFromEvents: tramos, limitFromName });
})(window.GI);
