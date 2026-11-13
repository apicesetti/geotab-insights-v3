// Configuración compartida (AddInData). Solo administradores la editan; el
// resto la ve en modo lectura.
(function (GI) {
  "use strict";
  const React = GI.React, ReactDOM = GI.ReactDOM;
  const { useState, useMemo, useEffect } = React;
  const html = GI.html;
  const { Panel, Info, GroupMultiSelect } = GI;

  const SECTIONS = [
    ["categorias", "Categorías"],
    ["reglas", "Reglas y objetivos"],
    ["tipos", "Tipos de vehículo"],
    ["servicio", "Corta / larga distancia"],
    ["objetivos", "Objetivos por perfil"],
    ["recorridos", "Recorridos"],
    ["fatiga", "Fatiga y gravedad"],
    ["referencias", "Conductores y referencias"],
    ["alcance", "Combustible y alcance"],
    ["general", "General"],
  ];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function ConfigTab({ api, settings, catalogs, groups, model, isAdmin, userName, onSave, benchmark, onPublishBenchmark, mgGroups }) {
    const [draft, setDraft] = useState(() => clone(settings));
    const [section, setSection] = useState("categorias");
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState(null);
    const dirty = JSON.stringify({ ...draft, _rev: 0, updated_at: 0 }) !== JSON.stringify({ ...settings, _rev: 0, updated_at: 0 });
    const ro = !isAdmin;
    const set = (path, value) => setDraft(d => {
      const n = clone(d);
      let o = n;
      for (let i = 0; i < path.length - 1; i++) o = o[path[i]] || (o[path[i]] = {});
      o[path[path.length - 1]] = value;
      return n;
    });

    async function save() {
      setSaving(true); setMsg(null);
      try {
        const saved = await onSave({ ...draft, configured: true });
        setDraft(clone(saved));
        setMsg({ tone: "ok", text: "Configuración guardada para todos los usuarios de la base." });
      } catch (e) {
        setMsg({ tone: "error", text: "No se pudo guardar: " + (e.message || e) });
      }
      setSaving(false);
    }

    // Guardado directo de la sección de fatiga (Parametrizar a IOGP 365 / volver atrás)
    async function saveFatigue(fatigue, okText) {
      setSaving(true); setMsg(null);
      try {
        const saved = await onSave({ ...draft, fatigue, configured: true });
        setDraft(clone(saved));
        setMsg({ tone: "ok", text: okText });
      } catch (e) {
        setMsg({ tone: "error", text: "No se pudo guardar: " + (e.message || e) });
        throw e;
      } finally { setSaving(false); }
    }

    const body = {
      reglas: html`<${RulesSection} api=${api} draft=${draft} set=${set} rules=${catalogs.rules} ro=${ro} />`,
      tipos: html`<${TypesSection} draft=${draft} set=${set} groups=${groups} ro=${ro} model=${model} />`,
      servicio: html`<${ServiceSection} draft=${draft} set=${set} groups=${groups} ro=${ro} model=${model} />`,
      objetivos: html`<${TargetsSection} draft=${draft} set=${set} ro=${ro} model=${model} />`,
      categorias: html`<${CategoriesSection} draft=${draft} set=${set} ro=${ro} />`,
      recorridos: html`<${RoutesSection} api=${api} draft=${draft} set=${set} ro=${ro} />`,
      fatiga: html`<${FatigueSection} draft=${draft} set=${set} ro=${ro} dirty=${dirty} userName=${userName} onSaveFatigue=${saveFatigue} />${GI.BUILD === "beta" || /\/dev\//.test(location.pathname) ? html`<${SpeedSevSection} draft=${draft} set=${set} ro=${ro} catalogs=${catalogs} api=${api} model=${model} />` : null}`,
      referencias: html`<${ReferenceSection} draft=${draft} set=${set} ro=${ro} model=${model} benchmark=${benchmark} onPublish=${onPublishBenchmark} mgGroups=${mgGroups} groups=${groups} />`,
      alcance: html`<${ScopeSection} draft=${draft} set=${set} groups=${groups} ro=${ro} model=${model} />`,
      general: html`<${GeneralSection} draft=${draft} set=${set} ro=${ro} />`,
    }[section];

    return html`<div className="config">
      ${ro ? html`<${Info}>Modo lectura: solo los administradores de la base (o los editores definidos en General) pueden modificar la configuración. Usuario actual: <b>${userName}</b>.<//>` : null}
      ${!settings.configured && !ro ? html`<${Info} tone="warn"><b>Primera configuración.</b> Revisá las categorías y asigná cada regla de MyGeotab a una categoría en "Reglas y objetivos" (solo se analizan las reglas asignadas). Los tipos de vehículo y los grupos a excluir vienen sugeridos por nombre de grupo. Al guardar, todos los usuarios ven lo mismo.<//>` : null}
      <div className="config-layout">
        <nav className="config-nav">${SECTIONS.map(([k, l]) => html`<button key=${k} className=${section === k ? "on" : ""} onClick=${() => setSection(k)}>${l}</button>`)}</nav>
        <div className="config-body">${body}</div>
      </div>
      ${!ro ? html`<div className=${"savebar" + (dirty ? " dirty" : "")}>
        ${msg ? html`<span className=${"msg " + msg.tone}>${msg.text}</span>` : html`<span className="muted">${dirty ? "Hay cambios sin guardar." : "Sin cambios."}</span>`}
        <button className="btn" disabled=${!dirty || saving} onClick=${() => { setDraft(clone(settings)); setMsg(null); }}>Descartar</button>
        <button className="btn primary" disabled=${(!dirty && settings.configured) || saving} onClick=${save}>${saving ? "Guardando…" : "Guardar para todos"}</button>
      </div>` : null}
    </div>`;
  }

  // ---------- Reglas ----------
  function RulesSection({ api, draft, set, rules, ro }) {
    const cats = draft.categories || GI.DEFAULT_CATEGORIES;
    const catKind = k => (cats.find(c => c.key === k) || {}).kind;
    const targets = draft.rule_targets || {};
    const setTarget = (id, v) => {
      const t = { ...targets };
      if (v === "" || v == null || Number.isNaN(+v)) delete t[id]; else t[id] = +v;
      set(["rule_targets"], t);
    };
    const [q, setQ] = useState("");
    const [showNoise, setShowNoise] = useState(false);
    const [onlyUnmapped, setOnlyUnmapped] = useState(false);
    const [counts, setCounts] = useState(null);
    const [counting, setCounting] = useState(false);
    const mapping = draft.rule_mapping;
    const list = rules
      .filter(r => showNoise || !GI.isNoiseRule(r) || mapping[r.id])
      .filter(r => !q || r.name.toLowerCase().includes(q.toLowerCase()))
      .filter(r => !onlyUnmapped || !mapping[r.id])
      .sort((a, b) => (counts ? (counts[b.id] || 0) - (counts[a.id] || 0) : 0) || a.name.localeCompare(b.name, "es"));
    const sugOf = r => { const k = GI.suggestCategory(r); return k && catKind(k) === "riesgo" ? k : null; };
    const pending = rules.filter(r => !GI.isNoiseRule(r) && !mapping[r.id] && sugOf(r));
    const ruleName = new Map(rules.map(r => [r.id, r.name]));
    const dupes = [...GI.groupBy(Object.keys(mapping), id => mapping[id]).entries()]
      .filter(([c, ids]) => ids.length > 1 && catKind(c) === "riesgo")
      .map(([c, ids]) => [c, ids.map(id => ruleName.get(id) || id)]);

    async function count() {
      setCounting(true);
      const from = GI.addDays(new Date(), -30).toISOString(), to = new Date().toISOString();
      const visible = rules.filter(r => showNoise || !GI.isNoiseRule(r));
      const out = {};
      for (let i = 0; i < visible.length; i += 40) {
        const batch = visible.slice(i, i + 40);
        try {
          const res = await api.multiCall(batch.map(r => ["GetCountOf", { typeName: "ExceptionEvent", search: { ruleSearch: { id: r.id }, fromDate: from, toDate: to } }]));
          batch.forEach((r, j) => { out[r.id] = res[j] || 0; });
        } catch (e) { /* seguimos sin conteo para ese lote */ }
      }
      setCounts(out); setCounting(false);
    }

    function setRule(id, cat) {
      const m = { ...mapping };
      if (cat) m[id] = cat; else delete m[id];
      set(["rule_mapping"], m);
    }

    return html`<${Panel} title="Reglas de MyGeotab → categoría"
      sub="Asigná a una categoría de riesgo las reglas que miden infracciones. Solo esas se descargan: el ralentí se calcula con los viajes, así que no hace falta mapear reglas operativas (y en flotas grandes son la mayor parte del volumen). Excepción: si asignás Ralentí a la regla de ralentí, Fatiga puede detectar los descansos con el motor en marcha. Las de prueba (Dummy, [TEST], .test) quedan ocultas.">
      <div className="toolbar">
        <input placeholder="Buscar regla…" value=${q} onInput=${e => setQ(e.target.value)} />
        <label className="inline"><input type="checkbox" checked=${onlyUnmapped} onChange=${e => setOnlyUnmapped(e.target.checked)} /> Solo sin categoría</label>
        <label className="inline"><input type="checkbox" checked=${showNoise} onChange=${e => setShowNoise(e.target.checked)} /> Mostrar reglas de prueba</label>
        <button className="btn" disabled=${counting} onClick=${count}>${counting ? "Contando…" : "Contar eventos (30 días)"}</button>
        ${!ro && pending.length ? html`<button className="btn primary" onClick=${() => {
          const m = { ...mapping };
          for (const r of pending) m[r.id] = sugOf(r);
          set(["rule_mapping"], m);
        }}>Completar ${pending.length} con la sugerencia</button>` : null}
      </div>
      <div className="table-wrap"><table className="tbl">
        <thead><tr><th>Regla</th><th>Tipo</th>${counts ? html`<th className="num">Eventos 30 d</th>` : null}<th>Categoría</th>
          <th className="num" title="Máximo de eventos cada 100 km. Se usa en Seguridad → Pronóstico.">Objetivo /100 km</th></tr></thead>
        <tbody>${list.map(r => {
          const sug = sugOf(r);
          const cur = mapping[r.id] || "";
          return html`<tr key=${r.id} className=${cur ? "" : "muted-row"}>
            <td>${r.name}${GI.isNoiseRule(r) ? html` <span className="tag">prueba</span>` : null}</td>
            <td className="muted">${r.baseType === "Stock" ? "Stock" : r.name.startsWith("SRF_") ? "Cámara" : "Custom"}</td>
            ${counts ? html`<td className="num">${GI.fmtNum(counts[r.id] || 0)}</td>` : null}
            <td><select disabled=${ro} value=${cur} onChange=${e => setRule(r.id, e.target.value)}>
              <option value="">— No incluir —</option>
              ${cats.map(c => html`<option key=${c.key} value=${c.key}>${c.label}${c.kind !== "riesgo" ? " (operativa: no se consulta)" : ""}${c.key === sug && c.key !== cur ? " (sugerida)" : ""}</option>`)}
            </select></td>
            <td className="num">${cur && catKind(cur) === "riesgo" ? html`<input type="number" step="0.01" min="0" className="num-in" disabled=${ro} placeholder="–"
              value=${targets[r.id] != null ? targets[r.id] : ""} onChange=${e => setTarget(r.id, e.target.value)} />` : null}</td></tr>`;
        })}</tbody></table></div>
      ${dupes.length ? html`<${Info} tone="warn">Hay varias reglas en la misma categoría: ${dupes.map(([c, rs]) => GI.catLabel(c) + " (" + rs.join(", ") + ")").join(" · ")}.
        Si miden la misma situación (ej. "Speeding" y "Speeding (New)", o una regla stock y una custom equivalente) el evento se cuenta dos veces. Usá "Contar eventos" para ver cuál está activa y dejá solo una.<//>` : null}
      <p className="muted small">${Object.keys(mapping).length} reglas incluidas.</p>
    <//>`;
  }

  // ---------- Tipos de vehículo ----------
  function TypesSection({ draft, set, groups, ro, model }) {
    const types = draft.vehicle_types;
    const counts = useMemo(() => {
      const c = {};
      if (model) for (const v of model.vtypeOf.values()) c[v] = (c[v] || 0) + 1;
      return c;
    }, [model]);
    const upd = (i, patch) => set(["vehicle_types"], types.map((t, j) => (j === i ? { ...t, ...patch } : t)));
    const move = (i, d) => {
      const arr = [...types];
      const [x] = arr.splice(i, 1);
      arr.splice(i + d, 0, x);
      set(["vehicle_types"], arr);
    };
    function add() {
      const key = "tipo" + Date.now().toString(36);
      set(["vehicle_types"], [...types, { key, label: "Nuevo tipo", groupIds: [], idle_lph: 2 }]);
      const t = clone(draft.profile_targets);
      for (const st of GI.SERVICE_TYPES) t[GI.profileKey(key, st.key)] = { l100: 0, idle_pct_max: st.key === "corta" ? 20 : 10, risk_max: st.key === "corta" ? 3 : 1.5 };
      set(["profile_targets"], t);
    }
    return html`<${Panel} title="Tipos de vehículo"
      sub="Cada vehículo toma el PRIMER tipo de la lista cuyos grupos contenga (por eso Bitren va antes que Camión). El consumo de ralentí (L/h) se usa solo para vehículos sin medición de combustible.">
      ${types.map((t, i) => html`<div key=${t.key} className="type-row">
        <div className="type-order">${!ro ? html`<button className="btn small" disabled=${i === 0} onClick=${() => move(i, -1)}>▲</button>
          <button className="btn small" disabled=${i === types.length - 1} onClick=${() => move(i, 1)}>▼</button>` : null}</div>
        <div className="type-main">
          <div className="type-line">
            <input className="type-name" disabled=${ro} value=${t.label} onInput=${e => upd(i, { label: e.target.value })} />
            <label className="inline">Ralentí estimado <input type="number" step="0.1" className="num-in" disabled=${ro} value=${t.idle_lph} onChange=${e => upd(i, { idle_lph: +e.target.value })} /> L/h</label>
            <span className="muted">${counts[t.key] || 0} vehículos</span>
            ${!ro ? html`<button className="btn small danger" onClick=${() => set(["vehicle_types"], types.filter((_, j) => j !== i))}>Quitar</button>` : null}
          </div>
          <${GroupMultiSelect} groups=${groups} value=${t.groupIds} disabled=${ro} onChange=${v => upd(i, { groupIds: v })} placeholder="Sin grupos asignados" />
        </div>
      </div>`)}
      ${!ro ? html`<button className="btn" onClick=${add}>+ Agregar tipo</button>` : null}
      ${counts.sin_tipo ? html`<${Info} tone="warn">${counts.sin_tipo} vehículos no caen en ningún tipo y se analizan como "Sin tipo".<//>` : null}
    <//>`;
  }

  // ---------- Servicio ----------
  function ServiceSection({ draft, set, groups, ro, model }) {
    const s = draft.service;
    const summary = useMemo(() => {
      if (!model) return null;
      const out = { corta: { grupo: 0, auto: 0 }, larga: { grupo: 0, auto: 0 } };
      for (const [id, st] of model.serviceOf) {
        const src = model.serviceSource.get(id);
        out[st][src === "grupo" ? "grupo" : "auto"]++;
      }
      return out;
    }, [model]);
    return html`<${Panel} title="Corta y larga distancia"
      sub="Si el vehículo está en uno de estos grupos, se usa eso. Si no, y la clasificación automática está activa, se decide por la distancia mediana de sus recorridos (zona a zona).">
      <div className="form">
        <div className="field"><span>Grupos de <b>corta distancia</b></span>
          <${GroupMultiSelect} groups=${groups} disabled=${ro} value=${s.group_ids.corta} onChange=${v => set(["service", "group_ids", "corta"], v)} /></div>
        <div className="field"><span>Grupos de <b>larga distancia</b></span>
          <${GroupMultiSelect} groups=${groups} disabled=${ro} value=${s.group_ids.larga} onChange=${v => set(["service", "group_ids", "larga"], v)} /></div>
        <label className="inline"><input type="checkbox" disabled=${ro} checked=${s.auto} onChange=${e => set(["service", "auto"], e.target.checked)} /> Clasificar automáticamente los vehículos que no estén en esos grupos</label>
        <label className="inline">Larga distancia si el recorrido mediano supera <input type="number" className="num-in" disabled=${ro || !s.auto} value=${s.threshold_km} onChange=${e => set(["service", "threshold_km", ], +e.target.value)} /> km</label>
      </div>
      <${Info}>Recomendado: crear en MyGeotab subgrupos "Corta distancia" y "Larga distancia" y asignarlos acá (si se llaman así, se detectan solos). La clasificación automática queda como respaldo para los vehículos sin grupo.<//>
      ${summary ? html`<p className="muted">Con los datos cargados: corta ${summary.corta.grupo} por grupo + ${summary.corta.auto} automáticos · larga ${summary.larga.grupo} por grupo + ${summary.larga.auto} automáticos. (Se recalcula al guardar.)</p>` : null}
    <//>`;
  }

  // ---------- Objetivos ----------
  function TargetsSection({ draft, set, ro, model }) {
    const actual = useMemo(() => {
      if (!model) return {};
      const out = {};
      for (const r of GI.profileRows(model, new Set(model.devices.map(d => d.id)))) out[r.profile] = r;
      return out;
    }, [model]);
    const profiles = [];
    for (const vt of [...draft.vehicle_types, { key: "sin_tipo", label: "Sin tipo" }]) {
      for (const st of GI.SERVICE_TYPES) profiles.push({ key: GI.profileKey(vt.key, st.key), label: vt.label + " · " + st.label });
    }
    const t = draft.profile_targets;
    const upd = (k, field, v) => set(["profile_targets"], { ...t, [k]: { ...(t[k] || { l100: 0, idle_pct_max: 15, risk_max: 2 }), [field]: v } });
    return html`<${Panel} title="Objetivos por perfil"
      sub="Un bitren de larga distancia no se mide igual que un camión de corta. L/100 = 0 compara contra la mediana del propio perfil. Entre paréntesis, el valor real del período cargado.">
      <div className="table-wrap"><table className="tbl">
        <thead><tr><th>Perfil</th><th className="num">L/100 km objetivo</th><th className="num">% ralentí máx.</th><th className="num">Riesgo máx. (pts/100 km)</th></tr></thead>
        <tbody>${profiles.map(p => {
          const v = t[p.key] || { l100: 0, idle_pct_max: 15, risk_max: 2 };
          const a = actual[p.key];
          return html`<tr key=${p.key}><td>${p.label}${a ? html` <span className="muted small">${a.vehicles} veh.</span>` : null}</td>
            <td className="num"><input type="number" step="0.5" className="num-in" disabled=${ro} value=${v.l100} onChange=${e => upd(p.key, "l100", +e.target.value)} />
              <span className="muted small"> (${a ? GI.fmtNum(a.l100, 1) : "–"})</span></td>
            <td className="num"><input type="number" className="num-in" disabled=${ro} value=${v.idle_pct_max} onChange=${e => upd(p.key, "idle_pct_max", +e.target.value)} />
              <span className="muted small"> (${a ? GI.fmtNum(a.idlePct, 1) : "–"})</span></td>
            <td className="num"><input type="number" step="0.1" className="num-in" disabled=${ro} value=${v.risk_max} onChange=${e => upd(p.key, "risk_max", +e.target.value)} />
              <span className="muted small"> (${a ? GI.fmtNum(a.risk, 2) : "–"})</span></td></tr>`;
        })}</tbody></table></div>
    <//>`;
  }

  // ---------- Pesos ----------
  // ---------- Categorías (editables) ----------
  function CategoriesSection({ draft, set, ro }) {
    const cats = draft.categories || GI.DEFAULT_CATEGORIES.map(c => ({ key: c.key, label: c.label, kind: c.kind }));
    const w = draft.category_weights || {};
    const mapping = draft.rule_mapping || {};
    const usage = k => Object.values(mapping).filter(v => v === k).length;
    let slot = 0;
    const colorOf = c => (c.kind === "riesgo" && slot < 8 ? ["#0078d3", "#fe5a3f", "#00aa00", "#f9ba00", "#edbbb2", "#00aa00", "#00aeff", "#fe5a3f"][slot++] : GI.OTHER_COLOR);
    const colors = cats.map(colorOf);
    const upd = (i, patch) => set(["categories"], cats.map((c, j) => (j === i ? { ...c, ...patch } : c)));
    const move = (i, d) => { const a = [...cats]; const [x] = a.splice(i, 1); a.splice(i + d, 0, x); set(["categories"], a); };
    function remove(i) {
      const c = cats[i];
      const n = usage(c.key);
      if (n && !confirm("La categoría \"" + c.label + "\" tiene " + n + " reglas asignadas. Si la quitás, esas reglas quedan sin categoría. ¿Continuar?")) return;
      const m = { ...mapping };
      for (const [rid, k] of Object.entries(m)) if (k === c.key) delete m[rid];
      set(["rule_mapping"], m);
      set(["categories"], cats.filter((_, j) => j !== i));
    }
    function add() {
      const key = "cat_" + Date.now().toString(36);
      set(["categories"], [...cats, { key, label: "Nueva categoría", kind: "riesgo" }]);
      set(["category_weights"], { ...w, [key]: 1 });
    }
    return html`<${Panel} title="Categorías"
      hint="Las categorías de riesgo se descargan, suman al índice de riesgo y se muestran en Seguridad. Las operativas no se consultan a MyGeotab ni suman al índice (el ralentí se calcula aparte, con los viajes y el combustible). Las primeras 8 de riesgo tienen color propio en los gráficos (en este orden); el resto aparece como 'Otras'.">
      <div className="table-wrap"><table className="tbl">
        <thead><tr><th></th><th>Nombre</th><th>Tipo</th><th className="num">Peso en el índice</th><th className="num">Reglas</th><th></th></tr></thead>
        <tbody>${cats.map((c, i) => html`<tr key=${c.key}>
          <td style=${{ whiteSpace: "nowrap" }}>${!ro ? html`<button className="btn small" disabled=${i === 0} onClick=${() => move(i, -1)} aria-label="Subir">▲</button>
            <button className="btn small" disabled=${i === cats.length - 1} onClick=${() => move(i, 1)} aria-label="Bajar">▼</button>` : null}</td>
          <td><span className="dot" style=${{ background: colors[i], borderRadius: "50%" }}></span><input disabled=${ro} value=${c.label} onInput=${e => upd(i, { label: e.target.value })} style=${{ width: "260px" }} /></td>
          <td><select disabled=${ro} value=${c.kind} onChange=${e => upd(i, { kind: e.target.value })}>
            <option value="riesgo">Riesgo (seguridad)</option><option value="operativo">Operativo (no suma)</option></select></td>
          <td className="num"><input type="number" step="0.1" min="0" className="num-in" disabled=${ro || c.kind !== "riesgo"} value=${c.kind !== "riesgo" ? 0 : w[c.key] != null ? w[c.key] : 1}
            onChange=${e => set(["category_weights"], { ...w, [c.key]: +e.target.value })} /></td>
          <td className="num">${usage(c.key)}</td>
          <td>${!ro ? html`<button className="btn small danger" onClick=${() => remove(i)}>Quitar</button>` : null}</td>
        </tr>`)}</tbody></table></div>
      ${!ro ? html`<button className="btn" style=${{ marginTop: "12px" }} onClick=${add}>+ Agregar categoría</button>` : null}
    <//>`;
  }

  // ---------- Recorridos ----------
  function RoutesSection({ api, draft, set, ro }) {
    const [types, setTypes] = useState(null);
    useEffect(() => { GI.loadZoneTypes(api).then(setTypes); }, []);
    const j = draft.journeys;
    const sel = j.zone_type_ids || [];
    const toggle = id => set(["journeys", "zone_type_ids"], sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id]);
    return html`<${Panel} title="Recorridos"
      hint="Un recorrido va de una zona a otra. Las paradas más cortas que el mínimo (ej. 5 min en una estación de servicio) no lo cortan: Añelo → Neuquén sigue siendo un solo recorrido.">
      <div className="form two-col">
        <label>Parada mínima para terminar un recorrido en una zona (min)<input type="number" min="0" disabled=${ro} value=${j.min_stop_minutes != null ? j.min_stop_minutes : 20} onChange=${e => set(["journeys", "min_stop_minutes"], +e.target.value)} /></label>
        <label>Cortar el recorrido fuera de zona tras una parada de (h)<input type="number" min="1" disabled=${ro} value=${j.break_hours} onChange=${e => set(["journeys", "break_hours"], +e.target.value)} /></label>
        <label>Ranking: mínimo de recorridos por tramo<input type="number" disabled=${ro} value=${j.min_journeys_route} onChange=${e => set(["journeys", "min_journeys_route"], +e.target.value)} /></label>
        <label>Ranking: km acumulados mínimos por tramo<input type="number" disabled=${ro} value=${j.min_km_route} onChange=${e => set(["journeys", "min_km_route"], +e.target.value)} /></label>
      </div>
      <h3>Tipos de zona que cuentan como origen o destino</h3>
      <p className="muted small">Si no elegís ninguno, cuentan todas las zonas.</p>
      ${types == null ? html`<div className="muted">Cargando tipos de zona…</div>` : html`<div className="checks">${types.map(t => html`<label key=${t.id} className="check">
        <input type="checkbox" disabled=${ro} checked=${sel.includes(t.id)} onChange=${() => toggle(t.id)} /> ${t.name}</label>`)}</div>`}
    <//>`;
  }

  // ---------- Conductores y valores de referencia ----------
  function ReferenceSection({ draft, set, ro, model, benchmark: b, onPublish, mgGroups, groups }) {
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState(null);
    const scoped = (mgGroups && mgGroups.length) || (draft.scope_group_ids || []).length;
    const gname = id => ((groups || []).find(g => g.id === id) || {}).name || id;
    async function publish() {
      setBusy(true); setMsg(null);
      try { await onPublish(); setMsg({ tone: "ok", text: "Valores de referencia publicados." }); }
      catch (e) { setMsg({ tone: "error", text: "No se pudieron publicar: " + (e.message || e) }); }
      setBusy(false);
    }
    const age = b && b.published_at ? Math.round((Date.now() - new Date(b.published_at).getTime()) / 86400000) : null;
    return html`<div>
      <${Panel} title="Vista de los conductores"
        hint="Los conductores que en MyGeotab tienen activada la opción 'Impedir que el conductor acceda a los datos compartidos' (y no son administradores ni editores) ven solo la pestaña 'Mi desempeño' con sus propios datos, comparados con los valores de referencia de la empresa. Los conductores sin esa opción, y los supervisores, ven el add-in completo con todo lo que abarca su alcance en MyGeotab.">
        <label className="inline"><input type="checkbox" disabled=${ro} checked=${draft.driver_view !== false} onChange=${e => set(["driver_view"], e.target.checked)} />
          Los conductores con "Impedir que el conductor acceda a los datos compartidos" (MyGeotab) ven solo "Mi desempeño"</label>
        <p className="muted small">Si se desmarca, todos los conductores ven el add-in completo dentro de su alcance, aunque tengan esa opción activada.</p>
      <//>
      <${Panel} title="Valores de referencia de la empresa"
        hint="Promedios de la flota sin nombres de conductores ni vehículos: índice de riesgo, infracciones por categoría, riesgo por hora y de noche, peligrosidad y velocidad de cada recorrido, riesgo según horas de manejo y valores por perfil. Con ellos un conductor o un supervisor se compara con la empresa sin ver los datos de otros. Se publican a mano y se calculan con los datos cargados en este momento.">
        ${b ? html`<p>Publicados el <b>${new Date(b.published_at).toLocaleString("es-AR")}</b> (hace ${age} días), con ${GI.fmtNum(b.vehicles)} vehículos y ${GI.fmtNum(b.km)} km del ${b.from} al ${b.to}.
          Índice de la empresa: <b>${GI.fmtNum(b.fleetIdx, 2)}</b> pts/100 km.</p>
          ${age > 30 ? html`<${Info} tone="warn">Tienen más de un mes: conviene publicarlos de nuevo.<//>` : null}`
          : html`<${Info} tone="warn">Todavía no se publicaron. Hasta entonces, "Mi desempeño" no puede comparar al conductor con la empresa.<//>`}
        ${model ? html`<p className="muted">Se van a calcular con lo cargado ahora: <b>${GI.fmtNum(model.devices.length)} vehículos</b>, del ${model.dayKeys[0]} al ${model.dayKeys[model.dayKeys.length - 1]}.
          ${scoped ? html` <span className="delta bad">Atención: hay un filtro de grupos activo${mgGroups && mgGroups.length ? " (" + mgGroups.map(gname).join(", ") + ")" : ""}; la referencia sería solo de ese alcance. Para la empresa completa, quitá el filtro y cargá "Toda la flota".</span>` : null}</p>` : null}
        ${!ro ? html`<button className="btn primary" disabled=${busy || !model} onClick=${publish}>${busy ? "Publicando…" : b ? "Volver a publicar con los datos cargados" : "Publicar con los datos cargados"}</button>` : null}
        ${msg ? html`<p className=${"msg " + msg.tone}>${msg.text}</p>` : null}
      <//>
    </div>`;
  }


  // ---------- Gravedad de los excesos de velocidad (Mapa de calor) ----------
  const SEV_LABEL = { leve: "Leve", medio: "Medio", grave: "Grave" };
  function suggestSev(name) {
    const n = String(name || "").toLowerCase();
    if (/grave|extrem|cr[ií]tic|excesiva/.test(n)) return "grave";
    if (/medio|moderad/.test(n)) return "medio";
    if (/leve/.test(n)) return "leve";
    return null;
  }
  function SpeedSevSection({ draft, set, ro, catalogs, api, model }) {
    const ss = Object.assign({ levels: {}, up_leve_min: 5, up_medio_min: 5, weigh: false, mult: { leve: 1, medio: 1.5, grave: 2.5 } }, draft.speed_sev || {});
    const map = draft.rule_mapping || {};
    const rules = (catalogs.rules || []).filter(r => map[r.id] === "velocidad").sort((a, b) => a.name.localeCompare(b.name));
    const [limits, setLimits] = useState(null);
    useEffect(() => {
      let off = false;
      if (!rules.length || !GI.loadRuleLimits) return;
      GI.loadRuleLimits(api, rules.map(r => r.id)).then(l => { if (!off) setLimits(l); }).catch(() => { if (!off) setLimits(new Map()); });
      return () => { off = true; };
    }, [rules.map(r => r.id).join(",")]);
    const count = useMemo(() => { const c = new Map(); for (const e of (model && model.events) || []) if (e.cat === "velocidad") c.set(e.rule, (c.get(e.rule) || 0) + 1); return c; }, [model]);
    const setLevel = (id, v) => set(["speed_sev", "levels"], { ...(ss.levels || {}), [id]: v || undefined });
    const sugg = rules.filter(r => !ss.levels[r.id] && suggestSev(r.name));
    const num = (path, v, props) => html`<input type="number" disabled=${ro} value=${v} onChange=${e => set(path, +e.target.value)} ...${props || {}} />`;
    return html`<${Panel} title="Gravedad de los excesos de velocidad"
      hint="Cada regla de la categoría Exceso de velocidad tiene un nivel según cuánto se pasa del límite. Si el exceso dura mucho, sube un nivel. Se usa en el Mapa de calor y, si lo activás, en el índice de riesgo. Las reglas escalonadas (por ejemplo +10, +20 y +30 sobre el límite) las crea un administrador en MyGeotab.">
      <div className="form two-col">
        <label>Un exceso Leve pasa a Medio si dura más de (min)${num(["speed_sev", "up_leve_min"], ss.up_leve_min, { min: 0, step: 1 })}</label>
        <label>Un exceso Medio pasa a Grave si dura más de (min)${num(["speed_sev", "up_medio_min"], ss.up_medio_min, { min: 0, step: 1 })}</label>
        <label className="inline"><input type="checkbox" disabled=${ro} checked=${!!ss.weigh} onChange=${e => set(["speed_sev", "weigh"], e.target.checked)} /> Pesar más en el índice de riesgo (Leve ×${GI.fmtNum(ss.mult.leve, 1)} · Medio ×${GI.fmtNum(ss.mult.medio, 1)} · Grave ×${GI.fmtNum(ss.mult.grave, 1)})</label>
      </div>
      ${!rules.length ? html`<p className="muted small">No hay reglas asignadas a la categoría Exceso de velocidad (Configuración → Reglas y objetivos).</p>` : html`
        ${sugg.length && !ro ? html`<p className="small"><button className="btn small" onClick=${() => { const lv = { ...(ss.levels || {}) }; for (const r of sugg) lv[r.id] = suggestSev(r.name); set(["speed_sev", "levels"], lv); }}>Aplicar el nivel sugerido a ${sugg.length} regla(s) sin asignar</button></p>` : null}
        <div className="table-wrap"><table className="tbl">
          <thead><tr><th>Regla de velocidad (MyGeotab)</th><th>Límite</th><th>Nivel</th><th className="num">Excesos en el período</th></tr></thead>
          <tbody>${rules.map(r => { const lv = ss.levels[r.id] || "", sg = suggestSev(r.name), lim = limits && limits.get(r.id);
            return html`<tr key=${r.id} className=${lv ? "" : "row-warn"}>
              <td>${r.name}</td><td>${limits == null ? "…" : lim && lim.length ? lim.join(" / ") + " km/h" : "–"}</td>
              <td><select disabled=${ro} value=${lv} onChange=${e => setLevel(r.id, e.target.value)} aria-label=${"Nivel de " + r.name}>
                <option value="">Sin asignar (cuenta como Leve)${sg ? " · sugerido " + SEV_LABEL[sg] : ""}</option>
                <option value="leve">Leve</option><option value="medio">Medio</option><option value="grave">Grave</option></select></td>
              <td className="num">${GI.fmtNum(count.get(r.id) || 0, 0)}</td></tr>`; })}</tbody></table></div>
        <p className="muted small">Una sola regla para todos los excesos no permite separar 111 de 140 km/h: solo la duración la sube de nivel. El límite se lee de la condición de cada regla ("más de X km/h"); si una regla tiene varios, se muestran todos.</p>`}
    <//>`;
  }

  // ---------- Fatiga y gravedad ----------
  const IOGP_CHIP = { laxo: ["cfg-iogp-laxo", "▲ Más laxo que IOGP"], exigente: ["cfg-iogp-exig", "★ Más exigente"], cumple: ["cfg-iogp-ok", "✓ Cumple"], off: ["cfg-iogp-off", "● No se mide"] };
  const iogpFmt = (r, v) => (r.dir === "bool" ? (v ? "sí" : "no") : v == null || v === "" || (r.isNew && !(+v > 0)) ? "no se mide" : r.key === "low_to" ? "02–" + String(v).padStart(2, "0") + " h" : GI.fmtNum(+v, v % 1 ? 1 : 0) + (r.unit ? " " + r.unit : ""));
  function IogpModal({ f, onClose, onApply, busy }) {
    const ch = GI.iogpChanges(f);
    const keep = GI.IOGP365.filter(r => GI.iogpStatus(r, f[r.key]) === "exigente" || GI.iogpStatus(r, f[r.key]) === "cumple");
    const adj = ch.filter(r => !r.isNew || r.dir === "bool"), act = ch.filter(r => r.isNew && r.dir !== "bool");
    return html`<${GI.Modal} title="Parametrizar a IOGP 365" wide=${true} onClose=${onClose}>
      ${!ch.length ? html`<p>La configuración ya cumple o es más exigente que el IOGP 365 en todos los parámetros. No hay nada para cambiar.</p>` : html`
      <p>Se van a hacer <b>${ch.length} ${ch.length === 1 ? "cambio" : "cambios"}</b>. Los parámetros que ya son más exigentes que la guía no se tocan. Nada cambia en MyGeotab: solo la configuración del add-in. Se guarda una copia de la configuración actual para poder volver atrás.</p>
      ${adj.length ? html`<h3 className="cfg-iogp-h">Valores que se ajustan (${adj.length})</h3>
      <table className="cfg-iogp-t"><thead><tr><th>Parámetro</th><th>Hoy</th><th>Queda</th><th>Por qué</th></tr></thead><tbody>
        ${adj.map(r => html`<tr key=${r.key}><td>${r.label}</td><td><s className="bad-text">${iogpFmt(r, r.now)}</s></td><td><b className="good-text">${iogpFmt(r, r.iogp)}</b></td><td className="small muted">${r.why}</td></tr>`)}</tbody></table>` : null}
      ${act.length ? html`<h3 className="cfg-iogp-h">Controles que se activan (${act.length})</h3>
      <table className="cfg-iogp-t"><thead><tr><th>Control</th><th>Límite</th><th>Qué cambia</th></tr></thead><tbody>
        ${act.map(r => html`<tr key=${r.key}><td>${r.label}</td><td><b>${iogpFmt(r, r.iogp)}</b></td><td className="small muted">${r.why}</td></tr>`)}</tbody></table>` : null}
      ${keep.length ? html`<div className="cfg-iogp-keep"><b>Quedan como están</b> (ya cumplen o son más exigentes): ${keep.map(r => r.label.toLowerCase() + " " + iogpFmt(r, f[r.key])).join(" · ")}.</div>` : null}
      <p className="small muted">Las señales nuevas cuentan para el nivel de cada jornada en la pestaña Fatiga igual que las actuales (la franja de 15 a 17 h vale ½): es esperable que suban los casos.</p>`}
      <div className="modal-actions"><button className="btn" onClick=${onClose}>${ch.length ? "Cancelar" : "Cerrar"}</button>${ch.length ? html`<button className="btn primary" disabled=${busy} onClick=${onApply}>${busy ? "Aplicando…" : "Aplicar " + (ch.length === 1 ? "el cambio" : "los " + ch.length + " cambios")}</button>` : null}</div>
    <//>`;
  }

  function FatigueSection({ draft, set, ro, dirty, userName, onSaveFatigue }) {
    const f = Object.assign({}, GI.FATIGUE_DEFAULT, draft.fatigue || {});
    const sv = Object.assign({ by_duration: false, per_minute: 0.5, max: 3, long_minutes: 1 }, draft.severity || {});
    const num = (path, v, props) => html`<input type="number" disabled=${ro} value=${v} onChange=${e => set(path, +e.target.value)} ...${props || {}} />`;
    const [modal, setModal] = useState(false), [busy, setBusy] = useState(false), [showCh, setShowCh] = useState(false);
    const st = Object.fromEntries(GI.IOGP365.map(r => [r.key, GI.iogpStatus(r, f[r.key])]));
    const nLax = Object.values(st).filter(x => x === "laxo").length, nOff = Object.values(st).filter(x => x === "off").length;
    const ap = f.iogp_applied;
    async function apply() {
      setBusy(true);
      try { await onSaveFatigue(GI.applyIogp(f, userName), "Configuración de fatiga parametrizada a IOGP 365 y guardada para todos."); setModal(false); } catch (e) {}
      setBusy(false);
    }
    async function revert() {
      if (!ap || !ap.prev) return;
      setBusy(true);
      try { const n = { ...f, ...ap.prev }; delete n.iogp_applied; await onSaveFatigue(n, "Se volvió a la configuración de fatiga anterior a la parametrización IOGP 365."); } catch (e) {}
      setBusy(false);
    }
    const ref = key => { const r = GI.IOGP365.find(x => x.key === key); const c = IOGP_CHIP[st[key]]; return html`<span className="cfg-iogp-ref"><span className="small muted">IOGP 365: <b>${iogpFmt(r, r.iogp)}</b></span><span className=${"cfg-iogp-chip " + c[0]}>${c[1]}</span></span>`; };
    const lax = key => (st[key] === "laxo" ? " cfg-iogp-in-laxo" : "");
    const field = (key, label, props) => html`<label className=${"cfg-iogp-row" + lax(key)}><span>${label}</span>${num(["fatigue", key], f[key], props)}${ref(key)}</label>`;
    return html`<div>
      ${ap && !nLax && !nOff ? html`<div className="cfg-iogp-banner ok">
        <div><b>Parametrizado a IOGP 365</b><div className="small">Aplicado el ${new Date(ap.at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}${ap.by ? " por " + ap.by : ""}. Todos los parámetros cumplen o son más exigentes que la guía.</div>
          ${showCh ? html`<ul className="small">${(ap.changes || []).map(c => { const r = GI.IOGP365.find(x => x.key === c.key) || { label: c.key, unit: "" }; return html`<li key=${c.key}>${r.label}: ${iogpFmt(r, c.from)} → ${iogpFmt(r, c.to)}</li>`; })}</ul>` : null}</div>
        <span className="cfg-iogp-acts"><button className="btn small" onClick=${() => setShowCh(!showCh)}>${showCh ? "Ocultar los cambios" : "Ver los cambios"}</button>${!ro ? html`<button className="btn small" disabled=${busy || dirty} title=${dirty ? "Guardá o descartá los cambios pendientes primero" : ""} onClick=${revert}>Volver a la configuración anterior</button>` : null}</span>
      </div>` : html`<div className="cfg-iogp-banner">
        <div><b>Referencia IOGP 365</b> (Land transportation safety practice, 2025)<div className="small">${nLax || nOff ? html`${nLax ? html`<b>${nLax}</b> ${nLax === 1 ? "parámetro es más laxo" : "parámetros son más laxos"} que la guía` : ""}${nLax && nOff ? " y " : ""}${nOff ? html`<b>${nOff}</b> ${nOff === 1 ? "control de la guía no se mide" : "controles de la guía no se miden"}` : ""}. Por ahora se pueden guardar valores más laxos: quedan marcados en amarillo.` : "Todos los parámetros cumplen o son más exigentes que la guía."}</div></div>
        ${!ro && (nLax || nOff) ? html`<button className="btn primary" disabled=${dirty} title=${dirty ? "Guardá o descartá los cambios pendientes primero" : ""} onClick=${() => setModal(true)}>Parametrizar a IOGP 365…</button>` : null}
      </div>`}
      ${modal ? html`<${IogpModal} f=${f} busy=${busy} onClose=${() => setModal(false)} onApply=${apply} />` : null}
      <${Panel} title="Jornada y fatiga"
        hint="Límites con los que se marcan las jornadas en la pestaña Fatiga. Al lado de cada uno está el valor del IOGP 365 (tabla 15). Ser más exigente siempre está permitido; ajustalos también a la normativa que aplique a cada operación (si la ley es más exigente, manda la ley).">
        <div className="cfg-iogp-list">
          ${field("min_rest", "Descanso mínimo entre jornadas (h)", { min: 1, step: 0.5 })}
          ${field("pause_min", "Pausa que reinicia el manejo continuo (min)", { min: 5, step: 5 })}
          ${field("max_continuous", "Manejo continuo máximo (h)", { min: 0.5, step: 0.5 })}
          ${field("max_drive_day", "Manejo máximo en una jornada (h)", { min: 1, step: 0.5 })}
          ${field("max_drive_24h", "Manejo máximo en 24 h móviles (h; 0 = no se mide)", { min: 0, step: 0.5 })}
          ${field("max_span", "Jornada máxima, del primer arranque al último corte (h)", { min: 1, step: 0.5 })}
          ${field("max_work_7d", "Horas de jornada en 7 días (h; 0 = no se mide)", { min: 0, step: 1 })}
          ${field("max_work_14d", "Horas de jornada en 14 días (h; 0 = no se mide)", { min: 0, step: 1 })}
          ${field("max_days_row", "Días seguidos de trabajo como máximo", { min: 1 })}
          ${field("break_after_row", "Corte continuo después de los días seguidos (h; 0 = no se mide)", { min: 0, step: 1 })}
          <label className=${"cfg-iogp-row" + lax("low_to")}><span>Franja de madrugada: de las 02 hasta las (h)</span><select disabled=${ro} value=${f.low_to} onChange=${e => set(["fatigue", "low_to"], +e.target.value)}>${[5, 6].map(h => html`<option key=${h} value=${h}>${String(h).padStart(2, "0")}:00</option>`)}</select>${ref("low_to")}</label>
          <label className=${"cfg-iogp-row" + lax("pm_low")}><span>Señal leve por manejo de 15 a 17 h (bajo circadiano de la tarde)</span><input type="checkbox" disabled=${ro} checked=${!!f.pm_low} onChange=${e => set(["fatigue", "pm_low"], e.target.checked)} />${ref("pm_low")}</label>
        </div>
        <h3 className="cfg-iogp-h">Otros parámetros del add-in</h3>
        <div className="form two-col">
          <label>Pausa que cierra una jornada (h)${num(["fatigue", "rest_split"], f.rest_split, { min: 1, step: 0.5 })}</label>
          <label>Movimiento mínimo que se ignora: menos de (km)${num(["fatigue", "micro_km"], f.micro_km, { min: 0, step: 0.1 })}</label>
          <label>… y menos de (minutos de manejo)${num(["fatigue", "micro_min"], f.micro_min, { min: 0, step: 1 })}</label>
          <label>Índice de fatiga: moderado desde${num(["fatigue", "fi_mod"], f.fi_mod, { min: 10, step: 5 })}</label>
          <label>Índice de fatiga: alto desde${num(["fatigue", "fi_high"], f.fi_high, { min: 20, step: 5 })}</label>
        </div>
        <p className="muted small">Las jornadas se arman por pausas, no por día calendario: los viajes separados por menos de ${f.rest_split} h son una sola jornada (un turno noche de 19 a 7 h cuenta como una jornada del día en que empezó). Una pausa más larga cierra la jornada y es el descanso previo de la siguiente; si es menor al descanso mínimo, se marca. Las horas de jornada (del primer arranque al último corte) son un mínimo de las horas de trabajo: el GPS no ve carga, descarga ni esperas fuera del vehículo.</p>
        <p className="muted small">Los movimientos mínimos (por ejemplo, encender el camión durante el descanso por frío o calor, o la dispersión del GPS con el vehículo parado) no cuentan como trabajo: no cortan el descanso. Si duran 5 minutos o más, ese tiempo cuenta como descanso con el motor en marcha.</p>
        <p className="muted small">El índice de fatiga es una estimación propia del add-in (no es un sistema certificado como FAID): sube mientras el conductor trabaja, más rápido manejando y de madrugada, y baja mientras descansa, más rápido si descansa de noche. Una jornada diurna normal termina cerca de 50–70; turnos noche largos o descansos cortos lo llevan por encima de 100.</p>
      <//>
      <${Panel} title="Alertas de fatiga con intervención obligatoria"
        hint="Mientras el add-in está abierto (en cualquier pestaña), cada 3 minutos se recalcula el índice de los conductores en jornada. Si alguno pasa el umbral aparece una ventana que no se cierra hasta registrar qué se hizo; la intervención queda guardada con el nombre de quien la registró y la ven todos los supervisores. Solo funciona en las pantallas que tengan el add-in abierto.">
        ${(() => { const al = Object.assign({}, GI.ALERT_DEFAULT || {}, draft.fatigue_alerts || {}); return html`<div className="form two-col">
          <label className="inline"><input type="checkbox" disabled=${ro} checked=${!!al.on} onChange=${e => set(["fatigue_alerts", "on"], e.target.checked)} /> Activar las alertas en esta base</label>
          <span></span>
          <label>Alerta (intervención obligatoria) desde el índice${num(["fatigue_alerts", "warn"], al.warn, { min: 10, step: 5 })}</label>
          <label>Alerta crítica (intervención + cámara en vivo) desde${num(["fatigue_alerts", "crit"], al.crit, { min: 10, step: 5 })}</label>
          <label>Volver a avisar si el índice sube (puntos)${num(["fatigue_alerts", "re_rise"], al.re_rise, { min: 1, step: 1 })}</label>
          <label>… o si pasan (horas) desde la última intervención${num(["fatigue_alerts", "re_hours"], al.re_hours, { min: 0.25, step: 0.25 })}</label>
          <label>Si no contesta, volver a avisar a los (min)${num(["fatigue_alerts", "noanswer_min"], al.noanswer_min, { min: 1, step: 1 })}</label>
          <label>Sonido mientras haya una alerta sin atender: cada (segundos, 0 = sin sonido)${num(["fatigue_alerts", "beep_sec"], al.beep_sec, { min: 0, step: 5 })}</label>
          <label>Usuarios que reciben las alertas (separados por coma; vacío = todos los supervisores)<input type="text" disabled=${ro} value=${al.users || ""} onChange=${e => set(["fatigue_alerts", "users"], e.target.value)} placeholder="operaciones@empresa.com" /></label>
        </div>`; })()}
        <p className="muted small">Solo avisa por conductores en jornada. En la alerta crítica la nota es obligatoria. El video en vivo de las cámaras GO Focus se ve dentro de la alerta; el de las Surfsight se abre en el reproductor de MyGeotab (Activos → Cámaras) en otra pestaña, con los permisos de cada usuario.</p>
      <//>
      <${Panel} title="Gravedad de las infracciones"
        hint="Una infracción que dura más (por ejemplo un exceso de velocidad de 3 minutos) es más peligrosa que una de segundos. Si activás la ponderación, cada minuto de duración suma un porcentaje del peso de la categoría, con un tope. Las infracciones instantáneas (frenadas, giros) no cambian.">
        <div className="form two-col">
          <label className="inline"><input type="checkbox" disabled=${ro} checked=${!!sv.by_duration} onChange=${e => set(["severity", "by_duration"], e.target.checked)} /> Ponderar el índice de riesgo por la duración de cada infracción</label>
          <span></span>
          <label>Cada minuto suma (% del peso)${num(["severity", "per_minute"], GI.round(sv.per_minute * 100, 0), { min: 0, step: 5, onChange: e => set(["severity", "per_minute"], +e.target.value / 100) })}</label>
          <label>Tope (veces el peso)${num(["severity", "max"], sv.max, { min: 1, step: 0.5 })}</label>
          <label>Se considera prolongada desde (min)${num(["severity", "long_minutes"], sv.long_minutes, { min: 0.1, step: 0.5 })}</label>
        </div>
        <p className="muted small">Ejemplo con los valores actuales: una infracción de 2 minutos pesa ${GI.fmtNum(Math.min(sv.max, 1 + sv.per_minute * 2), 1)} veces lo normal.</p>
      <//>
    </div>`;
  }

  // ---------- Alcance y combustible ----------
  function ScopeSection({ draft, set, groups, ro, model }) {
    const types = (draft.fuel.types && draft.fuel.types.length) ? draft.fuel.types : GI.defaultFuelTypes([]);
    // Los grupos de sistema por combustible (los asigna MyGeotab según el VIN) se suman al selector.
    const fuelGroups = [
      { id: GI.FUEL_SYSTEM_GROUPS.diesel, name: "Diésel (asignado por MyGeotab)", depth: 0 },
      { id: GI.FUEL_SYSTEM_GROUPS.nafta, name: "Nafta (asignado por MyGeotab)", depth: 0 },
      ...groups,
    ];
    const counts = useMemo(() => {
      const c = {};
      if (model) for (const v of model.fuelTypeOf.values()) c[v || "_none"] = (c[v || "_none"] || 0) + 1;
      return c;
    }, [model]);
    const upd = (i, patch) => set(["fuel", "types"], types.map((t, j) => (j === i ? { ...t, ...patch } : t)));
    return html`<div>
      <${Panel} title="Precio del combustible"
        hint="Cada vehículo toma el primer combustible cuyos grupos contenga. Por defecto se usan los grupos Diesel y Gasoline que MyGeotab asigna automáticamente según el VIN. Los vehículos sin clasificar usan el combustible por defecto.">
        <div className="table-wrap"><table className="tbl">
          <thead><tr><th>Combustible</th><th className="num">Precio por litro</th><th>Grupos</th><th className="num">Vehículos</th><th>Por defecto</th></tr></thead>
          <tbody>${types.map((t, i) => html`<tr key=${t.key}>
            <td><input disabled=${ro} value=${t.label} onInput=${e => upd(i, { label: e.target.value })} style=${{ width: "120px" }} /></td>
            <td className="num"><input type="number" min="0" className="num-in wide" disabled=${ro} value=${t.price} onChange=${e => upd(i, { price: +e.target.value })} /> $</td>
            <td><${GroupMultiSelect} groups=${fuelGroups} disabled=${ro} value=${t.groupIds} onChange=${v => upd(i, { groupIds: v })} placeholder="Sin grupos" /></td>
            <td className="num">${counts[t.key] || 0}</td>
            <td><input type="radio" name="fueldef" disabled=${ro} checked=${draft.fuel.default_type === t.key} onChange=${() => set(["fuel", "default_type"], t.key)} aria-label=${"Usar " + t.label + " por defecto"} /></td>
          </tr>`)}</tbody>
        </table></div>
        <div className="form" style=${{ marginTop: "14px" }}>
          <label className="inline">Tolerancia de consumo sobre la referencia <input type="number" className="num-in" disabled=${ro} value=${draft.fuel.tolerance_pct != null ? draft.fuel.tolerance_pct : 10}
            onChange=${e => set(["fuel", "tolerance_pct"], +e.target.value)} /> % <span className="muted small">(por debajo no se cuenta como exceso)</span></label>
        </div>
      <//>
      <${Panel} title="Alcance del análisis">
        <div className="form">
          <div className="field"><span>Analizar solo estos grupos <span className="muted">(vacío = toda la base)</span></span>
            <${GroupMultiSelect} groups=${groups} disabled=${ro} value=${draft.scope_group_ids} onChange=${v => set(["scope_group_ids"], v)} placeholder="Toda la base" /></div>
          <div className="field"><span>Excluir siempre estos grupos</span>
            <${GroupMultiSelect} groups=${groups} disabled=${ro} value=${draft.excluded_group_ids} onChange=${v => set(["excluded_group_ids"], v)} /></div>
        </div>
      <//>
    </div>`;
  }

  // ---------- General ----------
  function GeneralSection({ draft, set, ro }) {
    const [editors, setEditors] = useState(draft.editors.join(", "));
    return html`<${Panel} title="General">
      <div className="form two-col">
        <label>Período por defecto<select disabled=${ro} value=${(() => { const d = draft.ui.default_period; if (d) return d; const n = draft.ui.default_days; return !n ? "3m" : n <= 31 ? "month" : n <= 95 ? "3m" : n <= 185 ? "6m" : "12m"; })()} onChange=${e => { set(["ui", "default_period"], e.target.value); set(["ui", "default_period_set"], true); }}>
          ${[["month", "Este mes"], ["last_month", "Mes pasado"], ["3m", "Últimos 3 meses"], ["6m", "Últimos 6 meses"], ["12m", "Últimos 12 meses"]].map(([k, l]) => html`<option key=${k} value=${k}>${l}</option>`)}</select></label>
        <label>Agrupación por defecto<select disabled=${ro} value=${draft.ui.default_granularity} onChange=${e => set(["ui", "default_granularity"], e.target.value)}>
          <option value="day">Día</option><option value="week">Semana</option><option value="month">Mes</option></select></label>
        <label>Ventana de impacto de hitos (días)<input type="number" disabled=${ro} value=${draft.ui.milestone_window_days} onChange=${e => set(["ui", "milestone_window_days"], +e.target.value)} /></label>
        <label>Ranking de conductores: km mínimos<input type="number" disabled=${ro} value=${draft.drivers.min_km_ranking} onChange=${e => set(["drivers", "min_km_ranking"], +e.target.value)} /></label>
        <label className="inline span-2"><input type="checkbox" disabled=${ro} checked=${!!draft.drivers.exclude_unknown} onChange=${e => set(["drivers", "exclude_unknown"], e.target.checked)} />
          Dejar afuera los viajes y las infracciones sin conductor identificado
          <${GI.Hint}>Si se marca, los viajes sin conductor (y las infracciones que ocurren en ellos) no cuentan en ningún indicador: km, riesgo, ralentí ni consumo (el combustible del día se reparte según los km que quedan). Sirve cuando muchos viajes no tienen la llave o el conductor asignado y distorsionan los índices.<//></label>
        <label>Editores adicionales (usuarios MyGeotab, separados por coma)<input disabled=${ro} value=${editors}
          onInput=${e => setEditors(e.target.value)} onBlur=${() => set(["editors"], editors.split(",").map(s => s.trim()).filter(Boolean))} /></label>
      </div>
      <h3>Caché local</h3>
      <p className="muted small">Los datos ya descargados se guardan en este navegador para que la próxima apertura sea rápida. Borrarlo obliga a descargar todo de nuevo.</p>
      <button className="btn" onClick=${async () => { await GI.clearCache(); alert("Caché borrada. Se va a descargar todo en la próxima actualización."); }}>Borrar caché de este navegador</button>
    <//>`;
  }

  GI.ConfigTab = ConfigTab;
})(window.GI);
