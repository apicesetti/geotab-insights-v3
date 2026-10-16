// Helpers genéricos sin dependencias. Todo el proyecto corre en el browser,
// sin build: cada archivo define funciones globales dentro del namespace GI.
window.GI = window.GI || {};

(function (GI) {
  "use strict";

  const DAY_MS = 86400000;

  function round(value, decimals) {
    const f = Math.pow(10, decimals || 0);
    return Math.round((Number(value) + Number.EPSILON) * f) / f;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // "PT1H2M3S", "1.02:03:04.5", "HH:MM:SS(.fff)" o segundos -> horas.
  function durationToHours(v) {
    if (v == null) return 0;
    if (typeof v === "number") return v / 3600;
    const s = String(v).trim();
    if (s.startsWith("P")) {
      const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/.exec(s);
      if (!m) return 0;
      return (+(m[1] || 0)) * 24 + (+(m[2] || 0)) + (+(m[3] || 0)) / 60 + (+(m[4] || 0)) / 3600;
    }
    let days = 0;
    let rest = s;
    const dm = /^(\d+)\.(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(s);
    if (dm) { days = +dm[1]; rest = dm[2]; }
    const p = rest.split(":");
    if (p.length === 3) {
      const h = +p[0], m = +p[1], sec = parseFloat(p[2]);
      if ([h, m, sec].every(n => !Number.isNaN(n))) return days * 24 + h + m / 60 + sec / 3600;
    }
    return 0;
  }

  // ---- Fechas en hora LOCAL del navegador (los cortes de día/semana/mes
  // tienen que coincidir con el día operativo del cliente, no con UTC). ----
  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  function dayKey(d) {
    d = d instanceof Date ? d : new Date(d);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function parseDayKey(k) {
    const [y, m, d] = k.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  }

  function startOfDay(d) {
    const r = new Date(d);
    r.setHours(0, 0, 0, 0);
    return r;
  }

  // Lista de dayKeys entre fromKey y toKey inclusive.
  function dayRange(fromKey, toKey) {
    const out = [];
    let d = parseDayKey(fromKey);
    const end = parseDayKey(toKey);
    while (d <= end) {
      out.push(dayKey(d));
      d = addDays(d, 1);
    }
    return out;
  }

  // Bucket de un dayKey según granularidad: day | week (lunes) | month.
  function bucketKey(dk, gran) {
    if (gran === "day") return dk;
    const d = parseDayKey(dk);
    if (gran === "month") return d.getFullYear() + "-" + pad(d.getMonth() + 1);
    const wd = (d.getDay() + 6) % 7;
    return dayKey(addDays(d, -wd));
  }

  const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

  function bucketLabel(bk, gran) {
    if (gran === "month") {
      const [y, m] = bk.split("-").map(Number);
      return MONTHS[m - 1] + " " + String(y).slice(2);
    }
    const d = parseDayKey(bk);
    const base = d.getDate() + " " + MONTHS[d.getMonth()];
    return gran === "week" ? "Sem. " + base : base;
  }

  function median(values) {
    const v = values.filter(x => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  function sum(arr, fn) {
    let s = 0;
    for (const x of arr) s += fn ? (fn(x) || 0) : (x || 0);
    return s;
  }

  function groupBy(arr, keyFn) {
    const out = new Map();
    for (const x of arr) {
      const k = keyFn(x);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(x);
    }
    return out;
  }

  // Ejecuta tareas async con concurrencia acotada.
  async function pool(items, limit, worker) {
    const results = new Array(items.length);
    let i = 0;
    async function run() {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await worker(items[idx], idx);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
  }

  // ---- Reintentos (rate limiting / timeouts) ----
  const SKIP = /invalid|missing|unauthorized|forbidden|permission|not found|does not exist|malformed|unsupported|argument/i;
  const OVERLIMIT = /overlimit|quota exceeded|too many requests/i;

  function errText(err) {
    return [err && err.name, err && err.message, err && err.data && err.data.type].filter(Boolean).join(" ");
  }

  async function withRetry(fn) {
    let attempt = 0, over = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        const t = errText(err);
        if (OVERLIMIT.test(t) && over < 2) { over++; await sleep(61000); continue; }
        attempt++;
        if (attempt >= 4 || SKIP.test(t)) throw err;
        await sleep(Math.min(8000, 500 * Math.pow(2, attempt - 1)) * (0.5 + Math.random() * 0.5));
      }
    }
  }

  // El SDK de add-ins acepta callbacks; lo envolvemos en promesas + reintentos.
  function wrapApi(api) {
    const call = (method, params) => withRetry(() => new Promise((res, rej) => api.call(method, params, res, rej)));
    const multiCall = calls => withRetry(() => new Promise((res, rej) => api.multiCall(calls, res, rej)));
    return { call, multiCall, raw: api };
  }

  function idOf(ref) {
    if (!ref) return null;
    return typeof ref === "string" ? ref : ref.id || null;
  }

  function fmtNum(v, dec) {
    if (v == null || Number.isNaN(v)) return "–";
    return Number(v).toLocaleString("es-AR", { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 });
  }

  function fmtMoney(v) {
    if (v == null || Number.isNaN(v)) return "–";
    return "$ " + Number(v).toLocaleString("es-AR", { maximumFractionDigits: 0 });
  }

  function fmtPct(v, dec) {
    if (v == null || Number.isNaN(v)) return "–";
    return fmtNum(v, dec == null ? 1 : dec) + "%";
  }

  function pctChange(before, after) {
    if (before == null || after == null) return null;
    if (before === 0) return after === 0 ? 0 : null;
    return ((after - before) / before) * 100;
  }

  Object.assign(GI, {
    DAY_MS, round, sleep, durationToHours, dayKey, parseDayKey, addDays, startOfDay, dayRange,
    bucketKey, bucketLabel, median, sum, groupBy, pool, withRetry, wrapApi, idOf,
    fmtNum, fmtMoney, fmtPct, pctChange,
  });
})(window.GI);
