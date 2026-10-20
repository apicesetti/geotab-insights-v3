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
  const CACHE_VER = "corr3";

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
  // edges: Map("a~b" -> n) pasos entre celdas vecinas (arma la red de caminos
  // con la que después se agrupan las celdas en tramos).
  function aggregateWindow(recs, acc, bucketOf, seen, edges) {
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
      let prevCell = null; // última celda del recorrido continuo de este vehículo
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1], q = pts[i];
        const dt = (q[0] - p[0]) / 1000;
        if (!(dt > 0) || dt > MAX_GAP_S) { prevCell = null; continue; }
        const km = haversineKm(p[1], p[2], q[1], q[2]);
        if ((km / dt) * 3600 > MAX_KMH) { prevCell = null; continue; }
        const sp = (p[3] + q[3]) / 2;
        if (sp < 3 && km < 0.005) continue; // detenido: no es tránsito
        const h = new Date(p[0]).getHours();
        // Un segmento largo (hasta 60 s) puede cruzar varias celdas: se
        // reparte en pasos de ~400 m.
        const steps = Math.max(1, Math.ceil(km / 0.4));
        for (let st = 0; st < steps; st++) {
          const f = (st + 0.5) / steps;
          const cell = cellOf(p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f);
          const k = bk + "|" + cell + "|" + h;
          let row = acc.get(k);
          if (!row) acc.set(k, (row = [bk, cell, h, 0, 0, 0, 0]));
          const kk = km / steps, tt = dt / steps;
          row[3] += kk; row[4] += tt; row[5] += sp * tt; row[6] += sp * sp * tt;
          if (seen) { let sv = seen.get(cell); if (!sv) seen.set(cell, (sv = new Set())); sv.add(dev); }
          if (edges && prevCell && prevCell !== cell) { const ek = prevCell < cell ? prevCell + "~" + cell : cell + "~" + prevCell; edges.set(ek, (edges.get(ek) || 0) + 1); }
          prevCell = cell;
        }
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
    const acc = new Map(), seen = new Map(), edges = new Map();
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
        aggregateWindow(recs, acc, o.bucketOf, seen, edges);
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
    return { devs, rows, vd, edges: [...edges], points, windows: wins.length, scale: (o.every || EVERY_MIN) / WIN_MIN, bucketed: !!o.scopeKey };
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

  // ---------- Confianza y riesgo "suavizado" ----------
  // Con pocos datos una tasa puede salir altísima por casualidad (3
  // infracciones en 20 km = ×8). Se usa un promedio ponderado entre la tasa
  // propia y la de la flota (Bayes empírico Poisson-Gamma): cada tramo
  // arranca con el equivalente a PRIOR_EV infracciones "de flota promedio"
  // y a medida que suma km e infracciones pesa más lo propio.
  const PRIOR_EV = 5;
  function stats(totW, totKm, nEv) {
    const mu = totKm > 0 ? totW / totKm : 0;         // puntos por km
    const muN = totKm > 0 ? nEv / totKm : 0;         // infracciones por km
    return { mu, muN, K: muN > 0 ? PRIOR_EV / muN : 0 };
  }
  function judge(x, st) {
    if (!(st.mu > 0)) return { factorS: null, idxS: null, conf: "baja", expected: 0, excess: 0 };
    const rateS = (x.w + st.mu * st.K) / (x.km + st.K);
    const expected = x.km * st.muN;                  // infracciones esperables
    const conf = x.n >= 10 && expected >= 5 ? "alta" : x.n >= 5 && expected >= 2 ? "media" : "baja";
    return { idxS: rateS * 100, factorS: rateS / st.mu, conf, expected, excess: x.w - st.mu * x.km };
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
      if (!c) cells.set(k, (c = { key: k, km: 0, sec: 0, sv: 0, sv2: 0, heavyKm: 0, vmax: 0, byHour: new Array(24).fill(0), evByHour: new Array(24).fill(0), n: 0, w: 0, drivers: new Map(), cats: {} }));
      return c;
    };
    let totKm = 0;
    const kmByHour = new Array(24).fill(0);
    const edges = new Map();
    for (const v of days.values()) {
      for (const [k, n] of v.edges || []) edges.set(k, (edges.get(k) || 0) + n);
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
      if (e.drv) c.drivers.set(e.drv, (c.drivers.get(e.drv) || 0) + 1);
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
        sec: c.sec, sv: c.sv, sv2: c.sv2, heavyKm: c.heavyKm, drvCount: c.drivers, catCount: c.cats,
        cats: Object.entries(c.cats).sort((a, b) => b[1] - a[1]).map(([cat, n]) => ({ cat, n })),
      };
    });
    // Puntos negros: tasa ≥ 1,5× la flota, con exposición suficiente, al
    // menos 3 infracciones y más de un conductor/vehículo.
    const st = stats(totW, totKm, nEv);
    for (const c of list) Object.assign(c, judge(c, st));
    const black = list.filter(c => c.conf !== "baja" && c.factorS >= 1.5 && c.n >= 3 && c.drivers >= 2)
      .sort((a, b) => b.excess - a.excess);
    return { cells: list, black, st, edges, fleetIdx, totKm, kmDay: totKm / nDays, kmByHour, nEv, totW, nDays, minKm: o.minKm, evScale: o.evScale };
  }

  // ---------- Tramos ----------
  // Se arma la red de caminos con los pasos entre celdas (edges) y se corta:
  //  - "tramo": cadena de celdas sin bifurcaciones (cada celda con 2
  //    vecinas), partida cada ~MAX_SEG_KM.
  //  - "nudo": celdas con 3 o más vecinas juntas (cruces, pueblos, bases),
  //    más las cadenas muy cortas entre ellas.
  const MAX_SEG_KM = 20;
  // geom: modelo de todas las horas (define los tramos, estables al cambiar
  // de horario); cm: modelo del horario elegido (de donde salen los números).
  function corridorSegments(geom, cm, opts) {
    cm = cm || geom;
    const o = Object.assign({ minEdge: 1, maxKm: MAX_SEG_KM }, opts || {});
    const byKey = new Map(geom.cells.filter(c => c.km > 0).map(c => [c.key, c]));
    const statOf = new Map(cm.cells.map(c => [c.key, c]));
    const adj = new Map();
    for (const k of byKey.keys()) adj.set(k, new Set());
    for (const [ek, n] of geom.edges || []) {
      if (n < o.minEdge) continue;
      const [a, b] = ek.split("~");
      if (adj.has(a) && adj.has(b)) { adj.get(a).add(b); adj.get(b).add(a); }
    }
    // Limpieza de la red:
    // 1) Diagonales redundantes: si a–b es diagonal y existe c vecina de las
    //    dos (a–c–b), la diagonal sobra (si no, cada esquina parece un cruce).
    const rc = k => k.split(":").map(Number);
    for (const [a, na] of adj) {
      const [ra, qa] = rc(a);
      for (const b of [...na]) {
        const [rb, qb] = rc(b);
        if (ra === rb || qa === qb) continue;
        for (const c of na) if (c !== b && adj.get(b).has(c)) { na.delete(b); adj.get(b).delete(a); break; }
      }
    }
    // 2) Espolones: una celda suelta colgando de otra con mucho más tránsito
    //    (GPS al costado del camino) no es un camino nuevo: se suma a la vecina.
    const attachTo = new Map();
    for (let pass = 0; pass < 2; pass++) {
      for (const [k, nk] of adj) {
        if (nk.size !== 1) continue;
        const [n] = nk;
        if (adj.get(n).size >= 3 && byKey.get(k).km < 0.15 * byKey.get(n).km) {
          adj.get(n).delete(k); nk.delete(n); attachTo.set(k, n);
        }
      }
    }
    const deg = k => adj.get(k).size;
    const isJ = k => deg(k) >= 3;
    // Nudos: componentes conexas de celdas con 3+ vecinas.
    const groupOf = new Map();
    const groups = [];
    for (const k of adj.keys()) {
      if (!isJ(k) || groupOf.has(k)) continue;
      const g = { type: "nudo", cells: [] };
      const stack = [k];
      groupOf.set(k, g);
      while (stack.length) {
        const x = stack.pop();
        g.cells.push(x);
        for (const y of adj.get(x)) if (isJ(y) && !groupOf.has(y)) { groupOf.set(y, g); stack.push(y); }
      }
      groups.push(g);
    }
    // Cadenas entre nudos / extremos.
    const used = new Set();
    const chains = [];
    const walk = (start, next) => {
      const seq = [start];
      let prev = start, cur = next;
      while (cur && !used.has(cur) && !groupOf.has(cur)) {
        used.add(cur); seq.push(cur);
        const nx = [...adj.get(cur)].filter(y => y !== prev);
        if (deg(cur) !== 2 || !nx.length) break;
        prev = cur; cur = nx[0];
      }
      // termina en un nudo: se recuerda para absorber cadenas cortas
      const endG = cur && groupOf.has(cur) ? groupOf.get(cur) : null;
      return { seq, endG };
    };
    for (const k of adj.keys()) {
      if (groupOf.has(k)) {
        for (const y of adj.get(k)) if (!groupOf.has(y) && !used.has(y)) {
          const r = walk(k, y);
          r.seq.shift(); // la celda del nudo no es del tramo
          if (r.seq.length) chains.push({ cells: r.seq, a: groupOf.get(k), b: r.endG });
        }
      }
    }
    for (const k of adj.keys()) {
      if (used.has(k) || groupOf.has(k) || attachTo.has(k)) continue;
      {
        used.add(k);
        const nb = [...adj.get(k)].filter(y => !used.has(y) && !groupOf.has(y));
        let seq = [k];
        if (nb[0]) seq = seq.concat(walk(k, nb[0]).seq.slice(1));
        if (nb[1]) seq = walk(k, nb[1]).seq.slice(1).reverse().concat(seq);
        chains.push({ cells: seq, a: null, b: null });
      }
    }
    // Cadenas muy cortas (≤ 2 celdas) pegadas a un nudo: son parte del nudo.
    const segs = [];
    for (const ch of chains) {
      const g = ch.cells.length <= 2 ? ch.a || ch.b : null;
      if (g) { g.cells.push(...ch.cells); continue; }
      // partir cadenas largas
      let cur = [], len = 0;
      for (let i = 0; i < ch.cells.length; i++) {
        const c = byKey.get(ch.cells[i]);
        if (cur.length) len += haversineKm(byKey.get(cur[cur.length - 1]).center[0], byKey.get(cur[cur.length - 1]).center[1], c.center[0], c.center[1]);
        cur.push(ch.cells[i]);
        if (len >= o.maxKm && i < ch.cells.length - 2) { segs.push({ type: "tramo", cells: cur }); cur = [ch.cells[i]]; len = 0; }
      }
      if (cur.length) segs.push({ type: "tramo", cells: cur });
    }
    for (const g of groups) segs.push(g);
    // Infracciones ubicadas en celdas sin km en la muestra (caminos poco
    // usados, o el GPS cayó al costado): se suman al tramo vecino.
    const sgOf = new Map();
    for (const sg of segs) for (const k of sg.cells) sgOf.set(k, sg);
    for (const [k, n] of attachTo) {
      let t = n;
      while (attachTo.has(t)) t = attachTo.get(t);
      const g = sgOf.get(t);
      if (g) { g.cells.push(k); sgOf.set(k, g); }
    }
    for (const c of cm.cells) {
      if (!(c.n > 0) || sgOf.has(c.key)) continue;
      const [r, q] = c.key.split(":").map(Number);
      let found = null;
      for (let dr = -1; dr <= 1 && !found; dr++) for (let dq = -1; dq <= 1 && !found; dq++) found = sgOf.get((r + dr) + ":" + (q + dq)) || null;
      if (found) { found.cells.push(c.key); sgOf.set(c.key, found); }
    }
    // Celdas sueltas con infracciones pero sin km (no deberían, pero por las dudas).
    const st = cm.st;
    const out = segs.map((sg, i) => {
      const cs = sg.cells.map(k => byKey.get(k)).filter(Boolean);
      const css = sg.cells.map(k => statOf.get(k)).filter(Boolean);
      const x = { id: sg.cells[0] + "/" + sg.cells.length, type: sg.type, cellKeys: sg.cells, km: 0, w: 0, n: 0, sec: 0, sv: 0, sv2: 0, heavyKm: 0,
        byHour: new Array(24).fill(0), evByHour: new Array(24).fill(0), drv: new Map(), catCount: {}, vehicles: 0 };
      let lat0 = 90, lng0 = 180, lat1 = -90, lng1 = -180, len = 0;
      for (const c of css) {
        x.km += c.km; x.w += c.w; x.n += c.n; x.sec += c.sec; x.sv += c.sv; x.sv2 += c.sv2; x.heavyKm += c.heavyKm;
        x.vehicles = Math.max(x.vehicles, c.vehicles || 0);
        for (let h = 0; h < 24; h++) { x.byHour[h] += c.byHour[h]; x.evByHour[h] += c.evByHour[h]; }
        for (const [d, n] of c.drvCount || []) x.drv.set(d, (x.drv.get(d) || 0) + n);
        for (const k in c.catCount || {}) x.catCount[k] = (x.catCount[k] || 0) + c.catCount[k];
      }
      cs.forEach((c, j) => {
        const [[a, b], [cc, d]] = c.bounds;
        lat0 = Math.min(lat0, a); lng0 = Math.min(lng0, b); lat1 = Math.max(lat1, cc); lng1 = Math.max(lng1, d);
        if (j && sg.type === "tramo") len += haversineKm(cs[j - 1].center[0], cs[j - 1].center[1], c.center[0], c.center[1]);
      });
      x.bounds = [[lat0, lng0], [lat1, lng1]];
      x.length = sg.type === "tramo" ? len + 1.1 : null;
      x.path = sg.type === "tramo" ? cs.map(c => c.center) : null;
      x.start = cs[0] ? cs[0].center : null;
      x.end = cs[cs.length - 1] ? cs[cs.length - 1].center : null;
      x.mid = cs.length ? cs[Math.floor(cs.length / 2)].center : null;
      x.kmDay = x.km / cm.nDays;
      x.share = cm.totKm > 0 ? x.km / cm.totKm : 0;
      x.speed = x.sec > 0 ? x.sv / x.sec : null;
      x.sd = x.sec > 0 ? Math.sqrt(Math.max(0, x.sv2 / x.sec - x.speed * x.speed)) : null;
      x.heavyPct = x.km > 0 ? (x.heavyKm / x.km) * 100 : null;
      x.drivers = x.drv.size;
      const top = [...x.drv.entries()].sort((a, b) => b[1] - a[1]);
      const withDrv = top.reduce((s2, [, n]) => s2 + n, 0);
      x.topDrivers = top.slice(0, 5).map(([id, n]) => ({ id, n }));
      x.topShare = withDrv ? top[0][1] / withDrv : null;
      x.cats = Object.entries(x.catCount).sort((a, b) => b[1] - a[1]).map(([cat, n]) => ({ cat, n }));
      x.idx = x.km > 0 ? (x.w / x.km) * 100 : null;
      Object.assign(x, judge(x, st));
      x.franja = criticalWindow(x, st);
      return x;
    });
    const segOf = new Map();
    for (const x of out) for (const k of x.cellKeys) segOf.set(k, x);
    const action = out.filter(x => x.conf !== "baja" && x.factorS >= 1.3 && x.excess > 0).sort((a, b) => b.excess - a.excess);
    return { list: out, segOf, action };
  }

  // Franja de 3 h (circular) con más puntos por encima de lo esperable.
  function criticalWindow(x, st) {
    if (!(x.n > 0) || !(st.mu > 0)) return null;
    let best = null;
    for (let h = 0; h < 24; h++) {
      let w = 0, km = 0;
      for (let d = 0; d < 3; d++) { w += x.evByHour[(h + d) % 24]; km += x.byHour[(h + d) % 24]; }
      const ex = w - st.mu * km;
      if (!best || ex > best.ex) best = { from: h, to: (h + 3) % 24, ex, w, km };
    }
    if (!best || best.ex <= 0) return null;
    best.share = x.w > 0 ? best.w / x.w : 0;
    best.factor = best.km > 0 ? ((best.w + st.mu * st.K) / (best.km + st.K)) / st.mu : null;
    return best;
  }

  // ---------- Nombres de tramos ----------
  // Zona de MyGeotab si el punto cae en una; si no, dirección de Geotab
  // (GetAddresses: ruta y localidad). Se cachea por coordenada (~100 m).
  async function reverseGeocode(api, pts) {
    const key = p => "addr|" + p[0].toFixed(3) + "|" + p[1].toFixed(3);
    const uniq = [...new Map(pts.map(p => [key(p), p])).values()];
    const cached = await GI._idbGetMany("locs", uniq.map(key));
    const out = new Map();
    const missing = [];
    for (const p of uniq) { const h = cached.get(key(p)); if (h) out.set(key(p), h.a); else missing.push(p); }
    for (let i = 0; i < missing.length; i += 100) {
      const part = missing.slice(i, i + 100);
      let res = [];
      try { res = (await api.call("GetAddresses", { coordinates: part.map(p => ({ x: p[1], y: p[0] })), movingAddresses: false })) || []; }
      catch (e) { res = []; }
      const store = [];
      part.forEach((p, j) => {
        const r = res[j] || {};
        const a = { street: r.street || "", city: r.city || r.region || "", f: r.formattedAddress || "" };
        out.set(key(p), a); store.push({ k: key(p), a });
      });
      await GI._idbPutMany("locs", store);
    }
    return p => out.get(key(p)) || null;
  }
  // "Ruta Provincial 7" -> "RP7"; "Ruta Nacional 22" -> "RN22".
  function shortRoad(s) {
    if (!s) return "";
    const m = s.match(/ruta\s+(provincial|nacional)\s*(?:n[°º.]?\s*)?(\d+)/i);
    if (m) return (m[1][0].toUpperCase() === "P" ? "RP" : "RN") + m[2];
    const m2 = s.match(/\b(R[NP])\s*-?\s*(\d+)/i);
    if (m2) return m2[1].toUpperCase() + m2[2];
    return s.replace(/\s+\d+$/, "").trim();
  }
  async function nameSegments(api, segs, zones, limit) {
    const zoneAt = GI.makeZoneLocator(zones || []);
    const pick = segs.slice(0, limit || 80);
    const pts = [];
    for (const x of pick) { for (const p of [x.start, x.mid, x.end]) if (p) pts.push(p); }
    const addr = await reverseGeocode(api, pts);
    const place = p => {
      if (!p) return "";
      const z = zoneAt(p[1], p[0]);
      if (z) return z.name;
      const a = addr(p);
      return a ? a.city : "";
    };
    for (const x of pick) {
      const roads = [x.start, x.mid, x.end].map(p => (p && addr(p) ? shortRoad(addr(p).street) : "")).filter(Boolean);
      const cnt = {};
      for (const r of roads) cnt[r] = (cnt[r] || 0) + 1;
      const road = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0] || "";
      if (x.type === "nudo") {
        const zp = place(x.mid);
        x.name = (zp ? zp : "Cruce") + (road && !zp.includes(road) ? " · " + road : "");
      } else {
        const a = place(x.start), b = place(x.end);
        x.name = (road ? road + " · " : "Tramo · ") + (a && b && a !== b ? a + " → " + b : a || b || "sin localidad");
      }
      x.road = road;
    }
    for (const x of segs) if (!x.name) x.name = (x.type === "nudo" ? "Cruce " : "Tramo ") + x.mid[0].toFixed(3) + ", " + x.mid[1].toFixed(3);
    return segs;
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

  Object.assign(GI, { corridorPlan, loadCorridorDays, corridorModel, corridorSegments, nameSegments, corridorBand, corridorKml, _corr: { dayWindows, aggregateWindow, cellOf, cellBounds, haversineKm, SCALE } });
})(window.GI);
