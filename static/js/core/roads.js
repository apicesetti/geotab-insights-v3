// Corredores (v2): riesgo del CAMINO separado de la CONDUCTA de nuestros
// conductores, por tramo de ruta y franja horaria.
//
// Por qué separar: si un conductor infractor viaja siempre de 17 a 21 h, sus
// infracciones hacen "peligrosa" esa franja aunque el camino no lo sea. Para
// estimar el riesgo del entorno (el tránsito ajeno) se usa:
//   1. Interacción ajustada por conductor: frenadas, aceleraciones y giros
//      bruscos, distancia y colisiones, comparados con lo que ESE conductor
//      suele tener por km. observado ÷ esperado = efecto del lugar y la hora.
//   2. Congestión: velocidad mediana ÷ velocidad libre del mismo tramo (p85
//      de todas las horas), por tipo de vehículo. Lento = tránsito.
//   3. Anda y para: caídas bruscas de velocidad (≥ 25 km/h en ≤ 30 s) por km.
//   4. Luz: parte de la franja que es de noche (salida y puesta del sol).
// La conducta (exceso de velocidad, celular, cinturón, fatiga…) se mide
// aparte: infracciones por km frente al promedio de la red y % del tiempo
// sobre el límite de la vía (GetPostedRoadSpeedsForDevice o la geocerca).
//
// Tramos: cada celda de ~1 km se ubica con GetAddresses sobre un punto GPS
// real de la celda. Con número de calle (zona urbana): "calle (ciudad)". Sin
// número (ruta): la geocerca de control que la contiene ("RP7 - Chañar a
// Picada 11 - 110kmh"); sin geocerca: la ruta y la localidad.
//
// Datos: muestreo de LogRecord de toda la flota (5 min de cada media hora; en
// flotas grandes, de cada hora), guardado por día en el navegador.
(function (GI) {
  "use strict";

  const WIN_MIN = 5, EVERY_MIN = 30, SCALE = EVERY_MIN / WIN_MIN;
  const CELL_DEG = 0.01, MAX_GAP_S = 60, MAX_KMH = 180, LIMIT = 50000, BATCH = 12;
  const RECENT_TTL_MS = 15 * 60 * 1000, SETTLE_MS = 48 * 3600 * 1000;
  const CACHE_VER = "road1";
  const ADDR_TTL_MS = 30 * 24 * 3600 * 1000;
  const HBINS = 16; // histograma de velocidad: 0–9, 10–19, … 150+
  const OVER_TOL = 5; // km/h de tolerancia sobre el límite
  const ENV_CATS = new Set(["frenado_brusco", "aceleracion_brusca", "giro_brusco", "distancia", "colision"]);
  const FRANJAS = [
    { key: "0-6", label: "00 a 06 h", h: [0, 6] },
    { key: "6-10", label: "06 a 10 h", h: [6, 10] },
    { key: "10-17", label: "10 a 17 h", h: [10, 17] },
    { key: "17-21", label: "17 a 21 h", h: [17, 21] },
    { key: "21-24", label: "21 a 24 h", h: [21, 24] },
  ];

  const rad = Math.PI / 180;
  function haversineKm(lat1, lng1, lat2, lng2) {
    const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  const colW = r => CELL_DEG / Math.max(0.2, Math.cos((r + 0.5) * CELL_DEG * rad));
  function cellOf(lat, lng) { const r = Math.floor(lat / CELL_DEG); return r + ":" + Math.floor(lng / colW(r)); }
  function cellBounds(key) { const [r, c] = key.split(":").map(Number); const w = colW(r); return [[r * CELL_DEG, c * w], [(r + 1) * CELL_DEG, (c + 1) * w]]; }
  function cellCenter(key) { const [[a, b], [c, d]] = cellBounds(key); return [(a + c) / 2, (b + d) / 2]; }

  // ---------- Muestreo ----------
  function dayWindows(dk, every, win) {
    every = every || EVERY_MIN;
    const WIN_MIN = win || 5;
    const d0 = GI.parseDayKey(dk).getTime();
    const off = (GI.parseDayKey(dk).getDate() * 7) % (every - WIN_MIN);
    const out = [];
    for (let m = 0; m < 24 * 60; m += every) { const a = d0 + (m + off) * 60000; out.push([a, a + WIN_MIN * 60000]); }
    return out;
  }

  // Fila: [bucket, celda, hora, km, seg, Σv·seg, Σv²·seg, hist[16] (seg),
  //        anda-y-para, seg sobre el límite, seg con límite conocido, Σlímite·seg]
  // ctx: { bucketOf(dev) → bucket|null, limitAt(dev, t) → km/h|null, rep: Map(celda → [lat,lng]) }
  function aggregateWindow(recs, acc, ctx) {
    ctx = ctx || {};
    const byDev = new Map();
    for (const r of recs) {
      if (!(r.latitude || r.longitude) || !r.device) continue;
      const id = r.device.id || r.device;
      let a = byDev.get(id);
      if (!a) byDev.set(id, (a = []));
      a.push([new Date(r.dateTime).getTime(), r.latitude, r.longitude, r.speed || 0]);
    }
    for (const [dev, pts] of byDev) {
      const bk = ctx.bucketOf ? ctx.bucketOf(dev) : dev;
      if (bk == null) continue;
      pts.sort((x, y) => x[0] - y[0]);
      let recent = []; // [t, v] de los últimos 30 s (anda y para)
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1], q = pts[i];
        const dt = (q[0] - p[0]) / 1000;
        if (!(dt > 0) || dt > MAX_GAP_S) { recent = []; continue; }
        const km = haversineKm(p[1], p[2], q[1], q[2]);
        if ((km / dt) * 3600 > MAX_KMH) { recent = []; continue; }
        const sp = (p[3] + q[3]) / 2;
        // punto GPS real de cada celda (para GetAddresses: uno interpolado puede caer fuera del camino)
        if (ctx.rep) { const cq = cellOf(q[1], q[2]); if (!ctx.rep.has(cq) && q[3] > 3) ctx.rep.set(cq, [GI.round(q[1], 5), GI.round(q[2], 5)]); }
        // anda y para: la velocidad cae ≥ 25 km/h respecto del máximo de los últimos 30 s
        recent.push([p[0], p[3]]);
        while (recent.length && q[0] - recent[0][0] > 30000) recent.shift();
        let vmax = 0;
        for (const [, v] of recent) vmax = Math.max(vmax, v);
        let sg = 0;
        if (vmax >= 40 && q[3] <= vmax - 25) { sg = 1; recent = []; }
        if (sp < 3 && km < 0.005) continue; // detenido: no es tránsito
        const h = new Date(p[0]).getHours();
        const lim = ctx.limitAt ? ctx.limitAt(dev, p[0]) : null;
        const steps = Math.max(1, Math.ceil(km / 0.4));
        for (let st = 0; st < steps; st++) {
          const f = (st + 0.5) / steps;
          const la = p[1] + (q[1] - p[1]) * f, ln = p[2] + (q[2] - p[2]) * f;
          const cell = cellOf(la, ln);
          const k = bk + "|" + cell + "|" + h;
          let row = acc.get(k);
          if (!row) acc.set(k, (row = [bk, cell, h, 0, 0, 0, 0, new Array(HBINS).fill(0), 0, 0, 0, 0]));
          const kk = km / steps, tt = dt / steps;
          row[3] += kk; row[4] += tt; row[5] += sp * tt; row[6] += sp * sp * tt;
          row[7][Math.min(HBINS - 1, Math.floor(sp / 10))] += tt;
          if (lim) { row[10] += tt; row[11] += lim * tt; if (sp > lim + OVER_TOL) row[9] += tt; }
          if (sg && st === steps - 1) row[8] += 1;
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
    const recs = (await api.call(...logCall(w))) || [];
    if (recs.length < LIMIT || w[1] - w[0] < 30000) return recs;
    const mid = Math.round((w[0] + w[1]) / 2);
    return [...(await fetchWindow(api, [w[0], mid])), ...(await fetchWindow(api, [mid, w[1]]))];
  }

  // Límites de velocidad de la vía (GetPostedRoadSpeedsForDevice) para los
  // vehículos que circularon ese día. Devuelve limitAt(dev, t) o null si la
  // base no lo ofrece. Camiones: truckMaxSpeed si existe.
  async function loadPostedSpeeds(api, devs, from, to, heavyOf) {
    if (!devs.length) return null;
    const out = new Map();
    let ok = false;
    for (let i = 0; i < devs.length; i += 25) {
      const part = devs.slice(i, i + 25);
      let res;
      try {
        res = await api.multiCall(part.map(id => ["GetPostedRoadSpeedsForDevice", { deviceSearch: { id }, fromDate: new Date(from).toISOString(), toDate: new Date(to).toISOString() }]));
      } catch (e) { if (!ok && i === 0) return null; continue; }
      ok = true;
      part.forEach((id, j) => {
        const list = (res[j] || []).map(r => [new Date(r.date).getTime(), (heavyOf && heavyOf(id) && r.truckMaxSpeed) || r.maxSpeed || null]).filter(x => x[1] > 0).sort((a, b) => a[0] - b[0]);
        if (list.length) out.set(id, list);
      });
    }
    if (!ok) return null;
    return (dev, t) => {
      const l = out.get(dev);
      if (!l) return null;
      let lo = 0, hi = l.length - 1, best = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (l[m][0] <= t) { best = m; lo = m + 1; } else hi = m - 1; }
      return best >= 0 ? l[best][1] : null;
    };
  }

  async function fetchDay(api, dk, o, onWindow) {
    const wins = dayWindows(dk, o.every, o.win).filter(w => w[0] < Date.now());
    const d0 = GI.parseDayKey(dk).getTime(), d1 = d0 + 24 * 3600000;
    let limitAt = null;
    if (o.activeDevs && o.posted !== false) {
      const devs = o.activeDevs(dk);
      if (devs.length && devs.length <= 250) limitAt = await loadPostedSpeeds(api, devs, d0, d1, o.heavyOf);
    }
    const acc = new Map(), rep = new Map();
    const ctx = { bucketOf: o.bucketOf, limitAt, rep };
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
        aggregateWindow(recs, acc, ctx);
        res[j] = null;
      }
      points += n;
      const perWin = n / part.length;
      batch = perWin > 15000 ? 2 : perWin > 5000 ? 4 : BATCH;
      if (onWindow) onWindow(part.length);
    }
    const devs = [], devIdx = new Map(), rows = [];
    for (const r of acc.values()) {
      let di = devIdx.get(r[0]);
      if (di == null) { di = devs.length; devs.push(r[0]); devIdx.set(r[0], di); }
      rows.push([di, r[1], r[2], GI.round(r[3], 3), Math.round(r[4]), Math.round(r[5]), Math.round(r[6]), r[7].map(Math.round), r[8], Math.round(r[9]), Math.round(r[10]), Math.round(r[11])]);
    }
    return { devs, rows, rep: [...rep], points, windows: wins.length, scale: (o.every || EVERY_MIN) / (o.win || WIN_MIN), bucketed: !!o.scopeKey, posted: !!limitAt };
  }

  function validEntry(e, dk) {
    if (!e || !e.v) return false;
    const dayEnd = GI.addDays(GI.parseDayKey(dk), 1).getTime();
    if (e.at - dayEnd >= SETTLE_MS) return true;
    return Date.now() - e.at < RECENT_TTL_MS;
  }

  // Plan según el tamaño de la flota (ver Corredores v1): flotas grandes
  // muestrean cada hora y guardan filas pesados/livianos del alcance.
  const BIG_FLEET = () => window.GI_BIG_FLEET || 400;
  const isHeavy = (model, id) => { const t = model.vtypeOf.get(id); return t === "bitren" || t === "camion"; };
  function roadPlan(model, ids) {
    const heavyOf = id => isHeavy(model, id);
    // vehículos del alcance que tuvieron viajes ese día (para pedir los límites de la vía)
    const activeDevs = dk => {
      const d0 = GI.parseDayKey(dk).getTime(), d1 = d0 + 86400000, out = [];
      for (const id of ids) { const ts = model.tripsByDevice.get(id) || []; if (ts.some(t => t.e >= d0 && t.s < d1)) out.push(id); }
      return out;
    };
    // Flotas chicas (≤ 150 vehículos): 15 min de cada media hora (la mitad del
    // GPS), así hay datos suficientes por tramo; medianas: 5 de cada 30.
    if (model.devices.length <= 150) return { every: EVERY_MIN, win: 15, scopeKey: null, bucketOf: null, heavyOf, activeDevs };
    if (model.devices.length <= BIG_FLEET()) return { every: EVERY_MIN, win: 5, scopeKey: null, bucketOf: null, heavyOf, activeDevs };
    const sorted = [...ids].sort();
    let hsh = 0;
    for (const id of sorted) for (let i = 0; i < id.length; i++) hsh = (hsh * 31 + id.charCodeAt(i)) | 0;
    return { every: 60, win: 5, scopeKey: sorted.length + "." + (hsh >>> 0).toString(36), bucketOf: id => (ids.has(id) ? (heavyOf(id) ? "@p" : "@l") : null), heavyOf, activeDevs, posted: false };
  }

  async function loadRoadDays(api, database, dayKeys, onProgress, plan) {
    const o = plan || { every: EVERY_MIN };
    const key = dk => database + "|" + CACHE_VER + "|" + (o.scopeKey ? "s" + o.scopeKey + "|" + o.every : "all") + "|w" + (o.win || WIN_MIN) + "|" + dk;
    const cached = await GI._idbGetMany("days", dayKeys.map(key));
    const out = new Map(), missing = [];
    for (const dk of dayKeys) { const e = cached.get(key(dk)); if (validEntry(e, dk)) out.set(dk, e.v); else missing.push(dk); }
    const totalWin = missing.length * (24 * 60 / (o.every || EVERY_MIN));
    let done = 0;
    if (onProgress) onProgress(missing.length ? 0 : 1);
    await GI.pool(missing, 2, async dk => {
      const v = await fetchDay(api, dk, o, n => { done += n; if (onProgress) onProgress(Math.min(1, done / totalWin)); });
      out.set(dk, v);
      await GI._idbPutMany("days", [{ k: key(dk), at: Date.now(), v }]);
    });
    return out;
  }

  // ---------- Direcciones y geocercas ----------
  // GetAddresses sobre un punto GPS real de cada celda (no el centro, que
  // puede caer fuera del camino). Se guarda por celda 30 días.
  async function loadCellAddresses(api, database, reps, onProgress) {
    const key = c => "cad2|" + database + "|" + c;
    const cells = [...reps.keys()];
    const cached = await GI._idbGetMany("locs", cells.map(key));
    const out = new Map(), missing = [];
    for (const c of cells) { const h = cached.get(key(c)); if (h && Date.now() - h.at < ADDR_TTL_MS) out.set(c, h.a); else missing.push(c); }
    const batches = [];
    for (let i = 0; i < missing.length; i += 100) batches.push(missing.slice(i, i + 100));
    let done = 0;
    if (onProgress) onProgress(missing.length ? 0 : 1);
    await GI.pool(batches, 3, async part => {
      let res = [];
      try { res = (await api.call("GetAddresses", { coordinates: part.map(c => ({ x: reps.get(c)[1], y: reps.get(c)[0] })), movingAddresses: false })) || []; }
      catch (e) { res = []; }
      const store = [];
      part.forEach((c, j) => {
        const r = res[j];
        if (!r) return;
        const a = { city: r.city || "", street: r.streetName || r.street || "", num: r.streetNumber || "", region: r.region || "", zones: (r.zones || []).map(z => GI.idOf(z)).filter(Boolean) };
        out.set(c, a); store.push({ k: key(c), a, at: Date.now() });
      });
      await GI._idbPutMany("locs", store);
      done += part.length;
      if (onProgress) onProgress(done / missing.length);
    });
    return out;
  }

  // Nombres de todas las geocercas (sin puntos: liviano aunque sean miles).
  async function loadZoneNames(api, database, force) {
    const k = database + "|znames1";
    if (!force) { const hit = (await GI._idbGetMany("meta", [k])).get(k); if (hit && Date.now() - hit.at < 6 * 3600000) return new Map(hit.v); }
    let list = [];
    try { list = (await api.call("Get", { typeName: "Zone", propertySelector: { fields: ["id", "name"], isIncluded: true } })) || []; } catch (e) { list = []; }
    const v = list.map(z => [z.id, z.name || ""]);
    await GI._idbPutMany("meta", [{ k, v, at: Date.now() }]);
    return new Map(v);
  }

  // ---------- Tramos ----------
  const SPEED_RE = /(\d{2,3})\s*km\s*\/?\s*h/i;
  const isControlName = n => !!n && SPEED_RE.test(n) && !/^#/.test(n);
  const isPointZone = n => /radar|caminera|escuela|cartel/i.test(n || "");
  // "Ruta 7" / "RP7" / "RN 22" → "RP7" / "RN22"; si no, el nombre tal cual
  function normRoad(s) {
    if (!s) return "";
    const m = String(s).match(/\b(R[NP])\s*-?\s*(\d+)\b/i);
    if (m) return m[1].toUpperCase() + m[2];
    const m2 = String(s).match(/\bruta\s+(provincial|nacional)?\s*(?:n[°º.]?\s*)?(\d+)\b/i);
    if (m2) return (m2[1] && /^n/i.test(m2[1]) ? "RN" : "RP") + m2[2];
    return String(s).trim();
  }
  function cleanZoneName(n) { return String(n).replace(/\s+/g, " ").trim(); }

  // cellsKm: Map(celda → km de todas las horas); addr: Map(celda → dirección);
  // zoneNames: Map(id → nombre). Devuelve { tramos: Map(id → tramo), byCell }.
  // opts.zones: geocercas con puntos (las del catálogo) para ubicar por
  // polígono las celdas cuya dirección no trajo zonas de control;
  // opts.reps: punto GPS real de cada celda.
  function buildTramos(cellsKm, addr, zoneNames, opts) {
    const o = opts || {};
    zoneNames = new Map(zoneNames);
    const ctrlZones = (o.zones || []).filter(z => isControlName(z.name) && z.pts && z.pts.length >= 3);
    for (const z of ctrlZones) if (!zoneNames.has(z.id)) zoneNames.set(z.id, z.name);
    if (ctrlZones.length && o.reps) {
      // zonas por polígono (todas las que contienen el punto, no solo la más chica)
      // dentro del polígono o a menos de 150 m del borde (las geocercas de ruta son angostas)
      const TOL = 0.15, pad = 0.002;
      const nearEdge = (lng, lat, pts) => {
        const kx = 111.32 * Math.cos(lat * rad), ky = 110.57;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const ax = (pts[j][0] - lng) * kx, ay = (pts[j][1] - lat) * ky, bx = (pts[i][0] - lng) * kx, by = (pts[i][1] - lat) * ky;
          const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
          const t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
          if (Math.hypot(ax + t * dx, ay + t * dy) <= TOL) return true;
        }
        return false;
      };
      const inZones = (lng, lat) => ctrlZones.filter(z => lng >= z.bbox[0] - pad && lng <= z.bbox[2] + pad && lat >= z.bbox[1] - pad && lat <= z.bbox[3] + pad && (GI.pointInPolygon(lng, lat, z.pts) || nearEdge(lng, lat, z.pts))).map(z => z.id);
      const out = new Map(addr);
      for (const c of cellsKm.keys()) {
        const p = o.reps.get(c), a = out.get(c);
        if (!p) continue;
        const has = a && a.zones.some(z => isControlName(zoneNames.get(z)));
        if (has) continue;
        const zs = inZones(p[1], p[0]);
        if (zs.length) out.set(c, Object.assign({ city: "", street: "", num: "", zones: [] }, a || {}, { zones: [...((a && a.zones) || []), ...zs] }));
      }
      addr = out;
    }
    // frecuencia de cada geocerca de control (la más específica gana)
    const freq = new Map();
    for (const c of cellsKm.keys()) { const a = addr.get(c); if (a) for (const z of a.zones) if (isControlName(zoneNames.get(z))) freq.set(z, (freq.get(z) || 0) + 1); }
    const tramos = new Map(), byCell = new Map();
    const add = (c, id, base) => {
      let t = tramos.get(id);
      if (!t) tramos.set(id, (t = Object.assign({ id, cells: [], streets: {} }, base)));
      t.cells.push(c); byCell.set(c, t.id);
      const a = addr.get(c);
      if (a && a.street) { const r = normRoad(a.street); t.streets[r] = (t.streets[r] || 0) + (cellsKm.get(c) || 0); }
    };
    const pending = [];
    for (const c of cellsKm.keys()) {
      const a = addr.get(c);
      if (!a) { pending.push(c); continue; }
      if (a.num) { // urbano: calle (ciudad)
        add(c, "U|" + a.city + "|" + a.street, { kind: "urbano", name: (a.street || "Calle sin nombre") + (a.city ? " (" + a.city + ")" : ""), city: a.city, limit: null, zoneId: null });
        continue;
      }
      const ctrl = a.zones.filter(z => isControlName(zoneNames.get(z)));
      const main = ctrl.filter(z => !isPointZone(zoneNames.get(z)));
      const pick = (main.length ? main : ctrl).sort((x, y) => (freq.get(x) || 0) - (freq.get(y) || 0))[0];
      if (pick) {
        const nm = cleanZoneName(zoneNames.get(pick));
        const m = nm.match(SPEED_RE);
        add(c, "Z|" + pick, { kind: "geocerca", name: nm, zoneId: pick, limit: m ? +m[1] : null, city: a.city });
      } else {
        const road = normRoad(a.street) || "Camino sin nombre";
        add(c, "R|" + road + "|" + (a.city || ""), { kind: "ruta", name: road + (a.city ? " (" + a.city + ")" : ""), city: a.city, limit: null, zoneId: null });
      }
    }
    // celdas sin dirección: al tramo de una vecina
    for (let pass = 0; pass < 3 && pending.length; pass++) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const [r, q] = pending[i].split(":").map(Number);
        let found = null;
        for (let dr = -1; dr <= 1 && !found; dr++) for (let dq = -1; dq <= 1 && !found; dq++) { const id = byCell.get((r + dr) + ":" + (q + dq)); if (id) found = id; }
        if (found) { tramos.get(found).cells.push(pending[i]); byCell.set(pending[i], found); pending.splice(i, 1); }
      }
    }
    for (const t of tramos.values()) {
      const roads = Object.entries(t.streets).sort((a, b) => b[1] - a[1]);
      // ruta del tramo: la de la geocerca si la nombra ("RP7 - …", "Tramo 3 Ruta 7"), si no la calle más usada
      const fromName = t.kind === "geocerca" ? normRoad(t.name) : "";
      t.route = /^R[NP]\d+$/.test(fromName) ? fromName : roads[0] ? roads[0][0] : t.kind === "urbano" ? t.city : "";
      if (t.kind === "urbano" && !/^R[NP]\d+$/.test(t.route)) t.route = t.city ? "Urbano · " + t.city : "Urbano";
      let la = 0, ln = 0;
      for (const c of t.cells) { const [a, b] = cellCenter(c); la += a; ln += b; }
      t.center = [la / t.cells.length, ln / t.cells.length];
      delete t.streets;
    }
    // Rutas sin geocerca de control: un único tramo por ruta y localidad
    // puede tener decenas de km. Se parte en sectores de ~10 km a lo largo.
    for (const t of [...tramos.values()]) {
      if (t.kind !== "ruta" || t.cells.length <= 12) continue;
      const pts = t.cells.map(c => [c, cellCenter(c)]);
      let mx = 0, my = 0;
      for (const [, p] of pts) { mx += p[1]; my += p[0]; }
      mx /= pts.length; my /= pts.length;
      let sxx = 0, syy = 0, sxy = 0;
      for (const [, p] of pts) { const dx = p[1] - mx, dy = p[0] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      pts.sort((a, b) => ((a[1][1] - mx) * Math.cos(ang) + (a[1][0] - my) * Math.sin(ang)) - ((b[1][1] - mx) * Math.cos(ang) + (b[1][0] - my) * Math.sin(ang)));
      if (pts[0][1][0] > pts[pts.length - 1][1][0]) pts.reverse();
      const n = Math.ceil(pts.length / 10);
      tramos.delete(t.id);
      for (let k = 0; k < n; k++) {
        const part = pts.slice(Math.floor((k * pts.length) / n), Math.floor(((k + 1) * pts.length) / n)).map(x => x[0]);
        const id = t.id + "#" + (k + 1);
        let la = 0, ln = 0;
        for (const c of part) { const [a, b] = cellCenter(c); la += a; ln += b; byCell.set(c, id); }
        tramos.set(id, Object.assign({}, t, { id, cells: part, name: t.name + " · sector " + (k + 1) + " de " + n, center: [la / part.length, ln / part.length] }));
      }
    }
    return { tramos, byCell };
  }

  // ---------- Modelo ----------
  const pct = (hist, p) => {
    const tot = hist.reduce((s, v) => s + v, 0);
    if (!(tot > 0)) return null;
    let acc = 0;
    for (let i = 0; i < hist.length; i++) { acc += hist[i]; if (acc >= tot * p) { const prev = acc - hist[i]; const f = hist[i] ? (tot * p - prev) / hist[i] : 0; return i * 10 + f * 10; } }
    return hist.length * 10;
  };
  const shrink = (obs, exp, K) => (obs + K) / (exp + K);

  // events: infracciones con peso (e.w > 0) ya ubicadas (locs); opts:
  // { hours: [desde, hasta) | null, evScale, allEvents: todas las del período (para la tasa propia de cada conductor) }
  function roadModel(model, days, ids, built, events, locs, opts) {
    const o = Object.assign({ hours: null, evScale: 1, allEvents: events }, opts || {});
    const inSel = h => !o.hours || (h >= o.hours[0] && h < o.hours[1]);
    const T = new Map();
    const get = id => {
      let x = T.get(id);
      if (!x) {
        const z = () => new Array(24).fill(0);
        T.set(id, (x = { id, km: z(), sec: z(), sv: z(), sv2: z(), sg: z(), over: z(), limSec: z(), limSum: z(), exp: z(), obs: z(), condW: z(), condN: z(), drvKm: new Map(), drvCond: new Map(),
          hist: { l: Array.from({ length: 24 }, () => new Array(HBINS).fill(0)), p: Array.from({ length: 24 }, () => new Array(HBINS).fill(0)) }, dark: z(), days: z() }));
      }
      return x;
    };
    // conductor de cada vehículo en cada hora (viaje que la cubre)
    const exclUnknown = !!(model.settings && model.settings.drivers && model.settings.drivers.exclude_unknown);
    const drvCache = new Map();
    const driverAt = (dev, t0) => {
      const k = dev + "|" + t0;
      if (drvCache.has(k)) return drvCache.get(k);
      const ts = model.tripsByDevice.get(dev) || [];
      let best = null, bestOv = 0;
      for (const t of ts) { if (t.e < t0 || t.s > t0 + 3600000) continue; const ov = Math.min(t.e, t0 + 3600000) - Math.max(t.s, t0); if (ov > bestOv) { bestOv = ov; best = t.r || "_unknown"; } }
      drvCache.set(k, best || "_unknown");
      return best || "_unknown";
    };
    // 1) km por conductor (todas las horas y lugares) para su tasa propia
    const drvKmAll = new Map();
    let totKm = 0;
    const dset = new Set(days.keys());
    for (const [dk, v] of days) {
      const S = v.scale || SCALE, d0 = GI.parseDayKey(dk).getTime();
      for (const row of v.rows) {
        const dev = v.devs[row[0]];
        const bucket = dev === "@p" || dev === "@l";
        if (!bucket && !ids.has(dev)) continue;
        const drv = bucket ? dev : driverAt(dev, d0 + row[2] * 3600000);
        if (exclUnknown && drv === "_unknown") continue;
        const km = row[3] * S;
        drvKmAll.set(drv, (drvKmAll.get(drv) || 0) + km);
        totKm += km;
      }
    }
    // tasa de interacción de cada conductor (suavizada hacia la de la flota)
    const envEv = (o.allEvents || []).filter(e => ENV_CATS.has(e.cat) && ids.has(e.d) && dset.has(GI.dayKey(e.t)));
    const envByDrv = new Map();
    for (const e of envEv) { const d = e.drv || "_unknown"; envByDrv.set(d, (envByDrv.get(d) || 0) + 1); }
    const muEnv = totKm > 0 ? envEv.length / totKm : 0;
    const Kd = muEnv > 0 ? 2 / muEnv : 0; // equivale a 2 infracciones "de flota promedio"
    const rateOf = d => (muEnv > 0 ? ((envByDrv.get(d) || 0) + muEnv * Kd) / ((drvKmAll.get(d) || 0) + Kd) : 0);
    // 2) filas → tramo × hora
    for (const [dk, v] of days) {
      const S = v.scale || SCALE, d0 = GI.parseDayKey(dk).getTime();
      for (const row of v.rows) {
        const [di, cell, h, km0, sec0, sv0, sv20, hist, sg, over, limSec, limSum] = row;
        const dev = v.devs[di];
        const bucket = dev === "@p" || dev === "@l";
        if (!bucket && !ids.has(dev)) continue;
        const tid = built.byCell.get(cell);
        if (!tid) continue;
        const drv = bucket ? dev : driverAt(dev, d0 + h * 3600000);
        if (exclUnknown && drv === "_unknown") continue;
        const x = get(tid);
        const km = km0 * S, sec = sec0 * S;
        x.km[h] += km; x.sec[h] += sec; x.sv[h] += sv0 * S; x.sv2[h] += sv20 * S; x.sg[h] += sg * S;
        x.over[h] += over * S; x.limSec[h] += limSec * S; x.limSum[h] += limSum * S;
        const heavy = bucket ? dev === "@p" : isHeavy(model, dev);
        const hh = x.hist[heavy ? "p" : "l"][h];
        for (let i = 0; i < HBINS; i++) hh[i] += (hist[i] || 0) * S;
        x.exp[h] += km * rateOf(drv);
        if (inSel(h)) x.drvKm.set(drv, (x.drvKm.get(drv) || 0) + km);
      }
    }
    // 3) infracciones ubicadas
    let condW = 0, condKm = 0;
    for (const e of events) {
      const p = locs.get(e.i);
      if (!p || !ids.has(e.d) || !dset.has(GI.dayKey(e.t))) continue;
      const tid = built.byCell.get(cellOf(p[0], p[1]));
      if (!tid) continue;
      const x = get(tid), h = new Date(e.t).getHours();
      if (ENV_CATS.has(e.cat)) x.obs[h] += o.evScale;
      else if (e.w > 0) {
        x.condW[h] += e.w * o.evScale; x.condN[h] += o.evScale;
        if (inSel(h)) { const d = e.drv || "_unknown"; const c = x.drvCond.get(d) || { n: 0, w: 0, cats: {} }; c.n += 1; c.w += e.w; c.cats[e.cat] = (c.cats[e.cat] || 0) + 1; x.drvCond.set(d, c); }
      }
    }
    for (const x of T.values()) { for (let h = 0; h < 24; h++) { condW += x.condW[h]; condKm += x.km[h]; } }
    const muCond = condKm > 0 ? condW / condKm : 0;
    // normalización: el promedio de la red = 1
    let sObs = 0, sExp = 0;
    for (const x of T.values()) for (let h = 0; h < 24; h++) { sObs += x.obs[h]; sExp += x.exp[h]; }
    const R = sExp > 0 ? sObs / sExp : 1;
    // 4) luz: fracción de días en que la mitad de la hora es de noche
    const dayList = [...days.keys()];
    const out = [];
    const sumH = (arr, hs) => hs.reduce((s, h) => s + arr[h], 0);
    const hoursOf = range => { const r = []; for (let h = range[0]; h < range[1]; h++) r.push(h); return r; };
    const selHours = o.hours ? hoursOf(o.hours) : hoursOf([0, 24]);
    for (const x of T.values()) {
      const t = built.tramos.get(x.id);
      if (!t) continue;
      const kmAll = sumH(x.km, hoursOf([0, 24]));
      if (!(kmAll > 0)) continue;
      const sun = dayList.map(dk => { const d0 = GI.parseDayKey(dk).getTime(); return [d0, GI.sunTimes ? GI.sunTimes(d0 + 12 * 3600000, t.center[0], t.center[1]) : null]; });
      // velocidad libre: p85 de todas las horas, con el tipo de vehículo que más circula
      const tot = k => x.hist[k].reduce((s, hh) => s + hh.reduce((a, b) => a + b, 0), 0);
      const cls = tot("l") >= tot("p") * 0.4 ? "l" : "p";
      const histSum = hs => { const out2 = new Array(HBINS).fill(0); for (const h of hs) for (let i = 0; i < HBINS; i++) out2[i] += x.hist[cls][h][i]; return out2; };
      const vfree = pct(histSum(hoursOf([0, 24])), 0.85);
      const stat = hs => {
        const km = sumH(x.km, hs), sec = sumH(x.sec, hs);
        const obs = sumH(x.obs, hs), exp = sumH(x.exp, hs) * R;
        const cw = sumH(x.condW, hs), cn = sumH(x.condN, hs), cexp = km * muCond;
        const vmed = pct(histSum(hs), 0.5);
        const speed = sec > 0 ? sumH(x.sv, hs) / sec : null;
        const sd = sec > 0 ? Math.sqrt(Math.max(0, sumH(x.sv2, hs) / sec - speed * speed)) : null;
        const limSec = sumH(x.limSec, hs);
        let dark = 0, dn = 0;
        for (const h of hs) sun.forEach(([d0, st]) => {
          if (!st) return;
          const mid = d0 + h * 3600000 + 1800000;
          dn += x.km[h]; if (mid < st.rise || mid > st.set) dark += x.km[h];
        });
        return {
          km, obs, exp, envIdx: exp + obs > 0 ? shrink(obs, exp, 3) : null, envConf: exp >= 3 ? (exp >= 8 ? "alta" : "media") : "baja", envExcess: obs - exp,
          condN: cn, condW: cw, condExp: cexp, condIdx: cexp > 0 ? (cw + 4) / (cexp + 4) : null, condExcess: cw - cexp,
          vmed, speed, sd, cong: vfree && vmed != null ? Math.max(0, 1 - vmed / vfree) : null,
          sgPer10: km > 0 ? (sumH(x.sg, hs) / km) * 10 : null,
          overPct: limSec > 0 ? sumH(x.over, hs) / limSec : null,
          limitPosted: limSec > 0 ? Math.round(sumH(x.limSum, hs) / limSec / 10) * 10 : null,
          darkPct: dn > 0 ? dark / dn : null,
        };
      };
      const sel = stat(selHours);
      const limit = t.limit || sel.limitPosted || stat(hoursOf([0, 24])).limitPosted;
      const franjas = FRANJAS.map(f => Object.assign({ key: f.key, label: f.label }, stat(hoursOf(f.h))));
      const drivers = [...x.drvCond.entries()].map(([id, c]) => ({ id, n: c.n, w: c.w, km: x.drvKm.get(id) || 0, cats: c.cats })).sort((a, b) => b.w - a.w);
      out.push(Object.assign({}, t, sel, {
        limit, vfree, cls, kmDay: sel.km / dayList.length, kmAll, franjas, drivers,
        byHour: Array.from({ length: 24 }, (_, h) => ({ h, km: x.km[h] / dayList.length, vmed: pct(histSum([h]), 0.5), env: x.exp[h] * R + x.obs[h] > 0 ? shrink(x.obs[h], x.exp[h] * R, 3) : null, expEnv: x.exp[h] * R })),
      }));
    }
    // niveles
    for (const x of out) {
      x.envLevel = x.envConf === "baja" ? "nd" : x.envIdx >= 1.5 ? "cr" : x.envIdx >= 1.2 ? "at" : "ok";
      const over = x.overPct != null ? x.overPct : 0;
      const condOk = x.condExp >= 1.5 || x.condN >= 3;
      x.condLevel = !condOk && x.overPct == null ? "nd" : (condOk && x.condIdx >= 1.6) || over >= 0.25 ? "cr" : (condOk && x.condIdx >= 1.25) || over >= 0.12 ? "at" : "ok";
      for (const f of x.franjas) f.envLevel = f.envConf === "baja" ? "nd" : f.envIdx >= 1.5 ? "cr" : f.envIdx >= 1.2 ? "at" : "ok";
    }
    // rutas: tramos ordenados a lo largo (proyección sobre el eje principal)
    const routes = new Map();
    for (const x of out) { if (!x.route) continue; if (!routes.has(x.route)) routes.set(x.route, []); routes.get(x.route).push(x); }
    const routeList = [];
    for (const [name, list] of routes) {
      const km = list.reduce((s, x) => s + x.kmAll, 0);
      let mx = 0, my = 0;
      for (const x of list) { mx += x.center[1]; my += x.center[0]; }
      mx /= list.length; my /= list.length;
      let sxx = 0, syy = 0, sxy = 0;
      for (const x of list) { const dx = x.center[1] - mx, dy = x.center[0] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      const proj = x => (x.center[1] - mx) * Math.cos(ang) + (x.center[0] - my) * Math.sin(ang);
      list.sort((a, b) => proj(a) - proj(b));
      // sentido: que empiece por el extremo más al sur-este (Neuquén capital en la cuenca)
      if (list.length > 1 && list[0].center[0] > list[list.length - 1].center[0]) list.reverse();
      const fr = FRANJAS.map((f, i) => {
        let obs = 0, exp = 0, kmF = 0;
        for (const x of list) { obs += x.franjas[i].obs; exp += x.franjas[i].exp; kmF += x.franjas[i].km; }
        return { key: f.key, label: f.label, km: kmF, idx: exp >= 3 ? shrink(obs, exp, 3) : null };
      });
      const withData = fr.filter(f => f.idx != null && f.km > 0);
      const best = withData.length ? withData.reduce((a, b) => (b.idx < a.idx ? b : a)) : null;
      const worst = withData.length ? withData.reduce((a, b) => (b.idx > a.idx ? b : a)) : null;
      routeList.push({ name, tramos: list, km, kmDay: km / dayList.length, franjas: fr, best, worst });
    }
    routeList.sort((a, b) => b.km - a.km);
    const sumKm = out.reduce((s, x) => s + x.km, 0);
    return { tramos: out, routes: routeList, R, muEnv, muCond, nDays: dayList.length, totKm: sumKm, envEvents: envEv.length, posted: [...days.values()].some(v => v.posted) };
  }

  Object.assign(GI, {
    ROAD_FRANJAS: FRANJAS, ROAD_ENV_CATS: ENV_CATS, roadPlan, loadRoadDays, loadCellAddresses, loadZoneNames, buildTramos, roadModel,
    _road: { dayWindows, aggregateWindow, cellOf, cellBounds, cellCenter, haversineKm, normRoad, isControlName, pct, loadPostedSpeeds, SCALE, HBINS },
  });
})(window.GI);
