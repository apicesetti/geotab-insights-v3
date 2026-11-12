// Add-in unificado de Geotab Drive: "Mi jornada" + "Horas de trabajo" (tripulación, clientes y planilla).
//
// Cada módulo sigue siendo el mismo código (drive/app.js de este repo y scripts/drive.js de
// apicesetti/workinghours); este contenedor los registra como UN solo add-in, reparte el ciclo
// de vida a los dos y muestra una pestaña por módulo. Así hay un solo ícono en Drive, un solo
// onStartup y un solo lugar donde el técnico responde lo que le preguntan.
//
// Ingeniero Jorge Cesetti SRL
// Versión que se ve en Drive (pie de cada pestaña). Subirla junto con addin-config.json.
window.CESETTI_VERSION = "1.3.0";
(function () {
  "use strict";
  const M = window.CesettiModules || {};
  let mods = null, tab = "jornada", badgeTimer = null, bound = false;

  function create() {
    if (mods) return mods;
    mods = {};
    if (M.miJornada) mods.mj = M.miJornada();
    if (M.workingHours) mods.wh = M.workingHours();
    return mods;
  }
  const each = (fn) => Object.keys(mods || {}).map(k => { try { return fn(mods[k], k); } catch (e) { return null; } });
  const done = (n, cb) => { let left = n; return () => { if (--left === 0 && typeof cb === "function") cb(); }; };

  function pending() { try { return mods && mods.wh && mods.wh.pendingCount ? mods.wh.pendingCount() : 0; } catch (e) { return 0; } }
  function updateBadge() {
    const b = document.getElementById("cz-badge");
    if (!b) return;
    const n = pending();
    b.textContent = n; b.hidden = !n;
  }
  function show(name) {
    tab = name;
    document.querySelectorAll("#czShell .cz-tab").forEach(t => t.classList.toggle("is-on", t.getAttribute("data-tab") === name));
    const pj = document.getElementById("cz-p-jornada"), pt = document.getElementById("cz-p-tripulacion");
    if (pj) pj.hidden = name !== "jornada";
    // Tripulación y Clientes son dos secciones del mismo módulo (Horas de trabajo)
    if (pt) pt.hidden = name === "jornada";
    if (name !== "jornada" && mods && mods.wh && mods.wh.section) { try { mods.wh.section(name === "clientes" ? "clients" : "crew"); } catch (e) { /* módulo sin secciones */ } }
    window.scrollTo && window.scrollTo(0, 0);
    updateBadge();
  }
  function version() {
    const el = document.getElementById("cz-ver");
    if (!el) return;
    const wh = window.WorkingHoursShared && window.WorkingHoursShared.VERSION;
    el.textContent = "Mi jornada v" + window.CESETTI_VERSION + (wh ? " · Horas de trabajo v" + wh : "");
  }
  function who() {
    const el = document.getElementById("cz-who"), src = document.getElementById("mj-who") || document.getElementById("whd-who");
    if (el && src && src.textContent) el.textContent = src.textContent;
  }
  function bind() {
    if (window.__czBound) return;
    window.__czBound = true;
    document.addEventListener("click", e => {
      const t = e.target && e.target.closest ? e.target : e.target && e.target.parentElement;
      if (!t || !t.closest) return;
      const tb = t.closest("#czShell .cz-tab");
      if (tb) { show(tb.getAttribute("data-tab")); return; }
      if (t.closest("#cz-refresh")) {
        const b = t.closest("#cz-refresh"); b.disabled = true;
        const jobs = [];
        if (window.GI && window.GI._mj) jobs.push(window.GI._mj.check({ force: true }).then(() => window.GI._mj.render()));
        if (mods && mods.wh && mods.wh.refresh) jobs.push(Promise.resolve(mods.wh.refresh()));
        Promise.all(jobs.map(p => p.catch(() => {}))).then(() => { b.disabled = false; updateBadge(); who(); });
      }
    });
  }

  const shell = function () {
    return {
      startup(api, state, cb) {
        create();
        const fin = done(Object.keys(mods).length, cb);
        let called = false;
        const once = () => { if (!called) { called = true; if (typeof cb === "function") cb(); } };
        if (!Object.keys(mods).length) return once();
        each(m => m.startup ? m.startup(api, state, () => { fin(); }) : fin());
        setTimeout(once, 9000); // nunca bloquear el inicio de Drive
      },
      initialize(api, state, cb) {
        create(); bind(); version();
        const fin = done(Object.keys(mods).length || 1, cb);
        if (!Object.keys(mods).length) return fin();
        each(m => m.initialize(api, state, fin));
      },
      focus(api, state) {
        create(); bind();
        each(m => m.focus && m.focus(api, state));
        // si hay algo que responder en Tripulación, se abre ahí
        setTimeout(() => { updateBadge(); who(); if (pending() > 0) show("tripulacion"); else show(tab); }, 1500);
        if (!badgeTimer) badgeTimer = setInterval(() => { updateBadge(); who(); }, 30000);
      },
      blur(api, state) { each(m => m.blur && m.blur(api, state)); },
      shutdown(api, state, cb) {
        create();
        const fin = done(Object.keys(mods).length || 1, cb);
        if (!Object.keys(mods).length) return fin();
        each(m => (m.shutdown ? m.shutdown(api, state, fin) : fin()));
      },
    };
  };
  window.geotab = window.geotab || {};
  window.geotab.addin = window.geotab.addin || {};
  window.geotab.addin.cesettiMiJornada = shell;   // mismo nombre que la versión anterior de Mi jornada
})();
