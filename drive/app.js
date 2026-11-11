// Mi jornada — add-in de Geotab Drive (DriveAppLink/, onStartup).
//
// startup   corre al iniciar sesión en Drive, sin interfaz: carga datos y deja
//           corriendo el ciclo de revisión (límites de jornada y alejamiento).
// página    tarjetas de tiempo restante, fatiga, índice de riesgo y vehículo.
//
// Ciclo (cada 1 min revisa qué toca):
//   alejamiento         cada drive.away.poll_min (2 min): posición del teléfono vs vehículo
//   viajes recientes    cada drive.trips_refresh_min (10 min): jornada en curso y avisos
//   excepciones         cada drive.events_refresh_min (60 min): índice de riesgo
//   configuración       cada drive.config_refresh_min (60 min): límites de Insights
//
// API de Drive usada (guía de Drive Add-Ins de Geotab):
//   api.call / api.multiCall · api.getSession(callback[, newSession:boolean])  ← el 2.º NO es callback de error
//   api.mobile.exists() · api.mobile.geolocation.getCurrentPosition(ok, err, opts)
//   api.mobile.notification.notify(message, title) · api.mobile.notify(message, title, id) (anteriores)
//   api.mobile.speak(text) · api.mobile.listenTo(callback) · state.device, state.driving, state.online
//
// Ingeniero Jorge Cesetti SRL
(function (GI) {
  "use strict";
  const D = GI.Drive;
  const H = 3600000, MIN = 60000, DAY = 86400000;
  const LS = "mj.v1.";

  let api = null, wapi = null, state = null, root = null;
  let me = null, cfg = D.settingsFrom(null);
  let trips = [], rawEvents = [], rides = { records: [], vtrips: [] }, vehicle = null, phone = null, away = { status: "—" }, awayState = null;
  let last = { config: 0, trips: 0, events: 0, away: 0, fullTrips: 0 };
  let timer = null, busy = false, listening = false, error = null;
  let view = null; // resultados calculados
  let ui = { mode: null, q: "", busy: false, msg: null }; // mode: null | "unassign" | "relief"
  let drivers = null;

  // ---------- utilidades ----------
  const lsGet = (k, d) => { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } };
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const iso = t => new Date(t).toISOString();
  const isOnline = () => !state || state.online !== false;
  const hasMobile = () => { try { return !!(api && api.mobile && api.mobile.exists && api.mobile.exists()); } catch (e) { return false; } };
  const $ = sel => root && root.querySelector(sel);

  function loadCache() {
    me = lsGet("me", me);
    const sc = lsGet("settings", null);
    cfg = D.settingsFrom(sc);
    trips = lsGet("trips", []);
    rawEvents = lsGet("events", []);
    last = Object.assign(last, lsGet("last", {}));
    awayState = lsGet("away", null);
    rides = lsGet("rides", rides);
  }
  function saveCache() {
    lsSet("trips", trips); lsSet("events", rawEvents); lsSet("last", last); lsSet("away", awayState);
  }

  // ---------- datos ----------
  function loadMe() {
    return new Promise(resolve => {
      try { api.getSession(s => resolve(s && s.userName ? s.userName : "")); } catch (e) { resolve(""); }
    }).then(login => {
      if (!login) return me;
      if (me && me.login === login && me.id && me.groups) return me;
      return wapi.call("Get", { typeName: "User", search: { name: login }, propertySelector: { fields: ["id", "name", "firstName", "lastName", "driverGroups"], isIncluded: true } })
        .then(list => {
          const u = (list || [])[0];
          if (u) { me = { id: u.id, login: u.name, name: D.userName(u), groups: (u.driverGroups || []).map(GI.idOf) }; lsSet("me", me); }
          return me;
        });
    });
  }

  function loadConfig(force) {
    if (!force && Date.now() - last.config < cfg.drive.config_refresh_min * MIN) return Promise.resolve();
    return GI.loadShared(wapi).then(r => {
      const s = r && r.settings ? r.settings : null;
      // sin configuración visible: se queda con la última que se pudo leer (o la de fábrica)
      if (s) { lsSet("settings", s); cfg = D.settingsFrom(s); }
      else if (!lsGet("settings", null)) cfg = D.settingsFrom(null);
      last.config = Date.now();
    }).catch(() => { /* sin red o sin permiso: se mantiene la caché */ });
  }

  function loadTrips(force) {
    const now = Date.now();
    const keepFrom = now - Math.max(cfg.drive.risk_weeks * 7, cfg.drive.fatigue_days) * DAY - DAY;
    const full = force === "full" || now - last.fullTrips > 12 * H || !trips.length;
    if (!full && !force && now - last.trips < cfg.drive.trips_refresh_min * MIN) return Promise.resolve();
    const from = full ? keepFrom : now - 2 * DAY;
    return wapi.call("Get", {
      typeName: "Trip",
      search: { userSearch: { id: me.id }, fromDate: iso(from), toDate: iso(now) },
      propertySelector: { fields: ["id", "device", "driver", "start", "stop", "distance", "drivingDuration"], isIncluded: true },
    }).then(list => {
      const fresh = (list || []).map(D.compactTrip).map(t => Object.assign(t, { r: me.id }));
      trips = full ? D.mergeById([], fresh, keepFrom, "s") : D.mergeById(trips, fresh, keepFrom, "s");
      last.trips = now; if (full) last.fullTrips = now;
    });
  }

  function loadEvents(force) {
    const now = Date.now();
    if (!force && now - last.events < cfg.drive.events_refresh_min * MIN) return Promise.resolve();
    const keepFrom = now - cfg.drive.risk_weeks * 7 * DAY - DAY;
    const full = !rawEvents.length || now - (last.fullEvents || 0) > 24 * H;
    const from = full ? keepFrom : now - 7 * DAY;
    const devs = [...new Set(trips.filter(t => t.e >= from).map(t => t.d))];
    if (!devs.length) { last.events = now; return Promise.resolve(); }
    return wapi.multiCall(devs.map(d => ["Get", {
      typeName: "ExceptionEvent",
      search: { deviceSearch: { id: d }, fromDate: iso(from), toDate: iso(now) },
      propertySelector: { fields: ["id", "device", "driver", "rule", "activeFrom", "duration", "state"], isIncluded: true },
    }])).then(res => {
      const fresh = [].concat(...(res || []).map(x => x || [])).map(D.compactException).filter(Boolean)
        .filter(e => cfg.rule_mapping[e.rule]);
      rawEvents = full ? D.mergeById([], fresh, keepFrom, "t") : D.mergeById(rawEvents, fresh, keepFrom, "t");
      last.events = now; if (full) last.fullEvents = now;
    });
  }

  // Tramos como acompañante: tripulaciones de Horas de trabajo (AddInData) de los últimos
  // fatigue_days días y los viajes de esos vehículos en esos tramos.
  const WH = () => window.WorkingHoursShared || null;
  function loadRides(force) {
    const S = WH();
    const now = Date.now();
    if (!S || (!force && now - (last.rides || 0) < cfg.drive.trips_refresh_min * MIN)) return Promise.resolve();
    const dates = [];
    for (let i = cfg.drive.fatigue_days; i >= 0; i--) dates.push(S.addDays(S.dayKey(now), -i));
    const store = new S.Store((m, p) => wapi.call(m, p), calls => wapi.multiCall(calls));
    return store.recordsByDates(dates).then(recs => {
      const records = (recs || []).filter(r => r.type === S.ACK || (r.type === S.CREW && (r.members || []).some(m => m.userId === me.id)));
      const ivs = D.rideIntervals(records, me.id, now, S);
      const byDev = new Map();
      for (const iv of ivs) for (const d of iv.devices) {
        const cur = byDev.get(d) || { from: iv.from, to: iv.to };
        cur.from = Math.min(cur.from, iv.from); cur.to = Math.max(cur.to, iv.to); byDev.set(d, cur);
      }
      if (!byDev.size) { rides = { records, vtrips: [] }; return; }
      const devs = [...byDev.keys()];
      return wapi.multiCall(devs.map(d => ["Get", { typeName: "Trip",
        search: { deviceSearch: { id: d }, fromDate: iso(byDev.get(d).from - 6 * H), toDate: iso(byDev.get(d).to) },
        propertySelector: { fields: ["id", "device", "driver", "start", "stop", "distance", "drivingDuration"], isIncluded: true } }]))
        .then(res => { rides = { records, vtrips: [].concat(...(res || []).map(x => (x || []).map(D.compactTrip))) }; });
    }).then(() => { last.rides = now; lsSet("rides", rides); }).catch(() => { /* sin permiso o sin red: se mantiene la caché */ });
  }

  // Vehículo en el que estoy identificado: el de Drive y el del último cambio de conductor.
  function loadVehicle() {
    const now = Date.now();
    const cands = [];
    const sd = state && GI.idOf(state.device);
    if (sd && sd !== "NoDeviceId") cands.push(sd);
    return wapi.call("Get", { typeName: "DriverChange", search: { userSearch: { id: me.id }, fromDate: iso(now - DAY), toDate: iso(now) } })
      .catch(() => [])
      .then(chs => {
        const lastCh = (chs || []).filter(c => GI.idOf(c.driver) === me.id).sort((a, b) => new Date(b.dateTime) - new Date(a.dateTime))[0];
        if (lastCh && !cands.includes(GI.idOf(lastCh.device))) cands.push(GI.idOf(lastCh.device));
        if (!cands.length) { vehicle = null; return; }
        return wapi.multiCall(cands.map(id => ["Get", { typeName: "DeviceStatusInfo", search: { deviceSearch: { id } },
          propertySelector: { fields: ["device", "driver", "isDriving", "currentStateDuration", "dateTime", "latitude", "longitude"], isIncluded: true } }]))
          .then(res => {
            const st = (res || []).map(r => (r || [])[0]).filter(Boolean).map(r => ({
              d: GI.idOf(r.device), driver: D.realDriver(GI.idOf(r.driver)), driving: !!r.isDriving,
              since: now - GI.durationToHours(r.currentStateDuration) * H, lat: r.latitude, lon: r.longitude,
              at: r.dateTime ? new Date(r.dateTime).getTime() : null,
            }));
            vehicle = st.find(v => v.driver === me.id) || st[0] || null;
            if (!vehicle) return;
            // desde cuándo estoy identificado en este vehículo (último cambio de conductor a mi nombre)
            if (vehicle.driver === me.id && lastCh && GI.idOf(lastCh.device) === vehicle.d) vehicle.identFrom = new Date(lastCh.dateTime).getTime();
            const names = lsGet("devNames", {});
            if (names[vehicle.d]) { vehicle.name = names[vehicle.d]; return; }
            return wapi.call("Get", { typeName: "Device", search: { id: vehicle.d }, propertySelector: { fields: ["id", "name", "licensePlate"], isIncluded: true } })
              .then(l => { const dv = (l || [])[0]; if (dv) { vehicle.name = dv.name || dv.licensePlate; names[vehicle.d] = vehicle.name; lsSet("devNames", names); } })
              .catch(() => {});
          });
      });
  }

  function getPhonePosition() {
    const geo = (api && api.mobile && api.mobile.geolocation) || (typeof navigator !== "undefined" && navigator.geolocation);
    if (!geo || typeof geo.getCurrentPosition !== "function") return Promise.resolve(null);
    return new Promise(resolve => {
      const t = setTimeout(() => resolve(null), 25000);
      try {
        geo.getCurrentPosition(
          p => { clearTimeout(t); resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: p.timestamp || Date.now() }); },
          () => { clearTimeout(t); resolve(null); },
          { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
      } catch (e) { clearTimeout(t); resolve(null); }
    });
  }

  // ---------- cálculo ----------
  function compute() {
    if (!me) return;
    const now = Date.now();
    const evs = D.myEvents(rawEvents, trips, me.id, cfg);
    const live = vehicle && vehicle.driver === me.id ? { d: vehicle.d, driving: vehicle.driving || !!(state && state.driving), since: vehicle.since, identFrom: vehicle.identFrom || null } : null;
    // jornada y fatiga: lo que manejé + lo que viajé de acompañante (sin manejo)
    const ivs = D.rideIntervals(rides.records, me.id, now, WH());
    const rideT = D.rideTrips(ivs, rides.vtrips, me.id, trips);
    view = { at: now, rides: ivs, risk: D.riskSummary(trips, evs, cfg, now), fat: D.fatigueState(trips.concat(rideT), evs, cfg, me.id, now, live) };
  }

  // ---------- avisos ----------
  function notify(title, message, speak) {
    try {
      const m = api && api.mobile;
      if (m && m.notification && typeof m.notification.notify === "function") Promise.resolve(m.notification.notify(message, title)).catch(() => {});
      else if (m && typeof m.notify === "function") m.notify(message, title, "mj" + Date.now());
      if (speak && m && typeof m.speak === "function") m.speak(title + ". " + message);
    } catch (e) { /* fuera de la app nativa */ }
  }

  const LIMIT_TXT = { span: "jornada", drive: "manejo", stint: "manejo continuo" };
  function sendLimitAlerts() {
    if (!view || !view.fat.open) return;
    const sent = lsGet("sent", {});
    for (const a of D.limitAlerts(view.fat, cfg, sent)) {
      const x = a.item, name = LIMIT_TXT[x.key];
      if (a.level === "max") notify("Llegaste al límite de " + name, "Llevás " + D.dur(x.v) + " de " + name + " (límite " + x.max + " h)." + (x.key === "stint" ? " Hacé una pausa de 15 minutos." : " Coordiná el descanso con tu supervisor."), true);
      else notify("Te queda poco de " + name, "Quedan " + D.dur(x.left) + " de " + name + (x.at ? ", hasta las " + D.hm(x.at) : "") + ".", false);
      sent[a.key] = Date.now();
    }
    for (const k of Object.keys(sent)) if (sent[k] < Date.now() - 3 * DAY) delete sent[k];
    lsSet("sent", sent);
  }

  function checkAway() {
    return loadVehicle().then(() => (vehicle && vehicle.driver === me.id ? getPhonePosition() : null)).then(p => {
      phone = p;
      const r = D.awayCheck(awayState, vehicle, p, me.id, cfg, Date.now());
      awayState = r.state; away = r; last.away = Date.now();
      if (r.alert) {
        const vn = (vehicle && vehicle.name) || "el vehículo";
        if (r.alert.kind === "en_movimiento") notify("Vehículo en movimiento con tu identificación", vn + " se está moviendo con tu identificación y vos estás a " + D.meters(r.dist) + ". Avisá a tu supervisor.", true);
        else notify("Seguís identificado en " + vn, "Estás a " + D.meters(r.dist) + " del vehículo. Abrí Mi jornada para desvincularte o avisar quién te relevó.", true);
      }
    });
  }

  // ---------- desvincularse / relevo ----------
  function loadDrivers() {
    const c = lsGet("drivers", null);
    if (c && c.at > Date.now() - 6 * H && c.me === me.id) { drivers = c.list; return Promise.resolve(); }
    return wapi.call("Get", { typeName: "User", search: { isDriver: true },
      propertySelector: { fields: ["id", "name", "firstName", "lastName", "driverGroups", "activeTo", "isDriver"], isIncluded: true } })
      .then(list => { drivers = D.reliefCandidates(list, me, Date.now()); lsSet("drivers", { at: Date.now(), me: me.id, list: drivers }); })
      .catch(() => { drivers = drivers || []; });
  }

  // Cierra mi identificación en el vehículo: cambio de conductor a "desconocido".
  function unassign() {
    const v = vehicle;
    if (!v || v.driver !== me.id) return Promise.reject(new Error("Ya no estás identificado en ningún vehículo."));
    return wapi.call("Add", { typeName: "DriverChange", entity: {
      device: { id: v.d }, driver: { id: "UnknownDriverId" }, dateTime: iso(Date.now()), type: "Driver" } })
      .then(() => { v.driver = null; awayState = null; away = { status: "sin_vehiculo" }; lsSet("away", null); });
  }

  // Mensaje de usuario de Drive al conductor que me relevó (solo lo ve él).
  function sendRelief(u) {
    const msg = D.reliefMessage(me.name, vehicle, Date.now());
    const now = iso(Date.now());
    return wapi.call("Add", { typeName: "TextMessage", entity: {
      user: { id: me.id }, recipient: { id: u.id }, isDirectionToVehicle: false,
      messageContent: { contentType: "Normal", message: msg }, activeFrom: now, sent: now } });
  }

  function errMsg(e, what) {
    const t = (e && (e.message || e.name)) || String(e);
    return /permission|Unauthorized|Access/i.test(t) ? what + ": tu usuario no tiene permiso. Avisale a tu supervisor." : what + ": " + t;
  }

  function act(name, arg) {
    if (ui.busy) return;
    const vn = (vehicle && vehicle.name) || "el vehículo";
    if (name === "cancel") { ui = { mode: null, q: "", busy: false, msg: null }; return render(); }
    if (name === "drive-assets") { try { api.mobile.navigate("assets"); } catch (e) { /* versión de Drive sin navigate */ } return; }
    if (name === "ask-unassign") { ui.mode = "unassign"; ui.msg = null; return render(); }
    if (name === "ask-relief") { ui.mode = "relief"; ui.q = ""; ui.msg = null; render(); return loadDrivers().then(render); }
    ui.busy = true; render();
    let p;
    if (name === "unassign") {
      const dev = vehicle && vehicle.d;
      p = unassign().then(() => ({ ok: "Te desvinculaste de " + vn + ".", dev }), e => ({ err: errMsg(e, "No se pudo desvincular") }));
    } else if (name === "relief") {
      const u = (drivers || []).find(x => x.id === arg);
      if (!u) { ui.busy = false; return render(); }
      // el aviso sale aunque falle la desvinculación, y viceversa
      p = sendRelief(u).then(() => null, e => errMsg(e, "No se pudo avisar a " + u.name))
        .then(e1 => unassign().then(() => null, e => errMsg(e, "No se pudo desvincular"))
          .then(e2 => (e1 || e2 ? { err: [e1, e2].filter(Boolean).join(" ") + (e1 ? "" : " A " + u.name + " le llegó el aviso.") }
            : { ok: "Le avisamos a " + u.name + " y te desvinculaste de " + vn + ".", dev: vehicle && vehicle.d })));
    }
    return p.then(r => { ui = { mode: null, q: "", busy: false, msg: r }; render(); });
  }

  // ---------- ciclo ----------
  function check(opts) {
    if (busy) return Promise.resolve();
    if (!isOnline()) { compute(); return Promise.resolve(); }
    busy = true;
    const o = opts || {};
    return loadMe().then(() => {
      if (!me) throw new Error("No se pudo identificar al usuario de Drive.");
      return loadConfig(o.full);
    }).then(() => loadTrips(o.full ? "full" : o.force))
      .then(() => loadRides(o.full || o.force))
      .then(() => loadEvents(o.full || o.force))
      .then(() => (o.full || o.force || Date.now() - last.away >= cfg.drive.away.poll_min * MIN - 5000 ? checkAway().catch(() => {}) : null))
      .then(() => { error = null; compute(); sendLimitAlerts(); saveCache(); })
      .catch(e => { error = (e && e.message) || String(e); compute(); })
      .then(() => { busy = false; });
  }

  function startLoop() {
    if (timer) return;
    timer = setInterval(() => { check().then(() => { if (root && !root.hidden && !ui.mode && !ui.busy) render(); }); }, MIN);
    if (!listening && api && api.mobile && typeof api.mobile.listenTo === "function") {
      listening = true;
      try {
        api.mobile.listenTo(s => {
          const wasOffline = state && state.online === false;
          const wasDriving = state && state.driving;
          if (s) state = Object.assign({}, state, s);
          if ((wasOffline && isOnline()) || (state && !!state.driving !== !!wasDriving)) check({ force: true }).then(render);
        });
      } catch (e) { listening = false; }
    }
  }

  // ---------- interfaz ----------
  const LVL_TXT = { ok: "", amarillo: "Cerca del límite", rojo: "Límite superado" };
  function bar(x) {
    const pct = Math.min(100, Math.round((x.pct || 0) * 100));
    const left = x.v >= x.max ? "Límite superado por " + D.dur(x.v - x.max) : "Quedan " + D.dur(x.left);
    const atTxt = x.v < x.max && x.at ? " · hasta las " + D.hm(x.at) : "";
    return `<div class="mj-bar mj-${x.level}">
      <div class="mj-bar-head"><span class="mj-bar-name">${esc(x.label)}</span><span class="mj-bar-val">${D.dur(x.v)} <small>de ${x.max} h</small></span></div>
      <div class="mj-track"><div class="mj-fill" style="width:${pct}%"></div></div>
      <div class="mj-bar-left">${left}${atTxt}${LVL_TXT[x.level] && x.v < x.max ? ` <b>· ${LVL_TXT[x.level]}</b>` : ""}</div>
    </div>`;
  }

  function rideNote(o) {
    const iv = (view.rides || []).filter(r => r.crewKey === o.ride.crewKey).pop();
    if (!iv) return "";
    const st = iv.status === "pending" ? " (sin confirmar)" : "";
    return `<p class="mj-ride">${o.ride.only ? "Como acompañante" : "Parte como acompañante"} de ${esc(iv.driverName || "otro chofer")}${iv.deviceName ? " en " + esc(iv.deviceName) : ""}${st}. Cuenta como jornada, no como manejo.</p>`;
  }
  function cardTime(f) {
    if (f.open) {
      const p = f.open.progress;
      return `<section class="mj-card"><h2>Te queda</h2>
        <p class="mj-sub">Jornada desde las ${D.hm(f.open.shift.s)}${p.driving ? " · manejando" : p.sinceLast > 1 ? " · detenido hace " + D.dur(p.sinceLast / 60) : ""}</p>
        ${f.open.ride ? rideNote(f.open) : ""}
        ${f.open.ident ? `<p class="mj-ride">Identificado en ${esc((vehicle && vehicle.name) || "el vehículo")} desde las ${D.hm(f.open.ident.from)}${f.open.ident.noTrips ? " · todavía sin viajes" : ""}. La jornada cuenta desde la identificación.</p>` : ""}
        ${p.items.map(bar).join("")}
        ${f.open.daysRow > f.limits.max_days_row ? `<p class="mj-warn">Llevás ${f.open.daysRow} días seguidos de trabajo (máximo ${f.limits.max_days_row}).</p>` : ""}
        ${p.nightAhead ? `<p class="mj-warn">Tu jornada sigue de madrugada (02–05 h): es el horario de más riesgo de sueño.</p>` : ""}
      </section>`;
    }
    if (f.rest) {
      const r = f.rest, done = r.left <= 0;
      return `<section class="mj-card"><h2>Descanso</h2>
        <p class="mj-big ${done ? "mj-okc" : "mj-amc"}">${done ? "Descanso cumplido" : "Faltan " + D.dur(r.left)}</p>
        <p class="mj-sub">Descansando desde las ${D.hm(r.since)} (${D.dur(r.hours)}). Mínimo entre jornadas: ${r.min} h.</p>
        <p class="mj-sub">Al empezar tenés ${f.limits.max_span} h de jornada, ${f.limits.max_drive_day} h de manejo y ${f.limits.max_continuous} h de manejo continuo.</p>
      </section>`;
    }
    return `<section class="mj-card"><h2>Te queda</h2><p class="mj-sub">No hay viajes tuyos en los últimos ${cfg.drive.fatigue_days} días.</p></section>`;
  }

  const FI_TXT = { bajo: "Bajo", moderado: "Moderado", alto: "Alto", "muy alto": "Muy alto" };
  function cardFatigue(f) {
    const idx = f.open ? f.open.index.Fnow : f.rest ? f.rest.fiNow : null;
    const lvl = f.open ? f.open.index.level : f.rest ? f.rest.level : null;
    let extra = "";
    if (f.open && f.open.index.crossAt) extra = `<p class="mj-warn">Si seguís así, el índice pasa a alto cerca de las ${D.hm(f.open.index.crossAt)}.</p>`;
    if (!f.open && f.next) {
      extra = `<p class="mj-sub">Próximo turno (habitual ${D.hm(f.next.start)}): riesgo ${esc(FI_TXT[f.next.level] || "–").toLowerCase()}.${f.next.needRest ? " Para que no pase a alto, descansá al menos " + D.dur(f.next.needRest) + " desde el fin de la última jornada." : ""}</p>`;
    }
    const sig = f.recent.filter(j => j.signals.length).slice(0, 3);
    return `<section class="mj-card"><h2>Fatiga</h2>
      <div class="mj-row"><span class="mj-big mj-fi-${(lvl || "na").replace(" ", "-")}">${idx == null ? "–" : Math.round(idx)}</span>
        <span class="mj-tag mj-fi-${(lvl || "na").replace(" ", "-")}">${esc(FI_TXT[lvl] || "Sin datos")}</span></div>
      <p class="mj-hint">Índice estimado: sube mientras trabajás (más de madrugada) y baja mientras descansás. Alto desde ${f.limits.fi_high}.</p>
      ${extra}
      ${sig.length ? `<h3>Señales de tus últimas jornadas</h3><ul class="mj-list">${sig.map(j => `<li><b>${new Date(j.s).toLocaleDateString("es-AR", { weekday: "short", day: "numeric", month: "short" })}</b> ${j.signals.map(s => esc(s.text)).join("; ")}</li>`).join("")}</ul>` : `<p class="mj-sub">Sin señales de fatiga en tus últimas jornadas.</p>`}
    </section>`;
  }

  function cardRisk(r) {
    const vals = r.series.map(b => b.risk || 0), mx = Math.max(0.001, ...vals);
    const ch = r.change;
    const chTxt = ch == null ? "" : `<span class="mj-tag ${ch <= 0 ? "mj-okt" : "mj-badt"}">${ch <= 0 ? "▼" : "▲"} ${Math.abs(Math.round(ch * 100))} % vs ${r.days} días anteriores</span>`;
    return `<section class="mj-card"><h2>Índice de riesgo</h2>
      <div class="mj-row"><span class="mj-big">${r.cur.risk == null ? "–" : GI.fmtNum(r.cur.risk, 2)}</span><span class="mj-sub">pts cada 100 km · últimos ${r.days} días</span></div>
      ${chTxt}
      <div class="mj-spark">${r.series.map(b => `<div class="mj-sb" title="${esc(b.label)}: ${b.risk == null ? "sin km" : GI.fmtNum(b.risk, 2)}"><div style="height:${b.risk == null ? 0 : Math.max(4, Math.round((b.risk / mx) * 100))}%"></div><span>${esc(b.label.replace("Sem. ", ""))}</span></div>`).join("")}</div>
      <p class="mj-sub">${GI.fmtNum(r.cur.km, 0)} km · ${r.cur.n} eventos</p>
      ${r.byCat.length ? `<ul class="mj-cats">${r.byCat.slice(0, 5).map(c => `<li><span>${esc(c.label)}</span><b>${c.n}</b></li>`).join("")}</ul>` : `<p class="mj-sub">Sin eventos de riesgo en el período. ¡Bien!</p>`}
    </section>`;
  }

  const AWAY_TXT = {
    cerca: d => "Estás a " + D.meters(d) + " del vehículo.",
    lejos: d => "Estás a " + D.meters(d) + " del vehículo y seguís identificado en él.",
    impreciso: () => "La ubicación del teléfono es imprecisa en este momento.",
    sin_gps: () => "No se pudo leer la ubicación del teléfono. Revisá el permiso de ubicación de Geotab Drive.",
    sin_posicion_vehiculo: () => "El vehículo todavía no informó su posición.",
    sin_vehiculo: () => "No estás identificado en ningún vehículo.",
    off: () => "Aviso de alejamiento desactivado.",
  };
  function usersHtml() {
    const list = drivers == null ? null : D.filterUsers(drivers, ui.q);
    return list == null ? `<p class="mj-sub">Cargando conductores…</p>` : list.length ? list.slice(0, 40).map(u => `<button class="mj-user" data-act="relief" data-arg="${esc(u.id)}" ${ui.busy ? "disabled" : ""}>${esc(u.name)}</button>`).join("") : `<p class="mj-sub">No hay conductores con ese nombre.</p>`;
  }
  function reliefPicker() {
    return `<div class="mj-pick">
      <p class="mj-sub"><b>¿Quién te reemplazó?</b> Le llega un mensaje en su Drive para que se identifique al subir.</p>
      <input id="mj-q" class="mj-input" type="search" placeholder="Buscar conductor" value="${esc(ui.q)}" autocomplete="off">
      <div class="mj-users">${usersHtml()}</div>
      <button class="mj-btn mj-btn-2" data-act="cancel">Cancelar</button>
    </div>`;
  }
  function cardVehicle() {
    const mine = vehicle && vehicle.driver === me.id;
    const vn = mine ? vehicle.name || vehicle.d : null;
    const f = AWAY_TXT[away.status];
    const far = away.status === "lejos";
    let actions = "";
    if (mine && ui.mode === "unassign") {
      actions = `<div class="mj-pick"><p class="mj-sub"><b>¿Te desvinculás de ${esc(vn)}?</b> Desde ahora los viajes y eventos de este vehículo dejan de quedar a tu nombre.</p>
        <div class="mj-btns"><button class="mj-btn" data-act="unassign" ${ui.busy ? "disabled" : ""}>Sí, desvincularme</button><button class="mj-btn mj-btn-2" data-act="cancel">Cancelar</button></div></div>`;
    } else if (mine && ui.mode === "relief") actions = reliefPicker();
    else if (mine) {
      actions = `<div class="mj-btns"><button class="mj-btn ${far ? "" : "mj-btn-2"}" data-act="ask-unassign">Me desvinculo</button><button class="mj-btn mj-btn-2" data-act="ask-relief">Me relevaron</button></div>`;
    }
    // Drive tiene su propia selección de vehículo: si sigue elegido el que se dejó, se ofrece quitarlo
    const driveSel = state && GI.idOf(state.device);
    const offerAssets = ui.msg && ui.msg.ok && ui.msg.dev && driveSel === ui.msg.dev && hasMobile();
    const msg = ui.msg ? `<p class="${ui.msg.ok ? "mj-okm" : "mj-msg"}">${esc(ui.msg.ok || ui.msg.err)}</p>`
      + (offerAssets ? `<p class="mj-hint">En Drive todavía figura ese vehículo como elegido.</p><div class="mj-btns"><button class="mj-btn mj-btn-2" data-act="drive-assets">Quitar el vehículo en Drive</button></div>` : "") : "";
    return `<section class="mj-card ${far && mine ? "mj-card-alert" : ""}" id="mj-vehicle"><h2>Vehículo</h2>
      <p class="mj-big-s">${vn ? esc(vn) : "Sin identificación"}</p>
      <p class="mj-sub ${far ? "mj-badc" : ""}">${f ? f(away.dist) : "Revisando…"}</p>
      ${msg}${actions}
      <p class="mj-hint">Si te alejás más de ${cfg.drive.away.distance_m} m mientras seguís identificado, el teléfono te avisa.</p>
    </section>`;
  }

  function render() {
    root = document.getElementById("mjDrive") || root;
    if (!root) return;
    const who = $("#mj-who");
    if (who) who.textContent = me ? me.name : "";
    const body = $("#mj-view");
    if (!body) return;
    const foot = `<p class="mj-foot">${window.CESETTI_VERSION ? "v" + window.CESETTI_VERSION + " · " : ""}${cfg.fromInsights ? "Límites de Insights by Cesetti" : "Límites por defecto (no se pudo leer la configuración de Insights)"} · actualizado ${view ? D.hm(view.at) : "–"}${isOnline() ? "" : " · sin conexión"}</p>`;
    const err = error ? `<div class="mj-msg">${esc(error)}</div>` : "";
    if (!me || !view) { body.innerHTML = err + `<p class="mj-sub mj-loading">Cargando tus datos…</p>`; return; }
    // con el conductor lejos del vehículo (o eligiendo relevo) la tarjeta del vehículo va primero
    const top = (away.status === "lejos" && vehicle && vehicle.driver === me.id) || ui.mode || ui.msg;
    body.innerHTML = err + (top ? cardVehicle() : "") + cardTime(view.fat) + cardFatigue(view.fat) + cardRisk(view.risk) + (top ? "" : cardVehicle()) + foot;
  }

  function setup(freshApi, freshState) {
    api = freshApi;
    wapi = GI.wrapApi(api);
    state = Object.assign({}, state, freshState || {});
    if (!me) loadCache();
  }

  // Drive puede volver a insertar el HTML del add-in cada vez que se abre la
  // página (initialize corre una sola vez, focus cada vez). Por eso los eventos
  // se escuchan en el documento, no en un elemento que puede ser reemplazado.
  function onClick(e) {
    const t = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
    const el = t && t.closest ? t.closest("#mjDrive [data-act], #mj-refresh") : null;
    if (!el || el.disabled) return;
    root = document.getElementById("mjDrive") || root;
    try {
      if (el.id === "mj-refresh") { el.disabled = true; check({ force: true }).then(() => { el.disabled = false; render(); }); return; }
      const r = act(el.getAttribute("data-act"), el.getAttribute("data-arg"));
      if (r && r.catch) r.catch(showActError);
    } catch (err) { showActError(err); }
  }
  function showActError(err) {
    ui = { mode: null, q: "", busy: false, msg: { err: "Error: " + ((err && err.message) || err) } };
    render();
  }
  function onInput(e) {
    if (!e.target || e.target.id !== "mj-q") return;
    ui.q = e.target.value;
    const l = document.querySelector("#mjDrive .mj-users");
    if (l) l.innerHTML = usersHtml();
  }
  function bindEvents() {
    if (window.__mjBound) return;   // una sola vez por documento
    window.__mjBound = true;
    document.addEventListener("click", onClick, true);
    document.addEventListener("input", onInput, true);
  }

  const factory = function () {
    return {
      // onStartup: al iniciar sesión en Drive, sin interfaz.
      startup(freshApi, freshState, callback) {
        setup(freshApi, freshState);
        let done = false;
        const finish = () => { if (!done) { done = true; if (typeof callback === "function") callback(); } };
        check({ full: true }).then(() => { startLoop(); finish(); });
        setTimeout(finish, 8000); // nunca bloquear el inicio de Drive
      },
      initialize(freshApi, freshState, callback) {
        setup(freshApi, freshState);
        root = document.getElementById("mjDrive");
        bindEvents();
        compute(); render();
        callback();
      },
      focus(freshApi, freshState) {
        setup(freshApi, freshState);
        root = document.getElementById("mjDrive") || root;
        bindEvents();
        if (root) root.hidden = false;
        if (!ui.busy) ui = { mode: null, q: "", busy: false, msg: null };
        render();
        startLoop();
        check({ force: true }).then(render);
      },
      blur() { /* el ciclo sigue corriendo para los avisos */ },
      shutdown(freshApi, freshState, callback) {
        if (timer) { clearInterval(timer); timer = null; }
        if (typeof callback === "function") callback();
      },
    };
  };
  // Dentro del add-in unificado (shell.js) lo registra el contenedor; suelto, se registra solo.
  window.CesettiModules = window.CesettiModules || {};
  window.CesettiModules.miJornada = factory;
  if (!window.CESETTI_SHELL) {
    window.geotab = window.geotab || {};
    window.geotab.addin = window.geotab.addin || {};
    window.geotab.addin.cesettiMiJornada = factory;
  }
  GI._mj = { get view() { return view; }, get away() { return away; }, get ui() { return ui; }, check, render, act };
})(window.GI);
