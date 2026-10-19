// Componentes reutilizables. React + htm (JSX sin build).
(function (GI) {
  "use strict";
  const React = GI.React, ReactDOM = GI.ReactDOM;
  const { useState, useEffect, useRef, useMemo } = React;
  const html = GI.htm.bind(React.createElement);
  GI.html = html;

  // ---------- Estilo global de los gráficos ----------
  // Tipografía de la interfaz, ejes y grilla discretos, y popup chico y claro
  // que muestra solo lo que está bajo el mouse (no tapa el gráfico).
  if (window.Chart) {
    Chart.defaults.font.family = "'Barlow', system-ui, sans-serif";
    Chart.defaults.font.size = 12.5;
    Chart.defaults.color = "#4f5866";
    Chart.defaults.borderColor = "#e9ecf0";
    Chart.defaults.scale.grid.color = "#eef0f3";
    Chart.defaults.scale.border = { display: false };
    Chart.defaults.elements.bar.borderRadius = 3;
    Chart.defaults.elements.line.borderWidth = 2;
    Chart.defaults.elements.point.radius = 2.5;
    Chart.defaults.elements.point.hoverRadius = 5;
    Object.assign(Chart.defaults.plugins.tooltip, {
      backgroundColor: "#ffffff", titleColor: "#1f2a37", bodyColor: "#1c2430", footerColor: "#4f5866",
      borderColor: "#cdd3db", borderWidth: 1, padding: 10, cornerRadius: 6, boxWidth: 9, boxHeight: 9,
      boxPadding: 4, usePointStyle: true, caretSize: 5,
      titleFont: { weight: "600", size: 13 }, bodyFont: { size: 13 },
    });
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.plugins.legend.labels.boxWidth = 9;
  }

  // Ayuda contextual: explicación de cómo se calcula algo, sin ocupar espacio.
  function Hint({ children }) {
    if (!children) return null;
    return html`<span className="hint"><button type="button" aria-label="Cómo se calcula">?</button><span className="hint-body" role="tooltip">${children}</span></span>`;
  }

  // ---------- Indicador (va dentro de un contenedor .readouts) ----------
  function Kpi({ label, value, unit, sub, tone, hint }) {
    return html`<div className=${"readout" + (tone ? " " + tone : "")}>
      <div className="readout-label">${label}<${Hint}>${hint}<//></div>
      <div className="readout-value">${value}${unit ? html`<span className="unit">${unit}</span>` : null}</div>
      ${sub ? html`<div className="readout-foot">${sub}</div>` : null}
    </div>`;
  }

  // Variación con flecha + número (+ texto opcional): nunca solo color.
  function Delta({ value, goodWhenDown, suffix }) {
    if (value == null || Number.isNaN(value)) return html`<span className="delta flat">sin comparación</span>`;
    const down = value < 0;
    const good = goodWhenDown ? down : !down;
    const cls = Math.abs(value) < 3 ? "flat" : good ? "good" : "bad";
    const arrow = Math.abs(value) < 0.05 ? "=" : down ? "▼" : "▲";
    return html`<span className=${"delta " + cls}>${arrow} ${GI.fmtNum(Math.abs(value), 1)}%${suffix ? " " + suffix : ""}</span>`;
  }

  function Segmented({ value, options, onChange }) {
    return html`<div className="seg">${options.map(o => html`
      <button key=${o.value} className=${value === o.value ? "on" : ""} onClick=${() => onChange(o.value)}>${o.label}</button>`)}</div>`;
  }

  function Panel({ title, sub, hint, actions, children, className }) {
    return html`<section className=${"panel " + (className || "")}>
      ${title || actions ? html`<div className="panel-head">
        <div><h2>${title}<${Hint}>${hint}<//></h2>${sub ? html`<p className="panel-sub">${sub}</p>` : null}</div>
        ${actions ? html`<div className="panel-actions">${actions}</div>` : null}
      </div>` : null}
      ${children}
    </section>`;
  }

  function Info({ children, tone }) {
    return html`<div className=${"info " + (tone || "")}>${children}</div>`;
  }

  function Modal({ title, onClose, children, wide }) {
    useEffect(() => {
      const h = e => { if (e.key === "Escape") onClose(); };
      window.addEventListener("keydown", h);
      return () => window.removeEventListener("keydown", h);
    }, []);
    return html`<div className="modal-bg" onClick=${onClose}>
      <div className=${"modal" + (wide ? " wide" : "")} onClick=${e => e.stopPropagation()}>
        <div className="modal-head"><h2>${title}</h2><button className="btn ghost" onClick=${onClose}>✕</button></div>
        <div className="modal-body">${children}</div>
      </div>
    </div>`;
  }

  // ---------- Tabla ordenable ----------
  // columns: [{key, label, fmt(row), value(row), align, title}]
  function DataTable({ columns, rows, defaultSort, limit, onRowClick, rowKey, empty, rowClass }) {
    const [sort, setSort] = useState(defaultSort || { key: columns[0].key, dir: "desc" });
    const [showAll, setShowAll] = useState(false);
    useEffect(() => { if (defaultSort) setSort(defaultSort); }, [defaultSort && defaultSort.key, defaultSort && defaultSort.dir]);
    const col = columns.find(c => c.key === sort.key) || columns[0];
    const sorted = useMemo(() => {
      const val = col.value || (r => r[col.key]);
      return [...rows].sort((a, b) => {
        const va = val(a), vb = val(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        const c = typeof va === "string" ? va.localeCompare(vb, "es") : va - vb;
        return sort.dir === "asc" ? c : -c;
      });
    }, [rows, sort.key, sort.dir]);
    const shown = limit && !showAll ? sorted.slice(0, limit) : sorted;
    if (!rows.length) return html`<div className="empty">${empty || "Sin datos para los filtros elegidos."}</div>`;
    return html`<div className="table-wrap"><table className="tbl">
      <thead><tr>${columns.map(c => html`<th key=${c.key} className=${(c.align || "") + (sort.key === c.key ? " sorted" : "")} title=${c.title || ""}
        onClick=${() => setSort(s => ({ key: c.key, dir: s.key === c.key && s.dir === "desc" ? "asc" : "desc" }))}>
        ${c.label}${sort.key === c.key ? (sort.dir === "desc" ? " ▾" : " ▴") : ""}</th>`)}</tr></thead>
      <tbody>${shown.map((r, i) => html`<tr key=${rowKey ? rowKey(r) : i} className=${(onRowClick ? "clickable " : "") + (rowClass ? rowClass(r) : "")} onClick=${onRowClick ? () => onRowClick(r) : null}>
        ${columns.map(c => html`<td key=${c.key} className=${c.align || ""}>${c.fmt ? c.fmt(r) : r[c.key]}</td>`)}</tr>`)}</tbody>
    </table>
    ${limit && rows.length > limit ? html`<button className="btn link" onClick=${() => setShowAll(s => !s)}>
      ${showAll ? "Mostrar menos" : "Ver los " + rows.length}</button>` : null}
    </div>`;
  }

  // ---------- Chart.js ----------
  // milestones: [{label, index}] -> líneas verticales punteadas.
  const milestonePlugin = {
    id: "milestones",
    afterDatasetsDraw(chart, args, opts) {
      const ms = (opts && opts.items) || [];
      if (!ms.length) return;
      const { ctx, chartArea, scales } = chart;
      const x = scales.x;
      ctx.save();
      for (const m of ms) {
        const px = x.getPixelForValue(m.index);
        if (px == null || Number.isNaN(px)) continue;
        ctx.strokeStyle = "#f2b705";
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(px, chartArea.top); ctx.lineTo(px, chartArea.bottom); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#7a5a00";
        ctx.font = "600 12px Barlow, system-ui, sans-serif";
        const text = m.label;
        const w = ctx.measureText(text).width;
        const tx = Math.min(px + 4, chartArea.right - w);
        ctx.fillText(text, tx, chartArea.top + 12);
      }
      ctx.restore();
    },
  };

  function ChartView({ config, height }) {
    const ref = useRef(null);
    const chart = useRef(null);
    useEffect(() => {
      if (!ref.current) return;
      if (chart.current) chart.current.destroy();
      const cfg = { ...config, plugins: [...(config.plugins || []), milestonePlugin] };
      cfg.options = {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        ...(config.options || {}),
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 12, usePointStyle: true } },
          ...((config.options || {}).plugins || {}),
        },
      };
      chart.current = new Chart(ref.current, cfg);
      return () => { if (chart.current) { chart.current.destroy(); chart.current = null; } };
    }, [JSON.stringify(config.data), JSON.stringify((config.options || {}).plugins || {}), config.type]);
    return html`<div className="chart" style=${{ height: (height || 280) + "px" }}><canvas ref=${ref}></canvas></div>`;
  }

  // Índices de bucket donde cae cada hito, para el plugin.
  function milestoneMarks(milestones, series, gran) {
    const out = [];
    for (const m of milestones || []) {
      const bk = GI.bucketKey(m.date, gran);
      const idx = series.findIndex(s => s.key === bk);
      if (idx >= 0) out.push({ index: idx, label: m.title });
    }
    return out;
  }

  // ---------- Selector de grupos ----------
  function GroupMultiSelect({ groups, value, onChange, disabled, placeholder }) {
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState("");
    const byId = useMemo(() => new Map(groups.map(g => [g.id, g])), [groups]);
    const selected = value || [];
    const filtered = groups.filter(g => !q || g.name.toLowerCase().includes(q.toLowerCase())).slice(0, 80);
    const toggle = id => onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);
    return html`<div className="gsel">
      <div className="chips">
        ${selected.map(id => html`<span key=${id} className="chip">${(byId.get(id) || { name: id }).name}
          ${disabled ? null : html`<button onClick=${() => toggle(id)}>×</button>`}</span>`)}
        ${!selected.length ? html`<span className="muted">${placeholder || "Ninguno"}</span>` : null}
        ${disabled ? null : html`<button className="btn small" onClick=${() => setOpen(o => !o)}>${open ? "Cerrar" : "+ Grupo"}</button>`}
      </div>
      ${open ? html`<div className="gsel-pop">
        <input placeholder="Buscar grupo…" value=${q} onInput=${e => setQ(e.target.value)} autoFocus />
        <div className="gsel-list">${filtered.map(g => html`<label key=${g.id} style=${{ paddingLeft: 8 + g.depth * 14 + "px" }}>
          <input type="checkbox" checked=${selected.includes(g.id)} onChange=${() => toggle(g.id)} /> ${g.name}</label>`)}</div>
      </div>` : null}
    </div>`;
  }

  // Árbol de grupos plano (con profundidad) a partir de Company Group.
  function flattenGroups(groups) {
    const byId = new Map(groups.map(g => [g.id, g]));
    const out = [];
    const skip = new Set(["GroupAssetInformationId", "GroupDriverActivityGroupId", "GroupSecurityId", "GroupPrivateUserId"]);
    function walk(id, depth, seen) {
      const g = byId.get(id);
      if (!g || seen.has(id) || skip.has(id)) return;
      seen.add(id);
      if (id !== "GroupCompanyId") out.push({ id, name: g.name, depth });
      const kids = (g.children || []).map(c => byId.get(c)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, "es"));
      for (const k of kids) walk(k.id, id === "GroupCompanyId" ? 0 : depth + 1, seen);
    }
    walk("GroupCompanyId", 0, new Set());
    return out;
  }

  function Progress({ value, label }) {
    return html`<div className="progress"><div className="bar" style=${{ width: Math.round((value || 0) * 100) + "%" }}></div>
      <span>${label || "Cargando"} (${Math.round((value || 0) * 100)}%)</span></div>`;
  }

  function catLabel(k) { return (GI.CATEGORY_BY_KEY[k] || { label: k }).label; }
  function catColor(k) { return (GI.CATEGORY_BY_KEY[k] || { color: "#999" }).color; }

  function vtypeLabel(settings, key) {
    if (key === "sin_tipo") return "Sin tipo";
    const t = settings.vehicle_types.find(v => v.key === key);
    return t ? t.label : key;
  }
  function fuelLabel(settings, key) {
    const t = ((settings.fuel || {}).types || []).find(x => x.key === key);
    return t ? t.label : key;
  }
  function stypeLabel(key) { return key === "larga" ? "Larga" : key === "corta" ? "Corta" : "–"; }
  function profileLabel(settings, p) {
    const [vt, st] = p.split("|");
    return vtypeLabel(settings, vt) + " · " + stypeLabel(st);
  }

  Object.assign(GI, {
    Kpi, Hint, Delta, Segmented, Panel, Info, Modal, DataTable, ChartView, milestoneMarks, GroupMultiSelect,
    flattenGroups, Progress, catLabel, catColor, vtypeLabel, stypeLabel, fuelLabel, profileLabel,
  });
})(window.GI);
