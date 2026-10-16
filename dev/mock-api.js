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

  const rules = [
    ["RuleSeatbeltId", "Seat belt", "Stock"], ["RuleIdlingId", "Idling", "Stock"], ["RulePostedSpeedingId", "Speeding", "Stock"],
    ["RuleHarshBrakingId", "Harsh Braking", "Stock"], ["RuleJackrabbitStartsId", "Hard Acceleration", "Stock"],
    ["RuleHarshCorneringId", "Harsh Cornering", "Stock"], ["aPhone", "SRF_Uso del teléfono celular", "Custom"],
    ["aDist", "SRF_Conducción distraída", "Custom"], ["aCol", "SRF_Posible colisión", "Custom"],
    ["aVel", "Exceso de velocidad - General", "Custom"], ["aRuta", "Desvío de Ruta", "Custom"],
    ["aDummy", "Dummy Rule 0HNO1QCE7S0R2:00000087", "Custom"], ["aTest", "[TEST]Dentro TIL-TZ-TASA", "Custom"],
    ["RuleApplicationExceptionId", "**Application Exception", "Stock"],
  ].map(([id, name, baseType]) => ({ id, name, baseType }));

  const drivers = Array.from({ length: 22 }, (_, i) => ({
    id: "u" + i, name: "chofer" + i, firstName: ["Juan", "Pedro", "Luis", "Carlos", "Diego", "Martín", "Sergio", "Pablo", "Raúl", "Hugo", "Omar"][i % 11],
    lastName: ["Gómez", "Pérez", "Soares", "Carosio", "Barbera", "Rodrigo", "Veltri", "Frantom", "Cabaleiro", "Astobiza", "Lodato"][(i * 7) % 11] + " " + (i + 1),
    isDriver: true, risk: 0.3 + rnd() * 2.2, idleBias: 0.5 + rnd() * 1.5,
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
          const dh = pkm / (d._svc === "larga" ? 70 : 45);
          const idleBase = d._svc === "corta" ? 0.18 : 0.07;
          const ih = dh * idleBase * (drv ? drv.idleBias : 1) * (after ? 0.75 : 1) * (0.6 + rnd() * 0.8);
          const start = t, stop = t + dh * H;
          const end = p === parts - 1 ? zc[dest] : [(zc[pos][0] + zc[dest][0]) / 2 + 0.3, (zc[pos][1] + zc[dest][1]) / 2];
          trips.push({ id: "t" + (++tid), device: { id: d.id }, driver: drv ? { id: drv.id } : "UnknownDriverId",
            start: new Date(start).toISOString(), stop: new Date(stop).toISOString(), distance: pkm,
            drivingDuration: dur(dh), idlingDuration: dur(ih), stopPoint: { x: end[0], y: end[1] } });
          // eventos
          const risk = drv ? drv.risk : 1.2;
          const nEv = Math.floor((pkm / 100) * risk * (rnd() * 1.2));
          for (let e = 0; e < nEv; e++) {
            let rule = pick(["RuleSeatbeltId", "RuleSeatbeltId", "RulePostedSpeedingId", "RuleHarshBrakingId", "RuleJackrabbitStartsId", "aPhone", "aDist", "RuleHarshCorneringId", "aVel"]);
            if (rule === "RuleSeatbeltId" && after && rnd() < 0.6) continue; // efecto de la capacitación
            const et = start + rnd() * (stop - start);
            const id = "e" + (++eid);
            exceptions.push({ id, rule: { id: rule }, device: { id: d.id }, driver: rnd() < 0.5 && drv ? { id: drv.id } : "UnknownDriverId",
              activeFrom: new Date(et).toISOString(), activeTo: new Date(et + 20000).toISOString(), duration: "00:00:20", state: "ExceptionEventStateValidId" });
            const fr = (et - start) / (stop - start);
            logs.set(d.id + "|" + Math.round(et / 1000), { latitude: zc[pos][1] + (end[1] - zc[pos][1]) * fr, longitude: zc[pos][0] + (end[0] - zc[pos][0]) * fr, dateTime: new Date(et).toISOString() });
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

  const addInData = [];
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

  function handle(method, p) {
    const s = (p && p.search) || {};
    if (method === "Get" || method === "GetCountOf") {
      calls[method]++;
      let out;
      switch (p.typeName) {
        case "Group": out = groups; break;
        case "Device": out = devices.map(({ id, name, serialNumber, groups }) => ({ id, name, serialNumber, groups })); break;
        case "Rule": out = rules; break;
        case "User": out = s.name ? [{ id: "admin", name: s.name, securityGroups: [{ id: "GroupEverythingSecurityId" }] }] : drivers; break;
        case "Zone": out = zones; break;
        case "ZoneType": out = [{ id: "ztPuerto", name: "Puerto" }]; break;
        case "Trip": out = trips.filter(t => inRange(t.start, s) && inGroups(t.device, s)); break;
        case "ExceptionEvent": out = exceptions.filter(e => inRange(e.activeFrom, s) && inGroups(e.device, s) && (!s.ruleSearch || e.rule.id === s.ruleSearch.id)); break;
        case "StatusData": out = status.filter(r => inRange(r.dateTime, s) && inGroups(r.device, s) && (!s.diagnosticSearch || r.diagnostic.id === s.diagnosticSearch.id)); break;
        case "AddInData": out = addInData.filter(a => a.addInId === s.addInId); break;
        case "LogRecord": {
          const from = new Date(s.fromDate).getTime() / 1000, to = new Date(s.toDate).getTime() / 1000;
          out = [];
          for (let ts = Math.floor(from); ts <= to; ts++) { const l = logs.get(s.deviceSearch.id + "|" + ts); if (l) out.push(l); }
          break;
        }
        default: throw new Error("Mock: Get " + p.typeName + " no soportado");
      }
      if (method === "GetCountOf") return out.length;
      return p.resultsLimit ? out.slice(0, p.resultsLimit) : out;
    }
    if (method === "Add") { const id = "ad" + (++aid); addInData.push({ ...JSON.parse(JSON.stringify(p.entity)), id }); return id; }
    if (method === "Set") { const i = addInData.findIndex(a => a.id === p.entity.id); addInData[i] = JSON.parse(JSON.stringify(p.entity)); return null; }
    if (method === "Remove") { const i = addInData.findIndex(a => a.id === p.entity.id); if (i >= 0) addInData.splice(i, 1); return null; }
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
    getSession(cb) { cb({ database: "yusen_demo", userName: "mt@cesetti.com.ar", sessionId: "x" }, "my.geotab.com"); },
    _stats: calls,
    _sizes: { trips: trips.length, exceptions: exceptions.length, status: status.length },
  };
})();
