// Modelo analítico: funciones puras (sin API) que transforman los datos
// crudos compactados en todo lo que muestra la UI.
//
// Estructura base: "deviceDay" = por vehículo y por día local, km / horas de
// manejo / horas de ralentí / litros / eventos por categoría. Cualquier
// vista (tendencia por día-semana-mes, perfil, grupo, ventana antes/después
// de un hito) es una agregación de ese mismo cubo, así que cambiar filtros
// no requiere volver a pedir nada a MyGeotab.
(function (GI) {
  "use strict";

  const MAX_DAILY_LITERS = 1500; // delta diario mayor = reset de contador / dato inválido

  // ---------- Grupos ----------
  function makeGroupResolver(groups) {
    const byId = new Map(groups.map(g => [g.id, g]));
    const memo = new Map();
    function descendants(id) {
      if (memo.has(id)) return memo.get(id);
      const out = new Set([id]);
      const q = [id];
      while (q.length) {
        const g = byId.get(q.shift());
        if (!g) continue;
        for (const c of g.children || []) if (c && !out.has(c)) { out.add(c); q.push(c); }
      }
      memo.set(id, out);
      return out;
    }
    function expand(ids) {
      const out = new Set();
      for (const id of ids || []) for (const d of descendants(id)) out.add(d);
      return out;
    }
    return { byId, descendants, expand };
  }

  function deviceInGroups(device, groupSet) {
    return device.groups.some(g => groupSet.has(g));
  }

  // ---------- Zonas ----------
  function pointInPolygon(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function makeZoneLocator(zones) {
    const cache = new Map();
    return function zoneAt(x, y) {
      if (x == null || y == null) return null;
      const k = x.toFixed(4) + "," + y.toFixed(4);
      if (cache.has(k)) return cache.get(k);
      let found = null, foundArea = Infinity;
      for (const z of zones) {
        const b = z.bbox;
        if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
        if (pointInPolygon(x, y, z.pts)) {
          const area = (b[2] - b[0]) * (b[3] - b[1]);
          if (area < foundArea) { found = z; foundArea = area; } // la zona más chica (más específica)
        }
      }
      cache.set(k, found);
      return found;
    };
  }

  // ---------- Recorridos (journeys) ----------
  // Un recorrido arranca al salir de una zona y termina al llegar a una zona
  // (cualquiera) o tras una parada más larga que break_hours. Viajes que
  // terminan fuera de zona (paradas en ruta) se encadenan al mismo recorrido.
  function buildJourneys(tripsByDevice, zoneAt, breakHours) {
    const breakMs = breakHours * 3600000;
    const journeys = [];
    for (const [deviceId, trips] of tripsByDevice) {
      let prevStop = null;
      let cur = null;
      for (let i = 0; i < trips.length; i++) {
        const t = trips[i];
        if (!cur) {
          const oz = prevStop ? zoneAt(prevStop[0], prevStop[1]) : null;
          cur = {
            d: deviceId, s: t.s, e: t.e, km: 0, dh: 0, ih: 0, n: 0,
            o: prevStop ? (oz ? oz.id : "_none") : "_unknown",
            oName: prevStop ? (oz ? oz.name : "Sin zona") : "Desconocido",
          };
        }
        cur.e = t.e; cur.km += t.km; cur.dh += t.dh; cur.ih += t.ih; cur.n++;
        const dz = zoneAt(t.x, t.y);
        const next = trips[i + 1];
        const longStop = !next || next.s - t.e > breakMs;
        if (dz || longStop) {
          cur.dest = dz ? dz.id : "_none";
          cur.destName = dz ? dz.name : "Sin zona";
          cur.open = !dz && !next;
          cur.internal = !!dz && dz.id === cur.o;
          journeys.push(cur);
          cur = null;
        }
        prevStop = t.x != null ? [t.x, t.y] : prevStop;
      }
    }
    return journeys;
  }

  // Búsqueda binaria del elemento (ordenado por s) que contiene t.
  function findContaining(sorted, t) {
    let lo = 0, hi = sorted.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].s <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (ans < 0) return null;
    const it = sorted[ans];
    return t <= it.e + 60000 ? it : null; // 1 min de tolerancia
  }

  // ---------- Combustible: deltas diarios de un contador acumulado ----------
  // dailyMap: Map(dayKey -> {device: {ft,fv,lt,lv}}). Devuelve
  // Map(device -> Map(dayKey -> litros)) solo para vehículos con medición real.
  function counterDeltas(dailyMap, allDays, keepDays) {
    const keep = new Set(keepDays);
    const last = {};
    const nonZero = {};
    const out = new Map();
    for (const dk of allDays) {
      const day = dailyMap.get(dk);
      if (!day) continue;
      for (const [dev, c] of Object.entries(day)) {
        if (c.lv > 0) nonZero[dev] = true;
        const start = last[dev] != null ? last[dev] : c.fv;
        const delta = c.lv - start;
        last[dev] = c.lv;
        if (!keep.has(dk) || delta < 0 || delta > MAX_DAILY_LITERS) continue;
        if (!out.has(dev)) out.set(dev, new Map());
        out.get(dev).set(dk, delta);
      }
    }
    for (const dev of [...out.keys()]) if (!nonZero[dev]) out.delete(dev);
    return out;
  }

  // ---------- Construcción del modelo ----------
  function emptyCell() {
    return { km: 0, dh: 0, ih: 0, fuel: 0, kmFuel: 0, idleL: 0, idleMeasured: 0, ev: {}, w: 0, n: 0 };
  }

  function addCell(a, b) {
    a.km += b.km; a.dh += b.dh; a.ih += b.ih; a.fuel += b.fuel; a.kmFuel += b.kmFuel;
    a.idleL += b.idleL; a.idleMeasured += b.idleMeasured; a.w += b.w; a.n += b.n;
    for (const k in b.ev) a.ev[k] = (a.ev[k] || 0) + b.ev[k];
    return a;
  }

  // KPIs derivados de una celda agregada.
  function kpis(c) {
    const totalH = c.dh + c.ih;
    return {
      km: c.km,
      drivingH: c.dh,
      idleH: c.ih,
      idlePct: totalH > 0 ? (c.ih / totalH) * 100 : null,
      fuelL: c.fuel,
      l100: c.kmFuel > 20 ? (c.fuel / c.kmFuel) * 100 : null,
      idleL: c.idleL,
      events: c.n,
      weighted: c.w,
      risk: c.km > 0 ? (c.w / c.km) * 100 : null,
      evByCat: c.ev,
    };
  }

  // raw: salida de loadPeriod; cat: catálogos; settings: config compartida.
  function buildModel(raw, cat, settings) {
    const gr = makeGroupResolver(cat.groups);
    const excluded = gr.expand(settings.excluded_group_ids);
    const scope = settings.scope_group_ids && settings.scope_group_ids.length ? gr.expand(settings.scope_group_ids) : null;

    const devices = cat.devices.filter(d =>
      !["", "000-000-0000"].includes(d.serial.trim())
      && !deviceInGroups(d, excluded)
      && (!scope || deviceInGroups(d, scope)));
    const devById = new Map(devices.map(d => [d.id, d]));
    const driverName = new Map(cat.drivers.map(u => [u.id, u.name]));
    const zoneAt = makeZoneLocator(cat.zones);

    // Tipo de vehículo
    const vtypes = settings.vehicle_types.map(vt => ({ ...vt, set: gr.expand(vt.groupIds) }));
    const vtypeOf = new Map();
    for (const d of devices) {
      const vt = vtypes.find(t => t.set.size && deviceInGroups(d, t.set));
      vtypeOf.set(d.id, vt ? vt.key : "sin_tipo");
    }

    // Viajes por vehículo
    const tripsByDevice = new Map();
    for (const t of raw.trips) {
      if (!devById.has(t.d)) continue;
      if (!tripsByDevice.has(t.d)) tripsByDevice.set(t.d, []);
      tripsByDevice.get(t.d).push(t);
    }
    for (const arr of tripsByDevice.values()) arr.sort((a, b) => a.s - b.s);

    const journeys = buildJourneys(tripsByDevice, zoneAt, settings.journeys.break_hours);
    const journeysByDevice = GI.groupBy(journeys, j => j.d);

    // Tipo de servicio: grupo > automático por km mediano de recorrido
    const svcSets = {
      corta: gr.expand((settings.service.group_ids || {}).corta),
      larga: gr.expand((settings.service.group_ids || {}).larga),
    };
    const serviceOf = new Map();
    const serviceSource = new Map();
    for (const d of devices) {
      if (svcSets.larga.size && deviceInGroups(d, svcSets.larga)) { serviceOf.set(d.id, "larga"); serviceSource.set(d.id, "grupo"); continue; }
      if (svcSets.corta.size && deviceInGroups(d, svcSets.corta)) { serviceOf.set(d.id, "corta"); serviceSource.set(d.id, "grupo"); continue; }
      if (!settings.service.auto) { serviceOf.set(d.id, "corta"); serviceSource.set(d.id, "por defecto"); continue; }
      const js = (journeysByDevice.get(d.id) || []).filter(j => !j.internal && j.km > 1);
      const med = GI.median(js.map(j => j.km));
      if (med == null) { serviceOf.set(d.id, "corta"); serviceSource.set(d.id, "sin datos"); continue; }
      serviceOf.set(d.id, med >= settings.service.threshold_km ? "larga" : "corta");
      serviceSource.set(d.id, "auto (" + GI.round(med, 0) + " km/recorrido)");
    }
    const profileOf = id => GI.profileKey(vtypeOf.get(id), serviceOf.get(id));

    // Cubo vehículo × día
    const dayKeys = raw.dayKeys;
    const daySet = new Set(dayKeys);
    const dd = new Map(); // device -> Map(day -> cell)
    const cell = (dev, dk) => {
      if (!dd.has(dev)) dd.set(dev, new Map());
      const m = dd.get(dev);
      if (!m.has(dk)) m.set(dk, emptyCell());
      return m.get(dk);
    };

    // Conductor × vehículo × día (para repartir combustible por km)
    const drvCells = new Map(); // driverId|null -> Map(dev|day -> cell)
    const drvCell = (drv, dev, dk) => {
      const k = drv || "_unknown";
      if (!drvCells.has(k)) drvCells.set(k, new Map());
      const m = drvCells.get(k);
      const ck = dev + "|" + dk;
      if (!m.has(ck)) m.set(ck, emptyCell());
      return m.get(ck);
    };

    for (const [dev, trips] of tripsByDevice) {
      for (const t of trips) {
        const dk = GI.dayKey(t.s);
        if (!daySet.has(dk)) continue;
        const c = cell(dev, dk);
        c.km += t.km; c.dh += t.dh; c.ih += t.ih;
        const dc = drvCell(t.r, dev, dk);
        dc.km += t.km; dc.dh += t.dh; dc.ih += t.ih;
      }
    }

    // Combustible
    const fuelDeltas = counterDeltas(raw.fuelDaily, raw.fuelDays, dayKeys);
    const idleDeltas = counterDeltas(raw.idleFuelDaily, raw.fuelDays, dayKeys);
    const idleRate = new Map(settings.vehicle_types.map(v => [v.key, v.idle_lph || 1.5]));
    // Días con consumo pero sin viajes (motor encendido parado) también cuentan.
    for (const deltas of [fuelDeltas, idleDeltas]) {
      for (const [dev, m] of deltas) if (devById.has(dev)) for (const dk of m.keys()) cell(dev, dk);
    }
    for (const [dev, m] of dd) {
      const fd = fuelDeltas.get(dev);
      const idd = idleDeltas.get(dev);
      for (const [dk, c] of m) {
        if (fd && fd.has(dk)) { c.fuel = fd.get(dk); c.kmFuel = c.km; }
        if (idd && idd.has(dk)) { c.idleL = idd.get(dk); c.idleMeasured = c.idleL; }
        else c.idleL = c.ih * (idleRate.get(vtypeOf.get(dev)) || 1.5);
      }
    }

    // Eventos
    const mapping = settings.rule_mapping;
    const weights = settings.category_weights;
    const riskCats = new Set(GI.CATEGORIES.filter(c => c.kind === "riesgo").map(c => c.key));
    const events = [];
    for (const ev of raw.exceptions) {
      if (!devById.has(ev.d)) continue;
      const catKey = mapping[ev.rule];
      if (!catKey) continue;
      const dk = GI.dayKey(ev.t);
      if (!daySet.has(dk)) continue;
      let drv = ev.r;
      if (!drv) {
        const trip = findContaining(tripsByDevice.get(ev.d) || [], ev.t);
        if (trip) drv = trip.r;
      }
      const j = findContaining(journeysByDevice.get(ev.d) || [], ev.t);
      const w = riskCats.has(catKey) ? (weights[catKey] != null ? weights[catKey] : 1) : 0;
      const e = { ...ev, cat: catKey, dk, drv: drv || null, j, w };
      events.push(e);
      const c = cell(ev.d, dk);
      c.ev[catKey] = (c.ev[catKey] || 0) + 1;
      if (w > 0) { c.w += w; c.n += 1; }
      const dc = drvCell(drv, ev.d, dk);
      dc.ev[catKey] = (dc.ev[catKey] || 0) + 1;
      if (w > 0) { dc.w += w; dc.n += 1; }
      if (j) { j.w = (j.w || 0) + w; j.nEv = (j.nEv || 0) + (w > 0 ? 1 : 0); }
    }

    // Combustible por conductor: se reparte el del vehículo-día por km
    // (total) y por horas de ralentí (ralentí).
    for (const m of drvCells.values()) {
      for (const [ck, dc] of m) {
        const [dev, dk] = ck.split("|");
        const vc = dd.get(dev) && dd.get(dev).get(dk);
        if (!vc) continue;
        if (vc.km > 0 && vc.kmFuel > 0) { dc.fuel = vc.fuel * (dc.km / vc.km); dc.kmFuel = dc.km; }
        if (vc.ih > 0) dc.idleL = vc.idleL * (dc.ih / vc.ih);
      }
    }

    return {
      raw, cat, settings, gr, devices, devById, driverName, vtypeOf, serviceOf, serviceSource, profileOf,
      dd, drvCells, events, journeys, dayKeys, hasFuel: fuelDeltas.size > 0,
      fuelDevices: new Set(fuelDeltas.keys()), idleMeasuredDevices: new Set(idleDeltas.keys()),
    };
  }

  // ---------- Vistas ----------
  // filter: { groupIds, vtype, stype } -> Set de deviceIds. groupIds: grupos
  // elegidos en el filtro de MyGeotab (unión, con subgrupos); vacío = todos.
  function filterDevices(model, filter) {
    const set = new Set();
    const g = filter && filter.groupIds && filter.groupIds.length ? model.gr.expand(filter.groupIds) : null;
    for (const d of model.devices) {
      if (g && !deviceInGroups(d, g)) continue;
      if (filter && filter.vtype && model.vtypeOf.get(d.id) !== filter.vtype) continue;
      if (filter && filter.stype && model.serviceOf.get(d.id) !== filter.stype) continue;
      set.add(d.id);
    }
    return set;
  }

  function aggregate(model, deviceIds, daySet) {
    const total = emptyCell();
    for (const dev of deviceIds) {
      const m = model.dd.get(dev);
      if (!m) continue;
      for (const [dk, c] of m) if (!daySet || daySet.has(dk)) addCell(total, c);
    }
    return total;
  }

  function series(model, deviceIds, gran) {
    const buckets = new Map();
    const daysIn = new Map();
    for (const dk of model.dayKeys) {
      const bk = GI.bucketKey(dk, gran);
      if (!buckets.has(bk)) buckets.set(bk, emptyCell());
      daysIn.set(bk, (daysIn.get(bk) || 0) + 1);
    }
    const expected = bk => {
      if (gran === "day") return 1;
      if (gran === "week") return 7;
      const [y, m] = bk.split("-").map(Number);
      return new Date(y, m, 0).getDate();
    };
    for (const dev of deviceIds) {
      const m = model.dd.get(dev);
      if (!m) continue;
      for (const [dk, c] of m) {
        const b = buckets.get(GI.bucketKey(dk, gran));
        if (b) addCell(b, c);
      }
    }
    // Buckets incompletos (inicio/fin del período) se marcan con "*".
    return [...buckets.entries()].map(([bk, c]) => {
      const partial = daysIn.get(bk) < expected(bk);
      return { key: bk, label: GI.bucketLabel(bk, gran) + (partial ? " *" : ""), partial, ...kpis(c) };
    });
  }

  function targetFor(model, profile) {
    return model.settings.profile_targets[profile] || { l100: 0, idle_pct_max: 15, risk_max: 2 };
  }

  // Tabla por vehículo con su referencia de perfil.
  function vehicleRows(model, deviceIds) {
    const price = model.settings.fuel.price_per_liter || 0;
    const rows = [];
    for (const id of deviceIds) {
      const c = aggregate(model, [id]);
      if (c.km <= 0 && c.n === 0 && c.ih <= 0) continue;
      const k = kpis(c);
      const d = model.devById.get(id);
      rows.push({
        id, name: d.name, profile: model.profileOf(id), vtype: model.vtypeOf.get(id), stype: model.serviceOf.get(id),
        serviceSource: model.serviceSource.get(id), fuelMeasured: model.fuelDevices.has(id),
        idleMeasured: model.idleMeasuredDevices.has(id), ...k,
      });
    }
    // Referencia L/100: objetivo del perfil o mediana del perfil.
    const medByProfile = new Map();
    for (const [p, list] of GI.groupBy(rows.filter(r => r.l100 != null && r.km >= 200), r => r.profile)) {
      medByProfile.set(p, GI.median(list.map(r => r.l100)));
    }
    for (const r of rows) {
      const tgt = targetFor(model, r.profile);
      r.refL100 = tgt.l100 > 0 ? tgt.l100 : medByProfile.get(r.profile) || null;
      r.refSource = tgt.l100 > 0 ? "objetivo" : "mediana del perfil";
      r.fuelDevPct = r.l100 != null && r.refL100 ? ((r.l100 - r.refL100) / r.refL100) * 100 : null;
      // Exceso solo por encima de la tolerancia: con referencia = mediana,
      // la mitad del perfil siempre queda "arriba" por definición.
      const tol = model.settings.fuel.tolerance_pct != null ? model.settings.fuel.tolerance_pct : 10;
      const limit = r.refL100 ? r.refL100 * (1 + tol / 100) : null;
      r.fuelExcessL = r.l100 != null && limit && r.l100 > limit ? ((r.l100 - limit) / 100) * r.km : 0;
      r.idleMax = tgt.idle_pct_max;
      const totalH = r.drivingH + r.idleH;
      const idleAllowedH = (tgt.idle_pct_max / 100) * totalH;
      r.idleExcessH = Math.max(0, r.idleH - idleAllowedH);
      r.idleExcessL = r.idleH > 0 ? r.idleL * (r.idleExcessH / r.idleH) : 0;
      r.idleCost = r.idleL * price;
      r.riskMax = tgt.risk_max;
      r.excessCost = (r.fuelExcessL + r.idleExcessL) * price;
      r.flags = [];
      if (r.fuelExcessL > 0) r.flags.push("consumo");
      if (r.idlePct != null && r.idlePct > r.idleMax) r.flags.push("ralenti");
      if (r.risk != null && r.risk > r.riskMax && r.km >= 100) r.flags.push("riesgo");
    }
    return rows;
  }

  function driverRows(model, deviceIds) {
    const price = model.settings.fuel.price_per_liter || 0;
    const rows = [];
    for (const [drv, m] of model.drvCells) {
      const c = emptyCell();
      const vehicles = new Set();
      for (const [ck, dc] of m) {
        const dev = ck.split("|")[0];
        if (!deviceIds.has(dev)) continue;
        addCell(c, dc);
        if (dc.km > 0) vehicles.add(dev);
      }
      if (c.km <= 0 && c.n === 0) continue;
      const k = kpis(c);
      const vlist = [...vehicles];
      const svc = GI.groupBy(vlist, v => model.serviceOf.get(v));
      const mainSvc = [...svc.entries()].sort((a, b) => b[1].length - a[1].length)[0];
      rows.push({
        id: drv, unknown: drv === "_unknown",
        name: drv === "_unknown" ? "Sin conductor identificado" : model.driverName.get(drv) || drv,
        vehicles: vlist.length, stype: mainSvc ? mainSvc[0] : null,
        idleCost: k.idleL * price, ...k,
      });
    }
    return rows;
  }

  function routeRows(model, deviceIds) {
    const groups = new Map();
    for (const j of model.journeys) {
      if (!deviceIds.has(j.d) || j.internal || j.km < 1) continue;
      if (j.o === "_unknown") continue;
      const key = j.o + "→" + j.dest;
      if (!groups.has(key)) groups.set(key, { key, from: j.oName, to: j.destName, n: 0, km: 0, dh: 0, ih: 0, w: 0, nEv: 0, devices: new Set(), noZone: j.o === "_none" || j.dest === "_none" });
      const g = groups.get(key);
      g.n++; g.km += j.km; g.dh += j.dh; g.ih += j.ih; g.w += j.w || 0; g.nEv += j.nEv || 0; g.devices.add(j.d);
    }
    return [...groups.values()].map(g => ({
      ...g, devices: g.devices.size,
      avgKm: g.km / g.n, risk: g.km > 0 ? (g.w / g.km) * 100 : null,
      idlePct: g.dh + g.ih > 0 ? (g.ih / (g.dh + g.ih)) * 100 : null,
    }));
  }

  // Resumen por perfil (vehículo × servicio).
  function profileRows(model, deviceIds) {
    const byProfile = GI.groupBy([...deviceIds], id => model.profileOf(id));
    const rows = [];
    for (const [p, ids] of byProfile) {
      const c = aggregate(model, ids);
      if (c.km <= 0) continue;
      const [vt, st] = p.split("|");
      rows.push({ profile: p, vtype: vt, stype: st, vehicles: ids.length, target: targetFor(model, p), ...kpis(c) });
    }
    return rows.sort((a, b) => b.km - a.km);
  }

  // ---------- Impacto de un hito ----------
  // Compara ventana de N días antes vs N días después (recortada a los datos
  // cargados y a hoy). Métricas normalizadas por km para que no influya
  // cuánto se trabajó en cada ventana.
  function milestoneImpact(model, milestone, windowDays) {
    const mDay = milestone.date;
    const first = model.dayKeys[0], last = model.dayKeys[model.dayKeys.length - 1];
    const today = GI.dayKey(new Date());
    const lastUsable = last < today ? last : GI.dayKey(GI.addDays(new Date(), -1));
    const before = [], after = [];
    for (let i = 1; i <= windowDays; i++) {
      const b = GI.dayKey(GI.addDays(GI.parseDayKey(mDay), -i));
      if (b >= first) before.push(b);
      const a = GI.dayKey(GI.addDays(GI.parseDayKey(mDay), i - 1));
      if (a <= lastUsable) after.push(a);
    }
    const n = Math.min(before.length, after.length); // ventanas de igual largo
    const bSet = new Set(before.slice(0, n)), aSet = new Set(after.slice(0, n));
    let ids = model.devices.map(d => d.id);
    if (milestone.group_ids && milestone.group_ids.length) {
      const g = model.gr.expand(milestone.group_ids);
      ids = model.devices.filter(d => deviceInGroups(d, g)).map(d => d.id);
    }
    const cb = aggregate(model, ids, bSet), ca = aggregate(model, ids, aSet);
    const kb = kpis(cb), ka = kpis(ca);
    const cats = milestone.categories && milestone.categories.length ? milestone.categories : null;
    const catRate = (c, cat) => (c.km > 0 ? ((c.ev[cat] || 0) / c.km) * 100 : null);
    const catRows = (cats || Object.keys({ ...cb.ev, ...ca.ev })).map(cat => ({
      cat, before: catRate(cb, cat), after: catRate(ca, cat),
      nBefore: cb.ev[cat] || 0, nAfter: ca.ev[cat] || 0,
      change: GI.pctChange(catRate(cb, cat), catRate(ca, cat)),
    }));
    return {
      days: n, requested: windowDays, devices: ids.length,
      beforeRange: n ? [before[n - 1], before[0]] : null,
      afterRange: n ? [after[0], after[n - 1]] : null,
      before: kb, after: ka,
      riskChange: GI.pctChange(kb.risk, ka.risk),
      idleChange: GI.pctChange(kb.idlePct, ka.idlePct),
      l100Change: GI.pctChange(kb.l100, ka.l100),
      catRows,
    };
  }

  // ---------- Hallazgos ----------
  function findings(model, deviceIds, vRows, dRows) {
    const out = [];
    const price = model.settings.fuel.price_per_liter || 0;
    const money = l => (price ? " (≈ " + GI.fmtMoney(l * price) + ")" : "");

    const tol = model.settings.fuel.tolerance_pct != null ? model.settings.fuel.tolerance_pct : 10;
    const fuelOut = vRows.filter(r => r.fuelExcessL > 0).sort((a, b) => b.fuelExcessL - a.fuelExcessL);
    if (fuelOut.length) {
      const l = GI.sum(fuelOut, r => r.fuelExcessL);
      out.push({ type: "oportunidad", sev: "alta", area: "combustible",
        title: fuelOut.length + " vehículos consumen más de " + tol + "% sobre su referencia",
        text: "Exceso estimado " + GI.fmtNum(l) + " L" + money(l) + ". Mayores: " + fuelOut.slice(0, 3).map(r => r.name + " (+" + GI.fmtNum(r.fuelDevPct) + "%)").join(", ") + ".",
        target: { tab: "combustible" } });
    }
    const idleOut = vRows.filter(r => r.idleExcessH > 1).sort((a, b) => b.idleExcessL - a.idleExcessL);
    if (idleOut.length) {
      const l = GI.sum(idleOut, r => r.idleExcessL);
      out.push({ type: "oportunidad", sev: l > 500 ? "alta" : "media", area: "ralenti",
        title: idleOut.length + " vehículos superan el ralentí máximo de su perfil",
        text: GI.fmtNum(GI.sum(idleOut, r => r.idleExcessH)) + " h de ralentí por encima del objetivo ≈ " + GI.fmtNum(l) + " L" + money(l) + ".",
        target: { tab: "combustible" } });
    }
    const known = dRows.filter(r => !r.unknown && r.km >= model.settings.drivers.min_km_ranking);
    const riskyDrivers = known.filter(r => r.risk != null).sort((a, b) => b.risk - a.risk).slice(0, 3);
    if (riskyDrivers.length && riskyDrivers[0].risk > 0) {
      out.push({ type: "oportunidad", sev: "alta", area: "seguridad",
        title: "Conductores con mayor índice de riesgo",
        text: riskyDrivers.map(r => r.name + " (" + GI.fmtNum(r.risk, 2) + " pts/100 km)").join(", ") + ".",
        target: { tab: "conductores" } });
    }
    // Categoría que más aporta al riesgo
    const tot = aggregate(model, deviceIds);
    const contrib = Object.entries(tot.ev)
      .map(([k, n]) => ({ k, n, w: n * ((model.settings.category_weights[k]) || 0) }))
      .filter(x => x.w > 0).sort((a, b) => b.w - a.w);
    if (contrib.length && tot.w > 0) {
      const top = contrib[0];
      out.push({ type: "oportunidad", sev: "media", area: "seguridad",
        title: (GI.CATEGORY_BY_KEY[top.k] || { label: top.k }).label + " explica el " + GI.fmtNum((top.w / tot.w) * 100) + "% del riesgo",
        text: GI.fmtNum(top.n) + " eventos en el período. Es la categoría con más retorno si se trabaja en capacitación o seguimiento.",
        target: { tab: "seguridad" } });
    }
    // Tendencia: primera mitad vs segunda mitad del período
    const half = Math.floor(model.dayKeys.length / 2);
    if (half >= 7) {
      const a = kpis(aggregate(model, deviceIds, new Set(model.dayKeys.slice(0, half))));
      const b = kpis(aggregate(model, deviceIds, new Set(model.dayKeys.slice(half))));
      const trend = [["risk", "Índice de riesgo", true], ["idlePct", "% de ralentí", true], ["l100", "Consumo L/100 km", true]];
      for (const [k, label] of trend) {
        const ch = GI.pctChange(a[k], b[k]);
        if (ch == null || Math.abs(ch) < 10) continue;
        out.push({ type: ch < 0 ? "logro" : "oportunidad", sev: "media", area: "tendencia",
          title: label + (ch < 0 ? " bajó " : " subió ") + GI.fmtNum(Math.abs(ch)) + "%",
          text: "Comparando la primera y la segunda mitad del período (" + GI.fmtNum(a[k], 2) + " → " + GI.fmtNum(b[k], 2) + ")." });
      }
    }
    // Calidad de datos
    const unknown = dRows.find(r => r.unknown);
    const totalKm = GI.sum(dRows, r => r.km);
    if (unknown && totalKm > 0 && unknown.km / totalKm > 0.15) {
      out.push({ type: "dato", sev: "baja", area: "datos",
        title: GI.fmtNum((unknown.km / totalKm) * 100) + "% de los km no tiene conductor identificado",
        text: "El ranking de conductores solo refleja los km identificados. Revisar uso de llaves / login de conductor." });
    }
    const noType = vRows.filter(r => r.vtype === "sin_tipo");
    if (noType.length) {
      out.push({ type: "dato", sev: "baja", area: "datos",
        title: noType.length + " vehículos sin tipo asignado",
        text: "Se comparan contra el perfil \"Sin tipo\". Asignalos a un grupo en Configuración → Tipos de vehículo." });
    }
    const noFuel = vRows.filter(r => !r.fuelMeasured && r.km > 0);
    if (noFuel.length && model.hasFuel) {
      out.push({ type: "dato", sev: "baja", area: "datos",
        title: noFuel.length + " vehículos sin medición de combustible",
        text: "Su ralentí se estima con los L/h configurados por tipo de vehículo." });
    }
    return out;
  }

  function savings(vRows, price) {
    const idleL = GI.sum(vRows, r => r.idleExcessL);
    const fuelL = GI.sum(vRows, r => r.fuelExcessL);
    return { idleL, fuelL, totalL: idleL + fuelL, cost: (idleL + fuelL) * (price || 0) };
  }

  Object.assign(GI, {
    makeGroupResolver, pointInPolygon, makeZoneLocator, buildJourneys, counterDeltas,
    buildModel, filterDevices, aggregate, series, kpis, vehicleRows, driverRows, routeRows, profileRows,
    milestoneImpact, findings, savings, targetFor, deviceInGroups,
  });
})(window.GI);
