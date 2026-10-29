// Fatiga: jornadas por conductor con sus señales de riesgo (casos) y
// jornadas en curso con su avance contra los límites (ahora).
//
// Jornada = viajes del conductor separados por pausas de menos de
// rest_split horas (un turno noche es una sola jornada, del día en que
// empezó). Señales de una jornada:
//   larga       jornada (primer arranque → último corte) > max_span
//   manejo      horas de manejo > max_drive_day
//   continuo    manejo sin pausa de 15 min > max_continuous
//   madrugada   ≥ 30 min de manejo entre las 02 y las 05 h (punto más bajo del ritmo circadiano)
//   cambio      cambia de turno día ↔ noche con un solo descanso entremedio
//   descanso    descanso previo < min_rest, o mayormente de día antes de un turno noche
//   seguidos    más de max_days_row días seguidos de trabajo
//   (los eventos de cámara —bostezo, distracción, salida de carril— NO son
//   señales: bostezar no prueba cansancio. Se muestran como contexto y se usan
//   para validar si el índice anticipa esos eventos.)
// Nivel: alto con 3 señales o más, medio con 2.
(function (GI) {
  "use strict";
  const H = 3600000, MIN = 60000;
  const CAM_CATS = new Set(["fatiga", "distraccion", "salida_carril"]);
  const SIGNALS = [
    { key: "larga", label: "Jornada larga" },
    { key: "manejo", label: "Mucho manejo" },
    { key: "continuo", label: "Manejo continuo" },
    { key: "madrugada", label: "Madrugada" },
    { key: "cambio", label: "Cambio de turno" },
    { key: "descanso", label: "Descanso corto o de día" },
    { key: "seguidos", label: "Días seguidos" },
    { key: "franco", label: "Franco corto" },
    { key: "francos", label: "Noche después de francos" },
    { key: "motor", label: "Descanso con motor en marcha" },
    { key: "lejos", label: "Descansos fuera de base" },
    { key: "indice", label: "Índice de fatiga alto" },
  ];

  // ---------- Índice de fatiga estimado ----------
  // Modelo propio y simple (no es FAID): el índice sube mientras el conductor
  // está en jornada (más rápido manejando y de madrugada, por el ritmo
  // circadiano) y baja mientras descansa, más rápido si descansa de noche.
  // Calibrado para que una jornada diurna normal termine cerca de 50–70 y un
  // turno noche largo o con descanso corto pase de 100.
  // Coeficientes de fábrica. Se pueden calibrar por base (Fatiga → Validación)
  // y quedan en settings.fatigue.fi_params. FI es el juego en uso: lo fija
  // cada cálculo según la configuración (todo es sincrónico).
  const FI_DEFAULT = { drive: 5, work: 2, amp: 0.3, recNight: 0.16, recNap: 0.1, recDay: 0.07, start: 20, step: 15 * MIN };
  let FI = FI_DEFAULT;
  const useParams = P => { FI = P || FI_DEFAULT; };
  const hourOf = t => { const d = new Date(t); return d.getHours() + d.getMinutes() / 60; };
  // 1,0 a las 16 h, 1,6 a las 04 h
  const circ = t => 1 + FI.amp * (1 + Math.cos(((hourOf(t) - 4) / 24) * 2 * Math.PI));
  const sleepQ = t => { const h = hourOf(t); return h >= 22 || h < 7 ? FI.recNight : h >= 13 && h < 16 ? FI.recNap : FI.recDay; };
  // Avanza el índice un paso: trabajando (df = fracción manejando) o descansando.
  function fiStep(F, t, working, df, stepH) {
    if (working) return F + (FI.drive * df + FI.work * (1 - df)) * circ(t) * stepH;
    return F * Math.pow(1 - sleepQ(t), stepH);
  }
  // Recuperación entre a y b (descanso).
  function fiRest(F, a, b) {
    for (let t = a; t < b; t += FI.step) F = fiStep(F, t, false, 0, Math.min(FI.step, b - t) / H);
    return F;
  }
  // Jornada simulada desde t0 durante spanH horas manejando la fracción df.
  function fiWork(F, t0, spanH, df) {
    let peak = F, peakAt = t0;
    const end = t0 + spanH * H;
    for (let t = t0; t < end; t += FI.step) {
      F = fiStep(F, t, true, df, Math.min(FI.step, end - t) / H);
      if (F > peak) { peak = F; peakAt = Math.min(end, t + FI.step); }
    }
    return { F, peak, peakAt };
  }
  // Simula un conductor sobre sus jornadas (ordenadas). Anota en cada jornada
  // el índice al empezar, el máximo y al terminar; devuelve la serie cada 15 min.
  function simulateDriver(list, until) {
    if (!list.length) return null;
    const t0 = Math.floor(list[0].s / FI.step) * FI.step;
    const end = Math.max(until || 0, list[list.length - 1].e);
    const n = Math.ceil((end - t0) / FI.step) + 1;
    const vals = new Float32Array(n);
    let F = FI.start, ji = 0, ti = 0;
    // descansos con el motor en marcha (ralentí): se recupera la mitad
    const poor = [];
    for (const j of list) for (const iv of j.restIdle || []) poor.push(iv);
    poor.sort((x, y) => x[0] - y[0]);
    let pi = 0;
    const poorAt = t => { while (pi < poor.length && poor[pi][1] <= t) pi++; return pi < poor.length && poor[pi][0] <= t; };
    for (let i = 0; i < n; i++) {
      const a = t0 + i * FI.step, b = a + FI.step;
      while (ji < list.length && list[ji].e <= a) ji++;
      const j = list[ji];
      const working = j && j.s < b && j.e > a;
      let df = 0;
      if (working) {
        if (j._fiStart == null) { j._fiStart = F; j.fiPeak = F; j.fiPeakAt = j.s; }
        let ov = 0;
        for (let k = 0; k < j.trips.length; k++) { const t = j.trips[k]; if (t.e <= a) continue; if (t.s >= b) break; const len = t.e - t.s, fr = len > 0 ? Math.min(1, (t.dh * H) / len) : 1; ov += (Math.min(b, t.e) - Math.max(a, t.s)) * fr; }
        df = Math.min(1, ov / FI.step);
      }
      if (!working && poorAt(a)) F = F * Math.pow(1 - sleepQ(a) * 0.5, FI.step / H);
      else F = fiStep(F, a, working, df, FI.step / H);
      vals[i] = F;
      if (working) { if (F > j.fiPeak) { j.fiPeak = F; j.fiPeakAt = b; } j.fiEnd = F; }
    }
    for (const j of list) { j.fiStart = j._fiStart != null ? j._fiStart : FI.start; delete j._fiStart; }
    return { t0, step: FI.step, vals, at: t => { const i = Math.floor((t - t0) / FI.step); return i < 0 ? FI.start : vals[Math.min(vals.length - 1, i)]; } };
  }
  function fiLevel(v, fz) { return v == null ? null : v >= fz.fi_high + 20 ? "muy alto" : v >= fz.fi_high ? "alto" : v >= fz.fi_mod ? "moderado" : "bajo"; }

  // Horario habitual del conductor (últimas jornadas del mismo tipo que la última).
  function habitual(list) {
    const done = list.filter(j => !j.open).slice(-12);
    if (!done.length) return null;
    const type = done[done.length - 1].type;
    const same = done.filter(j => j.type === type);
    // minutos desde las 12 h (para que un turno noche 21–23 h no se parta en la medianoche)
    const mins = same.map(j => { const m = Math.round(hourOf(j.s) * 60); return (m - 720 + 1440) % 1440; });
    const med = GI.median(mins);
    return { type, startMin: (med + 720) % 1440, span: GI.median(same.map(j => j.span)), dh: GI.median(same.map(j => j.dh)), n: same.length };
  }
  function nextAt(minOfDay, after) {
    const d = new Date(after); d.setHours(0, minOfDay, 0, 0);
    let t = d.getTime();
    while (t < after) t += 86400000;
    return t;
  }
  // Riesgo del próximo turno: arranque en su horario habitual con el descanso
  // que lleva, y descanso necesario para no terminar por encima del umbral alto.
  function nextShiftRisk(list, sim, fz, now, rs) {
    useParams(fz.P);
    const hb = habitual(list);
    const last = list[list.length - 1];
    if (!hb || !sim || !last || last.open) return null;
    const df = hb.span > 0 ? Math.min(1, hb.dh / hb.span) : 0.7;
    const Fnow = fiRest(last.fiEnd != null ? last.fiEnd : FI.start, last.e, now);
    const start = nextAt(hb.startMin, Math.max(now, last.e + H, (rs && rs.inFranco && rs.backAt) || 0));
    const Fstart = fiRest(Fnow, now, start);
    const w = fiWork(Fstart, start, hb.span, df);
    let needRest = null;
    for (let r = Math.max(4, fz.min_rest || 8); r <= 48; r += 0.5) {
      const s0 = last.e + r * H;
      if (fiWork(fiRest(last.fiEnd || FI.start, last.e, s0), s0, hb.span, df).peak < fz.fi_high) { needRest = r; break; }
    }
    return { hb, Fnow, start, restAtStart: (start - last.e) / H, Fstart, peak: w.peak, peakAt: w.peakAt, level: fiLevel(w.peak, fz), needRest, lastE: last.e };
  }
  // Jornada en curso: índice ahora, y si completa su jornada habitual.
  function openShiftIndex(j, list, sim, fz, now) {
    useParams(fz.P);
    const Fnow = sim ? sim.at(now - 1) : null;
    const hb = habitual(list);
    const spanH = hb ? hb.span : fz.max_span;
    const rem = Math.max(0, spanH - (now - j.s) / H);
    const spanNow = (now - j.s) / H;
    const df = spanNow > 0.5 ? Math.min(1, j.dh / spanNow) : 0.7;
    const w = Fnow != null ? fiWork(Fnow, now, rem, df) : null;
    // cuándo cruza el umbral alto si sigue así (hasta 14 h)
    let crossAt = null;
    if (Fnow != null && Fnow < fz.fi_high) {
      let F = Fnow;
      for (let t = now; t < now + 14 * H; t += FI.step) { F = fiStep(F, t, true, df, FI.step / H); if (F >= fz.fi_high) { crossAt = t + FI.step; break; } }
    }
    return { Fnow, spanH, peak: w ? w.peak : null, crossAt, level: fiLevel(Fnow, fz) };
  }

  // Horas de [a, b] que caen entre las horas locales h0 y h1 (h0 < h1, mismo día).
  function overlapHours(a, b, h0, h1) {
    if (!(b > a)) return 0;
    let tot = 0;
    const d = new Date(a); d.setHours(0, 0, 0, 0);
    for (let day = d.getTime() - 86400000; day < b; day += 86400000) {
      const x0 = new Date(day); x0.setHours(h0, 0, 0, 0);
      const x1 = new Date(day); x1.setHours(h1, 0, 0, 0);
      tot += Math.max(0, Math.min(b, x1.getTime()) - Math.max(a, x0.getTime()));
    }
    return tot / H;
  }
  // Fracción de [a, b] que es "de noche" para turnos (20 a 06 h).
  function nightFrac(a, b) {
    if (!(b > a)) return 0;
    return (overlapHours(a, b, 20, 24) + overlapHours(a, b, 0, 6)) / ((b - a) / H);
  }

  function fatigueLimits(settings) {
    const fz = Object.assign({ max_drive_day: 9, max_span: 12, min_rest: 8, max_continuous: 4, max_days_row: 6, rest_split: 4, fi_mod: 80, fi_high: 100, micro_km: 0.5, micro_min: 10 }, (settings && settings.fatigue) || {});
    fz.SPLIT = Math.max(1, Math.min(fz.rest_split || 4, fz.min_rest || 8)) * H;
    fz.P = Object.assign({}, FI_DEFAULT, fz.fi_params || {}, { start: FI_DEFAULT.start, step: FI_DEFAULT.step });
    return fz;
  }

  // Viajes por conductor (sin superposiciones) con su vehículo.
  // Un viaje con un ralentí largo adentro (el conductor paró con el motor en
  // marcha, por ejemplo para dormir) se parte en dos: el ralentí no es manejo y
  // puede ser el descanso que cierra la jornada.
  function splitIdle(t, idleByDev) {
    if (!idleByDev || !(t.ih >= 1)) return [t];
    const iv = (idleByDev.get(t.d) || []).filter(([a, b]) => b - a >= H && a > t.s && b < t.e);
    if (!iv.length) return [t];
    const segs = [];
    let cur = t.s;
    for (const [a, b] of iv) { if (a > cur) segs.push([cur, a]); cur = Math.max(cur, b); }
    if (t.e > cur) segs.push([cur, t.e]);
    const tot = GI.sum(segs, ([a, b]) => b - a) || 1, idleH = GI.sum(iv, ([a, b]) => (b - a) / H);
    return segs.map(([a, b], i) => { const f = (b - a) / tot; return { ...t, s: a, e: b, dh: t.dh * f, km: t.km * f, ih: Math.max(0, t.ih - idleH) * f, x: i < segs.length - 1 ? null : t.x, y: i < segs.length - 1 ? null : t.y }; });
  }

  // Movimientos mínimos: menos de micro_km y menos de micro_min minutos de
  // manejo (encender el camión durante el descanso por frío o calor, la
  // dispersión del GPS, acomodar el vehículo). No son trabajo: no cortan ni
  // alargan un descanso. Se guardan aparte para mostrarlos y, si duran, para
  // contar ese tiempo como motor en marcha durante el descanso.
  function isMicro(t, fz) {
    return !t.live && (t.km || 0) < (fz.micro_km != null ? fz.micro_km : 0.5) && (t.dh || 0) * 60 < (fz.micro_min != null ? fz.micro_min : 10);
  }
  function tripsByDriver(tripsByDevice, ids, driverOk, now, idleByDev, fz, micro) {
    const by = new Map();
    for (const [dev, trips] of tripsByDevice) {
      if (!ids.has(dev)) continue;
      for (const t of trips) {
        if (!t.r || t.r === "_unknown" || (driverOk && !driverOk(t.r)) || (now && t.s > now)) continue;
        if (fz && micro && isMicro(t, fz)) { if (!micro.has(t.r)) micro.set(t.r, []); micro.get(t.r).push(t); continue; }
        if (!by.has(t.r)) by.set(t.r, []);
        for (const p of splitIdle(t, idleByDev)) by.get(t.r).push(p);
      }
    }
    for (const [id, raw] of by) {
      raw.sort((a, b) => a.s - b.s);
      const out = [];
      let reach = -Infinity;
      for (const t of raw) {
        if (t.e <= reach) continue;
        const s0 = Math.max(t.s, reach), f = t.e > t.s ? (t.e - s0) / (t.e - t.s) : 1;
        out.push({ s: s0, e: now ? Math.min(t.e, now) : t.e, dh: (t.dh || 0) * f, km: (t.km || 0) * f, ih: (t.ih || 0) * f, d: t.d, x: t.x, y: t.y, live: !!t.live });
        reach = t.e;
      }
      by.set(id, out);
    }
    return by;
  }

  function buildShifts(model, ids, driverOk, opts) {
    const fz = fatigueLimits(model.settings);
    useParams(fz.P);
    const o = Object.assign({ now: Date.now() }, opts || {});
    // ralentí por vehículo (reglas de ralentí con duración): para ver si descansó con el motor en marcha
    const idleByDev = new Map();
    for (const e of model.idle || []) {
      if (!ids.has(e.d)) continue;
      if (!idleByDev.has(e.d)) idleByDev.set(e.d, []);
      idleByDev.get(e.d).push([e.t, e.t + e.h * H, e.r || null]);
    }
    for (const l of idleByDev.values()) l.sort((a, b) => a[0] - b[0]);
    // ralentí del vehículo entre a y b; si se pasa drv, no cuenta el ralentí registrado a nombre de otro conductor
    const idleIn = (dev, a, b, drv) => {
      const out = [];
      for (const [x, y, r] of idleByDev.get(dev) || []) { if (x >= b) break; if (y > a && !(drv && r && r !== drv)) out.push([Math.max(a, x), Math.min(b, y)]); }
      return out;
    };
    // Vehículos que trabajan las 24 h con relevo: mientras un conductor descansa, el
    // camión puede seguir andando con otro. Primer uso del vehículo por otro
    // conductor (o sin conductor identificado, moviéndose) dentro de [a, b].
    const devTrips = new Map();
    for (const [dev, trips] of (o.tripsByDevice || model.tripsByDevice)) if (ids.has(dev)) devTrips.set(dev, trips);
    const otherUse = (dev, a, b, drv) => {
      for (const t of devTrips.get(dev) || []) {
        if (t.s >= b) break;
        if (t.s > a && t.r !== drv && (t.r ? !isMicro(t, fz) : (t.km || 0) >= (fz.micro_km != null ? fz.micro_km : 0.5))) return t;
      }
      return null;
    };
    const microByDrv = new Map();
    const byDrv = tripsByDriver(o.tripsByDevice || model.tripsByDevice, ids, driverOk, o.now, idleByDev, fz, microByDrv);
    for (const l of microByDrv.values()) l.sort((a, b) => a.s - b.s);
    const camByDrv = new Map(), evByDrv = new Map();
    for (const e of model.events) {
      if (!ids.has(e.d) || !e.drv || e.drv === "_unknown") continue;
      if (CAM_CATS.has(e.cat)) { if (!camByDrv.has(e.drv)) camByDrv.set(e.drv, []); camByDrv.get(e.drv).push(e); }
      if (e.w > 0) { if (!evByDrv.has(e.drv)) evByDrv.set(e.drv, []); evByDrv.get(e.drv).push(e); }
    }
    for (const l of camByDrv.values()) l.sort((a, b) => a.t - b.t);
    const placeAt = (x, y) => {
      const z = model.zoneAtPlace ? model.zoneAtPlace(x, y) : null;
      if (!z) return x == null ? null : { kind: "ruta", name: "Fuera de geocercas" };
      const ty = z.types || [];
      return { kind: ty.includes("ZoneTypeOfficeId") || ty.includes("ZoneTypeHomeId") ? "base" : ty.includes("ZoneTypeCustomerId") ? "cliente" : "zona", name: z.name, id: z.id };
    };
    const shifts = [], sims = new Map();
    for (const [drv, trips] of byDrv) {
      const list = [];
      let cur = null;
      for (const t of trips) {
        if (!cur || t.s - cur.e >= fz.SPLIT) { cur = { drv, s: t.s, e: t.e, trips: [] }; list.push(cur); }
        cur.trips.push(t); cur.e = Math.max(cur.e, t.e);
      }
      const rs = rosterOf(list, o.now, o.rosters && o.rosters.get(drv));
      let prev = null, row = 0, away = 0;
      for (const j of list) {
        j.dk = GI.dayKey(new Date(j.s));
        j.key = drv + "|" + j.s;
        j.span = (j.e - j.s) / H;
        j.dh = GI.sum(j.trips, t => t.dh); j.km = GI.sum(j.trips, t => t.km);
        j.devices = [...new Set(j.trips.map(t => t.d))];
        // tiradas de manejo continuo (pausas < 15 min no cortan)
        let st = 0, stS = null, lastE = null, maxStint = 0, maxStintS = null, maxStintE = null;
        const pauses = [];
        for (const t of j.trips) {
          if (lastE != null && t.s - lastE >= 15 * MIN) { pauses.push([lastE, t.s]); st = 0; stS = null; }
          if (stS == null) stS = t.s;
          st += t.dh;
          if (st > maxStint) { maxStint = st; maxStintS = stS; maxStintE = t.e; }
          lastE = t.e;
        }
        j.maxStint = maxStint; j.maxStintRange = [maxStintS, maxStintE]; j.pauses = pauses;
        // manejo de madrugada: horas de los viajes (proporcional al manejo) en 00–06 y 02–05
        j.night = 0; j.low = 0;
        for (const t of j.trips) {
          const len = (t.e - t.s) / H || 1, f = t.dh / len;
          j.night += overlapHours(t.s, t.e, 0, 6) * f;
          j.low += overlapHours(t.s, t.e, 2, 5) * f;
        }
        j.type = nightFrac(j.s, j.e) >= 0.5 ? "noche" : "día";
        if (prev) {
          j.prevS = prev.s; j.prevE = prev.e;
          j.restBefore = (j.s - prev.e) / H;
          j.restDayFrac = j.restBefore > 0 ? overlapHours(prev.e, j.s, 8, 19) / j.restBefore : 0;
          j.prevType = prev.type;
          const gap = Math.round((GI.parseDayKey(j.dk) - GI.parseDayKey(prev.dk)) / 86400000);
          row = gap === 1 ? row + 1 : gap === 0 ? row : 1;
          // dónde descansó y si fue con el motor en marcha
          const lt = prev.trips[prev.trips.length - 1];
          j.restPlace = placeAt(lt.x, lt.y);
          j.restMicro = (microByDrv.get(drv) || []).filter(t => t.s >= prev.e && t.e <= j.s);
          // el motor en marcha cuenta solo mientras el vehículo siguió con él (si lo tomó otro conductor, no es su descanso en la cabina)
          const ou = j.restBefore < 48 ? otherUse(lt.d, prev.e, j.s, drv) : null;
          j.restHandover = ou ? { drv: ou.r || null, at: ou.s, d: lt.d } : null;
          j.restIdle = j.restBefore < 48 ? idleIn(lt.d, prev.e, ou ? ou.s : j.s, drv) : [];
          // un movimiento mínimo de más de 5 min también es motor en marcha durante el descanso
          for (const t of j.restMicro) if (t.e - t.s >= 5 * MIN && !j.restIdle.some(([a, b]) => a < t.e && b > t.s)) j.restIdle.push([t.s, t.e]);
          j.restIdle.sort((a, b) => a[0] - b[0]);
          j.restIdleH = GI.sum(j.restIdle, ([a, b]) => (b - a) / H);
          j.restEngine = j.restIdleH >= 1 && j.restIdleH >= 0.25 * j.restBefore;
          away = j.restPlace && j.restPlace.kind !== "base" && j.restBefore < 48 ? away + 1 : 0;
          j.awayRow = away;
          j.rotation = prev.type !== j.type && j.restBefore < 24 ? (j.type === "día" ? "atras" : "adelante") : null;
          j.afterOff = j.restBefore >= 36;
        } else row = 1;
        j.daysRow = row;
        if (rs) { const di = dayIdx(GI.dayKey(j.s)), b = rs.blockOf(di); if (b) { j.cycleDay = di - b.start + 1; j.offBefore = di === b.start ? b.offBefore : null; } }
        // esperas: cortes de 1 h o más dentro de la jornada, con el lugar
        j.waits = [];
        for (let k = 1; k < j.trips.length; k++) {
          const a = j.trips[k - 1], b = j.trips[k];
          if (b.s - a.e >= H) j.waits.push({ a: a.e, b: b.s, h: (b.s - a.e) / H, place: placeAt(a.x, a.y), idleH: GI.sum(idleIn(a.d, a.e, b.s), ([x, y]) => (y - x) / H) });
        }
        // eventos de cámara/ADAS de fatiga en la jornada (hasta 30 min después del último corte)
        const cam = (camByDrv.get(drv) || []).filter(e => e.t >= j.s - 5 * MIN && e.t <= j.e + 30 * MIN);
        let cluster = 0, clusterAt = null;
        for (let a = 0, b = 0; b < cam.length; b++) {
          while (cam[b].t - cam[a].t > 60 * MIN) a++;
          if (b - a + 1 > cluster) { cluster = b - a + 1; clusterAt = [cam[a].t, cam[b].t]; }
        }
        j.cam = cam; j.camCluster = cluster; j.camClusterAt = clusterAt;
        j.events = (evByDrv.get(drv) || []).filter(e => e.t >= j.s - 5 * MIN && e.t <= j.e + 30 * MIN);
        // señales
        const sg = [];
        const add = (key, w, text) => sg.push({ key, w, text, label: SIGNALS.find(x => x.key === key).label });
        if (j.span > fz.max_span) add("larga", 1, GI.fmtNum(j.span, 1) + " h de jornada (límite " + fz.max_span + " h)");
        if (j.dh > fz.max_drive_day) add("manejo", 1, GI.fmtNum(j.dh, 1) + " h de manejo (límite " + fz.max_drive_day + " h)");
        if (j.maxStint > fz.max_continuous) add("continuo", 1, GI.fmtNum(j.maxStint, 1) + " h de manejo sin una pausa de 15 min (límite " + fz.max_continuous + " h)");
        if (j.low >= 0.5) add("madrugada", 1, GI.fmtNum(j.low, 1) + " h de manejo entre las 02 y las 05 h");
        if (prev && j.prevType !== j.type && j.restBefore < 24) add("cambio", 1, "pasó de turno " + j.prevType + " a turno " + j.type + " con un solo descanso de " + GI.fmtNum(j.restBefore, 1) + " h" + (j.rotation === "atras" ? " (rotación hacia atrás, de noche a día: la que más cuesta)" : ""));
        if (prev && j.type === "noche" && j.afterOff) add("francos", 1, "primer turno noche después de " + GI.fmtNum(j.restBefore / 24, 1) + " días de franco (el cuerpo viene acostumbrado a dormir de noche)");
        if (prev && j.restBefore < 48 && (j.restBefore < fz.min_rest || (j.type === "noche" && j.restDayFrac >= 0.7)))
          add("descanso", 1, j.restBefore < fz.min_rest ? "descanso previo de " + GI.fmtNum(j.restBefore, 1) + " h (mínimo " + fz.min_rest + " h)" : "descanso previo de " + GI.fmtNum(j.restBefore, 1) + " h, casi todo de día, antes de un turno noche");
        if (prev && j.restEngine) add("motor", 1, GI.fmtNum(j.restIdleH, 1) + " h del descanso previo con el motor en marcha (probablemente durmió en la cabina)" + (j.restPlace ? ", en " + j.restPlace.name : ""));
        if (j.awayRow >= 3) add("lejos", 1, j.awayRow + " descansos seguidos fuera de la base" + (j.restPlace ? " (el último en " + j.restPlace.name + ")" : ""));
        if (rs && rs.work) {
          if (j.cycleDay > rs.work + 1) add("seguidos", 1, "día " + j.cycleDay + " de la vuelta: su diagrama es " + rs.label + (rs.source === "auto" ? " (detectado)" : ""));
          if (j.offBefore != null && rs.off && j.offBefore < rs.off - 1) add("franco", 1, "volvió después de " + j.offBefore + " días de franco; su diagrama es " + rs.label);
        } else if (j.daysRow > fz.max_days_row) add("seguidos", 1, j.daysRow + " días seguidos de trabajo (máximo " + fz.max_days_row + ")");
        j.signals = sg;
        // jornada en curso: el último viaje terminó hace menos de la pausa que cierra la jornada
        j.open = o.now - j.e < fz.SPLIT && o.now >= j.e - 60000;
        j.live = j.trips.some(t => t.live);
        shifts.push(j);
        prev = j;
      }
      // índice de fatiga estimado: serie del conductor y máximo de cada jornada
      const sim = simulateDriver(list, o.now);
      // "fuera de base" solo si sabemos cuál es su base (descansó ahí alguna vez en el período)
      const knowsBase = list.some(j => j.restPlace && j.restPlace.kind === "base");
      for (const j of list) {
        // sin base conocida, o con diagrama por vueltas (vive en la operación), "fuera de base" no aplica
        if (!knowsBase || (rs && rs.work)) j.signals = j.signals.filter(x => x.key !== "lejos");
        j.sim = sim;
        j.fiLevel = fiLevel(j.fiPeak, fz);
        if (j.fiPeak >= fz.fi_high) j.signals.push({ key: "indice", w: 1, label: "Índice de fatiga alto", text: "el índice de fatiga estimado llegó a " + Math.round(j.fiPeak) + " a las " + new Date(j.fiPeakAt).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false }) + " (alto desde " + fz.fi_high + ")" });
        j.score = GI.sum(j.signals, x => x.w);
        j.level = j.score >= 3 ? "alto" : j.score === 2 ? "medio" : "bajo";
      }
      sims.set(drv, { sim, list, rs, next: nextShiftRisk(list, sim, fz, o.now, rs), rot: rotationSummary(list) });
    }
    shifts.sort((a, b) => b.s - a.s);
    return { shifts, limits: fz, sims };
  }


  // ---------- Diagramas de trabajo (14x7, 7x7, 21x7…) ----------
  // Se detectan de los viajes: bloques de días trabajados separados por 3 o más
  // días sin trabajar (un día suelto sin viajes no corta la vuelta). El diagrama
  // es la mediana de las vueltas completas y de los francos. También se puede
  // fijar a mano por conductor (manual = { work, off }).
  const dayIdx = dk => Math.round(GI.parseDayKey(dk).getTime() / 86400000);
  function rosterOf(list, now, manual) {
    const days = [...new Set(list.map(j => dayIdx(GI.dayKey(j.s))))].sort((a, b) => a - b);
    if (!days.length) return null;
    const blocks = [];
    for (const d of days) {
      const b = blocks[blocks.length - 1];
      if (b && d - b.end - 1 < 3) { b.end = d; b.n++; } else blocks.push({ start: d, end: d, n: 1, offBefore: b ? d - b.end - 1 : null });
    }
    const today = dayIdx(GI.dayKey(now));
    const last = blocks[blocks.length - 1];
    const lastDone = today - last.end >= 3;
    // vueltas completas: sin la primera (puede empezar antes del período) ni la última si sigue
    const done = blocks.slice(1, lastDone ? blocks.length : blocks.length - 1);
    const offs = blocks.slice(1).map(b => b.offBefore);
    let work = null, off = null, source = null;
    if (manual && manual.none) { /* fijado a mano: sin diagrama */ }
    else if (manual && manual.work > 0) { work = manual.work; off = manual.off || 0; source = "manual"; }
    else if (done.length >= 2 && offs.length >= 2) {
      // solo si las vueltas y los francos son parejos (si no, es trabajo irregular, no un diagrama)
      const lens = done.map(b => b.end - b.start + 1), W = GI.median(lens), O = GI.median(offs);
      const near = (arr, m) => arr.filter(v => Math.abs(v - m) <= Math.max(2, 0.2 * m)).length / arr.length;
      if (W >= 4 && O >= 3 && near(lens, W) >= 0.7 && near(offs, O) >= 0.7) { work = Math.round(W); off = Math.round(O); source = "auto"; }
    }
    const curDay = today - last.start + 1;
    const lenLast = last.end - last.start + 1;
    // de franco: terminó una vuelta (o lleva 2 días sin trabajar al final de ella)
    let inFranco = !!work && today > last.end && (lastDone || (lenLast >= work - 1 && today - last.end >= 1));
    if (inFranco && today >= last.end + off + 1) inFranco = false; // ya pasó su franco y no volvió: no es franco
    const backDay = inFranco ? last.end + off + 1 : null;
    return { work, off, source, blocks, cycles: done.length, curDay, inFranco, backAt: backDay != null ? backDay * 86400000 + new Date(backDay * 86400000).getTimezoneOffset() * 60000 : null,
      label: work ? work + "x" + off : null, blockOf: d => blocks.find(b => d >= b.start && d <= b.end) };
  }

  // Rotación de turnos del conductor: cambios día ↔ noche, hacia atrás (noche →
  // día con un solo descanso), primeras noches tras francos y cuánto varía la
  // hora de inicio entre jornadas seguidas (desvío circular, en horas).
  function rotationSummary(list) {
    const done = list.filter(j => !j.open);
    let changes = 0, back = 0, fwd = 0, afterOff = 0;
    for (const j of done) { if (j.rotation) { changes++; if (j.rotation === "atras") back++; else fwd++; } if (j.type === "noche" && j.afterOff) afterOff++; }
    let sx = 0, sy = 0;
    for (const j of done) { const a = (hourOf(j.s) / 24) * 2 * Math.PI; sx += Math.cos(a); sy += Math.sin(a); }
    const R = done.length ? Math.sqrt(sx * sx + sy * sy) / done.length : 1;
    const startSd = done.length >= 3 ? (Math.sqrt(-2 * Math.log(Math.max(1e-9, R))) * 24) / (2 * Math.PI) : null;
    const nights = done.filter(j => j.type === "noche").length;
    return { n: done.length, changes, back, fwd, afterOff, startSd, nightPct: done.length ? nights / done.length : 0 };
  }

  // Viajes para "Ahora": los del período hasta hace `hours`, los recientes
  // traídos en vivo y, si el vehículo está manejando, un viaje en curso.
  function liveTrips(model, recent, status, hours, now) {
    const cut = now - hours * H;
    const by = new Map();
    const push = t => { if (!by.has(t.d)) by.set(t.d, []); by.get(t.d).push(t); };
    for (const [, trips] of model.tripsByDevice) for (const t of trips) if (t.s < cut) push(t);
    for (const t of recent || []) if (t.s >= cut) push(t);
    for (const arr of by.values()) arr.sort((a, b) => a.s - b.s);
    for (const st of status || []) {
      if (!st.driving || !(st.since < now)) continue;
      const arr = by.get(st.d) || [];
      const last = arr[arr.length - 1];
      if (last && last.e > st.since) continue; // el viaje ya está registrado
      const r = st.r || (last && st.since - last.e < H ? last.r : null);
      if (!r) continue;
      push({ d: st.d, r, s: st.since, e: now, dh: (now - st.since) / H, km: 0, live: true });
    }
    return by;
  }

  // Avance de una jornada abierta contra los límites, con proyección.
  function shiftProgress(j, fz, now) {
    const spanNow = (now - j.s) / H;
    const ratio = spanNow > 0.5 ? j.dh / spanNow : 0.6; // fracción del tiempo que maneja
    const lastE = j.trips[j.trips.length - 1].e;
    const driving = j.trips[j.trips.length - 1].live;
    const sinceLast = driving ? 0 : (now - lastE) / MIN;
    // tirada continua actual (si el último viaje terminó hace menos de 15 min)
    let stint = 0;
    if (driving || sinceLast < 15) {
      for (let i = j.trips.length - 1; i >= 0; i--) {
        stint += j.trips[i].dh;
        if (i > 0 && j.trips[i].s - j.trips[i - 1].e >= 15 * MIN) break;
      }
    }
    const eta = (remaining, rate) => (remaining <= 0 ? now : rate > 0 ? now + (remaining / rate) * H : null);
    const items = [
      { key: "span", label: "Jornada", v: spanNow, max: fz.max_span, at: j.s + fz.max_span * H },
      { key: "drive", label: "Manejo", v: j.dh, max: fz.max_drive_day, at: eta(fz.max_drive_day - j.dh, ratio) },
      { key: "stint", label: "Manejo continuo", v: stint, max: fz.max_continuous, at: stint > 0 ? eta(fz.max_continuous - stint, 1) : null },
    ].map(x => Object.assign(x, { at: x.at && x.key !== "span" && (x.at > j.s + fz.max_span * H || (!driving && sinceLast > 60)) ? null : x.at })).map(x => Object.assign(x, { pct: x.max > 0 ? x.v / x.max : 0, level: x.v >= x.max ? "rojo" : x.v >= 0.8 * x.max ? "amarillo" : "ok" }));
    // ¿va a manejar en la franja 02–05 h? (turno noche que todavía no llegó a las 02)
    const hNow = new Date(now).getHours();
    const nightAhead = j.type === "noche" && (hNow >= 18 || hNow < 2);
    const worst = items.some(x => x.level === "rojo") ? "rojo" : items.some(x => x.level === "amarillo") ? "amarillo" : "ok";
    return { spanNow, sinceLast, stint, items, nightAhead, worst, driving };
  }



  // ---------- Proyección del índice (Seguimiento) ----------
  // Curva de las próximas horas: si está en jornada, sigue trabajando al ritmo
  // que lleva hasta completar su jornada habitual y después descansa; si está
  // descansando, descansa hasta su próximo arranque habitual y hace su jornada
  // habitual. Devuelve la curva, cuándo cruzaría el umbral alto y la acción.
  function projectIndex(entry, fz, now, horizonH) {
    useParams(fz.P);
    const { list, sim, rs } = entry;
    if (!sim || !list.length) return null;
    const hz = (horizonH || 16) * H;
    const last = list[list.length - 1];
    const open = last.open ? last : null;
    const hb = habitual(list) || { span: fz.max_span, dh: fz.max_drive_day * 0.8, startMin: Math.round(hourOf(last.s) * 60), type: last.type };
    let F = sim.at(now - 1);
    const pts = [[now, F]];
    let crossAt = F >= fz.fi_high ? now : null, peak = F, peakAt = now;
    const step = (t, working, df) => {
      F = fiStep(F, t, working, df, FI.step / H);
      pts.push([t + FI.step, F]);
      if (F > peak) { peak = F; peakAt = t + FI.step; }
      if (crossAt == null && F >= fz.fi_high) crossAt = t + FI.step;
    };
    let workEnd, nextStart = null;
    if (open) {
      const spanNow = (now - open.s) / H;
      const df = spanNow > 0.5 ? Math.min(1, open.dh / spanNow) : 0.7;
      workEnd = Math.max(now, open.s + hb.span * H);
      for (let t = now; t < Math.min(workEnd, now + hz); t += FI.step) step(t, true, df);
      for (let t = workEnd; t < now + hz; t += FI.step) step(t, false, 0);
    } else {
      nextStart = nextAt(hb.startMin, Math.max(now, last.e + H, (rs && rs.inFranco && rs.backAt) || 0));
      const df = hb.span > 0 ? Math.min(1, hb.dh / hb.span) : 0.7;
      const nEnd = nextStart + hb.span * H;
      for (let t = now; t < now + hz; t += FI.step) step(t, t >= nextStart && t < nEnd, df);
    }
    const Fnow = pts[0][1];
    const next = open ? null : nextShiftRisk(list, sim, fz, now, rs);
    // acción sugerida
    let level = "ok", action;
    const hhmm = t => new Date(t).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
    const dayWord = t => (GI.dayKey(t) === GI.dayKey(now) ? "" : GI.dayKey(t) === GI.dayKey(now + 86400000) ? "mañana " : new Date(t).toLocaleDateString("es-AR", { weekday: "short" }) + " ");
    if (open) {
      if (Fnow >= fz.fi_high) { level = "rojo"; action = "Cortar la jornada: el índice ya está en " + Math.round(Fnow); }
      else if (crossAt && crossAt <= workEnd) { level = "amarillo"; action = "Llega a " + fz.fi_high + " a las " + hhmm(crossAt) + ": programar relevo o pausa larga antes"; }
      else if (Fnow >= fz.fi_mod) { level = "amarillo"; action = "Índice moderado: evitar extender la jornada"; }
      else action = "Puede completar su jornada habitual";
    } else if (next) {
      if (next.peak >= fz.fi_high) {
        level = next.restAtStart < (next.needRest || Infinity) ? "rojo" : "amarillo";
        action = next.needRest == null ? "Acortar su próxima jornada: con la habitual pasa de " + fz.fi_high
          : next.restAtStart < next.needRest ? "No asignar antes de " + dayWord(next.lastE + next.needRest * H) + "las " + hhmm(next.lastE + next.needRest * H) + " (necesita " + GI.fmtNum(next.needRest, 1) + " h de descanso)"
          : "Próximo turno alto (" + Math.round(next.peak) + "): evitar madrugada y jornadas largas";
      } else if (next.peak >= fz.fi_mod) { level = "amarillo"; action = "Próximo turno moderado (" + Math.round(next.peak) + ")"; }
      else action = "Sin riesgo para su próximo turno";
    } else action = "Sin datos suficientes";
    if (!open && rs && rs.inFranco && level !== "rojo") { level = "ok"; action = "De franco hasta " + (rs.backAt ? new Date(rs.backAt).toLocaleDateString("es-AR", { weekday: "short", day: "numeric", month: "short" }) : "–") + " (" + rs.label + ")"; }
    return { pts, Fnow, crossAt, peak, peakAt, open, next, nextStart, workEnd, hb, level, action, rs, franco: !open && !!(rs && rs.inFranco), risk: Math.max(peak, next ? next.peak : 0) };
  }

  // ---------- Validación del índice contra eventos de cámara ----------
  const FI_BANDS = ["bajo", "moderado", "alto", "muy alto"];
  // Horas de manejo, km y eventos según la franja del índice en ese momento.
  // Eventos "de fatiga" = categorías de cámara (bostezo, distracción, carril);
  // "otros" = el resto de las infracciones de riesgo (control).
  function fiExposure(res, fz) {
    const bands = FI_BANDS.map(key => ({ key, hours: 0, km: 0, cam: 0, other: 0, byCat: {} }));
    const bins = []; // por 10 puntos: { h, n } para el ajuste
    const bin = F => { const i = Math.min(25, Math.max(0, Math.floor(F / 10))); return bins[i] || (bins[i] = { F: i * 10 + 5, h: 0, n: 0, c: {} }); };
    const bOf = F => FI_BANDS.indexOf(fiLevel(F, fz));
    for (const { list, sim } of res.sims.values()) {
      if (!sim) continue;
      for (const j of list) {
        for (const t of j.trips) {
          const len = t.e - t.s;
          if (!(len > 0)) continue;
          for (let a = t.s; a < t.e; a += 15 * MIN) {
            const b = Math.min(t.e, a + 15 * MIN), f = (b - a) / len, F = sim.at((a + b) / 2);
            const x = bands[bOf(F)];
            x.hours += t.dh * f; x.km += t.km * f; bin(F).h += t.dh * f;
          }
        }
        for (const e of j.cam || []) { const F = sim.at(e.t), x = bands[bOf(F)]; x.cam++; x.byCat[e.cat] = (x.byCat[e.cat] || 0) + 1; const bb = bin(F); bb.n++; bb.c[e.cat] = (bb.c[e.cat] || 0) + 1; }
        for (const e of j.events || []) if (!CAM_CATS.has(e.cat)) bands[bOf(sim.at(e.t))].other++;
      }
    }
    const B = bins.filter(Boolean);
    // los mismos tramos, con los eventos de un solo tipo (para ver qué tipo acompaña al índice)
    const binsOf = cat => B.map(x => ({ F: x.F, h: x.h, n: x.c[cat] || 0 }));
    return { bands, bins: B, binsOf, cam: GI.sum(bands, x => x.cam), hours: GI.sum(bands, x => x.hours) };
  }
  // Ajuste de Poisson: eventos por hora = exp(a + b·F/100). Devuelve b y la
  // log-verosimilitud (para comparar juegos de coeficientes con los mismos datos).
  function poissonFit(bins) {
    const B = bins.filter(x => x.h > 0);
    const N = GI.sum(B, x => x.n), Ht = GI.sum(B, x => x.h);
    if (!(N > 0) || !(Ht > 0)) return null;
    let a = Math.log(N / Ht), b = 0;
    for (let it = 0; it < 40; it++) {
      let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
      for (const x of B) { const z = x.F / 100, mu = x.h * Math.exp(a + b * z); ga += x.n - mu; gb += (x.n - mu) * z; haa += mu; hab += mu * z; hbb += mu * z * z; }
      const det = haa * hbb - hab * hab;
      if (!(det > 1e-12)) break;
      const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
      a += da; b += db;
      if (Math.abs(da) + Math.abs(db) < 1e-9) break;
    }
    let ll = 0, se = null;
    let hbb = 0, haa = 0, hab = 0;
    for (const x of B) { const z = x.F / 100, mu = x.h * Math.exp(a + b * z); ll += x.n * Math.log(mu) - mu; haa += mu; hab += mu * z; hbb += mu * z * z; }
    const det = haa * hbb - hab * hab;
    if (det > 0) se = Math.sqrt(haa / det);
    return { a, b, se, ll, n: N, hours: Ht };
  }
  // Índice al final de una jornada diurna típica (06–16 h, 5 días): para que
  // los umbrales 80/100 sigan significando lo mismo con otros coeficientes.
  function refPeak(P) {
    const prev = FI; useParams(P);
    const base = new Date(2026, 0, 5).getTime(), list = [];
    for (let d = 0; d < 5; d++) {
      let t = base + d * 86400000 + 6 * H; const trips = [];
      for (const [du, pa] of [[3, 0.5], [3, 0.75], [2.5, 0]]) { trips.push({ s: t, e: t + du * H, dh: du, km: du * 70 }); t += (du + pa) * H; }
      list.push({ s: trips[0].s, e: trips[2].e, trips });
    }
    simulateDriver(list);
    FI = prev;
    return list[4].fiPeak;
  }
  const REF_DAY = 67;
  function scaled(P) { const k = REF_DAY / refPeak(P); return Object.assign({}, P, { drive: GI.round(P.drive * k, 3), work: GI.round(P.work * k, 3) }); }
  // Busca los coeficientes que mejor separan los eventos de cámara (asincrónico, con avance).
  async function calibrateIndex(model, ids, driverOk, onProgress) {
    const grid = [];
    for (const amp of [0, 0.15, 0.3, 0.45]) for (const recNight of [0.1, 0.16, 0.24]) for (const dayR of [0.25, 0.45, 0.7]) for (const wr of [0.4, 0.1])
      grid.push(scaled({ drive: 5, work: 5 * wr, amp, recNight, recDay: GI.round(recNight * dayR, 4), recNap: GI.round(recNight * Math.min(1, dayR * 1.4), 4) }));
    const fz0 = fatigueLimits(model.settings);
    const fit = P => {
      const settings = Object.assign({}, model.settings, { fatigue: Object.assign({}, model.settings.fatigue, { fi_params: P }) });
      const res = buildShifts(Object.assign({}, model, { settings }), ids, driverOk);
      const ex = fiExposure(res, res.limits);
      return { P, ex, fit: poissonFit(ex.bins) };
    };
    const current = fit(fz0.P);
    let best = current;
    for (let i = 0; i < grid.length; i++) {
      const r = fit(grid[i]);
      if (r.fit && (!best.fit || r.fit.ll > best.fit.ll)) best = r;
      if (onProgress) onProgress((i + 1) / grid.length);
      await new Promise(ok => setTimeout(ok, 0));
    }
    useParams(fz0.P);
    return { current, best, tried: grid.length };
  }

  Object.assign(GI, { rosterOf, projectIndex, FI_DEFAULT, FI_BANDS, fiExposure, poissonFit, calibrateIndex, FATIGUE_SIGNALS: SIGNALS, FATIGUE_CAM_CATS: CAM_CATS, buildShifts, isMicro, shiftProgress, liveTrips, fatigueLimits, fiLevel, openShiftIndex, nextShiftRisk, _fat: { overlapHours, nightFrac, circ, fiWork, fiRest, simulateDriver, habitual } });
})(window.GI);
