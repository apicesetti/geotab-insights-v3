// API simulada de MyGeotab para probar el add-in fuera de MyGeotab
// (abrir dev/index.html con un servidor estático). Genera una flota
// sintética con bitrenes y camiones de corta/larga distancia, conductores,
// zonas, eventos y contadores de combustible. No se usa en producción.
(function () {
  "use strict";
  let seed = 42;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const H = 3600000;
  const pad = n => String(n).padStart(2, "0");
  const dur = h => { const s = Math.round(h * 3600); return pad(Math.floor(s / 3600)) + ":" + pad(Math.floor((s % 3600) / 60)) + ":" + pad(s % 60); };

  const groups = [
    { id: "GroupCompanyId", name: "Company Group", children: [{ id: "gY" }, { id: "gOut" }, { id: "GroupAssetInformationId" }] },
    { id: "GroupAssetInformationId", name: "Asset Information", children: [{ id: "GroupDieselId" }, { id: "GroupGasolinePetrolId" }] },
    { id: "GroupDieselId", name: "Diesel", children: [] },
    { id: "GroupGasolinePetrolId", name: "Gasoline or Petrol", children: [] },
    { id: "gY", name: "Yusen Logistics", children: [{ id: "gUN" }, { id: "gTS" }] },
    { id: "gUN", name: "Unidades de negocio", children: [{ id: "gVeh" }, { id: "gCond" }] },
    { id: "gVeh", name: "Vehiculos", children: [{ id: "gPes" }, { id: "gLiv" }, { id: "gBit" }] },
    { id: "gPes", name: "Pesados", children: [] },
    { id: "gLiv", name: "Livianos", children: [] },
    { id: "gBit", name: "bitren", children: [] },
    { id: "gCond", name: "Conductores", children: [] },
    { id: "gTS", name: "Tipo de servicio", children: [{ id: "gLarga" }] },
    { id: "gLarga", name: "Larga distancia", children: [] },
    { id: "gOut", name: "Fuera de servicio", children: [] },
  ];
  const zones = [
    { id: "zCam", name: "Depósito Campana", c: [-59.05, -34.14] },
    { id: "zPto", name: "Puerto Buenos Aires", c: [-58.37, -34.58] },
    { id: "zCba", name: "Planta Córdoba", c: [-64.18, -31.42] },
    { id: "zRos", name: "Terminal Rosario", c: [-60.64, -32.95] },
  ].map(z => ({ id: z.id, name: z.name, c: z.c, zoneTypes: [{ id: z.id === "zCam" ? "ZoneTypeOfficeId" : "ZoneTypeCustomerId" }], points: [[-.02, -.02], [.02, -.02], [.02, .02], [-.02, .02]].map(([dx, dy]) => ({ x: z.c[0] + dx, y: z.c[1] + dy })) }));
  const zc = Object.fromEntries(zones.map(z => [z.id, z.c]));
  const zoneTypes = [{ id: "ztPuerto", name: "Puerto" }];
  // Zona grande y genérica (como "IMSEG"): no debe usarse para nombrar tramos.
  zones.push({ id: "zBig", name: "IMSEG", zoneTypes: [{ id: "ZoneTypeCustomerId" }], points: [[-62, -35.5], [-57.5, -35.5], [-57.5, -31], [-62, -31]].map(([x, y]) => ({ x, y })) });
  // Geocercas creadas por el add-in en esta sesión (sessionStorage).
  try { for (const z of JSON.parse(sessionStorage.getItem("mockZones") || "[]")) zones.push(z); for (const t of JSON.parse(sessionStorage.getItem("mockZoneTypes") || "[]")) zoneTypes.push(t); } catch (e) {}
  const persistZones = () => { try { sessionStorage.setItem("mockZones", JSON.stringify(zones.filter(z => z._created))); sessionStorage.setItem("mockZoneTypes", JSON.stringify(zoneTypes.filter(t => t._created))); } catch (e) {} };

  const rules = [
    ["RuleSeatbeltId", "Seat belt", "Stock"], ["RuleIdlingId", "Idling", "Stock"], ["RulePostedSpeedingId", "Speeding", "Stock"],
    ["RuleHarshBrakingId", "Harsh Braking", "Stock"], ["RuleJackrabbitStartsId", "Hard Acceleration", "Stock"],
    ["RuleHarshCorneringId", "Harsh Cornering", "Stock"], ["aPhone", "SRF_Uso del teléfono celular", "Custom"],
    ["aDist", "SRF_Conducción distraída", "Custom"], ["aCol", "SRF_Posible colisión", "Custom"],
    ["aVel", "Exceso de velocidad - General", "Custom"], ["aYawn", "SRF_Yawn", "Custom"], ["aLane", "SRF_Lane departure", "Custom"], ["aRuta", "Desvío de Ruta", "Custom"],
    ["aDummy", "Dummy Rule 0HNO1QCE7S0R2:00000087", "Custom"], ["aTest", "[TEST]Dentro TIL-TZ-TASA", "Custom"],
    ["RuleApplicationExceptionId", "**Application Exception", "Stock"],
    ...Array.from({ length: 300 }, (_, i) => ["azs" + i, "Zona " + i, "ZoneStop"]),
  ].map(([id, name, baseType]) => ({ id, name, baseType }));

  const drivers = Array.from({ length: 22 }, (_, i) => ({
    id: "u" + i, name: "chofer" + i, firstName: ["Juan", "Pedro", "Luis", "Carlos", "Diego", "Martín", "Sergio", "Pablo", "Raúl", "Hugo", "Omar"][i % 11],
    lastName: ["Gómez", "Pérez", "Soares", "Carosio", "Barbera", "Rodrigo", "Veltri", "Frantom", "Cabaleiro", "Astobiza", "Lodato"][(i * 7) % 11] + " " + (i + 1),
    // MyGeotab: "Impedir que el conductor acceda a los datos compartidos" (pares sí, impares no)
    isDriver: true, viewDriversOwnDataOnly: i % 2 === 0, risk: 0.3 + rnd() * 2.2, idleBias: 0.5 + rnd() * 1.5,
    driverGroups: [{ id: i < 8 ? "gBit" : "gCond" }],
    companyGroups: [{ id: i < 8 ? "gBit" : "GroupCompanyId" }],
  }));

  // Flota: [tipo, servicio, cantidad]
  const fleetSpec = [["bitren", "larga", 6], ["camion", "corta", 10], ["camion", "larga", 4], ["liviano", "corta", 4]];
  const devices = [];
  let n = 0;
  for (const [type, svc, count] of fleetSpec) {
    for (let i = 0; i < count; i++) {
      n++;
      const g = type === "bitren" ? ["gBit", "gPes", "GroupDieselId"] : type === "camion" ? ["gPes", "GroupDieselId"] : ["gLiv", "GroupGasolinePetrolId"];
      if (svc === "larga" && type !== "bitren" && i % 2 === 0) g.push("gLarga"); // algunos por grupo, otros automáticos
      devices.push({ id: "b" + (100 + n), name: (type === "bitren" ? "BIT" : type === "camion" ? "CAM" : "LIV") + "-" + pad(n),
        serialNumber: "G9" + (1000 + n), groups: g.map(id => ({ id })), _type: type, _svc: svc,
        _l100: { bitren: 48, camion: 33, liviano: 11 }[type] * (n % 7 === 0 ? 1.3 : 0.9 + rnd() * 0.2),
        _fuel: n % 9 !== 0, _idleL: type === "liviano" ? 1 : 2.6, _drivers: [pick(drivers), pick(drivers)] });
    }
  }
  devices.push({ id: "bOut", name: "OUT-99", serialNumber: "G99999", groups: [{ id: "gOut" }], _type: "camion", _svc: "corta", _l100: 30, _fuel: true, _idleL: 2, _drivers: [drivers[0]] });

  const trips = [], exceptions = [], status = [], logs = new Map();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const DAYS = 200;
  const MILESTONE_DAY = 45; // hace 45 días: capacitación cinturón + ralentí
  const counters = {};
  let tid = 0, eid = 0, sid = 0;
  const routeFor = d => d._svc === "larga" ? (d._type === "bitren" ? ["zCam", "zCba"] : ["zCam", "zRos"]) : ["zCam", "zPto"];
  const kmFor = (a, b) => ({ "zCam|zCba": 690, "zCam|zRos": 270, "zCam|zPto": 78 })[[a, b].sort().join("|")] || 50;

  for (const d of devices) {
    counters[d.id] = { f: 10000 + rnd() * 50000, i: 1000 + rnd() * 5000 };
    let pos = "zCam";
    for (let day = DAYS; day >= 0; day--) {
      const base = new Date(today); base.setDate(base.getDate() - day);
      if (base.getDay() === 0 && rnd() < 0.8) continue;
      if (rnd() < 0.12) continue;
      const after = day < MILESTONE_DAY;
      const legs = d._svc === "larga" ? 1 : 3;
      let t = base.getTime() + (6 + rnd() * 2) * H;
      for (let leg = 0; leg < legs; leg++) {
        const [a, b] = routeFor(d);
        const dest = pos === a ? b : a;
        const km = kmFor(pos, dest) * (0.95 + rnd() * 0.1);
        const drv = rnd() < 0.3 ? null : pick(d._drivers);
        // larga distancia: tramo partido en 2 viajes con parada fuera de zona
        const parts = km > 200 ? 2 : 1;
        for (let p = 0; p < parts; p++) {
          const pkm = km / parts;
          // Hora pico 17–20 h: más tráfico (más lento) y más infracciones.
          const peakH = new Date(t).getHours(), peak = peakH >= 17 && peakH < 20;
          const dh = (pkm / (d._svc === "larga" ? 70 : 45)) * (peak ? 1.35 : 1);
          const idleBase = d._svc === "corta" ? 0.18 : 0.07;
          const ih = dh * idleBase * (drv ? drv.idleBias : 1) * (after ? 0.75 : 1) * (0.6 + rnd() * 0.8);
          const start = t, stop = t + dh * H;
          const end = p === parts - 1 ? zc[dest] : [(zc[pos][0] + zc[dest][0]) / 2 + 0.3, (zc[pos][1] + zc[dest][1]) / 2];
          trips.push({ id: "t" + (++tid), device: { id: d.id }, driver: drv ? { id: drv.id } : "UnknownDriverId",
            start: new Date(start).toISOString(), stop: new Date(stop).toISOString(), distance: pkm,
            drivingDuration: dur(dh), idlingDuration: dur(ih), stopPoint: { x: end[0], y: end[1] },
            _a: p === 0 ? zc[pos] : [(zc[pos][0] + zc[dest][0]) / 2 + 0.3, (zc[pos][1] + zc[dest][1]) / 2] });
          // eventos
          const risk = (drv ? drv.risk : 1.2) * (peak ? 1.8 : 1);
          const nEv = Math.floor((pkm / 100) * risk * (rnd() * 1.2));
          for (let e = 0; e < nEv; e++) {
            let rule = pick(["RuleSeatbeltId", "RuleSeatbeltId", "RulePostedSpeedingId", "RuleHarshBrakingId", "RuleJackrabbitStartsId", "aPhone", "aDist", "RuleHarshCorneringId", "aVel"]);
            if (rule === "RuleSeatbeltId" && after && rnd() < 0.6) continue; // efecto de la capacitación
            const et = start + rnd() * (stop - start);
            const id = "e" + (++eid);
            exceptions.push({ id, rule: { id: rule }, device: { id: d.id }, driver: rnd() < 0.5 && drv ? { id: drv.id } : "UnknownDriverId",
              activeFrom: new Date(et).toISOString(), activeTo: new Date(et + 20000).toISOString(), duration: "00:00:20", state: "ExceptionEventStateValidId" });
            const fr = (et - start) / (stop - start);
            // 12% de los eventos en una "curva peligrosa" fija (para probar puntos calientes).
            const curve = rnd() < 0.12;
            logs.set(d.id + "|" + Math.round(et / 1000), curve
              ? { latitude: (zc[pos][1] + end[1]) / 2 + (rnd() - 0.5) * 0.002, longitude: (zc[pos][0] + end[0]) / 2 + (rnd() - 0.5) * 0.002, dateTime: new Date(et).toISOString() }
              : { latitude: zc[pos][1] + (end[1] - zc[pos][1]) * fr, longitude: zc[pos][0] + (end[0] - zc[pos][0]) * fr, dateTime: new Date(et).toISOString() });
          }
          // Bostezos / salida de carril (cámara): más con horas acumuladas en el día y de madrugada.
          if (drv) {
            const hh = new Date(start).getHours(), lam = 0.05 * dh * (1 + leg + p) * (hh >= 22 || hh < 6 ? 3 : 1);
            if (rnd() < lam) { const et = start + rnd() * (stop - start); exceptions.push({ id: "e" + (++eid), rule: { id: rnd() < 0.7 ? "aYawn" : "aLane" }, device: { id: d.id }, driver: { id: drv.id },
              activeFrom: new Date(et).toISOString(), activeTo: new Date(et + 5000).toISOString(), duration: "00:00:05", state: "ExceptionEventStateValidId" }); }
          }
          if (ih > 0.2) exceptions.push({ id: "e" + (++eid), rule: { id: "RuleIdlingId" }, device: { id: d.id }, driver: drv ? { id: drv.id } : "UnknownDriverId",
            activeFrom: new Date(start + 600000).toISOString(), duration: dur(ih), state: "ExceptionEventStateValidId" });
          if (d._fuel) {
            const c = counters[d.id];
            status.push({ id: "s" + (++sid), diagnostic: { id: "DiagnosticDeviceTotalFuelId" }, device: { id: d.id }, dateTime: new Date(start).toISOString(), data: c.f });
            status.push({ id: "s" + (++sid), diagnostic: { id: "DiagnosticDeviceTotalIdleFuelId" }, device: { id: d.id }, dateTime: new Date(start).toISOString(), data: c.i });
            c.f += (pkm * d._l100) / 100 + ih * d._idleL; c.i += ih * d._idleL;
            status.push({ id: "s" + (++sid), diagnostic: { id: "DiagnosticDeviceTotalFuelId" }, device: { id: d.id }, dateTime: new Date(stop).toISOString(), data: c.f });
            status.push({ id: "s" + (++sid), diagnostic: { id: "DiagnosticDeviceTotalIdleFuelId" }, device: { id: d.id }, dateTime: new Date(stop).toISOString(), data: c.i });
          }
          t = stop + (p < parts - 1 ? 1.5 : 0.7 + rnd()) * H;
        }
        pos = dest;
      }
    }
  }

  // Fatiga: un conductor que pasa de turno día a turno noche (descansa de día,
  // maneja de madrugada, eventos de bostezo / salida de carril agrupados) y
  // una jornada en curso (empezó hace 7 h, sigue manejando).
  {
    const nd = { id: "u50", name: "chofer50", firstName: "Ramón", lastName: "Bertoldi", isDriver: true, viewDriversOwnDataOnly: true, risk: 1, idleBias: 1,
      driverGroups: [{ id: "gBit" }], companyGroups: [{ id: "gBit" }] };
    const od = { id: "u51", name: "chofer51", firstName: "Elías", lastName: "Montero", isDriver: true, viewDriversOwnDataOnly: true, risk: 1, idleBias: 1,
      driverGroups: [{ id: "gCond" }], companyGroups: [{ id: "GroupCompanyId" }] };
    drivers.push(nd, od);
    const dev = { id: "b300", name: "BIT-NOC", serialNumber: "G9300", groups: [{ id: "gBit" }, { id: "gPes" }, { id: "GroupDieselId" }], _type: "bitren", _svc: "larga", _l100: 48, _fuel: false, _idleL: 2.6, _drivers: [nd] };
    const dev2 = { id: "b301", name: "CAM-HOY", serialNumber: "G9301", groups: [{ id: "gPes" }, { id: "GroupDieselId" }], _type: "camion", _svc: "larga", _l100: 33, _fuel: false, _idleL: 2.6, _drivers: [od] };
    devices.push(dev, dev2);
    const addTrip = (d, drv, s, hours, stop) => {
      const km = hours * 72;
      trips.push({ id: "t" + (++tid), device: { id: d.id }, driver: { id: drv.id }, start: new Date(s).toISOString(), stop: new Date(s + hours * H).toISOString(),
        distance: km, drivingDuration: dur(hours), idlingDuration: dur(hours * 0.05), stopPoint: stop || { x: zc.zRos[0], y: zc.zRos[1] }, _a: zc.zCam });
      return s + hours * H;
    };
    const addEv = (d, drv, t, rule) => exceptions.push({ id: "e" + (++eid), rule: { id: rule }, device: { id: d.id }, driver: { id: drv.id },
      activeFrom: new Date(t).toISOString(), activeTo: new Date(t + 5000).toISOString(), duration: "00:00:05", state: "ExceptionEventStateValidId" });
    for (let day = 24; day >= 1; day--) {
      const base = new Date(today); base.setDate(base.getDate() - day);
      if (day >= 15) { // turno día 06–16
        if (base.getDay() === 0) continue;
        let t = base.getTime() + 6 * H;
        t = addTrip(dev, nd, t, 3) + 0.5 * H; t = addTrip(dev, nd, t, 3) + 0.75 * H; addTrip(dev, nd, t, 2.5, { x: zc.zCam[0], y: zc.zCam[1] });
      } else { // turno noche 21–08 hasta anoche: tirada larga y madrugada
        let t = base.getTime() + (day === 14 ? -2 : 21) * H; // el primero, 6 h después del último turno día
        t = addTrip(dev, nd, t, 4.6) + 0.4 * H; t = addTrip(dev, nd, t, 4) + 0.6 * H; t = addTrip(dev, nd, t, 1.8, { x: -60.2, y: -33.6 }); // termina en un parador de la ruta
        if (day % 4 === 1) trips.push({ id: "t" + (++tid), device: { id: dev.id }, driver: { id: nd.id }, start: new Date(t + 4 * H).toISOString(), stop: new Date(t + 4 * H + 180000).toISOString(),
          distance: 0, drivingDuration: dur(0.05), idlingDuration: dur(0.02), stopPoint: { x: -60.2, y: -33.6 }, _a: zc.zCam }); // encendió el camión durante el descanso
        if (day % 3 !== 0) exceptions.push({ id: "e" + (++eid), rule: { id: "RuleIdlingId" }, device: { id: dev.id }, driver: { id: nd.id }, activeFrom: new Date(t + 0.3 * H).toISOString(), duration: dur(5.5), state: "ExceptionEventStateValidId" });
        if (day % 2 === 0) { const c = base.getTime() + 27.2 * H; ["aYawn", "aLane", "aYawn", "aYawn"].forEach((r, i) => addEv(dev, nd, c + i * 13 * 60000, r)); }
      }
    }
    // jornada en curso
    const now = Date.now();
    let t = now - 7 * H;
    t = addTrip(dev2, od, t, 3.4) + 0.3 * H; addTrip(dev2, od, t, 3.13); // terminó hace 10 min; vuelve a manejar hace 8 min
    // diagrama 14x7 (hoy es el día 7 de la vuelta); una vuelta se extendió 3 días
    for (let day = 90; day >= 1; day--) { const pos = (90 - day) % 21; if (pos >= 14 && !(day >= 40 && day <= 42)) continue; const base = new Date(today); base.setDate(base.getDate() - day); let x = base.getTime() + 7 * H; x = addTrip(dev2, od, x, 4) + H; addTrip(dev2, od, x, 4); }
  }

  // AddInData persiste en sessionStorage para poder probar admin → conductor recargando la página.
  const addInData = (() => { try { return JSON.parse(sessionStorage.getItem("mockAddInData") || "[]"); } catch (e) { return []; } })();
  const persist = () => { try { sessionStorage.setItem("mockAddInData", JSON.stringify(addInData)); } catch (e) { /* sin storage */ } };
  let aid = 0;
  const calls = { Get: 0, GetCountOf: 0, multi: 0 };

  // deviceSearch.groups: filtra por grupos del vehículo (incluye subgrupos).
  function inGroups(devRef, s) {
    const gs = s.deviceSearch && s.deviceSearch.groups;
    if (!gs || !gs.length) return true;
    const want = new Set();
    const add = id => { if (want.has(id)) return; want.add(id); const g = groups.find(x => x.id === id); (g ? g.children : []).forEach(c => add(c.id)); };
    gs.forEach(g => add(g.id));
    const d = devices.find(x => x.id === devRef.id);
    return !!d && d.groups.some(g => want.has(g.id));
  }

  function inRange(iso, s) {
    return (!s.fromDate || iso >= s.fromDate) && (!s.toDate || iso < s.toDate);
  }

  // Geocodificación inversa de prueba: ruta según el corredor y la localidad más cercana.
  const towns = [["Campana", -59.05, -34.14], ["Zárate", -59.03, -34.1], ["Escobar", -58.79, -34.35], ["Pilar", -58.91, -34.46], ["Buenos Aires", -58.37, -34.58],
    ["San Pedro", -59.67, -33.68], ["Rosario", -60.64, -32.95], ["Villa María", -63.24, -32.41], ["Marcos Juárez", -62.1, -32.7], ["Córdoba", -64.18, -31.42], ["Baradero", -59.5, -33.8]];
  // Rutas de prueba (líneas entre depósitos) con sus localidades en orden.
  const mockRoads = [["RN9", "zCam", "zPto"], ["RN9", "zCam", "zRos"], ["RN8", "zCam", "zCba"]].map(([code, a, b], li) => {
    const A = zc[a], B = zc[b], dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
    const proj = (x, y) => { const t = ((x - A[0]) * dx + (y - A[1]) * dy) / L2; const px = A[0] + dx * t, py = A[1] + dy * t; return { t, d: Math.hypot(x - px, y - py) }; };
    const ts = towns.map(([n, x, y]) => ({ n, ...proj(x, y) })).filter(q => q.d < 0.35 && q.t > -0.05 && q.t < 1.05).sort((p1, p2) => p1.t - p2.t);
    return { code, li, proj, towns: ts };
  });
  function fakeAddress(x, y) {
    let best = null;
    for (const [n, tx, ty] of towns) { const d = Math.hypot(tx - x, ty - y); if (!best || d < best.d) best = { n, d }; }
    let road = null;
    for (const r of mockRoads) { const q = r.proj(x, y); if (!road || q.d < road.q.d) road = { r, q }; }
    const code = road.r.code;
    const zonesHit = [{ id: "zBig" }];
    if (best.d < 0.05) return { street: "250 " + code, streetName: code, streetNumber: "250", city: best.n, region: "Buenos Aires", country: "Argentina", formattedAddress: code + " 250, " + best.n, zones: zonesHit };
    const ts = road.r.towns;
    let i = 0;
    while (i < ts.length - 1 && ts[i + 1].t < road.q.t) i++;
    const A = ts[i] ? ts[i].n : "origen", B = ts[i + 1] ? ts[i + 1].n : "destino";
    const id = "zc_" + road.r.li + "_" + i;
    if (!zones.some(z => z.id === id)) zones.push({ id, name: code + " - " + A + " a " + B + " - " + (A === "Buenos Aires" || B === "Buenos Aires" ? 80 : 110) + "kmh", zoneTypes: [{ id: "ztControl" }], points: [[-.01, -.01], [.01, -.01], [.01, .01]].map(([ddx, ddy]) => ({ x: x + ddx, y: y + ddy })) });
    zonesHit.push({ id });
    return { street: code, streetName: code, streetNumber: "", city: "", region: "Buenos Aires", country: "Argentina", formattedAddress: code + ", Buenos Aires, Argentina", zones: zonesHit };
  }

  function handle(method, p) {
    const s = (p && p.search) || {};
    if (method === "GetPostedRoadSpeedsForDevice") {
      calls.posted = (calls.posted || 0) + 1;
      const f0 = new Date(p.fromDate).getTime(), f1 = new Date(p.toDate).getTime(), out = [];
      for (const t of trips) {
        if (t.device.id !== p.deviceSearch.id) continue;
        const t0 = new Date(t.start).getTime(), t1 = new Date(t.stop).getTime();
        if (t1 < f0 || t0 > f1) continue;
        out.push({ date: new Date(t0).toISOString(), maxSpeed: 110, truckMaxSpeed: 90, lcvMaxSpeed: 110, isEstimate: false });
        out.push({ date: new Date(t0 + (t1 - t0) * 0.93).toISOString(), maxSpeed: 60, truckMaxSpeed: 60, lcvMaxSpeed: 60, isEstimate: false });
      }
      return out;
    }
    if (method === "GetAddresses") { calls.addr = (calls.addr || 0) + 1; return (p.coordinates || []).map(c => fakeAddress(c.x, c.y)); }
    if (method === "Get" || method === "GetCountOf") {
      calls[method]++;
      let out;
      switch (p.typeName) {
        case "Group": out = groups; break;
        case "Device": out = devices.filter(d => !s.groups || inGroups({ id: d.id }, { deviceSearch: { groups: s.groups } })).map(({ id, name, serialNumber, groups }) => ({ id, name, serialNumber, groups })); break;
        case "Rule": out = rules; break;
        case "User": {
          const drv = s.name && drivers.find(d => d.name === s.name);
          out = drv ? [{ ...drv, securityGroups: [{ id: "GroupDriveUserSecurityId" }] }]
            : s.name ? [{ id: "admin", name: s.name, securityGroups: [{ id: "GroupEverythingSecurityId" }] }] : drivers;
          break;
        }
        case "Zone": {
          out = zones;
          if (s.name) { const re = new RegExp("^" + s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i"); out = out.filter(z => re.test(z.name)); }
          break;
        }
        case "ZoneType": out = zoneTypes; break;
        // Como el servidor real: Trip ignora deviceSearch.groups; solo filtra por id.
        case "Trip": out = trips.filter(t => inRange(t.start, s) && (!s.deviceSearch || !s.deviceSearch.id || t.device.id === s.deviceSearch.id)); break;
        case "ExceptionEvent": out = exceptions.filter(e => inRange(e.activeFrom, s) && inGroups(e.device, s) && (!s.ruleSearch || e.rule.id === s.ruleSearch.id)); break;
        case "StatusData":
          // fromDate = toDate con un vehículo: valor en ese instante (último anterior).
          if (s.fromDate && s.fromDate === s.toDate && s.deviceSearch && s.deviceSearch.id) {
            let best = null;
            for (const r of status) if (r.device.id === s.deviceSearch.id && (!s.diagnosticSearch || r.diagnostic.id === s.diagnosticSearch.id) && r.dateTime <= s.fromDate && (!best || r.dateTime > best.dateTime)) best = r;
            out = best ? [{ ...best, dateTime: s.fromDate, id: undefined }] : [];
            break;
          }
          out = status.filter(r => inRange(r.dateTime, s) && inGroups(r.device, s) && (!s.diagnosticSearch || r.diagnostic.id === s.diagnosticSearch.id)); break;
        case "DeviceStatusInfo": out = devices.map(d => ({ device: { id: d.id }, driver: d.id === "b301" ? { id: "u51" } : "UnknownDriverId",
          isDriving: d.id === "b301", currentStateDuration: d.id === "b301" ? "00:08:00" : "05:00:00", dateTime: new Date().toISOString() })); break;
        case "AddInData": out = addInData.filter(a => a.addInId === s.addInId); break;
        case "LogRecord": {
          // Sin deviceSearch (muestreo de corredores): un punto cada 10 s de
          // cada viaje que pase por la ventana, con velocidad.
          if (!s.deviceSearch) {
            const a0 = new Date(s.fromDate).getTime(), a1 = new Date(s.toDate).getTime();
            out = [];
            for (const t of trips) {
              const t0 = new Date(t.start).getTime(), t1 = new Date(t.stop).getTime();
              if (t1 < a0 || t0 > a1) continue;
              const A = t._a, Z = [t.stopPoint.x, t.stopPoint.y];
              const kmh = t.distance / ((t1 - t0) / 3600000);
              for (let k = Math.max(t0, Math.ceil(a0 / 10000) * 10000); k <= Math.min(t1, a1); k += 10000) {
                const f = (k - t0) / Math.max(1, t1 - t0);
                const wob = Math.sin(k / 7e5) * 0.15;
                out.push({ device: { id: t.device.id }, dateTime: new Date(k).toISOString(), latitude: A[1] + (Z[1] - A[1]) * f, longitude: A[0] + (Z[0] - A[0]) * f, speed: Math.max(0, kmh * (1 + wob) - (new Date(k).getHours() >= 17 && new Date(k).getHours() < 20 && (k / 1000) % 180 < 20 ? 35 : 0)) });
              }
            }
            break;
          }
          const from = new Date(s.fromDate).getTime() / 1000, to = new Date(s.toDate).getTime() / 1000;
          out = [];
          for (let ts = Math.floor(from); ts <= to; ts++) { const l = logs.get(s.deviceSearch.id + "|" + ts); if (l) out.push(l); }
          // Rangos largos (trazado de un recorrido): un punto cada 10 s de cada viaje, sobre la misma línea que usa el muestreo de corredores.
          if (to - from > 1200) {
            for (const t of trips) {
              if (t.device.id !== s.deviceSearch.id) continue;
              const t0 = new Date(t.start).getTime(), t1 = new Date(t.stop).getTime();
              if (t1 < from * 1000 || t0 > to * 1000) continue;
              const A = t._a, Z = [t.stopPoint.x, t.stopPoint.y];
              for (let k = Math.max(t0, Math.ceil(from / 10) * 10000); k <= Math.min(t1, to * 1000); k += 10000) {
                const f = (k - t0) / Math.max(1, t1 - t0);
                out.push({ latitude: A[1] + (Z[1] - A[1]) * f, longitude: A[0] + (Z[0] - A[0]) * f, dateTime: new Date(k).toISOString() });
              }
            }
          }
          break;
        }
        default: throw new Error("Mock: Get " + p.typeName + " no soportado");
      }
      if (method === "GetCountOf") return out.length;
      if (p.typeName === "Rule" && s.baseType) out = out.filter(r => r.baseType === s.baseType);
      if (p.sort && p.sort.sortBy === "id") {
        out = [...out].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        if (p.sort.offset) out = out.filter(r => r.id > p.sort.offset);
      }
      // Como el servidor real, Trip corta antes del resultsLimit (allá 25.000; acá 100).
      if (p.typeName === "Trip" && !p.sort) out = [...out].sort((a, b) => (a.start < b.start ? -1 : 1)).slice(0, 100);
      return p.resultsLimit ? out.slice(0, p.resultsLimit) : out;
    }
    if (method === "Add" || method === "Set") {
      // Como el servidor real: no acepta grupos donde uno contiene a otro.
      const gs = ((p.entity && p.entity.groups) || []).map(g => g.id);
      const desc = id => { const out = new Set(); const q = [id]; while (q.length) { const g = groups.find(x => x.id === q.shift()); for (const c of (g && g.children) || []) if (!out.has(c.id)) { out.add(c.id); q.push(c.id); } } return out; };
      for (const a of gs) { const d = desc(a); if (gs.some(b => b !== a && d.has(b))) throw new Error("Cannot add an entity with groups that have a parent-child relationship."); }
    }
    if (method === "Add" && p.typeName === "ZoneType") { const id = "zt" + (++aid); zoneTypes.push({ ...p.entity, id, _created: true }); persistZones(); return id; }
    if (method === "Add" && p.typeName === "Zone") {
      if (!p.entity.name || !(p.entity.points || []).length) throw new Error("Zone: name y points son obligatorios");
      const id = "zn" + (++aid); zones.push({ ...JSON.parse(JSON.stringify(p.entity)), id, _created: true }); persistZones(); return id;
    }
    if (method === "Add") { const id = "ad" + Date.now().toString(36) + (++aid); addInData.push({ ...JSON.parse(JSON.stringify(p.entity)), id }); persist(); return id; }
    if (method === "Set") { const i = addInData.findIndex(a => a.id === p.entity.id); addInData[i] = JSON.parse(JSON.stringify(p.entity)); persist(); return null; }
    if (method === "Remove") { const i = addInData.findIndex(a => a.id === p.entity.id); if (i >= 0) addInData.splice(i, 1); persist(); return null; }
    throw new Error("Mock: método " + method);
  }

  const latency = () => new Promise(r => setTimeout(r, 60 + Math.random() * 80));
  window.mockApi = {
    call(method, params, ok, err) {
      latency().then(() => { try { ok(handle(method, params)); } catch (e) { (err || console.error)(e); } });
    },
    multiCall(list, ok, err) {
      calls.multi++;
      latency().then(() => { try { ok(list.map(([m, p]) => handle(m, p))); } catch (e) { (err || console.error)(e); } });
    },
    // ?usuario=chofer3 en la URL: entra como ese conductor (sin permisos de administrador).
    getSession(cb) { cb({ database: "yusen_demo", userName: (typeof window !== "undefined" && window.__mockUser) || "mt@cesetti.com.ar", sessionId: "x" }, "my.geotab.com"); },
    _stats: calls,
    _sizes: { trips: trips.length, exceptions: exceptions.length, status: status.length },
  };
})();
