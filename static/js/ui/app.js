// Aplicación principal + entry point del Add-In.
(function (GI) {
  "use strict";
  const React = GI.React, ReactDOM = GI.ReactDOM;
  const { useState, useEffect, useMemo, useRef } = React;
  const html = GI.html;
  const { Segmented, Info, Progress } = GI;

  const TABS = [
    ["resumen", "Resumen"],
    ["combustible", "Combustible y ralentí"],
    ["seguridad", "Seguridad"],
    ["conductores", "Conductores"],
    ["recorridos", "Recorridos"],
    ["exposicion", "Exposición"],
    ["corredores", "Corredores"],
    ["hitos", "Hitos"],
    ["config", "Configuración"],
  ];

  // Config guardada + campos nuevos que pudieran faltar (versiones futuras).
  function mergeDefaults(saved, defaults) {
    if (!saved) return defaults;
    const out = { ...defaults, ...saved };
    for (const k of ["service", "fuel", "journeys", "drivers", "ui", "fatigue", "severity"]) out[k] = { ...defaults[k], ...(saved[k] || {}) };
    out.service.group_ids = { ...defaults.service.group_ids, ...((saved.service || {}).group_ids || {}) };
    out.category_weights = { ...defaults.category_weights, ...(saved.category_weights || {}) };
    out.categories = saved.categories && saved.categories.length ? saved.categories : defaults.categories;
    out.rule_targets = saved.rule_targets || {};
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
    // Conductor (no administrador): ve solo "Mi desempeño" con sus datos.
    const [me, setMe] = useState(null);
    const [benchmark, setBenchmark] = useState(null);
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
    const zonesAreaRef = useRef(false);
    const groupRef = useRef(GI._mgGroups || []);
    const [loadingLabel, setLoadingLabel] = useState("");
    const [largeFleet, setLargeFleet] = useState(false);
    const [noShared, setNoShared] = useState(false);
    const [sharing, setSharing] = useState(null);
    const [sharingBusy, setSharingBusy] = useState(false);
    async function shareNow() {
      setSharingBusy(true);
      try {
        const saved = await GI.shareWithAll(api, settings, milestones);
        setSettings(saved);
        const shared = await GI.loadShared(api);
        setSharing(await GI.sharingStatus(api, shared._settingsRecords));
      } catch (e) { setError("No se pudo compartir la configuración: " + (e.message || e)); }
      setSharingBusy(false);
    }

    // ---- Arranque: catálogos + config compartida ----
    useEffect(() => {
      (async () => {
        try {
          const [cat, shared] = await Promise.all([GI.loadCatalogs(api, database), GI.loadShared(api)]);
          const defaults = GI.defaultSettings(cat.groups, cat.rules);
          const s = mergeDefaults(shared.settings, defaults);
          GI.applyCategories(s.categories);
          const [admin, user] = await Promise.all([GI.resolveIsAdmin(api, userName, s), GI.currentUser(api, userName)]);
          setMe(user); setBenchmark(shared.benchmark || null);
          setCatalogs(cat); setSettings(s); setMilestones(shared.milestones); setIsAdmin(admin);
          setNoShared(!shared.settings);
          // El administrador ve si hay usuarios que todavía no reciben su configuración.
          if (admin && shared.settings) GI.sharingStatus(api, shared._settingsRecords).then(st => setSharing(st));
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
          if (!admin && user && user.isDriver && s.driver_view !== false) setTab("mi");
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
        if (force) { zonesAreaRef.current = false; await GI.loadCatalogs(api, database, true).then(c => { setCatalogs(c); cat = c; }); }
        const ruleIds = GI.riskRuleIds(s.rule_mapping);
        const large = cat.devices.length > LARGE_FLEET;
        const scope = large && groupRef.current.length ? groupRef.current : s.scope_group_ids;
        const t0 = performance.now();
        const quickFrom = GI.dayKey(GI.addDays(GI.parseDayKey(p.to), -13));
        const steps = quickFrom > p.from ? [{ from: quickFrom, label: "Viajes e infracciones de los últimos 14 días" }, { from: p.from, label: "Resto del período (ya podés usar el tablero)" }]
          : [{ from: p.from, label: "Viajes e infracciones" }];
        let last = null;
        for (const st of steps) {
          setLoadingLabel(st.label); setLoading(0);
          const r = await GI.loadPeriod(api, database, st.from, p.to, ruleIds, v => { if (id === loadId.current) setLoading(v); }, scope, { withFuel: false });
          if (id !== loadId.current) return;
          r.loadedMs = performance.now() - t0;
          r.ruleIds = new Set(ruleIds);
          r.complete = st.from === p.from;
          last = r;
          setRaw(r);
          if (st === steps[0]) loadZonesFor(r, id);
        }
        // Combustible al final: es lo más pesado y no bloquea el resto del tablero.
        setLoadingLabel("Combustible"); setLoading(0);
        const f = await GI.loadFuel(api, database, p.from, p.to, scope, v => { if (id === loadId.current) setLoading(v); });
        if (id !== loadId.current) return;
        setRaw({ ...last, ...f, fuelPending: false, loadedMs: performance.now() - t0 });
      } catch (e) {
        if (id === loadId.current) setError("Error consultando MyGeotab: " + (e.message || e));
      }
      if (id === loadId.current) setLoading(null);
    }

    // Zonas: solo las del área recorrida y después de mostrar el tablero.
    async function loadZonesFor(r, id) {
      if (zonesAreaRef.current) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const t of r.trips) if (t.x != null) { x0 = Math.min(x0, t.x); x1 = Math.max(x1, t.x); y0 = Math.min(y0, t.y); y1 = Math.max(y1, t.y); }
      const area = x0 === Infinity ? null : [x0, y0, x1, y1];
      zonesAreaRef.current = true;
      try {
        const zones = await GI.loadZones(api, database, area);
        setCatalogs(c => ({ ...c, zones }));
      } catch (e) {
        setCatalogs(c => ({ ...c, zones: [] }));
      }
    }

    // Errores de cálculo: se muestran en pantalla (y en la consola) en vez de dejarla en blanco.
    const [calcError, setCalcError] = useState(null);
    const model = useMemo(() => {
      if (!(raw && catalogs && settings)) return null;
      try { return GI.buildModel(raw, catalogs, settings); }
      catch (e) { console.error("[Geotab Insights] buildModel", e); setTimeout(() => setCalcError(e), 0); return null; }
    }, [raw, catalogs, settings]);
    const groupsFlat = useMemo(() => (catalogs ? GI.flattenGroups(catalogs.groups) : []), [catalogs]);

    const driverMode = !!(me && me.isDriver && !isAdmin && settings && settings.driver_view !== false);
    const view = useMemo(() => {
      if (!model) return null;
      try {
      if (driverMode) {
        // Solo los vehículos que manejó y solo él como conductor.
        const own = new Set();
        for (const [ck] of model.drvCells.get(me.id) || []) own.add(ck.split("|")[0]);
        const ids = new Set([...own].filter(id => model.devById.has(id)));
        const driverOk = id => id === me.id;
        return { model, ids, gran, settings, milestones, driverOk, me, benchmark, driverMode: true,
          series: GI.series(model, ids, gran), total: GI.kpis(GI.aggregate(model, ids)), events: model.events.filter(e => e.drv === me.id) };
      }
      const ids = GI.filterDevices(model, { groupIds: mgGroups, vtype: filter.vtype, stype: filter.stype });
      const series = GI.series(model, ids, gran);
      const total = GI.kpis(GI.aggregate(model, ids));
      const vRows = GI.vehicleRows(model, ids);
      // Conductores: además del vehículo, su propio grupo de conductor debe
      // estar en el filtro (si no, aparecen choferes de otros grupos de trabajo
      // que manejaron un vehículo del grupo).
      const driverOk = GI.driverFilter(model, mgGroups.length ? mgGroups : settings.scope_group_ids);
      const dRows = GI.driverRows(model, ids, driverOk);
      const rRows = GI.routeRows(model, ids);
      const pRows = GI.profileRows(model, ids);
      const events = model.events.filter(e => ids.has(e.d));
      return {
        model, ids, gran, settings, series, total, vRows, dRows, rRows, pRows, events, milestones, driverOk,
        findings: GI.findings(model, ids, vRows, dRows),
        savings: GI.savings(vRows),
      };
      } catch (e) { console.error("[Geotab Insights] view", e); setTimeout(() => setCalcError(e), 0); return null; }
    }, [model, filter, mgGroups, gran, milestones, driverMode, benchmark]);

    async function publishBenchmark() {
      const b = GI.buildBenchmark(model);
      const saved = await GI.saveBenchmark(api, b);
      setBenchmark(saved);
    }

    async function saveSettings(next) {
      const saved = await GI.saveSettings(api, next);
      GI.applyCategories(saved.categories);
      setNoShared(false);
      GI.loadShared(api).then(sh => GI.sharingStatus(api, sh._settingsRecords)).then(st => setSharing(st)).catch(() => {});
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
      if (phase === "ready" && largeFleet && settings) {
        zonesAreaRef.current = false;
        setCatalogs(c => (c ? { ...c, zones: null } : c));
        load(settings, period, catalogs);
      }
    }, [mgKey]);

    function applyPreset(v) {
      if (v === "custom") { setCustomDraft({ from: period.from, to: period.to }); return; }
      if (v === "range") return; // el rango personalizado ya aplicado
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
            <select value=${customDraft ? "custom" : period.preset || "range"} onChange=${e => applyPreset(e.target.value)}>
              ${[30, 60, 90, 180, 365].map(d => html`<option key=${d} value=${d}>Últimos ${d} días</option>`)}
              ${!period.preset ? html`<option value="range">Del ${period.from} al ${period.to}</option>` : null}
              <option value="custom">Personalizado…</option>
            </select></label>
          ${customDraft ? html`<span className="ctl dates">
            <input type="date" value=${customDraft.from} onChange=${e => setCustomDraft(c => ({ ...c, from: e.target.value }))} />
            <input type="date" value=${customDraft.to} max=${GI.dayKey(new Date())} onChange=${e => setCustomDraft(c => ({ ...c, to: e.target.value }))} />
            <button className="btn primary" disabled=${!customDraft.from || !customDraft.to || customDraft.from > customDraft.to}
              onClick=${() => { const p = { preset: null, ...customDraft }; setPeriod(p); setCustomDraft(null); load(settings, p, catalogs); }}>Aplicar</button>
            <button className="btn" onClick=${() => setCustomDraft(null)}>Cancelar</button>
          </span>` : null}
          <label className="ctl">Agrupar
            <${Segmented} value=${gran} onChange=${setGran} options=${[{ value: "day", label: "Día" }, { value: "week", label: "Semana" }, { value: "month", label: "Mes" }]} /></label>
          ${driverMode ? null : html`<div className="ctl">Grupos
            <span className="mg-groups" title="Se toma del filtro de grupos de MyGeotab (arriba a la izquierda). Cambialo ahí y el tablero se actualiza solo.">${mgLabel}</span></div>
          <label className="ctl">Tipo
            <select value=${filter.vtype} onChange=${e => setFilter(f => ({ ...f, vtype: e.target.value }))}>
              <option value="">Todos</option>${vtypes.map(v => html`<option key=${v.key} value=${v.key}>${v.label}</option>`)}
            </select></label>
          <label className="ctl">Servicio
            <select value=${filter.stype} onChange=${e => setFilter(f => ({ ...f, stype: e.target.value }))}>
              <option value="">Todos</option><option value="corta">Corta distancia</option><option value="larga">Larga distancia</option>
            </select></label>`}
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
      <nav className="tabs">${(driverMode ? [["mi", "Mi desempeño"]] : TABS).map(([k, l]) => html`<button key=${k} className=${tab === k ? "on" : ""} onClick=${() => setTab(k)}>${l}</button>`)}</nav>
      <div className="gi-main">
        ${error ? html`<${Info} tone="error">${error}<//>` : null}
        ${noShared && !isAdmin && !driverMode ? html`<${Info} tone="warn">Estás viendo la configuración por defecto: un administrador todavía no la configuró, o la guardó antes de que se compartiera con tu grupo. Pedile que abra el add-in y guarde la configuración (o use "Compartir con todos").<//>` : null}
        ${isAdmin && sharing && sharing.missingUsers.length ? html`<${Info} tone="warn">
          <b>${GI.fmtNum(sharing.missingUsers.length)} usuarios no ven tu configuración</b> porque su acceso a datos es un grupo con el que todavía no está compartida
          (${sharing.missingUsers.slice(0, 3).join(", ")}${sharing.missingUsers.length > 3 ? "…" : ""}). Hasta entonces ven los valores por defecto.
          <button className="btn primary small" style=${{ marginLeft: "8px" }} disabled=${sharingBusy} onClick=${shareNow}>${sharingBusy ? "Compartiendo…" : "Compartir con todos"}</button><//>` : null}
        ${calcError ? html`<${Info} tone="error"><b>Error al calcular el tablero:</b> ${String(calcError.message || calcError)}
          <details><summary>Detalle técnico</summary><pre style=${{ whiteSpace: "pre-wrap", fontSize: "12px" }}>${String(calcError.stack || "")}</pre></details><//>` : null}
        ${raw && raw.fuelPending && (tab === "combustible" || tab === "resumen") ? html`<${Info}>Los datos de combustible se están cargando; los litros y costos se completan en unos segundos.<//>` : null}
        ${largeFleet && !driverMode && !mgGroups.length && !(settings.scope_group_ids || []).length && tab !== "config" ? html`<${Info} tone="warn">
          Esta base tiene ${GI.fmtNum(catalogs.devices.length)} vehículos. Para que cargue rápido, elegí uno o más grupos en el <b>filtro de grupos de MyGeotab</b> (arriba a la izquierda): se consulta solo ese alcance.
          ${isAdmin ? " También podés fijar el alcance para todos en Configuración → Combustible y alcance." : ""}<//>` : null}
        ${model && !driverMode && model.fleetCount && model.excludedCount / model.fleetCount > 0.3 && tab !== "config" ? html`<${Info} tone="warn">
          Los grupos excluidos dejan afuera <b>${GI.fmtNum(model.excludedCount)} de ${GI.fmtNum(model.fleetCount)} vehículos</b>
          (${model.exclusionImpact.slice(0, 3).map(x => `${x.name}: ${GI.fmtNum(x.devices)}`).join(" · ")}).
          ${isAdmin ? " Revisalo en Configuración → Combustible y alcance → Excluir siempre estos grupos." : " Pedile a un administrador que revise los grupos excluidos."}<//>` : null}
        <${ErrorBoundary} key=${tab}>
        ${tab === "config" ? html`<${GI.ConfigTab} api=${api} settings=${settings} catalogs=${catalogs} groups=${groupsFlat}
            model=${model} isAdmin=${isAdmin} userName=${userName} onSave=${saveSettings}
            benchmark=${benchmark} onPublishBenchmark=${publishBenchmark} mgGroups=${mgGroups} />`
          : !view ? html`<div className="splash small"><div className="spinner"></div>Preparando el tablero…</div>`
          : driverMode || tab === "mi" ? html`<${GI.MyPerformanceTab} view=${view} />`
          : tab === "resumen" ? html`<${GI.SummaryTab} view=${view} onGo=${setTab} />`
          : tab === "combustible" ? html`<${GI.FuelTab} view=${view} onVehicle=${id => setDetail({ type: "v", id })} />`
          : tab === "seguridad" ? html`<${GI.SafetyTab} view=${view} onVehicle=${id => setDetail({ type: "v", id })} onDriver=${id => setDetail({ type: "d", id })} />`
          : tab === "conductores" ? html`<${GI.DriversTab} view=${view} onDriver=${id => setDetail({ type: "d", id })} />`
          : tab === "recorridos" ? html`<${GI.RoutesTab} view=${view} api=${api} />`
          : tab === "exposicion" ? html`<${GI.ExposureTab} view=${view} onDriver=${id => setDetail({ type: "d", id })} />`
          : tab === "corredores" ? html`<${GI.RoadsTab} view=${view} api=${api} database=${database} />`
          : tab === "hitos" ? html`<${GI.MilestonesTab} view=${view} milestones=${milestones} isAdmin=${isAdmin} groups=${groupsFlat}
              onAdd=${async m => { const r = await GI.addMilestone(api, m); setMilestones(ms => [...ms, r]); }}
              onUpdate=${async m => { await GI.updateMilestone(api, m); setMilestones(ms => ms.map(x => (x.id === m.id ? m : x))); }}
              onDelete=${async id => { await GI.removeMilestone(api, id); setMilestones(ms => ms.filter(x => x.id !== id)); }} />`
          : null}
        <//>
        ${raw ? html`<footer className="foot">Datos del ${raw.fromKey} al ${raw.toKey}${raw.complete ? "" : " (completando el resto del período)"}: ${GI.fmtNum(raw.trips.length)} viajes y ${GI.fmtNum(raw.exceptions.length)} eventos, cargados en ${GI.fmtNum(raw.loadedMs / 1000, 1)} s.</footer>` : null}
      </div>
      ${detail && view && detail.type === "v" ? html`<${GI.VehicleDetail} view=${view} id=${detail.id} onClose=${() => setDetail(null)} />` : null}
      ${detail && view && detail.type === "d" ? html`<${GI.DriverDetail} view=${view} id=${detail.id} onClose=${() => setDetail(null)} />` : null}
    </div>`;
  }

  // Si algo falla al dibujar una pestaña, se muestra el error en vez de
  // dejar la pantalla en blanco.
  class ErrorBoundary extends React.Component {
    constructor(props) { super(props); this.state = { err: null }; }
    static getDerivedStateFromError(err) { return { err }; }
    componentDidCatch(err, info) { console.error("[Geotab Insights]", err, info); }
    render() {
      if (!this.state.err) return this.props.children;
      const e = this.state.err;
      return html`<${Info} tone="error"><b>No se pudo mostrar esta pestaña.</b> ${String(e && e.message || e)}
        <details style=${{ marginTop: "8px" }}><summary>Detalle técnico (para soporte)</summary><pre style=${{ whiteSpace: "pre-wrap", fontSize: "12px" }}>${String(e && e.stack || "")}</pre></details>
        <button className="btn small" style=${{ marginTop: "8px" }} onClick=${() => this.setState({ err: null })}>Reintentar</button><//>`;
    }
  }

  // Navega a la página de eventos de MyGeotab con los filtros del caso.
  // MyGeotab no documenta los parámetros de "eventsInsights": se envían los
  // habituales (rango de fechas, reglas, vehículos, conductores) y la página
  // toma los que reconoce. El filtro de grupos de MyGeotab sigue aplicado.
  GI.EVENTS_PAGE = "eventsInsights";
  // Abre la página Eventos de MyGeotab con los filtros aplicados. Formato
  // verificado en MyGeotab 11.146 (estado en el hash, notación rison):
  // #eventsInsights,activeTab:overview,assetsFilter:!(id),driversFilter:!(id),
  //   dateRangeFilter:(from:'ISO',label:unknown,to:'ISO'),exceptionRulesFilter:!(id),groupByFilter:Device
  const risonStr = v => "'" + String(v).replace(/!/g, "!!").replace(/'/g, "!'") + "'";
  const risonList = arr => "!(" + arr.map(risonStr).join(",") + ")";
  GI.openEventsPage = function (o) {
    // La página de Eventos no acepta el filtro de grupos por URL (groupsFilter
    // la deja en blanco), así que el alcance se pasa como lista de vehículos.
    const few = (arr, max) => (arr && arr.length && arr.length <= (max || 100) ? arr : null);
    const from = GI.parseDayKey(o.from).toISOString();
    const to = GI.addDays(GI.parseDayKey(o.to), 1).toISOString();
    const parts = [GI.EVENTS_PAGE, "activeTab:overview"];
    const devs = few(o.deviceIds, 600), drvs = few(o.driverIds), rules = few(o.ruleIds);
    if (devs) parts.push("assetsFilter:" + risonList(devs));
    parts.push("dateRangeFilter:(from:" + risonStr(from) + ",label:unknown,to:" + risonStr(to) + ")");
    if (drvs) parts.push("driversFilter:" + risonList(drvs));
    if (rules) parts.push("exceptionRulesFilter:" + risonList(rules));
    parts.push("groupByFilter:" + (drvs ? "Driver" : "Device"));
    window.location.hash = parts.join(",");
  };

  GI.App = App;

  // ---------- Entry point del Add-In ----------
  // initialize recibe el api ya autenticado. getSession(callback): el
  // callback se declara con 2 parámetros (credentials, server) para que el
  // SDK siempre los pase separados. El 2.º argumento de getSession, si se
  // usara, es un booleano (newSession), nunca un callback de error.
  let root = null;
  // Versión: la BETA se sirve desde la rama beta (githack); la normal, desde GitHub Pages.
  let SRC = (document.currentScript && document.currentScript.src) || "";
  if (!SRC) { try { throw new Error("x"); } catch (e) { SRC = String(e.stack || ""); } }
  const BUILD = /githack|\/beta\/|\/exposicion\//.test(SRC) ? "beta" : "main";
  GI.BUILD = BUILD;
  // Cada versión toma su propio contenedor #gi3-root (si las dos están en la
  // página, getElementById devolvería siempre el primero).
  function claimRoot() {
    const all = [...document.querySelectorAll("#gi3-root")];
    return all.find(el => el.dataset.giOwner === BUILD)
      || all.slice().reverse().find(el => !el.dataset.giOwner)
      || all[all.length - 1];
  }
  window.geotab = window.geotab || {};
  window.geotab.addin = window.geotab.addin || {};
  window.geotab.addin[BUILD === "beta" ? "cesettiInsightsV3Beta" : "cesettiInsightsV3"] = function () {
    return {
      initialize: function (api, state, done) {
        GI._mgState = state;
        api.getSession(function (credentials, server) {
          if (!root) {
            const el = claimRoot();
            el.dataset.giOwner = BUILD;
            root = ReactDOM.createRoot(el);
            root.render(html`<${App} api=${GI.wrapApi(api)} database=${credentials.database} userName=${credentials.userName} />`);
          }
          done();
        });
      },
      // MyGeotab llama a focus al cargar y cada vez que cambia el filtro de grupos.
      focus: function (api, state) {
        if (state) GI._mgState = state;
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
