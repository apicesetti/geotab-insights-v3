// Compatibilidad: un index.html viejo en caché todavía pide este archivo.
// Corredores ahora vive en roads.js: se carga desde acá si hace falta.
(function () {
  "use strict";
  var GI = window.GI || {};
  if (GI.RoadsTab) return;
  var cur = document.currentScript && document.currentScript.src;
  if (!cur) return;
  var s = document.createElement("script");
  s.src = cur.replace(/corridor\.js(\?.*)?$/, "roads.js?v=" + Date.now());
  s.async = false;
  document.head.appendChild(s);
})();
