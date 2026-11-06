// Pruebas de la lógica del add-in de Drive: node drive/test-core.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const ctx = { window: {}, console, Date, Math, Map, Set, Number, JSON, Object, Array, String, Promise, setTimeout, Float32Array, Intl };
vm.createContext(ctx);
for (const f of ["static/js/core/util", "static/js/core/catalog", "static/js/core/fatigue", "drive/core"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f + ".js"), "utf8"), ctx);
}
const GI = ctx.window.GI, D = GI.Drive;
const H = 3600000;
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

// Configuración: sin Insights → valores por defecto
const def = D.settingsFrom(null);
ok(!def.fromInsights && def.fatigue.max_span === 12 && def.fatigue.max_drive_day === 9, "límites por defecto");
const cfg = D.settingsFrom({ _rev: 7, fatigue: { max_span: 10, max_drive_day: 8 }, rule_mapping: { rSpeed: "velocidad", rBelt: "cinturon", rIdle: "ralenti" }, category_weights: { velocidad: 2 }, drive: { away: { distance_m: 300 } } });
ok(cfg.fromInsights && cfg.fatigue.max_span === 10 && cfg.fatigue.max_continuous === 4, "límites de Insights + resto por defecto");
ok(cfg.drive.away.distance_m === 300 && cfg.drive.away.poll_min === 2, "configuración drive se combina");

// Escenario: hoy arrancó a las 06:00, manejó 06:00–09:30 y 10:00–13:00; ahora 14:00
const now = new Date(2026, 10, 6, 14, 0).getTime();
const at = (h, m, dd) => new Date(2026, 10, 6 + (dd || 0), h, m).getTime();
const trip = (i, s, e, km, d) => ({ i, d: d || "b1", r: "me", s, e, km, dh: (e - s) / H });
const trips = [
  trip("t1", at(6, 0, -1), at(12, 0, -1), 400), trip("t2", at(13, 0, -1), at(15, 0, -1), 150),
  trip("t3", at(6, 0), at(9, 30), 280), trip("t4", at(10, 0), at(13, 0), 240),
];
const evs = D.myEvents([
  { i: "e1", d: "b1", r: null, rule: "rSpeed", t: at(7, 0), h: 0.01 },
  { i: "e2", d: "b1", r: "otro", rule: "rSpeed", t: at(8, 0), h: 0.01 },       // de otro conductor
  { i: "e3", d: "b1", r: "me", rule: "rBelt", t: at(11, 0), h: 0 },
  { i: "e4", d: "b1", r: "me", rule: "rIdle", t: at(11, 30), h: 0.2 },          // operativo: peso 0
  { i: "e5", d: "b1", r: "me", rule: "sinMapeo", t: at(12, 0), h: 0 },          // regla sin categoría
], trips, "me", cfg);
ok(evs.length === 3 && evs.every(e => e.drv === "me"), "eventos propios (sin conductor → por viaje)");

const rs = D.riskSummary(trips, evs, cfg, now);
ok(Math.abs(rs.cur.km - 1070) < 1e-6 && rs.cur.n === 2, "km y eventos del período");
ok(Math.abs(rs.cur.risk - (2 + 1.5) / 1070 * 100) < 1e-9, "índice = Σ peso / km × 100");
ok(rs.series.length === 8 && rs.byCat[0].key === "velocidad", "8 semanas y categorías ordenadas por peso");

const fs1 = D.fatigueState(trips, evs, cfg, "me", now, null);
ok(fs1.open, "jornada en curso (pausa < 4 h)");
const it = Object.fromEntries(fs1.open.progress.items.map(x => [x.key, x]));
ok(Math.abs(it.span.v - 8) < 1e-6 && Math.abs(it.span.left - 2) < 1e-6, "jornada: 8 h usadas, quedan 2 h (límite 10)");
ok(Math.abs(it.drive.v - 6.5) < 1e-6 && Math.abs(it.drive.left - 1.5) < 1e-6, "manejo: 6,5 h, quedan 1,5 h (límite 8)");
ok(it.stint.v === 0, "manejo continuo en 0 (pausa de 1 h)");

// manejando ahora mismo desde las 13:45 (todavía no llegó el viaje)
const fs2 = D.fatigueState(trips, evs, cfg, "me", now, { d: "b1", driving: true, since: at(13, 45) });
const it2 = Object.fromEntries(fs2.open.progress.items.map(x => [x.key, x]));
ok(Math.abs(it2.drive.v - 6.75) < 1e-6 && Math.abs(it2.stint.v - 0.25) < 1e-6 && fs2.open.progress.driving, "viaje en curso suma al manejo y al continuo");

// avisos de límite (80 %): jornada 8/10 = 80 %, manejo 6,5/8 = 81 %
const al = D.limitAlerts(fs1, cfg, {});
ok(al.length === 2 && al.every(a => a.level === "warn"), "avisos del 80 %");
const sent = Object.fromEntries(al.map(a => [a.key, 1]));
ok(D.limitAlerts(fs1, cfg, sent).length === 0, "no se repiten");

// descansando: 5 h después del último viaje → la jornada se cerró, falta descanso
const later = at(18, 0);
const fs3 = D.fatigueState(trips, evs, cfg, "me", later, null);
ok(!fs3.open && fs3.rest && Math.abs(fs3.rest.hours - 5) < 1e-6 && Math.abs(fs3.rest.left - 3) < 1e-6, "descanso: 5 h de 8, faltan 3");

// alejamiento
const veh = { d: "b1", name: "AB123CD", driver: "me", lat: -38.95, lon: -68.06, driving: false };
const far = { lat: -38.95, lon: -68.05, acc: 20 };    // ~ 865 m
const near = { lat: -38.9505, lon: -68.0601, acc: 20 };
ok(Math.abs(D.haversine(-38.95, -68.06, -38.95, -68.05) - 865) < 10, "haversine");
let r = D.awayCheck(null, veh, far, "me", cfg, now);
ok(r.status === "lejos" && !r.alert, "1.ª lectura lejos: todavía no avisa");
r = D.awayCheck(r.state, veh, far, "me", cfg, now + 2 * 60000);
ok(r.alert && r.alert.kind === "estacionado", "2.ª lectura lejos: avisa");
r = D.awayCheck(r.state, veh, far, "me", cfg, now + 4 * 60000);
ok(!r.alert, "no repite antes de 30 min");
const r2 = D.awayCheck(r.state, veh, near, "me", cfg, now + 6 * 60000);
ok(r2.status === "cerca" && r2.state.far === 0, "cerca: reinicia el conteo");
ok(D.awayCheck(null, Object.assign({}, veh, { driver: "otro" }), far, "me", cfg, now).status === "sin_vehiculo", "si ya no está identificado no avisa");
ok(D.awayCheck(null, veh, { lat: -38.95, lon: -68.05, acc: 900 }, "me", cfg, now).status === "impreciso", "lectura imprecisa se descarta");
let m = D.awayCheck(null, Object.assign({}, veh, { driving: true }), far, "me", cfg, now);
m = D.awayCheck(m.state, Object.assign({}, veh, { driving: true }), far, "me", cfg, now + 120000);
ok(m.alert && m.alert.kind === "en_movimiento", "vehículo en movimiento con mi identificación y yo lejos");

// mergeById
const mg = D.mergeById([{ i: "a", s: 1 }, { i: "b", s: 5 }], [{ i: "b", s: 6 }, { i: "c", s: 7 }], 2, "s");
ok(mg.length === 2 && mg[0].s === 6 && mg[1].i === "c", "mergeById pisa y recorta");

console.log("OK " + pass + " pruebas");
