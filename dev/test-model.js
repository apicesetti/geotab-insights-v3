// Pruebas del modelo con datos sintéticos: node dev/test-model.js
const fs = require("fs");
const vm = require("vm");
const ctx = { window: {}, console, Date, Math, Map, Set, Number, JSON, Object, Array, String, Promise, setTimeout };
vm.createContext(ctx);
for (const f of ["util", "catalog", "model", "exposure"]) {
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
console.log("OK");
