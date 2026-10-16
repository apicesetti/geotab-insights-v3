// Capa de datos: lectura de MyGeotab con caché por día en IndexedDB.
//
// Idea central para que cargue rápido: los datos de un día que ya terminó
// (viajes, excepciones, lecturas de combustible) prácticamente no cambian.
// Se guardan YA COMPACTADOS por día; al volver a abrir el add-in solo se
// piden a la API los días que faltan y los últimos 2 días (que todavía
// pueden recibir datos atrasados). Cambiar la granularidad, los filtros o
// los perfiles no vuelve a consultar la API: se recalcula en memoria.
//
// Paginación: se piden rangos de fechas acotados; si una respuesta llega al
// resultsLimit se parte el rango a la mitad y se vuelve a pedir (no depende
// de sortBy, que no es uniforme entre tipos de entidad).
(function (GI) {
  "use strict";

  const DB_NAME = "gi3_cache";
  const DB_VERSION = 1;
  const LIMIT = 50000;
  const RECENT_TTL_MS = 15 * 60 * 1000;
  const SETTLE_MS = 48 * 3600 * 1000;      // un día se considera "cerrado" 48 h después de terminar
  const CATALOG_TTL_MS = 6 * 3600 * 1000;
  const MAX_RUN_DAYS = 7;
  const CONCURRENCY = 3;

  const FUEL_DIAG = "DiagnosticDeviceTotalFuelId";
  const IDLE_FUEL_DIAG = "DiagnosticDeviceTotalIdleFuelId";

  let dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of ["days", "locs", "meta"]) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: "k" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null); // sin IndexedDB (modo privado): seguimos sin caché
    });
    return dbPromise;
  }

  async function idbGetMany(store, keys) {
    const db = await openDb();
    if (!db || !keys.length) return new Map();
    return new Promise(resolve => {
      const out = new Map();
      const tx = db.transaction(store, "readonly");
      const os = tx.objectStore(store);
      for (const k of keys) {
        const r = os.get(k);
        r.onsuccess = () => { if (r.result) out.set(k, r.result); };
      }
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => resolve(out);
    });
  }

  async function idbPutMany(store, items) {
    const db = await openDb();
    if (!db || !items.length) return;
    return new Promise(resolve => {
      const tx = db.transaction(store, "readwrite");
      const os = tx.objectStore(store);
      for (const it of items) os.put(it);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  async function clearCache() {
    const db = await openDb();
    if (!db) return;
    await new Promise(resolve => {
      const tx = db.transaction(["days", "meta"], "readwrite");
      tx.objectStore("days").clear();
      tx.objectStore("meta").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  // ---------- Catálogos (Device, Group, Rule, User) ----------
  // Se piden solo los campos necesarios (propertySelector) y se guarda en
  // caché la versión compacta: en bases grandes (miles de usuarios) el objeto
  // completo pesa decenas de MB.
  async function cachedCatalog(api, database, typeName, params, fields, compact, force) {
    const k = database + "|cat2|" + typeName;
    if (!force) {
      const hit = (await idbGetMany("meta", [k])).get(k);
      if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.v;
    }
    const base = { typeName, ...(params || {}) };
    let raw;
    try {
      raw = await api.call("Get", fields ? { ...base, propertySelector: { fields, isIncluded: true } } : base);
    } catch (e) {
      if (!fields) throw e;
      raw = await api.call("Get", base);
    }
    const v = (raw || []).map(compact);
    await idbPutMany("meta", [{ k, v, at: Date.now() }]);
    return v;
  }

  async function loadCatalogs(api, database, force) {
    const [groups, devices, rules, drivers] = await Promise.all([
      cachedCatalog(api, database, "Group", null, ["id", "name", "children"],
        g => ({ id: g.id, name: g.name || g.id, children: (g.children || []).map(GI.idOf) }), force),
      cachedCatalog(api, database, "Device", null, ["id", "name", "serialNumber", "groups"],
        d => ({ id: d.id, name: d.name || d.id, serial: d.serialNumber || "", groups: (d.groups || []).map(GI.idOf) }), force),
      cachedCatalog(api, database, "Rule", null, ["id", "name", "baseType"],
        r => ({ id: r.id, name: r.name || r.id, baseType: r.baseType }), force),
      cachedCatalog(api, database, "User", { search: { isDriver: true } }, ["id", "name", "firstName", "lastName"],
        u => ({ id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.name || u.id, login: u.name || "" }), force).catch(() => []),
    ]);
    return { groups, devices, rules, drivers, zones: null };
  }

  // ---------- Zonas (para recorridos) ----------
  // Hay bases con decenas de miles de zonas: se piden solo las del área donde
  // anduvieron los vehículos (searchArea) y después de mostrar el tablero.
  function zoneBbox(points) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of points) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    return [x0, y0, x1, y1];
  }

  async function loadZones(api, database, area) {
    const r = v => Math.round(v * 2) / 2;
    const box = area ? { left: r(area[0]) - 0.5, bottom: r(area[1]) - 0.5, right: r(area[2]) + 0.5, top: r(area[3]) + 0.5 } : null;
    const k = database + "|zones|" + (box ? [box.left, box.bottom, box.right, box.top].join(",") : "all");
    const hit = (await idbGetMany("meta", [k])).get(k);
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.v;
    const fields = { propertySelector: { fields: ["id", "name", "points"], isIncluded: true } };
    const search = box ? { search: { searchArea: box } } : {};
    let raw;
    try { raw = await api.call("Get", { typeName: "Zone", resultsLimit: 50000, ...search, ...fields }); }
    catch (e) { raw = await api.call("Get", { typeName: "Zone", resultsLimit: 50000, ...search }); }
    const v = (raw || []).filter(z => (z.points || []).length >= 3).map(z => {
      const pts = z.points.map(p => [p.x, p.y]);
      return { id: z.id, name: z.name || z.id, pts, bbox: zoneBbox(pts) };
    });
    await idbPutMany("meta", [{ k, v, at: Date.now() }]);
    return v;
  }

  // ---------- Fetch por rango con partición automática ----------
  // calls: [{key, typeName, search}] -- se resuelven en un multiCall; los que
  // llegan al límite se parten a la mitad y se repiten.
  async function getRangeMulti(api, calls, from, to, onProgress) {
    const out = new Map(calls.map(c => [c.key, []]));
    let pending = calls.map(c => ({ ...c, from, to }));
    while (pending.length) {
      const batch = pending.splice(0, 20);
      const build = withSel => batch.map(c => ["Get", {
        typeName: c.typeName,
        resultsLimit: LIMIT,
        search: { ...c.search, fromDate: c.from.toISOString(), toDate: c.to.toISOString() },
        ...(withSel && c.fields ? { propertySelector: { fields: c.fields, isIncluded: true } } : {}),
      }]);
      let res;
      try {
        res = await api.multiCall(build(true));
      } catch (e) {
        // Si la base no acepta propertySelector para algún tipo, se repite sin él.
        if (!batch.some(c => c.fields)) throw e;
        res = await api.multiCall(build(false));
      }
      batch.forEach((c, i) => {
        const page = res[i] || [];
        if (page.length >= LIMIT && c.to - c.from > 60000) {
          const mid = new Date(c.from.getTime() + Math.floor((c.to - c.from) / 2));
          pending.push({ ...c, to: mid }, { ...c, from: mid });
        } else {
          const arr = out.get(c.key);
          for (const r of page) arr.push(r);
        }
      });
      if (onProgress) onProgress();
    }
    return out;
  }

  function dayIsSettled(dk, at) {
    const end = GI.addDays(GI.parseDayKey(dk), 1).getTime();
    return at - end > SETTLE_MS;
  }

  function cacheValid(entry, dk) {
    if (!entry) return false;
    return dayIsSettled(dk, entry.at) || Date.now() - entry.at < RECENT_TTL_MS;
  }

  // Agrupa días faltantes en tramos contiguos de hasta MAX_RUN_DAYS.
  function missingRuns(dayKeys, validSet) {
    const runs = [];
    let cur = null;
    for (const dk of dayKeys) {
      if (validSet.has(dk)) { cur = null; continue; }
      if (cur && cur.length < MAX_RUN_DAYS) cur.push(dk);
      else { cur = [dk]; runs.push(cur); }
    }
    return runs;
  }

  // Genérico: datasets = [{scope, typeName, search, dateOf(rec)->Date, compact(recs)->value}]
  // Devuelve { [scope]: Map(dayKey -> compact value) }.
  async function fetchDaily(api, database, datasets, dayKeys, progress) {
    const keyOf = (scope, dk) => database + "|" + scope + "|" + dk;
    const allKeys = [];
    for (const ds of datasets) for (const dk of dayKeys) allKeys.push(keyOf(ds.scope, dk));
    const cached = await idbGetMany("days", allKeys);

    const result = {};
    // runKey -> {days, datasets[]}: agrupa por tramo para pedir varias reglas en un mismo multiCall
    const runsByKey = new Map();
    for (const ds of datasets) {
      const m = new Map();
      const valid = new Set();
      for (const dk of dayKeys) {
        const entry = cached.get(keyOf(ds.scope, dk));
        if (cacheValid(entry, dk)) { m.set(dk, entry.v); valid.add(dk); }
      }
      result[ds.scope] = m;
      for (const run of missingRuns(dayKeys, valid)) {
        const rk = run[0] + "|" + run[run.length - 1];
        if (!runsByKey.has(rk)) runsByKey.set(rk, { days: run, datasets: [] });
        runsByKey.get(rk).datasets.push(ds);
      }
    }

    const runs = [...runsByKey.values()];
    const totalSteps = runs.reduce((s, r) => s + r.datasets.length, 0);
    let done = 0;
    if (progress) progress(0, totalSteps);

    await GI.pool(runs, CONCURRENCY, async run => {
      const from = GI.parseDayKey(run.days[0]);
      const to = GI.addDays(GI.parseDayKey(run.days[run.days.length - 1]), 1);
      const calls = run.datasets.map(ds => ({ key: ds.scope, typeName: ds.typeName, search: ds.search, fields: ds.fields }));
      const fetched = await getRangeMulti(api, calls, from, to);
      const toStore = [];
      const at = Date.now();
      for (const ds of run.datasets) {
        const byDay = new Map(run.days.map(dk => [dk, []]));
        const seen = new Set();
        for (const rec of fetched.get(ds.scope) || []) {
          if (rec.id && seen.has(rec.id)) continue;
          if (rec.id) seen.add(rec.id);
          const d = ds.dateOf(rec);
          if (!d) continue;
          const bucket = byDay.get(GI.dayKey(d));
          if (bucket) bucket.push(rec);
        }
        for (const [dk, recs] of byDay) {
          const v = ds.compact(recs);
          result[ds.scope].set(dk, v);
          toStore.push({ k: keyOf(ds.scope, dk), v, at });
        }
        done++;
        if (progress) progress(done, totalSteps);
      }
      await idbPutMany("days", toStore);
    });
    return result;
  }

  // ---------- Compactadores ----------
  function compactTrips(recs) {
    return recs.map(t => {
      const drv = GI.idOf(t.driver);
      return {
        i: t.id,
        d: GI.idOf(t.device),
        r: drv && drv !== "UnknownDriverId" && drv !== "NoDriverId" ? drv : null,
        s: new Date(t.start).getTime(),
        e: new Date(t.stop).getTime(),
        km: GI.round(t.distance || 0, 3),
        dh: GI.round(GI.durationToHours(t.drivingDuration), 4),
        ih: GI.round(GI.durationToHours(t.idlingDuration), 4),
        x: t.stopPoint ? GI.round(t.stopPoint.x, 5) : null,
        y: t.stopPoint ? GI.round(t.stopPoint.y, 5) : null,
      };
    });
  }

  function compactExceptions(recs) {
    const out = [];
    for (const ev of recs) {
      if (/Invalid/i.test(ev.state || "")) continue;
      const drv = GI.idOf(ev.driver);
      out.push({
        i: ev.id,
        d: GI.idOf(ev.device),
        r: drv && drv !== "UnknownDriverId" && drv !== "NoDriverId" ? drv : null,
        t: new Date(ev.activeFrom).getTime(),
        h: GI.round(GI.durationToHours(ev.duration), 4),
      });
    }
    return out;
  }

  // Lecturas de un contador acumulado -> por vehículo: primera y última del día.
  function compactCounter(recs) {
    const byDev = {};
    for (const r of recs) {
      const d = GI.idOf(r.device);
      const v = Number(r.data);
      if (!d || Number.isNaN(v)) continue;
      const t = new Date(r.dateTime).getTime();
      const cur = byDev[d];
      if (!cur) byDev[d] = { ft: t, fv: v, lt: t, lv: v };
      else {
        if (t < cur.ft) { cur.ft = t; cur.fv = v; }
        if (t > cur.lt) { cur.lt = t; cur.lv = v; }
      }
    }
    return byDev;
  }

  // ---------- Carga principal ----------
  // ruleIds: reglas mapeadas. Devuelve datos crudos compactados por día.
  // scopeGroupIds: si viene, la API filtra por esos grupos (deviceSearch) y
  // la caché se guarda aparte para ese alcance. Clave en flotas grandes.
  // opts.withFuel = false: no espera el combustible (se carga aparte con
  // loadFuel), así el tablero aparece con viajes e infracciones primero.
  async function loadPeriod(api, database, fromKey, toKey, ruleIds, onProgress, scopeGroupIds, opts) {
    const withFuel = !opts || opts.withFuel !== false;
    const dayKeys = GI.dayRange(fromKey, toKey);
    const scopeIds = (scopeGroupIds || []).filter(Boolean).slice().sort();
    const scopeKey = scopeIds.length ? "|g:" + scopeIds.join(",") : "";
    const devSearch = scopeIds.length ? { deviceSearch: { groups: scopeIds.map(id => ({ id })) } } : {};
    // Combustible: 3 días extra hacia atrás para tener el valor del contador
    // al arrancar el período.
    const fuelDays = GI.dayRange(GI.dayKey(GI.addDays(GI.parseDayKey(fromKey), -3)), toKey);

    // Trip con propertySelector: solo los campos que se usan (~5 veces menos datos).
    const tripsDs = [{ scope: "trip" + scopeKey, typeName: "Trip", search: { ...devSearch },
      fields: ["id", "device", "driver", "start", "stop", "distance", "drivingDuration", "idlingDuration", "stopPoint"],
      dateOf: r => new Date(r.start), compact: compactTrips }];
    const excDs = ruleIds.map(rid => ({
      scope: "exc:" + rid + scopeKey, typeName: "ExceptionEvent", search: { ruleSearch: { id: rid }, ...devSearch },
      dateOf: r => new Date(r.activeFrom), compact: compactExceptions,
    }));
    const fuelDs = [FUEL_DIAG, IDLE_FUEL_DIAG].map(diag => ({
      scope: "sd:" + diag + scopeKey, typeName: "StatusData", search: { diagnosticSearch: { id: diag }, ...devSearch },
      dateOf: r => new Date(r.dateTime), compact: compactCounter,
    }));

    const steps = { trip: [0, 1], exc: [0, excDs.length ? 1 : 0], fuel: [0, withFuel ? 1 : 0] };
    const report = () => {
      if (!onProgress) return;
      const done = steps.trip[0] + steps.exc[0] + steps.fuel[0];
      const total = steps.trip[1] + steps.exc[1] + steps.fuel[1];
      onProgress(total ? done / total : 1, steps);
    };
    const prog = name => (d, t) => { steps[name] = [d, t || 0]; report(); };

    const [trips, exc, fuel] = await Promise.all([
      fetchDaily(api, database, tripsDs, dayKeys, prog("trip")),
      excDs.length ? fetchDaily(api, database, excDs, dayKeys, prog("exc")) : Promise.resolve({}),
      withFuel ? fetchDaily(api, database, fuelDs, fuelDays, prog("fuel")).catch(() => ({})) : Promise.resolve({}),
    ]);

    const exceptions = [];
    for (const rid of ruleIds) {
      const m = exc["exc:" + rid + scopeKey];
      if (!m) continue;
      for (const arr of m.values()) for (const ev of arr) exceptions.push({ ...ev, rule: rid });
    }
    const tripList = [];
    for (const arr of trips["trip" + scopeKey].values()) for (const t of arr) tripList.push(t);

    return {
      fromKey, toKey, dayKeys,
      trips: tripList,
      exceptions,
      fuelDaily: fuel["sd:" + FUEL_DIAG + scopeKey] || new Map(),
      idleFuelDaily: fuel["sd:" + IDLE_FUEL_DIAG + scopeKey] || new Map(),
      scopeGroupIds: scopeIds,
      fuelDays,
      fuelPending: !withFuel,
    };
  }

  async function loadFuel(api, database, fromKey, toKey, scopeGroupIds, onProgress) {
    const scopeIds = (scopeGroupIds || []).filter(Boolean).slice().sort();
    const scopeKey = scopeIds.length ? "|g:" + scopeIds.join(",") : "";
    const devSearch = scopeIds.length ? { deviceSearch: { groups: scopeIds.map(id => ({ id })) } } : {};
    const fuelDays = GI.dayRange(GI.dayKey(GI.addDays(GI.parseDayKey(fromKey), -3)), toKey);
    const fuelDs = [FUEL_DIAG, IDLE_FUEL_DIAG].map(diag => ({
      scope: "sd:" + diag + scopeKey, typeName: "StatusData", search: { diagnosticSearch: { id: diag }, ...devSearch },
      dateOf: r => new Date(r.dateTime), compact: compactCounter,
    }));
    const fuel = await fetchDaily(api, database, fuelDs, fuelDays, (d, t) => onProgress && onProgress(t ? d / t : 1)).catch(() => ({}));
    return {
      fuelDaily: fuel["sd:" + FUEL_DIAG + scopeKey] || new Map(),
      idleFuelDaily: fuel["sd:" + IDLE_FUEL_DIAG + scopeKey] || new Map(),
      fuelDays,
    };
  }

  // Ubicación de eventos (para el mapa de calor): el LogRecord más cercano a
  // activeFrom. Se pide solo al abrir el mapa y se cachea por id de evento.
  async function loadEventLocations(api, events, onProgress) {
    const keys = events.map(e => "loc|" + e.i);
    const cached = await idbGetMany("locs", keys);
    const out = new Map();
    const missing = [];
    for (const ev of events) {
      const hit = cached.get("loc|" + ev.i);
      if (hit) { if (hit.x != null) out.set(ev.i, [hit.y, hit.x]); }
      else missing.push(ev);
    }
    const batches = [];
    // Lotes de 100 consultas por multiCall, 4 en paralelo, ventana de ±45 s.
    for (let i = 0; i < missing.length; i += 100) batches.push(missing.slice(i, i + 100));
    let done = 0;
    if (onProgress) onProgress(missing.length ? 0 : 1, out);
    await GI.pool(batches, 4, async batch => {
      const res = await api.multiCall(batch.map(ev => ["Get", {
        typeName: "LogRecord", resultsLimit: 4,
        search: { deviceSearch: { id: ev.d }, fromDate: new Date(ev.t - 45000).toISOString(), toDate: new Date(ev.t + 45000).toISOString() },
      }]));
      const store = [];
      batch.forEach((ev, i) => {
        const recs = (res[i] || []).filter(r => r.latitude || r.longitude);
        let best = null;
        for (const r of recs) {
          const dt = Math.abs(new Date(r.dateTime).getTime() - ev.t);
          if (!best || dt < best.dt) best = { dt, x: r.longitude, y: r.latitude };
        }
        if (best) out.set(ev.i, [best.y, best.x]);
        store.push({ k: "loc|" + ev.i, x: best ? best.x : null, y: best ? best.y : null });
      });
      await idbPutMany("locs", store);
      done += batch.length;
      // Se informa el avance con lo ya ubicado, así el mapa se va dibujando.
      if (onProgress) onProgress(done / missing.length, out);
    });
    return out;
  }

  Object.assign(GI, {
    loadCatalogs, loadZones, loadPeriod, loadFuel, loadEventLocations, clearCache,
    _compactTrips: compactTrips, _compactExceptions: compactExceptions, _compactCounter: compactCounter, _missingRuns: missingRuns,
  });
})(window.GI);
