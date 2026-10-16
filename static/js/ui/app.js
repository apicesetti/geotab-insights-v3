// Aplicación principal + entry point del Add-In.
(function (GI) {
  "use strict";
  const { useState, useEffect, useMemo, useRef } = React;
  const html = GI.html;
  const { Segmented, Info, Progress } = GI;

  const TABS = [
    ["resumen", "Resumen"],
    ["combustible", "Combustible y ralentí"],
    ["seguridad", "Seguridad"],
    ["conductores", "Conductores"],
    ["recorridos", "Recorridos"],
    ["hitos", "Hitos"],
    ["config", "Configuración"],
  ];

  // Config guardada + campos nuevos que pudieran faltar (versiones futuras).
  function mergeDefaults(saved, defaults) {
    if (!saved) return defaults;
    const out = { ...defaults, ...saved };
    for (const k of ["service", "fuel", "journeys", "drivers", "ui"]) out[k] = { ...defaults[k], ...(saved[k] || {}) };
    out.service.group_ids = { ...defaults.service.group_ids, ...((saved.service || {}).group_ids || {}) };
    out.category_weights = { ...defaults.category_weights, ...(saved.category_weights || {}) };
    out.profile_targets = { ...GI.defaultProfileTargets(out.vehicle_types), ...(saved.profile_targets || {}) };
    return out;
  }

  const LARGE_FLEET = window.GI_LARGE_FLEET || 300; // vehículos: a partir de acá el grupo filtra en la API

  function rangeFor(days) {
    const to = GI.dayKey(new Date());
    return { from: GI.dayKey(GI.addDays(new Date(), -(days - 1))), to };
  }

  function App({ api, database, userName }) {
    const [phase, setPhase] = useState("init");
    const [error, setError] = useState(null);
    const [catalogs, setCatalogs] = useState(null);
    const [settings, setSettings] = useState(null);
    const [milestones, setMilestones] = useState([]);
    const [isAdmin, setIsAdmin] = useState(false);
    const [period, setPeriod] = useState({ preset: 90, ...rangeFor(90) });
    const [customDraft, setCustomDraft] = useState(null);
    const [gran, setGran] = useState("week");
    const [filter, setFilter] = useState({ vtype: "", stype: "" });
    // Grupos del filtro de MyGeotab (barra "Grupos" de arriba). Vacío = toda la flota.
    const [mgGroups, setMgGroups] = useState(GI._mgGroups || []);
    useEffect(() => { GI._onMgGroups = ids => setMgGroups(ids); return () => { GI._onMgGroups = null; }; }, []);
    const [raw, setRaw] = useState(null);
    const [loading, setLoading] = useState(null);
    const [tab, setTab] = useState("resumen");
    const [detail, setDetail] = useState(null);
    const loadId = useRef(0);
    const groupRef = useRef(GI._mgGroups || []);
    const [loadingLabel, setLoadingLabel] = useState("");
    const [largeFleet, setLargeFleet] = useState(false);

    // ---- Arranque: catálogos + config compartida ----
    useEffect(() => {
      (async () => {
        try {
          const [cat, shared] = await Promise.all([GI.loadCatalogs(api, database), GI.loadShared(api)]);
          const defaults = GI.defaultSettings(cat.groups, cat.rules);
          const s = mergeDefaults(shared.settings, defaults);
          const admin = await GI.resolveIsAdmin(api, userName, s);
          setCatalogs(cat); setSettings(s); setMilestones(shared.milestones); setIsAdmin(admin);
          setGran(s.ui.default_granularity);
          // Flota grande sin alcance definido: arranca con 30 días; el grupo
          // elegido arriba pasa a filtrar en la API (no en el navegador).
          const large = cat.devices.length > LARGE_FLEET;
          setLargeFleet(large);
          const days = large && !(s.scope_group_ids || []).length ? Math.min(30, s.ui.default_days) : s.ui.default_days;
          const p = { preset: days, ...rangeFor(days) };
          setPeriod(p);
          setPhase("ready");
          if (!s.configured && admin) setTab("config");
          load(s, p, cat);
        } catch (e) {
          setError("No se pudo iniciar: " + (e.message || e)); setPhase("error");
        }
      })();
    }, []);

    // Carga en dos tiempos cuando el período es largo: primero los últimos 14
    // días (el tablero ya se puede usar) y después el resto del historial,
    // que reutiliza lo ya descargado.
    async function load(s, p, cat, force) {
      const id = ++loadId.current;
      setLoading(0); setError(null);
      try {
        if (force) await GI.loadCatalogs(api, database, true).then(c => { setCatalogs(c); cat = c; });
        const ruleIds = GI.riskRuleIds(s.rule_mapping);
        const large = cat.devices.length > LARGE_FLEET;
        const scope = large && groupRef.current.length ? groupRef.current : s.scope_group_ids;
        const t0 = performance.now();
        const quickFrom = GI.dayKey(GI.addDays(GI.parseDayKey(p.to), -13));
        const steps = quickFrom > p.from ? [{ from: quickFrom, label: "Cargando los últimos 14 días" }, { from: p.from, label: "Completando el historial; ya podés usar el tablero" }]
          : [{ from: p.from, label: "Descargando datos" }];
        for (const st of steps) {
          setLoadingLabel(st.label); setLoading(0);
          const r = await GI.loadPeriod(api, database, st.from, p.to, ruleIds, v => { if (id === loadId.current) setLoading(v); }, scope);
          if (id !== loadId.current) return;
          r.loadedMs = performance.now() - t0;
          r.ruleIds = new Set(ruleIds);
          r.complete = st.from === p.from;
          setRaw(r);
        }
      } catch (e) {
        if (id === loadId.current) setError("Error consultando MyGeotab: " + (e.message || e));
      }
      if (id === loadId.current) setLoading(null);
    }

    const model = useMemo(() => (raw && catalogs && settings ? GI.buildModel(raw, catalogs, settings) : null), [raw, catalogs, settings]);
    const groupsFlat = useMemo(() => (catalogs ? GI.flattenGroups(catalogs.groups) : []), [catalogs]);

    const view = useMemo(() => {
      if (!model) return null;
      const ids = GI.filterDevices(model, { groupIds: mgGroups, vtype: filter.vtype, stype: filter.stype });
      const series = GI.series(model, ids, gran);
      const total = GI.kpis(GI.aggregate(model, ids));
      const vRows = GI.vehicleRows(model, ids);
      const dRows = GI.driverRows(model, ids);
      const rRows = GI.routeRows(model, ids);
      const pRows = GI.profileRows(model, ids);
      const events = model.events.filter(e => ids.has(e.d));
      return {
        model, ids, gran, settings, series, total, vRows, dRows, rRows, pRows, events, milestones,
        findings: GI.findings(model, ids, vRows, dRows),
        savings: GI.savings(vRows),
      };
    }, [model, filter, mgGroups, gran, milestones]);

    async function saveSettings(next) {
      const saved = await GI.saveSettings(api, next);
      const prevRules = raw ? raw.ruleIds : new Set();
      const needsReload = GI.riskRuleIds(saved.rule_mapping).some(r => !prevRules.has(r));
      setSettings(saved);
      if (needsReload) load(saved, period, catalogs);
      return saved;
    }

    // Flota grande: al cambiar el filtro de grupos de MyGeotab se consulta solo ese alcance.
    const mgKey = mgGroups.slice().sort().join(",");
    useEffect(() => {
      groupRef.current = mgGroups;
      if (phase === "ready" && largeFleet && settings) load(settings, period, catalogs);
    }, [mgKey]);

    function applyPreset(v) {
      if (v === "custom") { setCustomDraft({ from: period.from, to: period.to }); return; }
      const p = { preset: +v, ...rangeFor(+v) };
      setPeriod(p); setCustomDraft(null);
      load(settings, p, catalogs);
    }

    if (phase === "init") return html`<div className="splash"><div className="spinner"></div>Cargando configuración de ${database}…</div>`;
    if (phase === "error") return html`<div className="splash"><${Info} tone="error">${error}<//></div>`;

    const vtypes = [...settings.vehicle_types, { key: "sin_tipo", label: "Sin tipo" }];
    const activeFilters = [];
    const groupName = id => ((catalogs.groups.find(g => g.id === id) || {}).name || id);
    const mgLabel = mgGroups.length ? mgGroups.slice(0, 3).map(groupName).join(", ") + (mgGroups.length > 3 ? " y " + (mgGroups.length - 3) + " más" : "") : "Toda la flota";
    if (filter.vtype) activeFilters.push({ key: "v", label: (vtypes.find(v => v.key === filter.vtype) || {}).label || filter.vtype, clear: () => setFilter(f => ({ ...f, vtype: "" })) });
    if (filter.stype) activeFilters.push({ key: "s", label: filter.stype === "larga" ? "Larga distancia" : "Corta distancia", clear: () => setFilter(f => ({ ...f, stype: "" })) });
    return html`<div className="app">
      <header className="topbar">
        <div className="brand"><h1>Geotab Insights</h1><span className="sub">Base ${database}${isAdmin ? ", con permisos de administrador" : ""}</span></div>
        <div className="controls">
          <label className="ctl">Período
            <select value=${customDraft ? "custom" : period.preset || "custom"} onChange=${e => applyPreset(e.target.value)}>
              ${[30, 60, 90, 180, 365].map(d => html`<option key=${d} value=${d}>Últimos ${d} días</option>`)}
              <option value="custom">Personalizado…</option>
            </select></label>
          ${customDraft ? html`<span className="ctl dates">
            <input type="date" value=${customDraft.from} onChange=${e => setCustomDraft(c => ({ ...c, from: e.target.value }))} />
            <input type="date" value=${customDraft.to} max=${GI.dayKey(new Date())} onChange=${e => setCustomDraft(c => ({ ...c, to: e.target.value }))} />
            <button className="btn primary" disabled=${!customDraft.from || !customDraft.to || customDraft.from > customDraft.to}
              onClick=${() => { const p = { preset: null, ...customDraft }; setPeriod(p); setCustomDraft(null); load(settings, p, catalogs); }}>Aplicar</button>
          </span>` : null}
          <label className="ctl">Agrupar
            <${Segmented} value=${gran} onChange=${setGran} options=${[{ value: "day", label: "Día" }, { value: "week", label: "Semana" }, { value: "month", label: "Mes" }]} /></label>
          <div className="ctl">Grupos
            <span className="mg-groups" title="Se toma del filtro de grupos de MyGeotab (arriba a la izquierda). Cambialo ahí y el tablero se actualiza solo.">${mgLabel}</span></div>
          <label className="ctl">Tipo
            <select value=${filter.vtype} onChange=${e => setFilter(f => ({ ...f, vtype: e.target.value }))}>
              <option value="">Todos</option>${vtypes.map(v => html`<option key=${v.key} value=${v.key}>${v.label}</option>`)}
            </select></label>
          <label className="ctl">Servicio
            <select value=${filter.stype} onChange=${e => setFilter(f => ({ ...f, stype: e.target.value }))}>
              <option value="">Todos</option><option value="corta">Corta distancia</option><option value="larga">Larga distancia</option>
            </select></label>
          <button className="btn" disabled=${loading != null} title="Vuelve a consultar los días recientes y los catálogos"
            onClick=${() => load(settings, period, catalogs, true)}>↻ Actualizar</button>
        </div>
      </header>
      ${activeFilters.length ? html`<div className="filterbar" role="status">
        <span>Mostrando:</span>
        ${activeFilters.map(f => html`<span key=${f.key} className="fchip">${f.label}<button aria-label=${"Quitar " + f.label} onClick=${f.clear}>×</button></span>`)}
        <button className="btn link small" onClick=${() => setFilter({ vtype: "", stype: "" })}>Quitar filtros</button>
      </div>` : null}
      ${loading != null ? html`<${Progress} value=${loading} label=${loadingLabel || "Descargando datos"} />` : null}
      <nav className="tabs">${TABS.map(([k, l]) => html`<button key=${k} className=${tab === k ? "on" : ""} onClick=${() => setTab(k)}>${l}</button>`)}</nav>
      <div className="gi-main">
        ${error ? html`<${Info} tone="error">${error}<//>` : null}
        ${largeFleet && !mgGroups.length && !(settings.scope_group_ids || []).length && tab !== "config" ? html`<${Info} tone="warn">
          Esta base tiene ${GI.fmtNum(catalogs.devices.length)} vehículos. Para que cargue rápido, elegí uno o más grupos en el <b>filtro de grupos de MyGeotab</b> (arriba a la izquierda): se consulta solo ese alcance.
          ${isAdmin ? " También podés fijar el alcance para todos en Configuración → Combustible y alcance." : ""}<//>` : null}
        ${tab === "config" ? html`<${GI.ConfigTab} api=${api} settings=${settings} catalogs=${catalogs} groups=${groupsFlat}
            model=${model} isAdmin=${isAdmin} userName=${userName} onSave=${saveSettings} />`
          : !view ? html`<div className="splash small"><div className="spinner"></div>Preparando el tablero…</div>`
          : tab === "resumen" ? html`<${GI.SummaryTab} view=${view} onGo=${setTab} />`
          : tab === "combustible" ? html`<${GI.FuelTab} view=${view} onVehicle=${id => setDetail({ type: "v", id })} />`
          : tab === "seguridad" ? html`<${GI.SafetyTab} view=${view} onVehicle=${id => setDetail({ type: "v", id })} />`
          : tab === "conductores" ? html`<${GI.DriversTab} view=${view} onDriver=${id => setDetail({ type: "d", id })} />`
          : tab === "recorridos" ? html`<${GI.RoutesTab} view=${view} api=${api} />`
          : tab === "hitos" ? html`<${GI.MilestonesTab} view=${view} milestones=${milestones} isAdmin=${isAdmin} groups=${groupsFlat}
              onAdd=${async m => { const r = await GI.addMilestone(api, m); setMilestones(ms => [...ms, r]); }}
              onUpdate=${async m => { await GI.updateMilestone(api, m); setMilestones(ms => ms.map(x => (x.id === m.id ? m : x))); }}
              onDelete=${async id => { await GI.removeMilestone(api, id); setMilestones(ms => ms.filter(x => x.id !== id)); }} />`
          : null}
        ${raw ? html`<footer className="foot">Datos del ${raw.fromKey} al ${raw.toKey}${raw.complete ? "" : " (completando el resto del período)"}: ${GI.fmtNum(raw.trips.length)} viajes y ${GI.fmtNum(raw.exceptions.length)} eventos, cargados en ${GI.fmtNum(raw.loadedMs / 1000, 1)} s.</footer>` : null}
      </div>
      ${detail && view && detail.type === "v" ? html`<${GI.VehicleDetail} view=${view} id=${detail.id} onClose=${() => setDetail(null)} />` : null}
      ${detail && view && detail.type === "d" ? html`<${GI.DriverDetail} view=${view} id=${detail.id} onClose=${() => setDetail(null)} />` : null}
    </div>`;
  }

  GI.App = App;

  // ---------- Entry point del Add-In ----------
  // initialize recibe el api ya autenticado. getSession(callback): el
  // callback se declara con 2 parámetros (credentials, server) para que el
  // SDK siempre los pase separados. El 2.º argumento de getSession, si se
  // usara, es un booleano (newSession), nunca un callback de error.
  let root = null;
  window.geotab = window.geotab || {};
  window.geotab.addin = window.geotab.addin || {};
  window.geotab.addin.cesettiInsightsV3 = function () {
    return {
      initialize: function (api, state, done) {
        api.getSession(function (credentials, server) {
          if (!root) {
            root = ReactDOM.createRoot(document.getElementById("gi3-root"));
            root.render(html`<${App} api=${GI.wrapApi(api)} database=${credentials.database} userName=${credentials.userName} />`);
          }
          done();
        });
      },
      // MyGeotab llama a focus al cargar y cada vez que cambia el filtro de grupos.
      focus: function (api, state) {
        let ids = [];
        try { ids = ((state && state.getGroupFilter && state.getGroupFilter()) || []).map(g => (typeof g === "string" ? g : g && g.id)).filter(Boolean); } catch (e) { ids = []; }
        if (ids.includes("GroupCompanyId")) ids = [];
        GI._mgGroups = ids;
        if (GI._onMgGroups) GI._onMgGroups(ids);
      },
      blur: function () {},
    };
  };
})(window.GI);
