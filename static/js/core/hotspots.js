// Puntos calientes: celdas de ~500 m con muchas infracciones de varios
// conductores distintos (un problema del lugar, no de una persona). Se
// calculan con las ubicaciones del mapa de calor y se exportan como KML para
// crear zonas en MyGeotab (add-in "Import KML Zones") y ponerles una regla.
(function (GI) {
  "use strict";

  function hotspots(events, locs, opts) {
    const o = Object.assign({ cellM: 500, minEvents: 5, minDrivers: 2 }, opts || {});
    const dLat = o.cellM / 111320;
    const cells = new Map();
    for (const e of events) {
      const p = locs.get(e.i);
      if (!p) continue;
      const [lat, lng] = p;
      const dLng = o.cellM / (111320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
      const ci = Math.floor(lat / dLat), cj = Math.floor(lng / dLng);
      const k = ci + ":" + cj;
      const c = cells.get(k) || { key: k, lat0: ci * dLat, lng0: cj * dLng, dLat, dLng, n: 0, w: 0, drivers: new Set(), devices: new Set(), cats: {}, sumLat: 0, sumLng: 0, last: 0 };
      c.n++; c.w += e.w || 0; c.sumLat += lat; c.sumLng += lng; c.last = Math.max(c.last, e.t);
      if (e.drv) c.drivers.add(e.drv); c.devices.add(e.d);
      c.cats[e.cat] = (c.cats[e.cat] || 0) + 1;
      cells.set(k, c);
    }
    return [...cells.values()]
      .filter(c => c.n >= o.minEvents && Math.max(c.drivers.size, c.devices.size) >= o.minDrivers)
      .map(c => ({
        key: c.key, n: c.n, w: c.w, drivers: c.drivers.size, devices: c.devices.size, last: c.last,
        lat: c.sumLat / c.n, lng: c.sumLng / c.n,
        bounds: [[c.lat0, c.lng0], [c.lat0 + c.dLat, c.lng0 + c.dLng]],
        cats: Object.entries(c.cats).sort((a, b) => b[1] - a[1]).map(([cat, n]) => ({ cat, n })),
      }))
      .sort((a, b) => b.w - a.w);
  }

  const esc = s => String(s).replace(/[<>&'"]/g, ch => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[ch]));

  // KML con un polígono por punto caliente (coordenadas lng,lat).
  function hotspotsKml(list, title) {
    const pm = list.map((h, i) => {
      const [[a, b], [c, d]] = h.bounds;
      const ring = [[b, a], [d, a], [d, c], [b, c], [b, a]].map(([x, y]) => x.toFixed(6) + "," + y.toFixed(6) + ",0").join(" ");
      const cats = h.cats.slice(0, 3).map(x => GI.catLabel ? GI.catLabel(x.cat) + " " + x.n : x.cat + " " + x.n).join(", ");
      return `  <Placemark>
    <name>${esc("Punto caliente " + (i + 1) + (h.cats[0] ? " - " + (GI.catLabel ? GI.catLabel(h.cats[0].cat) : h.cats[0].cat) : ""))}</name>
    <description>${esc(h.n + " infracciones de " + Math.max(h.drivers, h.devices) + " conductores/vehículos. " + cats)}</description>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon>
  </Placemark>`;
    }).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${esc(title || "Puntos calientes")}</name>
${pm}
</Document>
</kml>
`;
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type: type || "application/vnd.google-earth.kml+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  Object.assign(GI, { hotspots, hotspotsKml, downloadText: download });
})(window.GI);
