// Catálogo de categorías, sugerencia automática regla -> categoría y la
// configuración por defecto que se guarda en AddInData.
(function (GI) {
  "use strict";

  // Categorías por defecto. Son editables (Configuración → Categorías): se
  // pueden renombrar, agregar o quitar. kind: "riesgo" suma al índice de
  // riesgo y se muestra en Seguridad; "operativo" no.
  const DEFAULT_CATEGORIES = [
    { key: "velocidad", label: "Exceso de velocidad", kind: "riesgo", weight: 1.5 },
    { key: "cinturon", label: "Cinturón de seguridad", kind: "riesgo", weight: 1.5 },
    { key: "telefono", label: "Uso de celular", kind: "riesgo", weight: 1.6 },
    { key: "distraccion", label: "Distracción", kind: "riesgo", weight: 1.4 },
    { key: "frenado_brusco", label: "Frenado brusco", kind: "riesgo", weight: 1.3 },
    { key: "aceleracion_brusca", label: "Aceleración brusca", kind: "riesgo", weight: 1.2 },
    { key: "giro_brusco", label: "Giro brusco", kind: "riesgo", weight: 1.2 },
    { key: "colision", label: "Colisión / casi colisión", kind: "riesgo", weight: 2.0 },
    { key: "distancia", label: "Conducción cercana (distancia)", kind: "riesgo", weight: 1.4 },
    { key: "fatiga", label: "Fatiga / bostezo", kind: "riesgo", weight: 1.5 },
    { key: "salida_carril", label: "Salida de carril / doble línea", kind: "riesgo", weight: 1.3 },
    { key: "fumar_comer", label: "Fumar / comer / beber", kind: "riesgo", weight: 0.8 },
    { key: "reversa", label: "Marcha atrás", kind: "riesgo", weight: 0.6 },
    { key: "camara", label: "Cámara obstruida / manipulada", kind: "riesgo", weight: 1.0 },
    { key: "ralenti", label: "Ralentí", kind: "operativo", weight: 0 },
    { key: "operativo", label: "Otro operativo (ruta, zonas, horario)", kind: "operativo", weight: 0 },
  ];

  // Colores de gráficos: paleta categórica validada para daltonismo (8
  // tonos, en este orden: tonos vecinos en una pila se distinguen). Se asigna
  // a las primeras 8 categorías de riesgo según el orden de la configuración;
  // el resto se agrupa como "Otras" en gris.
  const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
  const OTHER_COLOR = "#9a9893";
  const SERIES_COLORS = PALETTE;

  // Estado vivo (se reemplaza en el lugar con applyCategories).
  const CATEGORIES = [];
  const CATEGORY_BY_KEY = {};
  const CHART_SLOTS = [];

  function applyCategories(list) {
    const src = list && list.length ? list : DEFAULT_CATEGORIES;
    CATEGORIES.length = 0;
    CHART_SLOTS.length = 0;
    for (const k of Object.keys(CATEGORY_BY_KEY)) delete CATEGORY_BY_KEY[k];
    let slot = 0;
    for (const c of src) {
      const color = c.kind === "riesgo" && slot < PALETTE.length ? PALETTE[slot] : OTHER_COLOR;
      if (c.kind === "riesgo" && slot < PALETTE.length) { CHART_SLOTS.push(c.key); slot++; }
      const cat = { key: c.key, label: c.label, kind: c.kind, weight: c.weight != null ? c.weight : 1, color };
      CATEGORIES.push(cat);
      CATEGORY_BY_KEY[c.key] = cat;
    }
  }
  applyCategories(DEFAULT_CATEGORIES);

  // Reglas stock de Geotab -> categoría.
  const STOCK_RULES = {
    RulePostedSpeedingId: "velocidad", RuleGpsSpeedingWindowId: "velocidad", RuleSpeedingId: "velocidad",
    RuleHarshBrakingId: "frenado_brusco", RuleHarshGpsBrakingId: "frenado_brusco",
    RuleJackrabbitStartsId: "aceleracion_brusca", RuleHarshGpsAccelerationId: "aceleracion_brusca",
    RuleHarshCorneringId: "giro_brusco", RuleHarshGpsCorneringId: "giro_brusco",
    RuleSeatbeltId: "cinturon", RuleCameraDetectedDriverSeatbeltId: "cinturon",
    RulePhoneUsageId: "telefono", RuleDistractionId: "distraccion",
    RuleDriverFatigueId: "fatiga", RuleDriverYawningId: "fatiga", RuleDriverEyeRubbingId: "fatiga",
    RuleFollowingDistanceId: "distancia", RuleTailgatingId: "distancia",
    RuleNearCollisionWarningId: "colision", RuleAccidentId: "colision",
    RuleEnhancedMajorCollisionId: "colision", RuleEnhancedMinorCollisionId: "colision",
    RuleDoubleSolidLineViolationId: "salida_carril", RuleLaneDepartureId: "salida_carril",
    RuleSmokingId: "fumar_comer", RuleDrinkingOrEatingId: "fumar_comer",
    RuleReverseAtStartId: "reversa",
    RuleCameraLensObstructionId: "camara", RuleCameraTamperingId: "camara",
    RuleIdlingId: "ralenti", RuleFleetIdlingId: "ralenti", RulePreventableIdlingId: "ralenti",
  };

  // Por nombre (reglas custom, incluidas las SRF_ de Surfsight). Orden importa.
  const NAME_PATTERNS = [
    [/colisi|collision|choque/i, "colision"],
    [/cercan|tailgat|following|distancia de seg/i, "distancia"],
    [/cintur|seat ?belt/i, "cinturon"],
    [/celular|tel[eé]fono|phone/i, "telefono"],
    [/distra/i, "distraccion"],
    [/fatiga|fatigue|bostez|yawn|somnol|ojos|conducci[oó]n\s*\d|continuous driving|driving time|horas de manejo/i, "fatiga"],
    [/velocidad|speed|exceso/i, "velocidad"],
    [/fren|brak/i, "frenado_brusco"],
    [/aceler|accel/i, "aceleracion_brusca"],
    [/giro|corner/i, "giro_brusco"],
    [/carril|lane|l[ií]nea/i, "salida_carril"],
    [/fuma|smok|comiend|bebiend|eating|drink/i, "fumar_comer"],
    [/reversa|marcha atr|revers|backing/i, "reversa"],
    [/lente|lens|c[aá]mara|camera|obstruc/i, "camara"],
    [/ralent|idl/i, "ralenti"],
    [/desv[ií]o|ruta|zona|espera|horario|after hours|lavadero|tiempo en/i, "operativo"],
  ];

  // Reglas que no conviene ni mostrar en el mapeo por defecto.
  const NOISE_RULE = /^dummy rule|\[test\]|\(test\)|\btest\b|\.test\b|^test[._ ]|#deprecated|application exception|adjustment required|late arrival|engine abuse/i;
  const NOISE_STOCK_IDS = new Set(["RuleApplicationExceptionId", "RuleRoadCameraAdjustmentRequiredId"]);

  function suggestCategory(rule) {
    const ok = k => (k && CATEGORY_BY_KEY[k] ? k : null);
    if (STOCK_RULES[rule.id]) return ok(STOCK_RULES[rule.id]);
    const name = rule.name || "";
    for (const [re, cat] of NAME_PATTERNS) if (re.test(name)) return ok(cat);
    return null;
  }

  // Reglas que se descargan: solo las mapeadas a una categoría de riesgo.
  function riskRuleIds(mapping) {
    return Object.keys(mapping || {}).filter(id => (CATEGORY_BY_KEY[mapping[id]] || {}).kind === "riesgo");
  }

  function isNoiseRule(rule) {
    return NOISE_STOCK_IDS.has(rule.id) || NOISE_RULE.test(rule.name || "") || rule.baseType === "ZoneStop";
  }

  // Tipos de vehículo por defecto: se detectan grupos por nombre. El orden
  // importa (un bitren suele estar también en "Pesados").
  const DEFAULT_VEHICLE_TYPES = [
    { key: "bitren", label: "Bitren", pattern: /bitren|bi-tren|b-train/i, l100: 0, idleLph: 3.0 },
    { key: "camion", label: "Camión / tractor", pattern: /pesad|cami[oó]n|tractor|semi|heavy|truck/i, l100: 0, idleLph: 2.5 },
    { key: "liviano", label: "Liviano", pattern: /livian|camioneta|utilitar|pick ?up|light|van\b/i, l100: 0, idleLph: 1.2 },
  ];

  function defaultVehicleTypes(groups) {
    return DEFAULT_VEHICLE_TYPES.map(t => ({
      key: t.key,
      label: t.label,
      groupIds: groups.filter(g => t.pattern.test(g.name || "")).map(g => g.id),
      idle_lph: t.idleLph,
    }));
  }

  const SERVICE_TYPES = [
    { key: "corta", label: "Corta distancia" },
    { key: "larga", label: "Larga distancia" },
  ];

  function defaultServiceGroups(groups) {
    const find = re => groups.filter(g => re.test(g.name || "")).map(g => g.id);
    return { corta: find(/corta/i), larga: find(/larga/i) };
  }

  // Combustibles con precio propio. Por defecto se usan los grupos de sistema
  // que MyGeotab asigna por VIN (Diesel / Gasoline or Petrol) más cualquier
  // grupo del cliente cuyo nombre lo indique.
  const FUEL_SYSTEM_GROUPS = { diesel: "GroupDieselId", nafta: "GroupGasolinePetrolId" };
  function defaultFuelTypes(groups) {
    const find = re => groups.filter(g => re.test(g.name || "") && !g.id.startsWith("Group")).map(g => g.id);
    return [
      { key: "diesel", label: "Diésel", price: 0, groupIds: [FUEL_SYSTEM_GROUPS.diesel, ...find(/diesel|di[eé]sel|gasoil|gas-oil/i)] },
      { key: "nafta", label: "Nafta", price: 0, groupIds: [FUEL_SYSTEM_GROUPS.nafta, ...find(/nafta|naftero|gasolina/i)] },
    ];
  }

  function profileKey(vtype, stype) { return vtype + "|" + stype; }

  // Objetivos por perfil (tipo de vehículo × tipo de servicio). 0 / null =
  // sin objetivo cargado -> se compara contra la mediana del propio perfil.
  function defaultProfileTargets(vehicleTypes) {
    const out = {};
    for (const vt of [...vehicleTypes, { key: "sin_tipo" }]) {
      for (const st of SERVICE_TYPES) {
        out[profileKey(vt.key, st.key)] = {
          l100: 0,
          idle_pct_max: st.key === "corta" ? 20 : 10,
          risk_max: st.key === "corta" ? 3 : 1.5,
        };
      }
    }
    return out;
  }

  function defaultSettings(groups, rules) {
    const vehicleTypes = defaultVehicleTypes(groups);
    // Las reglas arrancan sin categoría: las asigna el administrador. Las
    // sugerencias se muestran como ayuda en Configuración → Reglas.
    const ruleMapping = {};
    // Solo grupos "hoja" (o casi): un grupo de prueba que cuelga encima de
    // cientos de subgrupos reales no se excluye automáticamente.
    const byId = new Map(groups.map(g => [g.id, g]));
    const subtree = id => { const seen = new Set([id]); const q = [id]; while (q.length) { const g = byId.get(q.shift()); for (const c of (g && g.children) || []) { const cid = typeof c === "string" ? c : c && c.id; if (cid && !seen.has(cid)) { seen.add(cid); q.push(cid); } } } return seen.size; };
    const excluded = groups.filter(g => /fuera de servicio|baja|inactiv|prueba|test/i.test(g.name || "") && subtree(g.id) <= 5).map(g => g.id);
    return {
      version: 3,
      configured: false,
      rule_mapping: ruleMapping,
      categories: DEFAULT_CATEGORIES.map(c => ({ key: c.key, label: c.label, kind: c.kind })),
      category_weights: Object.fromEntries(DEFAULT_CATEGORIES.map(c => [c.key, c.weight])),
      rule_targets: {},
      scope_group_ids: [],
      excluded_group_ids: excluded,
      vehicle_types: vehicleTypes,
      service: {
        group_ids: defaultServiceGroups(groups),
        auto: true,
        threshold_km: 150,
      },
      profile_targets: defaultProfileTargets(vehicleTypes),
      fuel: { price_per_liter: 0, currency: "ARS", tolerance_pct: 10, types: defaultFuelTypes(groups), default_type: "diesel" },
      journeys: { break_hours: 10, min_km_route: 300, min_journeys_route: 3, min_stop_minutes: 20, zone_type_ids: [] },
      drivers: { min_km_ranking: 300, exclude_unknown: false },
      // Fatiga: valores de referencia, se ajustan a la política de la empresa.
      fatigue: { max_drive_day: 9, max_span: 12, min_rest: 8, max_continuous: 4, max_days_row: 6, rest_split: 4, fi_mod: 80, fi_high: 100 },
      // Gravedad: ponderar cada infracción por su duración (opcional).
      severity: { by_duration: false, per_minute: 0.5, max: 3, long_minutes: 1 },
      ui: { default_days: 90, default_granularity: "week", milestone_window_days: 28 },
      editors: [],
    };
  }

  Object.assign(GI, {
    CATEGORIES, CATEGORY_BY_KEY, CHART_SLOTS, OTHER_COLOR, SERIES_COLORS, DEFAULT_CATEGORIES, applyCategories, STOCK_RULES, SERVICE_TYPES,
    suggestCategory, isNoiseRule, riskRuleIds, defaultFuelTypes, FUEL_SYSTEM_GROUPS, defaultSettings, defaultProfileTargets, profileKey,
  });
})(window.GI);
