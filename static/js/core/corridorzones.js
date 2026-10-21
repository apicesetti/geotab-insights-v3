// Geocercas de corredores: zonas de MyGeotab con nomenclatura propia que fijan
// los tramos del análisis de Corredores.
//
//   Tramo de ruta:  "COR · RP7 · Añelo → Cruce RP7 / RP17"   tipo "Corredor vial (Insights)"
//   Cruce / pueblo: "NUDO · Cruce RP7 / RP17 (Añelo)"         tipo "Nudo vial (Insights)"
//
// El add-in las propone a partir de los tramos detectados (el trazado GPS real
// de un vehículo que lo recorrió, con 200 m a cada lado), el administrador las
// revisa y las crea en MyGeotab o las descarga en KML. Desde ahí, el análisis
// usa esas geocercas: los nombres no cambian y se puede comparar en el tiempo.
(function (GI) {
  "use strict";

  const TYPES = { tramo: "Corredor vial (Insights)", nudo: "Nudo vial (Insights)" };
  const PREFIX = { tramo: "COR · ", nudo: "NUDO · " };
  const COLORS = { tramo: { r: 37, g: 106, b: 191, a: 90 }, nudo: { r: 227, g: 73, b: 72, a: 90 } };
  const COMMENT = "Creada por Geotab Insights (Corredores). Nomenclatura: COR · ruta · desde → hasta / NUDO · lugar.";
  const rad = Math.PI / 180;
  const C = () => GI._corr;

  const kindOfName = n => (/^COR\s*·/i.test(n || "") ? "tramo" : /^NUDO\s*·/i.test(n || "") ? "nudo" : null);

  // ---------- Geometría ----------
  const toXY = (lat0) => { const kx = 111.32 * Math.cos(lat0 * rad), ky = 110.57; return { f: p => [p[1] * kx, p[0] * ky], b: q => [q[1] / ky, q[0] / kx] }; };

  function simplify(pts, tol) {
    if (pts.length < 3) return pts.slice();
    const keep = new Array(pts.length).fill(false);
    keep[0] = keep[pts.length - 1] = true;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, ay] = pts[a], [bx, by] = pts[b];
      const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
      let best = -1, bi = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L;
        if (d > best) { best = d; bi = i; }
      }
      if (best > tol) { keep[bi] = true; stack.push([a, bi], [bi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  // Polígono alrededor de una línea (coordenadas planas en km).
  function bufferLine(xy, half) {
    if (xy.length < 2) return null;
    const n = xy.length, left = [], right = [];
    for (let i = 0; i < n; i++) {
      const p = xy[Math.max(0, i - 1)], q = xy[Math.min(n - 1, i + 1)];
      let dx = q[0] - p[0], dy = q[1] - p[1];
      const L = Math.hypot(dx, dy) || 1;
      dx /= L; dy /= L;
      // en las curvas se abre un poco más (sin pasar de 2×)
      let k = 1;
      if (i > 0 && i < n - 1) {
        const a = [xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]], b = [xy[i + 1][0] - xy[i][0], xy[i + 1][1] - xy[i][1]];
        const la = Math.hypot(...a) || 1, lb = Math.hypot(...b) || 1;
        const cos = (a[0] * b[0] + a[1] * b[1]) / (la * lb);
        k = Math.min(2, 1 / Math.max(0.5, Math.sqrt((1 + cos) / 2)));
      }
      const nx = -dy * half * k, ny = dx * half * k;
      // extremos: se alarga la punta medio ancho para cubrir el final
      const ext = i === 0 ? -half : i === n - 1 ? half : 0;
      const bx = xy[i][0] + dx * ext, by = xy[i][1] + dy * ext;
      left.push([bx + nx, by + ny]); right.push([bx - nx, by - ny]);
    }
    return left.concat(right.reverse());
  }

  function convexHull(pts) {
    const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (const q of p.slice().reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }

  // Polígono de un nudo: envolvente de las esquinas de sus celdas.
  function nudoPolygon(cellKeys) {
    const pts = [];
    for (const k of cellKeys) { const [[a, b], [c, d]] = C().cellBounds(k); pts.push([a, b], [a, d], [c, b], [c, d]); }
    return convexHull(pts);
  }

  // Polígono de un tramo: trazado GPS real (lat,lng) si hay, si no la línea de
  // centros de celda suavizada (más ancha, porque no sigue el camino exacto).
  function tramoPolygon(seg, trace) {
    let line = null, half = 0.2, source = "gps";
    if (trace && trace.length >= 2) {
      const set = new Set(seg.cellKeys);
      // tramos del recorrido dentro de las celdas del tramo; el más largo
      const runs = [];
      let cur = [];
      for (const p of trace) {
        const last = cur[cur.length - 1];
        // un salto de más de 1,5 km entre puntos corta el tramo (GPS errático o hueco)
        if (last && C().haversineKm(last[0], last[1], p[0], p[1]) > 1.5) { runs.push(cur); cur = []; }
        if (set.has(C().cellOf(p[0], p[1]))) cur.push(p);
        else if (cur.length) { runs.push(cur); cur = []; }
      }
      if (cur.length) runs.push(cur);
      runs.sort((a, b) => b.length - a.length);
      const best = runs[0];
      if (best && best.length >= 3) {
        const cells = new Set(best.map(p => C().cellOf(p[0], p[1])));
        if (cells.size >= Math.max(2, seg.cellKeys.length * 0.6)) line = best;
      }
    }
    if (!line) {
      source = "celdas";
      half = 0.7;
      const c = seg.path || [];
      line = c.map((p, i) => {
        const a = c[Math.max(0, i - 1)], b = c[Math.min(c.length - 1, i + 1)];
        return [(a[0] + p[0] + b[0]) / 3, (a[1] + p[1] + b[1]) / 3];
      });
      if (line.length < 2) return null;
    }
    const lat0 = line[0][0];
    const T = toXY(lat0);
    let xy = line.map(T.f), tol = 0.03;
    let simp = simplify(xy, tol);
    while (simp.length > 80) { tol *= 1.6; simp = simplify(xy, tol); }
    const poly = bufferLine(simp, half);
    return poly ? { pts: poly.map(T.b), source } : null;
  }

  // Celdas de ~1 km que cubre una geocerca (borde muestreado cada 150 m y
  // celdas con el centro adentro).
  function zoneCells(pts) {
    const set = new Set();
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const d = C().haversineKm(a[0], a[1], b[0], b[1]);
      const n = Math.max(1, Math.ceil(d / 0.15));
      for (let k = 0; k < n; k++) { const f = k / n; set.add(C().cellOf(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)); }
    }
    let lat0 = 90, lat1 = -90, lng0 = 180, lng1 = -180;
    for (const [la, ln] of pts) { lat0 = Math.min(lat0, la); lat1 = Math.max(lat1, la); lng0 = Math.min(lng0, ln); lng1 = Math.max(lng1, ln); }
    const poly = pts.map(([la, ln]) => [ln, la]);
    for (let la = lat0; la <= lat1; la += 0.005) for (let ln = lng0; ln <= lng1; ln += 0.005) {
      if (GI.pointInPolygon(ln, la, poly)) set.add(C().cellOf(la, ln));
    }
    return set;
  }

  function perimeterKm(pts) {
    let s = 0;
    for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += C().haversineKm(a[0], a[1], b[0], b[1]); }
    return s;
  }

  // ---------- Lectura ----------
  // Se buscan por nombre (la nomenclatura empieza con "COR ·" o "NUDO ·").
  async function loadCorridorZones(api) {
    const sel = { propertySelector: { fields: ["id", "name", "points", "zoneTypes", "comment"], isIncluded: true } };
    let res;
    try {
      res = await api.multiCall([
        ["Get", { typeName: "Zone", search: { name: "COR%" }, resultsLimit: 5000, ...sel }],
        ["Get", { typeName: "Zone", search: { name: "NUDO%" }, resultsLimit: 5000, ...sel }],
      ]);
    } catch (e) { return []; }
    const all = [...(res[0] || []), ...(res[1] || [])];
    const seen = new Set();
    return all.filter(z => z && !seen.has(z.id) && seen.add(z.id) && kindOfName(z.name) && (z.points || []).length >= 3).map(z => {
      const pts = z.points.map(p => [p.y, p.x]);
      return { id: z.id, name: z.name, kind: kindOfName(z.name), pts, cells: zoneCells(pts), perimeterKm: perimeterKm(pts), label: z.name.replace(/^(COR|NUDO)\s*·\s*/i, "") };
    });
  }

  // ---------- Propuesta ----------
  // Para cada tramo se busca el vehículo que más celdas del tramo recorrió
  // en un mismo día (de las filas por vehículo del muestreo) y se trae su
  // GPS de esas horas para dibujar el camino real.
  function bestPass(days, cellKeys) {
    const set = new Set(cellKeys);
    const score = new Map();
    for (const [dk, v] of days) {
      if (v.bucketed) return null;
      for (const [di, cell, h, km] of v.rows) {
        if (!set.has(cell)) continue;
        const k = v.devs[di] + "|" + dk;
        let s = score.get(k);
        if (!s) score.set(k, (s = { dev: v.devs[di], dk, cells: new Set(), h0: h, h1: h, km: 0 }));
        s.cells.add(cell); s.h0 = Math.min(s.h0, h); s.h1 = Math.max(s.h1, h); s.km += km;
      }
    }
    let best = null;
    for (const s of score.values()) if (!best || s.cells.size > best.cells.size || (s.cells.size === best.cells.size && s.km > best.km)) best = s;
    return best;
  }

  async function proposeZones(api, segs, days, opts) {
    const o = Object.assign({ onProgress: null }, opts || {});
    const out = [];
    let done = 0;
    await GI.pool(segs, 3, async x => {
      let poly = null;
      if (x.type === "nudo") poly = { pts: nudoPolygon(x.cellKeys), source: "celdas" };
      else {
        let trace = null;
        const b = bestPass(days, x.cellKeys);
        if (b) {
          const d0 = GI.parseDayKey(b.dk).getTime();
          const h1 = Math.min(b.h1 + 1, b.h0 + 4);
          try { trace = await GI.loadTrace(api, b.dev, d0 + b.h0 * 3600000, d0 + h1 * 3600000); } catch (e) { trace = null; }
        }
        poly = tramoPolygon(x, trace);
      }
      done++;
      if (o.onProgress) o.onProgress(done / segs.length);
      if (poly && poly.pts.length >= 3) out.push({ segId: x.id, kind: x.type, name: PREFIX[x.type] + x.name, pts: poly.pts, source: poly.source, kmDay: x.kmDay, length: x.length, share: x.share, include: true });
    });
    // nombres únicos
    const count = {};
    for (const z of out) count[z.name] = (count[z.name] || 0) + 1;
    const idx = {};
    for (const z of out) if (count[z.name] > 1) { idx[z.name] = (idx[z.name] || 0) + 1; z.name += " (" + idx[z.name] + ")"; }
    return out;
  }

  // ---------- Escritura ----------
  async function ensureZoneTypes(api) {
    const list = (await api.call("Get", { typeName: "ZoneType" })) || [];
    const ids = {};
    for (const k of Object.keys(TYPES)) {
      const hit = list.find(t => t.name === TYPES[k]);
      ids[k] = hit ? hit.id : await api.call("Add", { typeName: "ZoneType", entity: { name: TYPES[k], comment: COMMENT } });
    }
    return ids;
  }

  async function createCorridorZones(api, items, groups, onProgress) {
    const typeIds = await ensureZoneTypes(api);
    const created = [], failed = [];
    for (let i = 0; i < items.length; i += 20) {
      const part = items.slice(i, i + 20);
      const calls = part.map(z => {
        const pts = z.pts.map(([la, ln]) => ({ x: GI.round(ln, 6), y: GI.round(la, 6) }));
        pts.push({ ...pts[0] }); // polígono cerrado
        return ["Add", { typeName: "Zone", entity: {
          name: z.name, points: pts, zoneTypes: [{ id: typeIds[z.kind] }], groups,
          comment: COMMENT, displayed: true, mustIdentifyStops: false,
          activeFrom: "1986-01-01T00:00:00.000Z", activeTo: "2050-01-01T00:00:00.000Z", fillColor: COLORS[z.kind],
        } }];
      });
      try {
        const ids = await api.multiCall(calls);
        part.forEach((z, j) => created.push({ ...z, id: ids[j] }));
      } catch (e) {
        // si falla el lote, se prueba de a una para saber cuál
        for (let j = 0; j < part.length; j++) {
          try { created.push({ ...part[j], id: await api.call(calls[j][0], calls[j][1]) }); }
          catch (e2) { failed.push({ ...part[j], error: String(e2.message || e2) }); }
        }
      }
      if (onProgress) onProgress(Math.min(1, (i + part.length) / items.length));
    }
    return { created, failed };
  }

  const esc = s => String(s).replace(/[<>&'"]/g, ch => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[ch]));
  function zonesKml(items) {
    const style = k => `<Style id="${k}"><LineStyle><color>ff${k === "nudo" ? "4849e3" : "bf6a25"}</color><width>2</width></LineStyle><PolyStyle><color>5a${k === "nudo" ? "4849e3" : "bf6a25"}</color></PolyStyle></Style>`;
    const pm = items.map(z => {
      const ring = z.pts.concat([z.pts[0]]).map(([la, ln]) => ln.toFixed(6) + "," + la.toFixed(6) + ",0").join(" ");
      return `  <Placemark><name>${esc(z.name)}</name><description>${esc(TYPES[z.kind])}</description><styleUrl>#${z.kind}</styleUrl>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`;
    }).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Geocercas de corredores</name>
  ${style("tramo")}
  ${style("nudo")}
${pm}
</Document>
</kml>
`;
  }

  Object.assign(GI, {
    CORRIDOR_ZONE_TYPES: TYPES, loadCorridorZones, proposeZones, createCorridorZones, corridorZonesKml: zonesKml,
    _cz: { simplify, bufferLine, convexHull, nudoPolygon, tramoPolygon, zoneCells, kindOfName },
  });
})(window.GI);
