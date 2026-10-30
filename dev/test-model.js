// Pruebas del modelo con datos sintéticos: node dev/test-model.js
const fs = require("fs");
const vm = require("vm");
const ctx = { window: {}, console, Date, Math, Map, Set, Number, JSON, Object, Array, String, Promise, setTimeout };
vm.createContext(ctx);
for (const f of ["util", "catalog", "model", "exposure", "riskfactors", "hotspots", "roads", "fatigue"]) {
  vm.runInContext(fs.readFileSync(require("path").join(__dirname, "../static/js/core", f + ".js"), "utf8"), ctx);
}
const GI = ctx.window.GI;
const assert = require("assert");

// Catálogos
const groups = [
  { id: "GroupCompanyId", name: "Company", children: ["gV", "gS", "gOut"] },
  { id: "gV", name: "Vehiculos", children: ["gP", "gB"] },
  { id: "gP", name: "Pesados", children: [] },
  { id: "gB", name: "bitren", children: [] },
  { id: "gS", name: "Tipo de servicio", children: ["gL"] },
  { id: "gL", name: "Larga distancia", children: [] },
  { id: "gOut", name: "Fuera de servicio", children: [] },
];
const devices = [
  { id: "d1", name: "BIT-01", serial: "G9A1", groups: ["gB", "gP"] },
  { id: "d2", name: "CAM-02", serial: "G9A2", groups: ["gP"] },
  { id: "d3", name: "CAM-03", serial: "G9A3", groups: ["gP", "gL"] },
  { id: "d4", name: "OUT-04", serial: "G9A4", groups: ["gOut"] },
];
const rules = [
  { id: "RuleSeatbeltId", name: "Seat belt", baseType: "Stock" },
  { id: "RuleIdlingId", name: "Idling", baseType: "Stock" },
  { id: "aX", name: "SRF_Uso del teléfono celular", baseType: "Custom" },
  { id: "aD", name: "Dummy Rule 0HN", baseType: "Custom" },
  { id: "aT", name: "[TEST]Dentro TIL", baseType: "Custom" },
];
const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const zones = [
  { id: "zA", name: "Depósito", pts: sq(0, 0, 1), bbox: [0, 0, 1, 1] },
  { id: "zB", name: "Puerto", pts: sq(10, 10, 1), bbox: [10, 10, 11, 11] },
];
const cat = { groups, devices, rules, drivers: [{ id: "u1", name: "Juan" }, { id: "u2", name: "Pedro" }], zones };

const settings = GI.defaultSettings(groups, rules);
// Las reglas ya no se asignan solas: arrancan vacías y se sugieren.
assert.strictEqual(Object.keys(settings.rule_mapping).length, 0);
assert.strictEqual(GI.suggestCategory(rules[0]), "cinturon");
assert.strictEqual(GI.suggestCategory(rules[2]), "telefono");
assert.ok(GI.isNoiseRule(rules[3]) && GI.isNoiseRule(rules[4]), "dummy/test rules are noise");
settings.rule_mapping = { RuleSeatbeltId: "cinturon", aX: "telefono", RuleIdlingId: "ralenti" };
assert.strictEqual(GI.riskRuleIds(settings.rule_mapping).sort().join(), "RuleSeatbeltId,aX");
assert.deepStrictEqual(settings.excluded_group_ids, ["gOut"]);
assert.deepStrictEqual(settings.service.group_ids.larga, ["gL"]);
assert.deepStrictEqual(settings.vehicle_types.find(v => v.key === "bitren").groupIds, ["gB"]);
settings.fuel.price_per_liter = 1000;

// Período de 14 días
const fromKey = "2026-09-01", toKey = "2026-09-14";
const dayKeys = GI.dayRange(fromKey, toKey);
assert.strictEqual(dayKeys.length, 14);
const fuelDays = GI.dayRange("2026-08-29", toKey);
const H = 3600000;
const trips = [];
const exceptions = [];
const fuelDaily = new Map(), idleDaily = new Map();
const counters = { d1: 1000, d2: 5000 };
const idleC = { d1: 100, d2: 300 };
for (const dk of fuelDays) {
  const base = GI.parseDayKey(dk).getTime() + 8 * H;
  const inPeriod = dayKeys.includes(dk);
  const fd = {}, id = {};
  for (const [dev, km, l100, drv] of [["d1", 300, 50, "u1"], ["d2", 300, 30, "u2"], ["d3", 80, 0, null]]) {
    // viaje A->B (zona a zona) en 2 tramos con parada fuera de zona
    if (inPeriod) {
      trips.push({ i: dev + dk + "a", d: dev, r: drv, s: base, e: base + 2 * H, km: km / 2, dh: 2, ih: 0.5, x: 5, y: 5 });
      trips.push({ i: dev + dk + "b", d: dev, r: drv, s: base + 3 * H, e: base + 5 * H, km: km / 2, dh: 2, ih: 0.5, x: dev === "d3" ? 0.5 : 10.5, y: dev === "d3" ? 0.5 : 10.5 });
      trips.push({ i: dev + dk + "c", d: dev, r: drv, s: base + 10 * H, e: base + 12 * H, km: 0, dh: 0.2, ih: dev === "d2" ? 3 : 0.1, x: 0.5, y: 0.5 });
      if (dev !== "d3") exceptions.push({ i: "e" + dev + dk, d: dev, r: null, t: base + H, h: 0.01, rule: dev === "d1" ? "RuleSeatbeltId" : "aX" });
    }
    if (counters[dev] != null) {
      const before = counters[dev];
      counters[dev] += inPeriod ? (km * l100) / 100 : 50;
      fd[dev] = { ft: base, fv: before, lt: base + 12 * H, lv: counters[dev] };
      const ib = idleC[dev];
      idleC[dev] += 2;
      id[dev] = { ft: base, fv: ib, lt: base + 12 * H, lv: idleC[dev] };
    }
  }
  fuelDaily.set(dk, fd);
  idleDaily.set(dk, id);
}
// trip of excluded device
trips.push({ i: "x", d: "d4", r: null, s: GI.parseDayKey(fromKey).getTime() + 9 * H, e: GI.parseDayKey(fromKey).getTime() + 10 * H, km: 999, dh: 1, ih: 0, x: 0, y: 0 });

const raw = { fromKey, toKey, dayKeys, trips, exceptions, fuelDaily, idleFuelDaily: idleDaily, fuelDays };
const model = GI.buildModel(raw, cat, settings);
// Dejar afuera conductores desconocidos: d3 (sin conductor) no suma km; d1/d2 igual
{
  const s2 = JSON.parse(JSON.stringify(settings)); s2.drivers.exclude_unknown = true;
  const m2 = GI.buildModel(raw, cat, s2);
  const kmOf = (m, id) => GI.aggregate(m, [id]).km;
  assert.strictEqual(kmOf(m2, "d3"), 0);
  assert.strictEqual(kmOf(m2, "d1"), kmOf(model, "d1"));
  assert.ok(Math.abs(GI.aggregate(m2, ["d1"]).fuel - GI.aggregate(model, ["d1"]).fuel) < 1e-6);
  assert.ok(m2.excludedUnknown.trips > 0 && !m2.drvCells.has("_unknown"));
  assert.strictEqual(model.excludedUnknown, null);
}

assert.ok(!model.devById.has("d4"), "excluded group");
assert.strictEqual(model.vtypeOf.get("d1"), "bitren");
assert.strictEqual(model.vtypeOf.get("d2"), "camion");
assert.strictEqual(model.serviceOf.get("d3"), "larga");
assert.strictEqual(model.serviceSource.get("d3"), "grupo");

// journeys: A->B for d1 (first one origin unknown)
const j1 = model.journeys.filter(j => j.d === "d1");
console.log("d1 journeys", j1.length, j1.slice(0, 3).map(j => j.oName + "→" + j.destName + " " + j.km));
const all = new Set(model.devices.map(d => d.id));
const vr = GI.vehicleRows(model, all);
const r1 = vr.find(r => r.id === "d1"), r2 = vr.find(r => r.id === "d2");
console.log("d1 l100", r1.l100, "km", r1.km, "fuel", r1.fuelL, "idle%", GI.round(r1.idlePct, 1), "risk", GI.round(r1.risk, 2));
console.log("d2 l100", r2.l100, "idle%", GI.round(r2.idlePct, 1), "idleL", r2.idleL, "excessH", GI.round(r2.idleExcessH, 1), "flags", r2.flags);
assert.ok(Math.abs(r1.l100 - 50) < 0.01, "bitren L/100 = 50");
assert.ok(Math.abs(r2.l100 - 30) < 0.01, "camion L/100 = 30");
assert.strictEqual(r1.km, 300 * 14);
assert.strictEqual(r1.idleL, 28, "idle measured 2 L/day");
assert.ok(r2.flags.includes("ralenti"));
// d1 seatbelt events: 14 events * 1.5 weight / 4200 km * 100
assert.ok(Math.abs(r1.risk - (14 * 1.5 / 4200) * 100) < 1e-9);

const dr = GI.driverRows(model, all);
const u1 = dr.find(r => r.id === "u1");
console.log("drivers", dr.map(r => r.name + " km=" + r.km + " risk=" + GI.round(r.risk, 2) + " ev=" + r.events));
assert.strictEqual(u1.events, 14, "events attributed to driver via trip");
assert.ok(Math.abs(u1.fuelL - r1.fuelL) < 1e-6);

const rr = GI.routeRows(model, all);
console.log("routes", rr.map(r => r.from + "→" + r.to + " n=" + r.n + " risk=" + GI.round(r.risk, 2)));

for (const g of ["day", "week", "month"]) {
  const s = GI.series(model, all, g);
  console.log(g, s.length, s.slice(0, 2).map(x => x.label + " km=" + x.km + " l100=" + GI.round(x.l100, 1)));
}
const imp = GI.milestoneImpact(model, { date: "2026-09-08", categories: ["cinturon"], group_ids: [] }, 28);
console.log("impact days", imp.days, imp.beforeRange, imp.afterRange, "riskChange", imp.riskChange, imp.catRows);
assert.strictEqual(imp.days, 7);

const pr = GI.profileRows(model, all);
console.log("profiles", pr.map(p => p.profile + " v=" + p.vehicles + " l100=" + GI.round(p.l100, 1)));
const f = GI.findings(model, all, vr, dr);
console.log("findings", f.map(x => "[" + x.type + "] " + x.title));
console.log("savings", GI.savings(vr, 1000));
assert.strictEqual(GI.bucketKey("2026-09-03", "week"), "2026-08-31");
assert.strictEqual(GI.durationToHours("1.02:00:00"), 26);
assert.strictEqual(GI.durationToHours("00:11:42.0300000").toFixed(4), (11 / 60 + 42.03 / 3600).toFixed(4));
// Parada corta en una zona intermedia no corta el recorrido
{
  const zs = [{ id: "zA", name: "A", pts: sq(0, 0, 1), bbox: [0, 0, 1, 1] }, { id: "zM", name: "M", pts: sq(5, 5, 1), bbox: [5, 5, 6, 6] }, { id: "zB", name: "B", pts: sq(10, 10, 1), bbox: [10, 10, 11, 11] }];
  const zoneAt = GI.makeZoneLocator(zs);
  const t0 = Date.UTC(2026, 8, 1, 10);
  const tr = [
    { s: t0 - 3600000, e: t0 - 3000000, km: 1, dh: .1, ih: 0, x: .5, y: .5 },             // termina en A
    { s: t0, e: t0 + 3600000, km: 100, dh: 1, ih: 0, x: 5.5, y: 5.5 },                       // llega a M
    { s: t0 + 3600000 + 5 * 60000, e: t0 + 7200000, km: 100, dh: 1, ih: 0, x: 10.5, y: 10.5 }, // 5 min en M y sigue a B
  ];
  const js = GI.buildJourneys(new Map([["d", tr]]), zoneAt, 10, 20);
  const main = js.find(j => j.km >= 200);
  assert.ok(main, "A→B en un solo recorrido");
  assert.strictEqual(main.oName + "→" + main.destName, "A→B");
  const js2 = GI.buildJourneys(new Map([["d", tr]]), zoneAt, 10, 2);
  assert.ok(js2.some(j => j.destName === "M"), "con mínimo 2 min sí corta en M");
}
// Tendencia lineal
{
  const t = GI.linearTrend([1, 2, 3, 4, 5]);
  assert.ok(Math.abs(t.slope - 1) < 1e-9 && Math.abs(t.at(2) - 7) < 1e-9 && t.periodsTo(8) === 3);
}
// Exposición: km de la matriz = km de viajes; eventos de la matriz = eventos de riesgo.
{
  const ids = GI.filterDevices(model, {});
  const ex = GI.exposure(model, ids, null);
  let gk = 0, gn = 0;
  for (const row of ex.grid) for (const c of row) { gk += c.km; gn += c.n; }
  const tk = GI.sum([...model.tripsByDevice].filter(([d]) => ids.has(d)).flatMap(([, ts]) => ts), t => t.km > 0 ? t.km : 0);
  assert.ok(Math.abs(gk - tk) < 1e-6 * Math.max(1, tk), "km de la matriz " + gk + " vs viajes " + tk);
  assert.strictEqual(gn, model.events.filter(e => e.w > 0 && ids.has(e.d)).length);
  // spreadTrip reparte proporcional al tiempo
  const parts = [];
  const s = new Date(2026, 0, 5, 10, 30).getTime();
  GI._spreadTrip({ s, e: s + 2 * 3600000, km: 100, dh: 2 }, (di, h, km) => parts.push([h, Math.round(km)]));
  assert.strictEqual(JSON.stringify(parts), JSON.stringify([[10, 25], [11, 50], [12, 25]]));
  for (const d of ex.drivers) {
    assert.ok(d.expected >= 0 && d.actual >= 0);
    assert.ok(d.nightPct == null || (d.nightPct >= 0 && d.nightPct <= 100));
  }
}
// Factores de riesgo: los km de los tramos de fatiga suman los km de viajes.
{
  const ids = GI.filterDevices(model, {});
  const ex = GI.exposure(model, ids, null);
  const rmap = new Map(ex.routes.filter(r => r.stable && r.idx != null).map(r => [r.key, r.idx]));
  const rf = GI.riskFactors(model, ids, null, rmap, ex.fleetIdx);
  const fk = GI.sum(rf.fatigue.buckets, b => b.km);
  assert.ok(Math.abs(fk - ex.totKm) < 1e-6 * Math.max(1, fk), "km fatiga " + fk + " vs " + ex.totKm);
  const trips = [{ s: 0, e: 100 }, { s: 200, e: 300 }];
  assert.strictEqual(GI._findTrip(trips, 250), 1);
  assert.strictEqual(GI._findTrip(trips, -5), -1);
  for (const d of rf.fatigue.drivers) assert.ok(["alta", "media", "baja"].includes(d.level));
}
// Sol: Neuquén 19/10/2026 sale ~06:41 y se pone ~19:55 (hora argentina).
{
  const st = GI.sunTimes(new Date("2026-10-19T15:00:00Z").getTime(), -38.95, -68.06);
  const hm = ms => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };
  assert.ok(Math.abs(hm(st.rise) - (6 * 60 + 41)) <= 5, "salida " + new Date(st.rise));
  assert.ok(Math.abs(hm(st.set) - (19 * 60 + 55)) <= 6, "puesta " + new Date(st.set));
  // Un viaje de 18 a 22 h en junio en Neuquén es casi todo de noche (puesta ~18:18).
  const a = new Date(2026, 5, 21, 18).getTime(), b = new Date(2026, 5, 21, 22).getTime();
  const fJun = GI._darkFraction(a, b, -38.95, -68.06);
  assert.ok(fJun > 0.9, "junio " + fJun);
  // El mismo horario en diciembre (puesta ~20:58) es mitad de noche.
  const c = new Date(2026, 11, 21, 18).getTime(), d = new Date(2026, 11, 21, 22).getTime();
  const fDic = GI._darkFraction(c, d, -38.95, -68.06);
  assert.ok(fDic > 0.15 && fDic < 0.4, "diciembre " + fDic);
}
// Por qué cambió el riesgo, antes/después de un hito: regla nueva y cambio de flota.
{
  const days = GI.dayRange("2026-03-01", "2026-04-30");
  const dd = new Map();
  const put = (dev, dk, km, ev) => {
    if (!dd.has(dev)) dd.set(dev, new Map());
    const er = {}, evc = {};
    let w = 0, n = 0;
    for (const [rule, cat, k] of ev) { er[rule] = (er[rule] || 0) + k; evc[cat] = (evc[cat] || 0) + k; w += k * (cat === "giro_brusco" ? 1.2 : 1.5); n += k; }
    dd.get(dev).set(dk, { km, w, n, ev: evc, er });
  };
  for (const dk of days) {
    const after = dk >= "2026-04-01";
    // vA sigue igual todo el período: 100 km/día y 1 exceso
    put("vA", dk, 100, [["rVel", "velocidad", 1]]);
    // vB (ruta, pocos eventos) sale de la flota en abril
    if (!after) put("vB", dk, 400, [["rVel", "velocidad", 1]]);
    // regla nueva de giros desde abril
    if (after) put("vA", dk, 100, [["rVel", "velocidad", 1], ["rGiro", "giro_brusco", 1]]);
  }
  const fm = {
    dayKeys: days, dd, drvCells: new Map(), devices: [{ id: "vA", name: "A" }, { id: "vB", name: "B" }],
    profileOf: id => (id === "vB" ? "camion|larga" : "liviano|corta"), driverName: new Map(),
    settings: { category_weights: { velocidad: 1.5, giro_brusco: 1.2 }, rule_mapping: { rVel: "velocidad", rGiro: "giro_brusco" } },
    cat: { rules: [{ id: "rVel", name: "SPEED" }, { id: "rGiro", name: "Harsh cornering" }] },
  };
  const rc = GI.riskChange(fm, new Set(["vA", "vB"]), "week", null, { date: "2026-04-01", title: "Bus" });
  assert.ok(rc.b > rc.a * 3, "sube mucho: " + rc.a + " → " + rc.b);
  assert.strictEqual(rc.newRules.length, 1);
  assert.strictEqual(rc.newRules[0].name, "Harsh cornering");
  // con las mismas reglas y sin el cambio de flota, vA no cambió
  assert.ok(Math.abs(rc.fleet.kept.rate[0] - 1.5) < 1e-9);
  assert.strictEqual(rc.fleet.left.n, 1);
  assert.ok(rc.sameRules.b > rc.sameRules.a, "sin regla nueva igual sube por flota");
  assert.ok(rc.fleet.effect > 0);
  assert.ok(Math.abs(rc.mix + rc.within - (rc.b - rc.a)) < 1e-9, "mezcla + conducta = cambio total");
}
// Jornadas por pausas: turno noche = una jornada; el descanso real es el previo.
{
  const T = (d, h, m) => new Date(2026, 9, d, h, m).getTime();
  const trips = [];
  const add = (s, e, km) => trips.push({ d: "v1", r: "L", s, e, dh: (e - s) / 3600000 * 0.7, km });
  // sáb 24 08:39 → dom 25 06:07 con pausas cortas
  for (let t = T(24, 8, 39); t < T(25, 6, 7); t += 3 * 3600000) add(t, Math.min(t + 2.5 * 3600000, T(25, 6, 7)), 80);
  // dom 25 19:09 → lun 26 07:52
  for (let t = T(25, 19, 9); t < T(26, 7, 52); t += 2 * 3600000) add(t, Math.min(t + 1.8 * 3600000, T(26, 7, 52)), 60);
  // lun 26 19:03 → mar 27 03:45
  for (let t = T(26, 19, 3); t < T(27, 3, 45); t += 2 * 3600000) add(t, Math.min(t + 1.5 * 3600000, T(27, 3, 45)), 50);
  const fm = { settings: { fatigue: {}, severity: {} }, tripsByDevice: new Map([["v1", trips]]), events: [], journeys: [], dayKeys: GI.dayRange("2026-10-20", "2026-10-27"), driverName: new Map([["L", "Leandro"]]) };
  const rf = GI.riskFactors(fm, new Set(["v1"]), null, new Map(), 1);
  const d = rf.fatigue.drivers.find(x => x.id === "L");
  const days = d.dayList.map(j => [j.dk, GI.round(j.span, 1), j.restBefore == null ? null : GI.round(j.restBefore, 1)]);
  assert.strictEqual(days.length, 3, JSON.stringify(days));
  assert.strictEqual(days[0][0], "2026-10-24"); assert.ok(days[0][1] > 21, "sábado " + days[0][1]);
  assert.strictEqual(days[1][0], "2026-10-25"); assert.ok(Math.abs(days[1][2] - 13) < 0.2, "descanso dom " + days[1][2]);
  assert.strictEqual(days[2][0], "2026-10-26"); assert.ok(days[2][2] > 10 && days[2][2] < 12, "descanso lun " + days[2][2]);
}
// Fatiga: señales por jornada, nivel y jornada en curso.
{
  const T = (d, h, m) => new Date(2026, 9, d, h, m || 0).getTime();
  const trips = [];
  const add = (s, hrs) => { trips.push({ d: "v1", r: "L", s, e: s + hrs * 3600000, dh: hrs, km: hrs * 70 }); return s + hrs * 3600000; };
  // 19 y 20: turno día 06–16
  for (const d of [19, 20]) { let t = T(d, 6); t = add(t, 3) + 1800000; add(t, 3); }
  // 20 → 21: turno noche 21–08 tras 5 h de descanso de día; 4,6 h seguidas; madrugada
  { let t = T(20, 21); t = add(t, 4.6) + 0.4 * 3600000; t = add(t, 4) + 0.6 * 3600000; add(t, 1.8); }
  const ev = [];
  [0, 12, 25, 40].forEach((m, i) => ev.push({ d: "v1", drv: "L", t: T(21, 3) + m * 60000, cat: i % 2 ? "salida_carril" : "fatiga", w: 1.5 }));
  // en curso: empezó hace 7 h
  const now = T(26, 15);
  { let t = now - 7 * 3600000; t = add(t, 3.4) + 0.3 * 3600000; add(t, 3.2); }
  const fm = { settings: { fatigue: {} }, tripsByDevice: new Map([["v1", trips]]), events: ev };
  const { shifts, limits } = GI.buildShifts(fm, new Set(["v1"]), null, { now });
  const night = shifts.find(j => j.dk === "2026-10-20" && j.type === "noche");
  assert.ok(night, JSON.stringify(shifts.map(j => [j.dk, j.type])));
  const keys = night.signals.map(x => x.key).sort().join(",");
  for (const k of ["cambio", "continuo", "descanso", "madrugada", "manejo", "indice"]) assert.ok(keys.includes(k), k + " en " + keys);
  assert.ok(!keys.includes("camara"), "las cámaras no son señal");
  assert.strictEqual(night.level, "alto");
  assert.strictEqual(night.camCluster, 4);
  assert.ok(Math.abs(night.low - 3) < 0.01, "02–05 " + night.low);
  const day = shifts.find(j => j.dk === "2026-10-19");
  assert.strictEqual(day.level, "bajo", JSON.stringify(day.signals));
  const open = shifts.filter(j => j.open);
  assert.strictEqual(open.length, 1);
  const pr = GI.shiftProgress(open[0], limits, now);
  const drive = pr.items.find(x => x.key === "drive"), stint = pr.items.find(x => x.key === "stint");
  assert.ok(Math.abs(drive.v - 6.6) < 0.01 && drive.level === "ok");
  assert.ok(stint.v > 3.1 && stint.level === "amarillo", "continuo " + stint.v + " " + stint.level);
  assert.ok(drive.at > now && drive.at < now + 4 * 3600000);
  // índice de fatiga: el turno noche tras descansar de día termina alto; el diurno, bajo
  assert.ok(night.fiPeak >= 100 && night.signals.some(x => x.key === "indice"), "índice noche " + night.fiPeak);
  // proyección: la jornada en curso
  const pj = GI.projectIndex(GI.buildShifts(fm, new Set(["v1"]), null, { now }).sims.get("L"), limits, now, 16);
  assert.ok(pj.open && pj.pts.length > 10 && pj.peak >= pj.Fnow && typeof pj.action === "string");
  assert.ok(day.fiPeak < 80, "índice día " + day.fiPeak);
  const oi = GI.openShiftIndex(open[0], shifts.filter(j => j.drv === "L").reverse(), open[0].sim, limits, now);
  assert.ok(oi.Fnow > 30 && oi.peak >= oi.Fnow);
  // próximo turno: después de un turno noche, descanso recomendado razonable
  const fm3 = { settings: { fatigue: {} }, tripsByDevice: new Map([["v1", trips.filter(t => t.s < T(22, 0))]]), events: [] };
  const r3 = GI.buildShifts(fm3, new Set(["v1"]), null, { now: T(21, 14) });
  const nx = r3.sims.get("L").next;
  assert.ok(nx && nx.start > T(21, 14) && nx.needRest >= 8 && nx.needRest <= 30, JSON.stringify(nx && { s: new Date(nx.start).toString(), r: nx.needRest, p: nx.peak }));
  // en vivo: el vehículo está manejando hace 4 min (todavía no hay viaje registrado)
  const lt = GI.liveTrips(fm, trips, [{ d: "v1", r: null, driving: true, since: now - 4 * 60000 }], 36, now);
  const live = GI.buildShifts(fm, new Set(["v1"]), null, { now, tripsByDevice: lt }).shifts.find(j => j.open);
  assert.ok(live.live && GI.shiftProgress(live, limits, now).driving);
}
// Descanso: lugar, motor en marcha, esperas y rotación.
{
  const T = (d, h, m) => new Date(2026, 9, d, h, m || 0).getTime();
  const base = { id: "zB", name: "Base Neuquén", types: ["ZoneTypeOfficeId"] }, cli = { id: "zC", name: "Planta Añelo", types: ["ZoneTypeCustomerId"] };
  const zoneAtPlace = (x, y) => (x === 1 ? base : x === 2 ? cli : null);
  const trips = [];
  const add = (s, hrs, x) => { trips.push({ d: "v1", r: "L", s, e: s + hrs * 3600000, dh: hrs, km: hrs * 70, x, y: 0 }); return s + hrs * 3600000; };
  // día 1: sale de base, espera 3 h en la planta, vuelve a base
  { let t = T(5, 6); t = add(t, 3, 2) + 3 * 3600000; add(t, 3, 1); }
  // día 2 turno día terminando en ruta; descansa en ruta con motor en marcha 6 h
  { let t = T(6, 6); add(t, 8, 9); }
  // día 2 noche (rotación hacia adelante) y día 3 de día (hacia atrás)
  { let t = T(6, 22); add(t, 8, 1); }
  { let t = T(7, 13); add(t, 6, 1); }
  // franco largo y primera noche
  { let t = T(10, 21); add(t, 8, 1); }
  const idle = [{ d: "v1", t: T(6, 14, 10), h: 6 }];
  const fm = { settings: { fatigue: {} }, tripsByDevice: new Map([["v1", trips]]), events: [], idle, zoneAtPlace };
  const r = GI.buildShifts(fm, new Set(["v1"]), null, { now: T(20, 0) });
  const L = r.sims.get("L").list;
  assert.strictEqual(L[0].waits.length, 1); assert.strictEqual(L[0].waits[0].place.name, "Planta Añelo"); assert.ok(Math.abs(L[0].waits[0].h - 3) < 1e-6);
  assert.strictEqual(L[1].restPlace.kind, "base");
  const n2 = L[2];
  assert.strictEqual(n2.restPlace.kind, "ruta"); assert.ok(n2.restEngine && n2.signals.some(x => x.key === "motor"), JSON.stringify(n2.signals));
  assert.strictEqual(n2.rotation, "adelante"); assert.strictEqual(L[3].rotation, "atras");
  assert.ok(L[4].signals.some(x => x.key === "francos"));
  const rot = r.sims.get("L").rot;
  assert.strictEqual(rot.back, 1); assert.strictEqual(rot.fwd, 1); assert.strictEqual(rot.afterOff, 1); assert.ok(rot.startSd > 3);
  // con el motor en marcha se recupera menos: arranca la noche más cansado que sin ralentí
  const r2 = GI.buildShifts({ ...fm, idle: [] }, new Set(["v1"]), null, { now: T(20, 0) });
  assert.ok(n2.fiStart > r2.sims.get("L").list[2].fiStart + 3, n2.fiStart + " vs " + r2.sims.get("L").list[2].fiStart);
}
// Viaje con 7 h de ralentí adentro (durmió con el motor en marcha): se parte y el ralentí es el descanso.
{
  const T = (h) => new Date(2026, 9, 12, 0, 0).getTime() + h * 3600000;
  const trips = [{ d: "v1", r: "L", s: T(8), e: T(24), dh: 9, km: 600, ih: 7.2, x: 5, y: 5 }];
  const idle = [{ d: "v1", t: T(16), h: 7 }];
  const r = GI.buildShifts({ settings: { fatigue: {} }, tripsByDevice: new Map([["v1", trips]]), events: [], idle }, new Set(["v1"]), null, { now: T(48) });
  const L = r.sims.get("L").list;
  assert.strictEqual(L.length, 2, L.map(j => j.span).join(","));
  assert.ok(Math.abs(L[1].restBefore - 7) < 0.01 && L[1].restEngine);
  assert.ok(Math.abs(L[0].dh + L[1].dh - 9) < 1e-6);
}
// Diagramas: 14x7 detectado, día 15 de la vuelta, franco corto y franco en curso.
{
  const D = (n, h) => new Date(2026, 6, 1 + n, h || 0).getTime();
  const trips = [];
  const work = (d0, n) => { for (let d = d0; d < d0 + n; d++) trips.push({ d: "v1", r: "L", s: D(d, 7), e: D(d, 17), dh: 9, km: 600 }); };
  work(0, 14); work(21, 14); work(42, 16); /* 2 días de más */ work(61, 14); /* volvió con 3 de franco */ work(81, 14);
  const now = D(97, 12); // terminó el día 94: de franco
  const r = GI.buildShifts({ settings: { fatigue: {} }, tripsByDevice: new Map([["v1", trips]]), events: [] }, new Set(["v1"]), null, { now });
  const e = r.sims.get("L");
  assert.strictEqual(e.rs.label, "14x7"); assert.strictEqual(e.rs.source, "auto");
  const L = e.list;
  const d57 = L.find(j => GI.dayKey(j.s) === GI.dayKey(D(57)));
  assert.ok(d57.cycleDay === 16 && d57.signals.some(x => x.key === "seguidos"), d57.cycleDay);
  const d10 = L.find(j => GI.dayKey(j.s) === GI.dayKey(D(10)));
  assert.ok(!d10.signals.some(x => x.key === "seguidos"), "día 11 de 14 no es 'días seguidos'");
  const d60 = L.find(j => GI.dayKey(j.s) === GI.dayKey(D(61)));
  assert.ok(d60.signals.some(x => x.key === "franco"), JSON.stringify(d60.signals));
  assert.ok(e.rs.inFranco && e.rs.backAt >= D(102) && e.rs.backAt <= D(102, 1), new Date(e.rs.backAt).toString());
  const pj = GI.projectIndex(e, r.limits, now, 16);
  assert.ok(pj.franco && /De franco/.test(pj.action), pj.action);
  assert.ok(e.next.start >= D(102), new Date(e.next.start).toString());
  // manual: 7x7
  const r2 = GI.buildShifts({ settings: { fatigue: {} }, tripsByDevice: new Map([["v1", trips]]), events: [] }, new Set(["v1"]), null, { now, rosters: new Map([["L", { work: 7, off: 7 }]]) });
  assert.strictEqual(r2.sims.get("L").rs.label, "7x7");
}
// Movimiento mínimo durante el descanso (encendió el camión a la 01:20, 3 min, 0 km): no corta el descanso.
{
  const T = (d, h, m) => new Date(2026, 9, d, h, m || 0).getTime();
  const trips = [
    { d: "v1", r: "L", s: T(28, 8), e: T(28, 18), dh: 8, km: 500, x: 1, y: 1 },
    { d: "v1", r: "L", s: T(28, 22, 0), e: T(28, 22, 3), dh: 0.05, km: 0.1, x: 1, y: 1 },
    { d: "v1", r: "L", s: T(29, 1, 20), e: T(29, 1, 30), dh: 0.05, km: 0, x: 1, y: 1 },
    { d: "v1", r: "L", s: T(29, 6), e: T(29, 16), dh: 8, km: 500, x: 1, y: 1 },
  ];
  const r = GI.buildShifts({ settings: { fatigue: {} }, tripsByDevice: new Map([["v1", trips]]), events: [] }, new Set(["v1"]), null, { now: T(30, 0) });
  const L = r.sims.get("L").list;
  assert.strictEqual(L.length, 2, L.map(j => new Date(j.s) + " " + j.span).join(" | "));
  assert.ok(Math.abs(L[1].restBefore - 12) < 1e-6);
  assert.strictEqual(L[1].restMicro.length, 2);
  assert.ok(L[1].restIdle.length === 1, "la de 10 min cuenta como motor en marcha");
  // con el control desactivado, el movimiento corta el descanso
  const r2 = GI.buildShifts({ settings: { fatigue: { micro_km: 0, micro_min: 0 } }, tripsByDevice: new Map([["v1", trips]]), events: [] }, new Set(["v1"]), null, { now: T(30, 0) });
  assert.ok(r2.sims.get("L").list.length === 1 || r2.sims.get("L").list[1].restBefore < 12);
}
// Relevo: el camión trabaja 24 h con dos conductores; el ralentí mientras maneja el otro no es "descanso con motor".
{
  const T = (d, h, m) => new Date(2026, 9, d, h, m || 0).getTime();
  const trips = [], idle = [];
  for (const d of [23, 24, 25]) {
    trips.push({ d: "v1", r: "A", s: T(d - 1, 17), e: T(d, 5, 50), dh: 9, km: 500 });  // A de noche
    trips.push({ d: "v1", r: "B", s: T(d, 6), e: T(d, 16, 40), dh: 8, km: 400 });      // B de día
    idle.push({ d: "v1", t: T(d, 9), h: 1.5, r: "B" }, { d: "v1", t: T(d, 12), h: 1.5, r: null });
  }
  const r = GI.buildShifts({ settings: { fatigue: {} }, tripsByDevice: new Map([["v1", trips.sort((a, b) => a.s - b.s)]]), events: [], idle }, new Set(["v1"]), null, { now: T(28, 0) });
  for (const drv of ["A", "B"]) for (const j of r.sims.get(drv).list.slice(1)) {
    assert.ok(!j.restEngine, drv + " " + new Date(j.s) + " idle " + j.restIdleH);
    assert.ok(j.restHandover && j.restHandover.drv === (drv === "A" ? "B" : "A"));
  }
}
// Revisar identificación: jornada de 25 h por un relevo sin llave; confirmado el relevo, se parte.
{
  const T = (d, h, m) => new Date(2026, 9, d, h, m || 0).getTime();
  const trips = [];
  const block = (r, s, hrs) => { for (let t = s; t < s + hrs * 3600000 - 1800000; t += 3600000) trips.push({ d: "v1", r, s: t, e: t + 3000000, dh: 0.8, km: 50 }); };
  block("A", T(22, 17), 6.5); block("A", T(23, 4, 16), 13); block("A", T(23, 17, 29), 12.4); block("B", T(24, 6), 10.7); block("A", T(24, 17), 12.8);
  trips.sort((a, b) => a.s - b.s);
  const fm = { settings: { fatigue: {} }, tripsByDevice: new Map([["v1", trips]]), events: [] };
  const r = GI.buildShifts(fm, new Set(["v1"]), null, { now: T(27, 0) });
  const long = r.sims.get("A").list.find(j => j.span > 20);
  assert.ok(long && long.signals.some(x => x.key === "ident"), JSON.stringify(r.sims.get("A").list.map(j => j.span)));
  const r2 = GI.buildShifts(fm, new Set(["v1"]), null, { now: T(27, 0), identFixes: [{ drv: "A", d: "v1", from: long.s, to: T(23, 17, 29), other: "B" }] });
  assert.ok(r2.sims.get("A").list.every(j => j.span < 20), "partida");
  assert.ok(r2.sims.get("B").list.some(j => GI.dayKey(j.s) === GI.dayKey(T(23, 4))), "el tramo pasó a B");
}
// Validación del índice: el ajuste de Poisson recupera la pendiente.
{
  const bins = [];
  for (let F = 5; F < 160; F += 10) { const h = 100; bins.push({ F, h, n: Math.round(h * 0.05 * Math.exp(1.5 * F / 100)) }); }
  const f = GI.poissonFit(bins);
  assert.ok(Math.abs(f.b - 1.5) < 0.1, "b " + f.b);
  assert.ok(GI.poissonFit([{ F: 5, h: 0, n: 0 }]) === null);
}
// Corredores v2: riesgo del camino ajustado por conductor.
{
  const RD = GI._road;
  // aggregateWindow: histograma, anda y para y tiempo sobre el límite
  const t0 = new Date(2026, 9, 10, 17, 0, 0).getTime();
  const recs = [];
  for (let i = 0; i <= 30; i++) recs.push({ device: { id: "dA" }, dateTime: new Date(t0 + i * 10000).toISOString(), latitude: -38.9 + i * 0.2 / 111.2, longitude: -68.0, speed: i === 15 ? 40 : 72 });
  const acc = new Map(), rep = new Map();
  RD.aggregateWindow(recs, acc, { limitAt: () => 60, rep });
  let sg = 0, over = 0, limSec = 0, hsum = 0;
  for (const r of acc.values()) { sg += r[8]; over += r[9]; limSec += r[10]; hsum += r[7].reduce((a, b) => a + b, 0); }
  assert.strictEqual(sg, 1, "anda y para " + sg);
  assert.ok(limSec === 300 && over > 250, "sobre el límite " + over);
  assert.ok(Math.abs(hsum - 300) < 1e-6);
  assert.ok(rep.size >= 6);
  assert.strictEqual(RD.normRoad("Tramo 3 Ruta 7 110kmh"), "RP7");
  assert.strictEqual(RD.normRoad("RN 22"), "RN22");
  assert.ok(RD.isControlName("RP7 - Chañar a Picada 11 - 110kmh") && !RD.isControlName("#IMSEGZONE"));
  // Tramos con GetAddresses: urbano (número), geocerca de control, ruta sin geocerca
  const cells = new Map([["c1", 10], ["c2", 10], ["c3", 5], ["c4", 1]]);
  const addr = new Map([
    ["c1", { city: "", street: "RP7", num: "", zones: ["zIm", "zA"] }],
    ["c2", { city: "", street: "RP7", num: "", zones: ["zA", "zRad"] }],
    ["c3", { city: "Añelo", street: "RP7", num: "120", zones: [] }],
    ["c4", { city: "", street: "RP17", num: "", zones: [] }],
  ]);
  const names = new Map([["zIm", "#IMSEGZONE"], ["zA", "RP7 - Chañar a Picada 11 - 110kmh"], ["zRad", "Ruta 7: Zona Radar El Cruce 60kmh"]]);
  // celdas reales para los centros
  const real = ["-3890:-5292", "-3889:-5292", "-3888:-5292", "-3887:-5292"];
  const cells2 = new Map(real.map((k, i) => [k, [...cells.values()][i]]));
  const addr2 = new Map(real.map((k, i) => [k, addr.get("c" + (i + 1))]));
  const built = GI.buildTramos(cells2, addr2, names);
  const tr = [...built.tramos.values()];
  const zA = tr.find(t => t.zoneId === "zA");
  assert.ok(zA && zA.cells.length === 2 && zA.limit === 110 && zA.route === "RP7", JSON.stringify(tr));
  assert.ok(tr.find(t => t.kind === "urbano" && t.name === "RP7 (Añelo)"));
  assert.ok(tr.find(t => t.kind === "ruta" && t.route === "RP17"));
  // Modelo: el conductor A (infractor) siempre maneja a las 17 h; B a las 10 h.
  const d0 = GI.parseDayKey("2026-10-10").getTime();
  const fakeModel = {
    vtypeOf: new Map([["dA", "liviano"], ["dB", "liviano"]]),
    tripsByDevice: new Map([["dA", [{ s: d0 + 17 * 3600000, e: d0 + 18 * 3600000, r: "A" }]], ["dB", [{ s: d0 + 10 * 3600000, e: d0 + 11 * 3600000, r: "B" }]]]),
  };
  const hist = new Array(16).fill(0); hist[7] = 600;
  const days = new Map([["2026-10-10", { devs: ["dA", "dB"], scale: 6, rows: [
    [0, real[0], 17, 10, 600, 72 * 600, 72 * 72 * 600, hist, 0, 0, 0, 0],
    [1, real[0], 10, 10, 600, 72 * 600, 72 * 72 * 600, hist, 0, 0, 0, 0],
  ] }]]);
  const evs = [], locs = new Map();
  for (let i = 0; i < 12; i++) { evs.push({ i: "a" + i, d: "dA", drv: "A", t: d0 + 17 * 3600000 + i * 60000, cat: "frenado_brusco", w: 1.3 }); locs.set("a" + i, GI._road.cellCenter(real[0])); }
  evs.push({ i: "b0", d: "dB", drv: "B", t: d0 + 10 * 3600000 + 60000, cat: "frenado_brusco", w: 1.3 }); locs.set("b0", GI._road.cellCenter(real[0]));
  const rm = GI.roadModel(fakeModel, days, new Set(["dA", "dB"]), built, evs, locs, {});
  const x = rm.tramos.find(t => t.zoneId === "zA");
  const f17 = x.franjas.find(f => f.key === "17-21"), f10 = x.franjas.find(f => f.key === "10-17");
  // Sin ajustar sería 12 contra 1 (×12). Ajustado por conductor, las dos franjas quedan parecidas.
  assert.ok(f17.envIdx / f10.envIdx < 1.6, "17h " + f17.envIdx + " vs 10h " + f10.envIdx);
  // Si B (prudente) también frena mucho a las 17 h, ahí sí la franja es riesgosa.
  const days2 = new Map([["2026-10-10", { devs: ["dA", "dB"], scale: 6, rows: [
    [1, real[0], 17, 10, 600, 72 * 600, 72 * 72 * 600, hist, 0, 0, 0, 0],
    [1, real[0], 10, 10, 600, 72 * 600, 72 * 72 * 600, hist, 0, 0, 0, 0],
  ] }]]);
  const fm2 = { vtypeOf: fakeModel.vtypeOf, tripsByDevice: new Map([["dB", [{ s: d0 + 10 * 3600000, e: d0 + 11 * 3600000, r: "B" }, { s: d0 + 17 * 3600000, e: d0 + 18 * 3600000, r: "B" }]]]) };
  const evs2 = [], locs2 = new Map();
  for (let i = 0; i < 8; i++) { evs2.push({ i: "c" + i, d: "dB", drv: "B", t: d0 + 17 * 3600000 + i * 60000, cat: "frenado_brusco", w: 1.3 }); locs2.set("c" + i, GI._road.cellCenter(real[0])); }
  evs2.push({ i: "c9", d: "dB", drv: "B", t: d0 + 10 * 3600000, cat: "frenado_brusco", w: 1.3 }); locs2.set("c9", GI._road.cellCenter(real[0]));
  const rm2 = GI.roadModel(fm2, days2, new Set(["dB"]), built, evs2, locs2, {});
  const y = rm2.tramos.find(t => t.zoneId === "zA");
  const g17 = y.franjas.find(f => f.key === "17-21"), g10 = y.franjas.find(f => f.key === "10-17");
  assert.ok(g17.envIdx / g10.envIdx > 2, "mismo conductor: 17h " + g17.envIdx + " vs 10h " + g10.envIdx);
  assert.ok(rm.routes.find(r => r.name === "RP7"));
}

// Contador de combustible con días sin lecturas: el consumo del hueco cae
// en el día siguiente y los km del hueco tienen que contar también.
{
  const cd = GI.counterDeltas;
  const daily = new Map([
    ["2026-10-01", { v1: { fv: 100, lv: 110 } }],
    ["2026-10-04", { v1: { fv: 150, lv: 160 } }],
  ]);
  const days = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];
  const out = cd(daily, days, days);
  assert.strictEqual(out.get("v1").get("2026-10-04"), 50);
  assert.deepStrictEqual(out.gaps.get("v1").get("2026-10-04"), ["2026-10-02", "2026-10-03"]);
}

// Vehículo sin comunicación: el descanso desde la última comunicación no se confirma.
{
  const now = Date.parse("2026-10-30T12:00:00Z");
  const lt = { d: "v9", r: "c9", s: now - 14 * 3600000, e: now - 10 * 3600000 };
  const entry = { list: [{ trips: [lt] }] };
  assert.strictEqual(GI.commGap(entry, [{ d: "v9", comm: true, at: now - 10 * 3600000 }], now), null);
  const g = GI.commGap(entry, [{ d: "v9", comm: false, at: now - 10 * 3600000 }], now);
  assert.ok(g && g.d === "v9" && Math.abs(g.h - 10) < 0.01);
  assert.strictEqual(GI.commGap(entry, [{ d: "v9", comm: false, r: "otro", at: now - 9 * 3600000 }], now), null);
  // un estado viejo "manejando" de un equipo sin comunicación no crea un viaje en vivo
  const fake = { tripsByDevice: new Map() };
  const tb = GI.liveTrips(fake, [], [{ d: "v9", r: "c9", driving: true, comm: false, since: now - 3600000 }], 24, now);
  assert.ok(!(tb.get("v9") || []).length);
}
console.log("OK");
