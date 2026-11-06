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
  let trips = [], rawEvents = [], vehicle = null, phone = null, away = { status: "—" }, awayState = null;
  let last = { config: 0, trips: 0, events: 0, away: 0, fullTrips: 0 };
  let timer = null, busy = false, listening = false, bound = false, error = null;
  let view = null; // resultados calculados

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
      if (me && me.login === login && me.id) return me;
      return wapi.call("Get", { typeName: "User", search: { name: login }, propertySelector: { fields: ["id", "name", "firstName", "lastName"], isIncluded: true } })
        .then(list => {
          const u = (list || [])[0];
          if (u) { me = { id: u.id, login: u.name, name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.name }; lsSet("me", me); }
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
    const live = vehicle && vehicle.driver === me.id ? { d: vehicle.d, driving: vehicle.driving || !!(state && state.driving), since: vehicle.since } : null;
    view = { at: now, risk: D.riskSummary(trips, evs, cfg, now), fat: D.fatigueState(trips, evs, cfg, me.id, now, live) };
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
        else notify("Seguís identificado en " + vn, "Estás a " + D.meters(r.dist) + " del vehículo. Si terminaste, desvinculate; si no, volvé al vehículo.", true);
      }
    });
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
      .then(() => loadEvents(o.full || o.force))
      .then(() => (o.full || o.force || Date.now() - last.away >= cfg.drive.away.poll_min * MIN - 5000 ? checkAway().catch(() => {}) : null))
      .then(() => { error = null; compute(); sendLimitAlerts(); saveCache(); })
      .catch(e => { error = (e && e.message) || String(e); compute(); })
      .then(() => { busy = false; });
  }

  function startLoop() {
    if (timer) return;
    timer = setInterval(() => { check().then(() => { if (root && !root.hidden) render(); }); }, MIN);
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

  function cardTime(f) {
    if (f.open) {
      const p = f.open.progress;
      return `<section class="mj-card"><h2>Te queda</h2>
        <p class="mj-sub">Jornada desde las ${D.hm(f.open.shift.s)}${p.driving ? " · manejando" : p.sinceLast > 1 ? " · detenido hace " + D.dur(p.sinceLast / 60) : ""}</p>
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
  function cardVehicle() {
    const vn = vehicle && vehicle.driver === me.id ? vehicle.name || vehicle.d : null;
    const f = AWAY_TXT[away.status];
    return `<section class="mj-card"><h2>Vehículo</h2>
      <p class="mj-big-s">${vn ? esc(vn) : "Sin identificación"}</p>
      <p class="mj-sub ${away.status === "lejos" ? "mj-badc" : ""}">${f ? f(away.dist) : "Revisando…"}</p>
      <p class="mj-hint">Si te alejás más de ${cfg.drive.away.distance_m} m mientras seguís identificado, el teléfono te avisa.</p>
    </section>`;
  }

  function render() {
    if (!root) return;
    const who = $("#mj-who");
    if (who) who.textContent = me ? me.name : "";
    const body = $("#mj-view");
    if (!body) return;
    const foot = `<p class="mj-foot">${cfg.fromInsights ? "Límites de Insights by Cesetti" : "Límites por defecto (no se pudo leer la configuración de Insights)"} · actualizado ${view ? D.hm(view.at) : "–"}${isOnline() ? "" : " · sin conexión"}</p>`;
    const err = error ? `<div class="mj-msg">${esc(error)}</div>` : "";
    if (!me || !view) { body.innerHTML = err + `<p class="mj-sub mj-loading">Cargando tus datos…</p>`; return; }
    body.innerHTML = err + cardTime(view.fat) + cardFatigue(view.fat) + cardRisk(view.risk) + cardVehicle() + foot;
  }

  function setup(freshApi, freshState) {
    api = freshApi;
    wapi = GI.wrapApi(api);
    state = Object.assign({}, state, freshState || {});
    if (!me) loadCache();
  }

  function bindEvents() {
    const b = $("#mj-refresh");
    if (b) b.addEventListener("click", () => { b.disabled = true; check({ force: true }).then(() => { b.disabled = false; render(); }); });
  }

  window.geotab = window.geotab || {};
  window.geotab.addin = window.geotab.addin || {};
  window.geotab.addin.cesettiMiJornada = function () {
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
        if (root && !bound) { bindEvents(); bound = true; }
        compute(); render();
        callback();
      },
      focus(freshApi, freshState) {
        setup(freshApi, freshState);
        root = document.getElementById("mjDrive") || root;
        if (root) root.hidden = false;
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
  GI._mj = { get view() { return view; }, get away() { return away; }, check, render };
})(window.GI);
