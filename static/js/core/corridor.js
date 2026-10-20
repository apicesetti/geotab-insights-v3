// Corredores: dónde y a qué hora se concentra el tránsito de la flota, a qué
// velocidad se circula y dónde ocurren las infracciones, por tramo de ~1 km.
//
// Cómo se mide sin traer todo el GPS (en flotas grandes son cientos de miles
// de puntos por día): MUESTREO. Por cada media hora se piden 5 minutos de
// LogRecord de TODA la flota en una sola consulta (sin deviceSearch), o sea
// 1 de cada 6 minutos. Todos los días y todas las horas quedan representados
// y los km / el tiempo se multiplican por 6 para estimar el total.
//
// Con la muestra, para cada vehículo se unen sus puntos consecutivos (hasta
// 60 s de diferencia) en segmentos; cada segmento suma km, segundos y
// velocidad a la celda de ~1 km donde cae y a la hora local en que ocurre.
// Se guarda por día y por vehículo (para poder filtrar por grupo sin volver a
// pedir nada) en el caché del navegador.
//
// Las infracciones se ubican todas (no por muestra) con loadEventLocations.
(function (GI) {
  "use strict";

  const WIN_MIN = 5;           // minutos de GPS por ventana
  const EVERY_MIN = 30;        // una ventana cada media hora
  const SCALE = EVERY_MIN / WIN_MIN;
  const CELL_DEG = 0.01;       // ~1,1 km de latitud
  const MAX_GAP_S = 60;        // puntos más separados no forman segmento
  const MAX_KMH = 180;         // descarta saltos de GPS
  const LIMIT = 50000;
  const BATCH = 12;            // ventanas por multiCall
  const RECENT_TTL_MS = 15 * 60 * 1000;
  const SETTLE_MS = 48 * 3600 * 1000;
  const CACHE_VER = "corr2";

  const rad = Math.PI / 180;
  function haversineKm(lat1, lng1, lat2, lng2) {
    const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Celda: fila por latitud; el ancho en longitud se ajusta por la latitud de
  // la fila para que la celda sea aproximadamente cuadrada.
  function cellOf(lat, lng) {
    const r = Math.floor(lat / CELL_DEG);
    const w = CELL_DEG / Math.max(0.2, Math.cos((r + 0.5) * CELL_DEG * rad));
    return r + ":" + Math.floor(lng / w);
  }
  function cellBounds(key) {
    const [r, c] = key.split(":").map(Number);
    const w = CELL_DEG / Math.max(0.2, Math.cos((r + 0.5) * CELL_DEG * rad));
    return [[r * CELL_DEG, c * w], [(r + 1) * CELL_DEG, (c + 1) * w]];
  }
  function cellCenter(key) {
    const [[a, b], [c, d]] = cellBounds(key);
    return [(a + c) / 2, (b + d) / 2];
  }

  // Ventanas de muestreo de un día (hora local): [inicio, fin] en ms.
  // every: minutos entre ventanas (30 en flotas normales, 60 en flotas muy
  // grandes: con millones de km por mes 1 de cada 12 minutos alcanza).
  function dayWindows(dk, every) {
    every = every || EVERY_MIN;
    const d0 = GI.parseDayKey(dk).getTime();
    // Se corre la ventana dentro del intervalo según el día, así no siempre
    // se mira el mismo minuto (p. ej. :00 de un cambio de turno).
    const off = (GI.parseDayKey(dk).getDate() * 7) % (every - WIN_MIN);
    const out = [];
    for (let m = 0; m < 24 * 60; m += every) {
      const a = d0 + (m + off) * 60000;
      out.push([a, a + WIN_MIN * 60000]);
    }
    return out;
  }

  // Agrega los puntos de UNA ventana en filas [bucket, celda, hora, km, seg, sv, sv2]
  // (sv / sv2: suma de velocidad·seg y velocidad²·seg, para media y dispersión).
  // bucketOf(dev): el vehículo (flotas chicas) o "@p"/"@l" pesado/liviano
  // (flotas grandes, ya filtradas por alcance); null = fuera del alcance.
  // seen: Map(celda -> Set(vehículos)) para contar vehículos distintos por día.
  function aggregateWindow(recs, acc, bucketOf, seen) {
    const byDev = new Map();
    for (const r of recs) {
      if (!(r.latitude || r.longitude) || !r.device) continue;
      const id = r.device.id || r.device;
      let a = byDev.get(id);
      if (!a) byDev.set(id, (a = []));
      a.push([new Date(r.dateTime).getTime(), r.latitude, r.longitude, r.speed || 0]);
    }
    for (const [dev, pts] of byDev) {
      const bk = bucketOf ? bucketOf(dev) : dev;
      if (bk == null) continue;
      pts.sort((x, y) => x[0] - y[0]);
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1], q = pts[i];
        const dt = (q[0] - p[0]) / 1000;
        if (!(dt > 0) || dt > MAX_GAP_S) continue;
        const km = haversineKm(p[1], p[2], q[1], q[2]);
        if ((km / dt) * 3600 > MAX_KMH) continue;
        const sp = (p[3] + q[3]) / 2;
        if (sp < 3 && km < 0.005) continue; // detenido: no es tránsito
        const cell = cellOf((p[1] + q[1]) / 2, (p[2] + q[2]) / 2);
        const h = new Date(p[0]).getHours();
        const k = bk + "|" + cell + "|" + h;
        let row = acc.get(k);
        if (!row) acc.set(k, (row = [bk, cell, h, 0, 0, 0, 0]));
        row[3] += km; row[4] += dt; row[5] += sp * dt; row[6] += sp * sp * dt;
        if (seen) { let st = seen.get(cell); if (!st) seen.set(cell, (st = new Set())); st.add(dev); }
      }
    }
  }

  const logCall = ([a, b]) => ["Get", {
    typeName: "LogRecord", resultsLimit: LIMIT,
    search: { fromDate: new Date(a).toISOString(), toDate: new Date(b).toISOString() },
    propertySelector: { fields: ["device", "dateTime", "latitude", "longitude", "speed"], isIncluded: true },
  }];

  async function fetchWindow(api, w) {
    // Si una ventana llega al límite (flotas muy grandes) se parte en dos.
    const recs = (await api.call(...logCall(w))) || [];
    if (recs.length < LIMIT || w[1] - w[0] < 30000) return recs;
    const mid = Math.round((w[0] + w[1]) / 2);
    return [...(await fetchWindow(api, [w[0], mid])), ...(await fetchWindow(api, [mid, w[1]]))];
  }

  // Trae y agrega un día. Los puntos de cada lote se agregan y se descartan
  // enseguida (nunca hay más de un lote en memoria). El tamaño del lote se
  // ajusta: si las ventanas vienen pesadas (flotas grandes) se piden de a
  // menos por multiCall para no armar respuestas de decenas de MB.
  async function fetchDay(api, dk, o, onWindow) {
    const wins = dayWindows(dk, o.every).filter(w => w[0] < Date.now());
    const acc = new Map(), seen = new Map();
    let points = 0, batch = BATCH;
    for (let i = 0; i < wins.length; ) {
      const part = wins.slice(i, i + batch);
      i += part.length;
      let res;
      try { res = await api.multiCall(part.map(logCall)); }
      catch (e) { res = []; for (const w of part) res.push(await fetchWindow(api, w)); }
      let n = 0;
      for (let j = 0; j < part.length; j++) {
        let recs = res[j] || [];
        if (recs.length >= LIMIT) recs = await fetchWindow(api, part[j]);
        n += recs.length;
        aggregateWindow(recs, acc, o.bucketOf, seen);
        res[j] = null;
      }
      points += n;
      const perWin = n / part.length;
      batch = perWin > 15000 ? 2 : perWin > 5000 ? 4 : BATCH;
      if (onWindow) onWindow(part.length);
    }
    // Compacto: lista de buckets + filas con índice de bucket; vd = vehículos
    // distintos por celda en el día.
    const devs = [], devIdx = new Map();
    const rows = [];
    for (const r of acc.values()) {
      let di = devIdx.get(r[0]);
      if (di == null) { di = devs.length; devs.push(r[0]); devIdx.set(r[0], di); }
      rows.push([di, r[1], r[2], GI.round(r[3], 3), Math.round(r[4]), Math.round(r[5]), Math.round(r[6])]);
    }
    const vd = {};
    for (const [cell, st] of seen) vd[cell] = st.size;
    return { devs, rows, vd, points, windows: wins.length, scale: (o.every || EVERY_MIN) / WIN_MIN, bucketed: !!o.scopeKey };
  }

  function validEntry(e, dk) {
    if (!e || !e.v) return false;
    const dayEnd = GI.addDays(GI.parseDayKey(dk), 1).getTime();
    if (e.at - dayEnd >= SETTLE_MS) return true;      // día cerrado
    return Date.now() - e.at < RECENT_TTL_MS;         // día reciente: 15 min
  }

  // Estrategia según el tamaño de la flota:
  //  - hasta BIG_FLEET vehículos: muestra cada 30 min y filas por vehículo
  //    (cambiar el filtro de grupos no vuelve a consultar).
  //  - flotas grandes (p. ej. 6 millones de km/mes): muestra cada 60 min y
  //    filas agregadas pesados/livianos del alcance elegido (el caché es por
  //    alcance; otro alcance se vuelve a pedir).
  const BIG_FLEET = () => window.GI_BIG_FLEET || 400;
  function corridorPlan(model, ids) {
    const big = model.devices.length > BIG_FLEET();
    if (!big) return { every: EVERY_MIN, scopeKey: null, bucketOf: null };
    const heavy = id => { const t = model.vtypeOf.get(id); return t === "bitren" || t === "camion"; };
    const sorted = [...ids].sort();
    let hsh = 0;
    for (const id of sorted) for (let i = 0; i < id.length; i++) hsh = (hsh * 31 + id.charCodeAt(i)) | 0;
    return { every: 60, scopeKey: sorted.length + "." + (hsh >>> 0).toString(36), bucketOf: id => (ids.has(id) ? (heavy(id) ? "@p" : "@l") : null) };
  }

  // Devuelve Map(dayKey -> {devs, rows, vd, scale}). onProgress(0..1).
  async function loadCorridorDays(api, database, dayKeys, onProgress, plan) {
    const o = plan || { every: EVERY_MIN };
    const key = dk => database + "|" + CACHE_VER + "|" + (o.scopeKey ? "s" + o.scopeKey + "|" + o.every : "all") + "|" + dk;
    const cached = await GI._idbGetMany("days", dayKeys.map(key));
    const out = new Map(), missing = [];
    for (const dk of dayKeys) {
      const e = cached.get(key(dk));
      if (validEntry(e, dk)) out.set(dk, e.v); else missing.push(dk);
    }
    const totalWin = missing.length * (24 * 60 / (o.every || EVERY_MIN));
    let done = 0;
    if (onProgress) onProgress(missing.length ? 0 : 1);
    // Dos días en paralelo: ~2 multiCall simultáneos, lejos de la cuota.
    await GI.pool(missing, 2, async dk => {
      const v = await fetchDay(api, dk, o, n => { done += n; if (onProgress) onProgress(Math.min(1, done / totalWin)); });
      out.set(dk, v);
      await GI._idbPutMany("days", [{ k: key(dk), at: Date.now(), v }]);
    });
    return out;
  }

  // ---------- Modelo ----------
  // days: Map(dk -> {devs, rows, vd, scale}); ids: vehículos del alcance;
  // events: ya filtrados (con e.w > 0) y ubicados en locs; opts.hours:
  // [desde, hasta); opts.evScale: si se ubicó solo una muestra de las
  // infracciones, cuánto representa cada una (total / ubicadas).
  function corridorModel(model, days, ids, events, locs, opts) {
    const o = Object.assign({ hours: null, minKm: 50, evScale: 1 }, opts || {});
    const inHour = h => !o.hours || (o.hours[0] <= o.hours[1] ? h >= o.hours[0] && h < o.hours[1] : h >= o.hours[0] || h < o.hours[1]);
    const heavyId = id => { const t = model.vtypeOf.get(id); return t === "bitren" || t === "camion"; };
    const nDays = days.size || 1;
    const cells = new Map();
    const get = k => {
      let c = cells.get(k);
      if (!c) cells.set(k, (c = { key: k, km: 0, sec: 0, sv: 0, sv2: 0, heavyKm: 0, vmax: 0, byHour: new Array(24).fill(0), evByHour: new Array(24).fill(0), n: 0, w: 0, drivers: new Set(), cats: {} }));
      return c;
    };
    let totKm = 0;
    const kmByHour = new Array(24).fill(0);
    for (const v of days.values()) {
      const S = v.scale || SCALE;
      const dayDevs = v.bucketed ? null : new Map();
      for (const [di, cell, h, km, sec, sv, sv2] of v.rows) {
        const dev = v.devs[di];
        const bucket = dev === "@p" || dev === "@l";
        if ((!bucket && !ids.has(dev)) || !inHour(h)) continue;
        const c = get(cell);
        const kmE = km * S;
        c.km += kmE; c.sec += sec * S; c.sv += sv * S; c.sv2 += sv2 * S;
        if (bucket ? dev === "@p" : heavyId(dev)) c.heavyKm += kmE;
        c.byHour[h] += kmE;
        totKm += kmE; kmByHour[h] += kmE;
        if (dayDevs) { let st = dayDevs.get(cell); if (!st) dayDevs.set(cell, (st = new Set())); st.add(dev); }
      }
      // Vehículos distintos: el día de más tránsito del tramo.
      if (dayDevs) { for (const [cell, st] of dayDevs) { const c = cells.get(cell); if (c) c.vmax = Math.max(c.vmax, st.size); } }
      else if (v.vd) { for (const cell in v.vd) { const c = cells.get(cell); if (c) c.vmax = Math.max(c.vmax, v.vd[cell]); } }
    }
    // Infracciones del mismo período de días y horas.
    const dset = new Set(days.keys());
    let totW = 0, nEv = 0;
    for (const e of events) {
      const p = locs.get(e.i);
      if (!p || !ids.has(e.d) || !dset.has(GI.dayKey(e.t))) continue;
      const h = new Date(e.t).getHours();
      if (!inHour(h)) continue;
      const c = get(cellOf(p[0], p[1]));
      const w = e.w * o.evScale;
      c.n++; c.w += w; c.evByHour[h] += w;
      if (e.drv) c.drivers.add(e.drv);
      c.cats[e.cat] = (c.cats[e.cat] || 0) + 1;
      totW += w; nEv++;
    }
    const fleetIdx = totKm > 0 ? (totW / totKm) * 100 : null;
    const list = [...cells.values()].map(c => {
      const speed = c.sec > 0 ? c.sv / c.sec : null;
      const sd = c.sec > 0 ? Math.sqrt(Math.max(0, c.sv2 / c.sec - speed * speed)) : null;
      const idx = c.km >= o.minKm ? (c.w / c.km) * 100 : null;
      let peakH = 0;
      for (let h = 1; h < 24; h++) if (c.byHour[h] > c.byHour[peakH]) peakH = h;
      let evPeakH = null;
      for (let h = 0; h < 24; h++) if (c.evByHour[h] > 0 && (evPeakH == null || c.evByHour[h] > c.evByHour[evPeakH])) evPeakH = h;
      return {
        key: c.key, bounds: cellBounds(c.key), center: cellCenter(c.key),
        km: c.km, kmDay: c.km / nDays, hoursDay: c.sec / 3600 / nDays, speed, sd, cv: speed > 5 ? sd / speed : null,
        heavyPct: c.km > 0 ? (c.heavyKm / c.km) * 100 : null, vehicles: c.vmax,
        n: c.n, w: c.w, drivers: c.drivers.size, idx, factor: idx != null && fleetIdx ? idx / fleetIdx : null,
        peakH, evPeakH, byHour: c.byHour, evByHour: c.evByHour,
        cats: Object.entries(c.cats).sort((a, b) => b[1] - a[1]).map(([cat, n]) => ({ cat, n })),
      };
    });
    // Puntos negros: tasa ≥ 1,5× la flota, con exposición suficiente, al
    // menos 3 infracciones y más de un conductor/vehículo.
    const black = list.filter(c => c.factor != null && c.factor >= 1.5 && c.n >= 3 && Math.max(c.drivers, 1) >= 2)
      .sort((a, b) => b.w * b.factor - a.w * a.factor);
    return { cells: list, black, fleetIdx, totKm, kmDay: totKm / nDays, kmByHour, nEv, totW, nDays, minKm: o.minKm, evScale: o.evScale };
  }

  // Banda km × hora a lo largo de un trazado de referencia: cada celda a
  // menos de maxKm de la línea se proyecta al punto más cercano y se le
  // asigna su "km del recorrido". Devuelve filas por km (1 km) con la suma
  // por hora de km recorridos y puntos de infracción.
  function corridorBand(cm, trace, opts) {
    const o = Object.assign({ maxKm: 1.5, stepKm: null, maxRows: 60 }, opts || {});
    if (!trace || trace.length < 2) return null;
    const cum = [0];
    for (let i = 1; i < trace.length; i++) cum.push(cum[i - 1] + haversineKm(trace[i - 1][0], trace[i - 1][1], trace[i][0], trace[i][1]));
    const total = cum[cum.length - 1];
    // Filas de 2 km; en recorridos largos se agrandan para no pasar de ~60.
    if (!o.stepKm) o.stepKm = total / o.maxRows > 2 ? Math.ceil(total / o.maxRows / 5) * 5 : 2;
    const nBins = Math.max(1, Math.ceil(total / o.stepKm));
    const bins = Array.from({ length: nBins }, (_, b) => ({ from: b * o.stepKm, to: Math.min(total, (b + 1) * o.stepKm), km: new Array(24).fill(0), w: new Array(24).fill(0), cells: [] }));
    for (const c of cm.cells) {
      // Proyección al segmento más cercano (plano local equirectangular).
      const kx = 111.32 * Math.cos(c.center[0] * rad), ky = 110.57;
      let best = null;
      for (let i = 1; i < trace.length; i++) {
        const ax = (trace[i - 1][1] - c.center[1]) * kx, ay = (trace[i - 1][0] - c.center[0]) * ky;
        const bx = (trace[i][1] - c.center[1]) * kx, by = (trace[i][0] - c.center[0]) * ky;
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        const t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
        const px = ax + t * dx, py = ay + t * dy;
        const d = Math.sqrt(px * px + py * py);
        if (!best || d < best.d) best = { d, at: cum[i - 1] + t * (cum[i] - cum[i - 1]) };
      }
      if (!best || best.d > o.maxKm) continue;
      const b = bins[Math.min(nBins - 1, Math.floor(best.at / o.stepKm))];
      for (let h = 0; h < 24; h++) { b.km[h] += c.byHour[h]; b.w[h] += c.evByHour[h]; }
      b.cells.push(c);
    }
    return { total, bins, stepKm: o.stepKm };
  }

  function corridorKml(list, title) {
    return GI.hotspotsKml(list.map(c => ({ bounds: c.bounds, n: c.n, drivers: c.drivers, devices: c.vehicles, cats: c.cats })), title || "Puntos negros");
  }

  Object.assign(GI, { corridorPlan, loadCorridorDays, corridorModel, corridorBand, corridorKml, _corr: { dayWindows, aggregateWindow, cellOf, cellBounds, haversineKm, SCALE } });
})(window.GI);
