// API simulado de MyGeotab/Drive para probar "Mi jornada" sin Geotab Drive.
// Ahora fijo = hoy 14:00. El conductor arrancó a las 06:00 y está detenido.
(function () {
  "use strict";
  const now = new Date(); now.setHours(14, 0, 0, 0);
  const at = (h, m, dd) => { const d = new Date(now); d.setDate(d.getDate() + (dd || 0)); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const dur = h => { const s = Math.round(h * 3600); return String(Math.floor(s / 3600)).padStart(2, "0") + ":" + String(Math.floor(s / 60) % 60).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); };
  const trips = [];
  let n = 0;
  const trip = (s, e, km, dd) => { const a = at(s[0], s[1], dd), b = at(e[0], e[1], dd);
    trips.push({ id: "t" + (++n), device: { id: "b1" }, driver: { id: "uMe" }, start: a, stop: b, distance: km, drivingDuration: dur((new Date(b) - new Date(a)) / 3600000) }); };
  for (let dd = -40; dd < 0; dd++) { if ((dd + 42) % 7 >= 5) continue; trip([6, 0], [11, 0], 380, dd); trip([12, 0], [15, 30], 260, dd); }
  trip([6, 0], [9, 30], 280); trip([10, 0], [13, 50], 270);
  const ev = (i, rule, dd, h) => ({ id: "e" + i, device: { id: "b1" }, driver: { id: "uMe" }, rule: { id: rule }, activeFrom: at(h, 10, dd), duration: "00:00:20", state: "Valid" });
  const exceptions = [];
  for (let i = 0; i < 40; i++) exceptions.push(ev(i, i % 3 ? "rSpeed" : "rBrake", -40 + i, 8));
  for (let i = 40; i < 46; i++) exceptions.push(ev(i, "rBelt", -6 + (i - 40), 10));
  const settings = { version: 3, configured: true, fatigue: { max_drive_day: 9, max_span: 12, min_rest: 8, max_continuous: 4, max_days_row: 6, rest_split: 4, fi_mod: 80, fi_high: 100 },
    rule_mapping: { rSpeed: "velocidad", rBrake: "frenado_brusco", rBelt: "cinturon" } };
  const chunk = JSON.stringify(settings);
  window.__phone = { lat: -38.9504, lon: -68.0578, acc: 15 };   // al lado del vehículo
  window.__vehicle = { lat: -38.9505, lon: -68.0580, driving: false, driver: "uMe" };
  window.__notifications = []; window.__spoken = [];
  const db = {
    User: [
      { id: "uMe", name: "jp@cesetti.com.ar", firstName: "Juan", lastName: "Pérez", isDriver: true, driverGroups: [{ id: "gChof" }] },
      { id: "u2", name: "ma@cesetti.com.ar", firstName: "María", lastName: "Álvarez", isDriver: true, driverGroups: [{ id: "gChof" }] },
      { id: "u3", name: "cr@cesetti.com.ar", firstName: "Carlos", lastName: "Ruiz", isDriver: true, driverGroups: [{ id: "gChof" }] },
      { id: "u4", name: "baja@cesetti.com.ar", firstName: "Pedro", lastName: "Baja", isDriver: true, driverGroups: [{ id: "gChof" }], activeTo: "2020-01-01T00:00:00Z" },
      { id: "u5", name: "llave", firstName: "Llave de mantenimiento", lastName: "", isDriver: true, driverGroups: [{ id: "gMant" }] },
    ],
    Trip: trips, ExceptionEvent: exceptions,
    Device: [{ id: "b1", name: "Camión 12", licensePlate: "AD123CD" }],
    DriverChange: [{ id: "dc1", device: { id: "b1" }, driver: { id: "uMe" }, dateTime: at(5, 55), type: "DriverKey" }],
    AddInData: [{ id: "aid1", addInId: "a2jBAg7PpaFdQpimkOJ7Ajg", details: { kind: "settings", rev: 3, part: 0, parts: 1, chunk } }],
  };
  window.__calls = [];
  function get(p) {
    const s = p.search || {};
    const tn = p.typeName;
    window.__calls.push(tn);
    if (tn === "DeviceStatusInfo") { const v = window.__vehicle; return [{ device: { id: "b1" }, driver: { id: v.driver }, isDriving: v.driving, currentStateDuration: "00:30:00", dateTime: new Date().toISOString(), latitude: v.lat, longitude: v.lon }]; }
    let l = (db[tn] || []).slice();
    if (s.name) l = l.filter(x => x.name === s.name);
    if (s.isDriver) l = l.filter(x => x.isDriver);
    if (s.id) l = l.filter(x => x.id === s.id);
    if (s.addInId) l = l.filter(x => x.addInId === s.addInId);
    if (s.deviceSearch) l = l.filter(x => x.device && x.device.id === s.deviceSearch.id);
    if (s.userSearch) l = l.filter(x => x.driver && x.driver.id === s.userSearch.id);
    const tk = { Trip: "start", ExceptionEvent: "activeFrom", DriverChange: "dateTime" }[tn];
    if (tk && s.fromDate) l = l.filter(x => x[tk] >= s.fromDate || (tn === "Trip" && x.stop >= s.fromDate));
    if (tk && s.toDate) l = l.filter(x => x[tk] <= s.toDate);
    return JSON.parse(JSON.stringify(l));
  }
  window.__added = [];
  function add(p) {
    window.__added.push(p);
    if (window.__denyAdd) throw new Error("Unauthorized: missing permission");
    if (p.typeName === "DriverChange" && p.entity.driver.id === "UnknownDriverId") window.__vehicle.driver = "UnknownDriverId";
    return "new" + window.__added.length;
  }
  window.__api = {
    call: (m, p, ok, err) => setTimeout(() => { try { ok(m === "Add" ? add(p) : get(p)); } catch (e) { err(e); } }, 5),
    multiCall: (calls, ok, err) => setTimeout(() => { try { ok(calls.map(c => get(c[1]))); } catch (e) { err(e); } }, 5),
    getSession: cb => setTimeout(() => cb({ userName: "jp@cesetti.com.ar", database: "intcesetti" }), 1),
    mobile: {
      exists: () => true,
      geolocation: { getCurrentPosition: (ok) => setTimeout(() => { const p = window.__phone; ok({ coords: { latitude: p.lat, longitude: p.lon, accuracy: p.acc }, timestamp: Date.now() }); }, 5) },
      notification: { notify: (msg, title) => { window.__notifications.push({ title, msg }); return Promise.resolve(); } },
      speak: t => window.__spoken.push(t),
      listenTo: () => {},
    },
  };
  window.__state = { device: "b1", driving: false, online: true };
})();
