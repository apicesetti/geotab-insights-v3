// Hitos: decisiones del cliente (capacitaciones, cambios de política...)
// marcadas en una fecha, compartidas en AddInData, con su impacto medido
// comparando ventanas iguales antes y después, normalizado por km.
(function (GI) {
  "use strict";
  const { useState, useMemo } = React;
  const html = GI.html;
  const { Panel, Info, DataTable, ChartView, Delta, Modal } = GI;
  const n2 = v => GI.fmtNum(v, 2), n1 = v => GI.fmtNum(v, 1);

  function MilestoneForm({ initial, groups, onSave, onCancel }) {
    const [m, setM] = useState(initial || { date: GI.dayKey(new Date()), title: "", description: "", categories: [], group_ids: [] });
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState(null);
    const toggleCat = k => setM(x => ({ ...x, categories: x.categories.includes(k) ? x.categories.filter(c => c !== k) : [...x.categories, k] }));
    async function save() {
      if (!m.title.trim() || !m.date) { setErr("Fecha y título son obligatorios."); return; }
      setSaving(true); setErr(null);
      try { await onSave(m); } catch (e) { setErr(e.message || String(e)); setSaving(false); }
    }
    return html`<${Modal} title=${initial ? "Editar hito" : "Nuevo hito"} onClose=${onCancel}>
      <div className="form">
        <label>Fecha<input type="date" value=${m.date} onChange=${e => setM({ ...m, date: e.target.value })} /></label>
        <label>Título<input value=${m.title} placeholder="Ej. Capacitación cinturón y ralentí" onInput=${e => setM({ ...m, title: e.target.value })} /></label>
        <label>Descripción<textarea rows="3" value=${m.description} onInput=${e => setM({ ...m, description: e.target.value })}></textarea></label>
        <div className="field"><span>Categorías que debería impactar <span className="muted">(vacío = todas)</span></span>
          <div className="checks">${GI.CATEGORIES.map(c => html`<label key=${c.key} className="check">
            <input type="checkbox" checked=${m.categories.includes(c.key)} onChange=${() => toggleCat(c.key)} /> ${c.label}</label>`)}</div>
        </div>
        <div className="field"><span>Grupos alcanzados <span className="muted">(vacío = toda la flota analizada)</span></span>
          <${GI.GroupMultiSelect} groups=${groups} value=${m.group_ids} onChange=${v => setM({ ...m, group_ids: v })} placeholder="Toda la flota" />
        </div>
        ${err ? html`<${Info} tone="error">${err}<//>` : null}
        <div className="form-actions">
          <button className="btn" onClick=${onCancel}>Cancelar</button>
          <button className="btn primary" disabled=${saving} onClick=${save}>${saving ? "Guardando…" : "Guardar hito"}</button>
        </div>
      </div>
    <//>`;
  }

  function ImpactCard({ view, m, windowDays, isAdmin, onEdit, onDelete }) {
    const imp = useMemo(() => GI.milestoneImpact(view.model, m, windowDays), [view.model, m, windowDays]);
    const metric = m.categories && m.categories.length === 1 && m.categories[0] === "ralenti" ? "idlePct" : "risk";
    // Serie diaria alrededor del hito para el gráfico
    const daily = useMemo(() => {
      if (!imp.days) return [];
      let ids = view.model.devices.map(d => d.id);
      if (m.group_ids && m.group_ids.length) {
        const g = view.model.gr.expand(m.group_ids);
        ids = view.model.devices.filter(d => GI.deviceInGroups(d, g)).map(d => d.id);
      }
      const from = imp.beforeRange[0], to = imp.afterRange[1];
      const days = GI.dayRange(from, to);
      const cats = m.categories && m.categories.length ? m.categories : null;
      return days.map(dk => {
        const c = GI.aggregate(view.model, ids, new Set([dk]));
        const k = GI.kpis(c);
        const n = cats ? GI.sum(cats, x => c.ev[x] || 0) : c.n;
        return { dk, label: GI.bucketLabel(dk, "day"), km: c.km, rate: c.km > 0 ? (n / c.km) * 100 : null, idlePct: k.idlePct };
      });
    }, [imp]);
    const rolling = (arr, key, w) => arr.map((_, i) => {
      const win = arr.slice(Math.max(0, i - w + 1), i + 1);
      const km = GI.sum(win, x => x.km);
      if (key === "rate") {
        const n = GI.sum(win, x => (x.rate != null ? (x.rate * x.km) / 100 : 0));
        return km > 0 ? GI.round((n / km) * 100, 3) : null;
      }
      const v = win.map(x => x[key]).filter(x => x != null);
      return v.length ? GI.round(GI.sum(v) / v.length, 2) : null;
    });
    const truncated = imp.days < windowDays;
    const scopeTxt = m.group_ids && m.group_ids.length
      ? m.group_ids.map(id => (view.model.gr.byId.get(id) || { name: id }).name).join(", ")
      : "toda la flota analizada";
    const catTxt = m.categories && m.categories.length ? m.categories.map(GI.catLabel).join(", ") : "todas las categorías";
    const mainChange = metric === "idlePct" ? imp.idleChange : (() => {
      const r = imp.catRows.filter(x => x.before != null);
      if (!m.categories || !m.categories.length) return imp.riskChange;
      const b = GI.sum(r, x => x.nBefore), a = GI.sum(r, x => x.nAfter);
      return imp.before.km && imp.after.km ? GI.pctChange(b / imp.before.km, a / imp.after.km) : null;
    })();
    const verdict = mainChange == null ? "Sin datos suficientes" : mainChange <= -10 ? "Impacto positivo" : mainChange >= 10 ? "Empeoró" : "Sin cambio significativo";
    const vtone = mainChange == null ? "" : mainChange <= -10 ? "good" : mainChange >= 10 ? "bad" : "flat";
    return html`<div className="milestone">
      <div className="ms-head">
        <div>
          <div className="ms-date">◆ ${GI.parseDayKey(m.date).toLocaleDateString("es-AR", { day: "numeric", month: "long", year: "numeric" })}</div>
          <h3>${m.title}</h3>
          ${m.description ? html`<p>${m.description}</p>` : null}
          <p className="muted small">Alcance: ${scopeTxt} · ${imp.devices} vehículos · Categorías: ${catTxt}</p>
        </div>
        <div className="ms-verdict">
          <span className=${"verdict " + vtone}>${verdict}</span>
          ${mainChange != null ? html`<${Delta} value=${mainChange} goodWhenDown />` : null}
          ${isAdmin ? html`<div className="ms-actions"><button className="btn small" onClick=${onEdit}>Editar</button>
            <button className="btn small danger" onClick=${onDelete}>Eliminar</button></div>` : null}
        </div>
      </div>
      ${!imp.days ? html`<${Info} tone="warn">El período cargado no incluye días antes y después de este hito. Ampliá el rango de fechas para medir su impacto.<//>` : html`
        ${truncated ? html`<${Info}>Se comparan ${imp.days} días antes vs ${imp.days} días después (de ${windowDays} pedidos): el rango cargado o la fecha actual no alcanzan para más.<//>` : null}
        <div className="grid-2">
          <${DataTable} rowKey=${r => r.k} rows=${[
            { k: "risk", label: "Índice de riesgo (pts/100 km)", b: imp.before.risk, a: imp.after.risk, ch: imp.riskChange },
            { k: "idle", label: "% ralentí", b: imp.before.idlePct, a: imp.after.idlePct, ch: imp.idleChange },
            { k: "l100", label: "Consumo L/100 km", b: imp.before.l100, a: imp.after.l100, ch: imp.l100Change },
            ...imp.catRows.map(r => ({ k: "c" + r.cat, label: GI.catLabel(r.cat) + " /100 km", b: r.before, a: r.after, ch: r.change, nb: r.nBefore, na: r.nAfter })),
          ]} defaultSort=${{ key: "order", dir: "asc" }} columns=${[
            { key: "label", label: "Métrica", value: () => 0 },
            { key: "b", label: "Antes", align: "num", fmt: r => html`${n2(r.b)}${r.nb != null ? html` <span className="muted">(${r.nb})</span>` : ""}`, value: () => 0 },
            { key: "a", label: "Después", align: "num", fmt: r => html`${n2(r.a)}${r.na != null ? html` <span className="muted">(${r.na})</span>` : ""}`, value: () => 0 },
            { key: "ch", label: "Cambio", align: "num", fmt: r => html`<${Delta} value=${r.ch} goodWhenDown />`, value: () => 0 },
          ]} />
          <${ChartView} height=${230} config=${{
            type: "line",
            data: { labels: daily.map(d => d.label), datasets: [{
              label: (metric === "idlePct" ? "% ralentí" : "Eventos/100 km") + " (media móvil 7 días)",
              data: rolling(daily, metric === "idlePct" ? "idlePct" : "rate", 7),
              borderColor: "#b45309", backgroundColor: "#f59e0b22", fill: true, tension: 0.3, spanGaps: true, pointRadius: 0 }] },
            options: { plugins: { milestones: { items: [{ index: daily.findIndex(d => d.dk === m.date), label: "hito" }] } }, scales: { y: { beginAtZero: true } } },
          }} />
        </div>`}
    </div>`;
  }

  function MilestonesTab({ view, milestones, isAdmin, groups, onAdd, onUpdate, onDelete }) {
    const [editing, setEditing] = useState(null); // null | "new" | milestone
    const [windowDays, setWindowDays] = useState(view.settings.ui.milestone_window_days);
    const sorted = [...milestones].sort((a, b) => (a.date < b.date ? 1 : -1));
    return html`<div>
      <${Panel} title="Hitos y su impacto"
        sub="Compara la misma cantidad de días antes y después de cada hito, normalizando por km recorridos. Los hitos son compartidos por todos los usuarios de la base."
        actions=${html`<label className="inline">Ventana <select value=${windowDays} onChange=${e => setWindowDays(+e.target.value)}>
            ${[14, 28, 42, 56, 90].map(d => html`<option key=${d} value=${d}>${d} días</option>`)}</select></label>
          ${isAdmin ? html`<button className="btn primary" onClick=${() => setEditing("new")}>+ Nuevo hito</button>` : null}`}>
        ${!sorted.length ? html`<div className="empty">Todavía no hay hitos. ${isAdmin ? "Cargá el primero con \"+ Nuevo hito\"." : "Un administrador puede cargarlos."}</div>` : null}
        ${sorted.map(m => html`<${ImpactCard} key=${m.id} view=${view} m=${m} windowDays=${windowDays} isAdmin=${isAdmin}
          onEdit=${() => setEditing(m)} onDelete=${() => { if (confirm("¿Eliminar el hito \"" + m.title + "\"?")) onDelete(m.id); }} />`)}
      <//>
      ${editing ? html`<${MilestoneForm} groups=${groups} initial=${editing === "new" ? null : editing} onCancel=${() => setEditing(null)}
        onSave=${async m => { if (editing === "new") await onAdd(m); else await onUpdate({ ...m, id: editing.id }); setEditing(null); }} />` : null}
    </div>`;
  }

  GI.MilestonesTab = MilestonesTab;
})(window.GI);
