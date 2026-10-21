// Panel "Geocercas de corredores": propone zonas con nomenclatura propia para
// los tramos detectados, permite revisarlas y crearlas en MyGeotab o bajarlas
// en KML.
(function (GI) {
  "use strict";
  const React = GI.React;
  const { useState, useEffect, useRef, useMemo } = React;
  const html = GI.html;
  const { Panel, Info } = GI;
  const n0 = v => GI.fmtNum(v, 0);
  const PREFIX = { tramo: "COR · ", nudo: "NUDO · " };
  const stripPrefix = n => n.replace(/^(COR|NUDO)\s*·\s*/i, "");

  function CorridorZonesPanel({ api, database, isAdmin, geo, cm, days, anchors, named, onCreated }) {
    const [props, setProps] = useState(null);
    const [progress, setProgress] = useState(null);
    const [plabel, setPlabel] = useState("");
    const [err, setErr] = useState(null);
    const [confirm, setConfirm] = useState(false);
    const [result, setResult] = useState(null);
    const [focus, setFocus] = useState(null);
    const [minShare, setMinShare] = useState(0.3);

    const nTramos = anchors.filter(a => a.kind === "tramo").length, nNudos = anchors.length - nTramos;
    const fixedKm = geo.list.filter(x => x.fixed).reduce((s, x) => s + x.km, 0);
    const coverage = cm.totKm > 0 ? fixedKm / cm.totKm : 0;
    // Candidatos: tramos detectados sin geocerca, con tránsito relevante o
    // con infracciones; de más a menos km.
    const candidates = useMemo(() => geo.list.filter(x => !x.fixed && x.km > 0 && (x.share * 100 >= minShare || x.n >= 3)).sort((a, b) => b.km - a.km).slice(0, 150), [geo, minShare]);
    const unassignedShare = geo.list.filter(x => !x.fixed).reduce((s, x) => s + x.share, 0);

    async function propose() {
      setErr(null); setResult(null); setConfirm(false); setProgress(0); setPlabel("Armando geocercas (trazado GPS de cada tramo)");
      try {
        const list = await GI.proposeZones(api, candidates, days, { onProgress: setProgress });
        list.sort((a, b) => (b.kmDay || 0) - (a.kmDay || 0));
        setProps(list);
      } catch (e) { setErr("No se pudo armar la propuesta: " + (e.message || e)); }
      setProgress(null);
    }
    const chosen = (props || []).filter(z => z.include && stripPrefix(z.name).trim());
    const update = (i, patch) => setProps(ps => ps.map((z, j) => (j === i ? { ...z, ...patch } : z)));
    const dupNames = useMemo(() => {
      const c = {};
      for (const z of chosen) c[z.name] = (c[z.name] || 0) + 1;
      for (const a of anchors) c[a.name] = (c[a.name] || 0) + 1;
      return new Set(Object.keys(c).filter(k => c[k] > 1));
    }, [props, anchors]);

    function kml() {
      GI.downloadText("geocercas-corredores-" + database + ".kml", GI.corridorZonesKml(chosen), "application/vnd.google-earth.kml+xml");
    }
    async function create() {
      setConfirm(false); setErr(null); setProgress(0); setPlabel("Creando geocercas en " + database);
      try {
        const groups = await GI.shareGroups(api);
        const r = await GI.createCorridorZones(api, chosen, groups, setProgress);
        setResult(r);
        if (r.created.length) {
          const ids = new Set(r.created.map(z => z.segId));
          setProps(ps => ps.filter(z => !ids.has(z.segId)));
          await onCreated();
        }
      } catch (e) { setErr("No se pudieron crear las geocercas: " + (e.message || e)); }
      setProgress(null);
    }

    // Mapa de vista previa
    const ref = useRef(null), mapObj = useRef(null);
    useEffect(() => {
      if (!props || !ref.current) return;
      if (!mapObj.current) {
        mapObj.current = L.map(ref.current, { preferCanvas: true });
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(mapObj.current);
      }
      const m = mapObj.current;
      if (m._z) m.removeLayer(m._z);
      const layers = [];
      for (const a of anchors) layers.push(L.polygon(a.pts, { color: "#8a8a8a", weight: 1, fillOpacity: 0.15, dashArray: "4 3" }).bindTooltip(a.name + " (ya creada)"));
      props.forEach((z, i) => {
        const col = z.kind === "nudo" ? "#e34948" : "#256abf";
        layers.push(L.polygon(z.pts, { color: col, weight: focus === i ? 3 : 1.5, fillOpacity: z.include ? 0.3 : 0.05, opacity: z.include ? 1 : 0.4 })
          .bindTooltip(z.name).on("click", () => setFocus(i)));
      });
      m._z = L.featureGroup(layers).addTo(m);
      if (!m._fitted && layers.length) { m.fitBounds(m._z.getBounds(), { padding: [20, 20] }); m._fitted = true; }
      setTimeout(() => m.invalidateSize(), 0);
    }, [props, anchors, focus]);
    useEffect(() => {
      const m = mapObj.current;
      if (m && props && focus != null && props[focus]) m.fitBounds(L.latLngBounds(props[focus].pts), { padding: [60, 60], maxZoom: 14 });
    }, [focus]);
    useEffect(() => () => { if (mapObj.current) { mapObj.current.remove(); mapObj.current = null; } }, []);

    return html`<${Panel} title="Geocercas de corredores"
      hint=${"Zonas de MyGeotab que fijan los tramos del análisis con un nombre claro y estable. Nomenclatura: 'COR · ruta · desde → hasta' para tramos de ruta (tipo de zona '" + GI.CORRIDOR_ZONE_TYPES.tramo + "') y 'NUDO · lugar' para cruces, pueblos y accesos (tipo '" + GI.CORRIDOR_ZONE_TYPES.nudo + "'). Los tramos se dibujan con el GPS real de un vehículo que los recorrió y 200 m a cada lado; si no hay GPS suficiente, con la línea de las celdas (más ancha). Una vez creadas, el análisis usa esas geocercas y los nombres no cambian entre períodos. También sirven para reglas de MyGeotab (por ejemplo, velocidad máxima o aviso nocturno por corredor)."}
      actions=${html`<label className="inline small">Proponer tramos con al menos
          <select value=${minShare} onChange=${e => setMinShare(+e.target.value)} aria-label="Tránsito mínimo">
            ${[0.1, 0.3, 1, 2].map(v => html`<option key=${v} value=${v}>${GI.fmtNum(v, 1)}%</option>`)}
          </select> de los km</label>
        <button className="btn primary" disabled=${progress != null || !named || !candidates.length} onClick=${propose}>${props ? "Volver a proponer" : "Proponer geocercas"}</button>`}>
      <p className="small">${anchors.length
        ? html`Hay <b>${n0(anchors.length)}</b> geocercas de corredores en la base (${n0(nTramos)} tramos y ${n0(nNudos)} nudos), que cubren el <b>${GI.fmtPct(coverage * 100, 0)}</b> de los km de la flota. ${unassignedShare > 0.05 ? html`El ${GI.fmtPct(unassignedShare * 100, 0)} restante pasa por tramos sin geocerca.` : ""}`
        : html`Todavía no hay geocercas de corredores. Los tramos se arman automáticamente y sus nombres pueden variar de un período a otro.`}</p>
      ${!named ? html`<p className="muted small">Esperando los nombres de rutas y localidades para poder proponer…</p>` : null}
      ${progress != null ? html`<${GI.Progress} value=${progress} label=${plabel} />` : null}
      ${err ? html`<${Info} tone="error">${err}<//>` : null}
      ${result ? html`<${Info} tone=${result.failed.length ? "warn" : "ok"}>Se crearon ${n0(result.created.length)} geocercas en ${database}.${result.failed.length ? " No se pudieron crear " + result.failed.length + ": " + result.failed.slice(0, 3).map(f => f.name + " (" + f.error + ")").join("; ") : ""}<//>` : null}
      ${props ? html`
        <div ref=${ref} className="map small-map"></div>
        <p className="muted small">Azul: tramos de ruta; rojo: nudos; gris punteado: geocercas que ya existen. Click en una geocerca para ubicarla en la lista.</p>
        <div className="zone-list">
          <div className="zone-row head"><span></span><span>Nombre</span><span>Tipo</span><span className="num">Km/día</span><span className="num">Largo</span><span>Forma</span></div>
          ${props.map((z, i) => html`<div key=${z.segId} className=${"zone-row" + (focus === i ? " on" : "") + (z.include ? "" : " off")} onClick=${() => setFocus(i)}>
            <span><input type="checkbox" checked=${z.include} aria-label="Incluir" onChange=${e => update(i, { include: e.target.checked })} onClick=${e => e.stopPropagation()} /></span>
            <span className="zone-name"><span className="zprefix">${PREFIX[z.kind].trim()}</span>
              <input type="text" value=${stripPrefix(z.name)} aria-label="Nombre de la geocerca"
                onChange=${e => update(i, { name: PREFIX[z.kind] + e.target.value })} onClick=${e => e.stopPropagation()} />
              ${dupNames.has(z.name) ? html`<span className="conf" title="Hay otra geocerca con el mismo nombre">repetido</span>` : null}</span>
            <span>${z.kind === "nudo" ? "Nudo" : "Tramo"}</span>
            <span className="num">${n0(z.kmDay)}</span>
            <span className="num">${z.length ? n0(z.length) + " km" : "–"}</span>
            <span className="muted small">${z.source === "gps" ? "GPS real" : "aproximada"}</span>
          </div>`)}
        </div>
        <div className="zone-actions">
          <button className="btn" disabled=${!chosen.length} onClick=${kml}>Descargar KML (${n0(chosen.length)})</button>
          ${isAdmin ? (confirm
            ? html`<span className="confirm-box">Se van a crear <b>${n0(chosen.length)}</b> zonas en la base <b>${database}</b> con los tipos "${GI.CORRIDOR_ZONE_TYPES.tramo}" y "${GI.CORRIDOR_ZONE_TYPES.nudo}" (se crean si no existen), visibles para los grupos de los usuarios de la base. Se pueden editar o borrar después desde MyGeotab.
                <button className="btn primary" onClick=${create}>Confirmar y crear</button><button className="btn" onClick=${() => setConfirm(false)}>Cancelar</button></span>`
            : html`<button className="btn primary" disabled=${!chosen.length || progress != null || dupNames.size > 0} onClick=${() => setConfirm(true)}>Crear ${n0(chosen.length)} geocercas en MyGeotab</button>
                ${dupNames.size ? html`<span className="muted small">Corregí los nombres repetidos antes de crear.</span>` : null}`)
            : html`<span className="muted small">Crear las geocercas en MyGeotab requiere permisos de administrador; podés bajar el KML e importarlo con el add-in "Import KML Zones".</span>`}
        </div>` : null}
    <//>`;
  }

  Object.assign(GI, { CorridorZonesPanel });
})(window.GI);
