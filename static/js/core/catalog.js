// Catálogo de categorías, sugerencia automática regla -> categoría y la
// configuración por defecto que se guarda en AddInData.
(function (GI) {
  "use strict";

  // kind: "riesgo" suma al índice de riesgo; "operativo" no (ralentí, desvío
  // de ruta, tiempos en zona...). weight: peso por defecto en el índice.
  const CATEGORIES = [
    { key: "velocidad", label: "Exceso de velocidad", kind: "riesgo", weight: 1.5, color: "#ef4444" },
    { key: "frenado_brusco", label: "Frenado brusco", kind: "riesgo", weight: 1.3, color: "#f97316" },
    { key: "aceleracion_brusca", label: "Aceleración brusca", kind: "riesgo", weight: 1.2, color: "#f59e0b" },
    { key: "giro_brusco", label: "Giro brusco", kind: "riesgo", weight: 1.2, color: "#eab308" },
    { key: "cinturon", label: "Cinturón de seguridad", kind: "riesgo", weight: 1.5, color: "#8b5cf6" },
    { key: "telefono", label: "Uso de celular", kind: "riesgo", weight: 1.6, color: "#ec4899" },
    { key: "distraccion", label: "Distracción", kind: "riesgo", weight: 1.4, color: "#d946ef" },
    { key: "fatiga", label: "Fatiga / bostezo", kind: "riesgo", weight: 1.5, color: "#6366f1" },
    { key: "colision", label: "Colisión / casi colisión", kind: "riesgo", weight: 2.0, color: "#dc2626" },
    { key: "salida_carril", label: "Salida de carril / doble línea", kind: "riesgo", weight: 1.3, color: "#0ea5e9" },
    { key: "fumar_comer", label: "Fumar / comer / beber", kind: "riesgo", weight: 0.8, color: "#14b8a6" },
    { key: "reversa", label: "Marcha atrás", kind: "riesgo", weight: 0.6, color: "#64748b" },
    { key: "camara", label: "Cámara obstruida / manipulada", kind: "riesgo", weight: 1.0, color: "#94a3b8" },
    { key: "ralenti", label: "Ralentí", kind: "operativo", weight: 0, color: "#22c55e" },
    { key: "operativo", label: "Otro operativo (ruta, zonas, horario)", kind: "operativo", weight: 0, color: "#a3a3a3" },
  ];
  const CATEGORY_BY_KEY = Object.fromEntries(CATEGORIES.map(c => [c.key, c]));

  // Reglas stock de Geotab -> categoría.
  const STOCK_RULES = {
    RulePostedSpeedingId: "velocidad", RuleGpsSpeedingWindowId: "velocidad", RuleSpeedingId: "velocidad",
    RuleHarshBrakingId: "frenado_brusco", RuleHarshGpsBrakingId: "frenado_brusco",
    RuleJackrabbitStartsId: "aceleracion_brusca", RuleHarshGpsAccelerationId: "aceleracion_brusca",
    RuleHarshCorneringId: "giro_brusco", RuleHarshGpsCorneringId: "giro_brusco",
    RuleSeatbeltId: "cinturon", RuleCameraDetectedDriverSeatbeltId: "cinturon",
    RulePhoneUsageId: "telefono", RuleDistractionId: "distraccion",
    RuleDriverFatigueId: "fatiga", RuleDriverYawningId: "fatiga", RuleDriverEyeRubbingId: "fatiga",
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
    [/cintur|seat ?belt/i, "cinturon"],
    [/celular|tel[eé]fono|phone/i, "telefono"],
    [/distra/i, "distraccion"],
    [/fatiga|fatigue|bostez|yawn|somnol|ojos/i, "fatiga"],
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
  const NOISE_RULE = /^dummy rule|\[test\]|\(test\)|\btest\b|application exception|adjustment required|late arrival|engine abuse/i;
  const NOISE_STOCK_IDS = new Set(["RuleApplicationExceptionId", "RuleRoadCameraAdjustmentRequiredId"]);

  function suggestCategory(rule) {
    if (STOCK_RULES[rule.id]) return STOCK_RULES[rule.id];
    const name = rule.name || "";
    for (const [re, cat] of NAME_PATTERNS) if (re.test(name)) return cat;
    return null;
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
    const ruleMapping = {};
    for (const r of rules) {
      if (isNoiseRule(r)) continue;
      const cat = suggestCategory(r);
      if (cat) ruleMapping[r.id] = cat;
    }
    const excluded = groups.filter(g => /fuera de servicio|baja|inactiv|prueba|test/i.test(g.name || "")).map(g => g.id);
    return {
      version: 3,
      configured: false,
      rule_mapping: ruleMapping,
      category_weights: Object.fromEntries(CATEGORIES.map(c => [c.key, c.weight])),
      scope_group_ids: [],
      excluded_group_ids: excluded,
      vehicle_types: vehicleTypes,
      service: {
        group_ids: defaultServiceGroups(groups),
        auto: true,
        threshold_km: 150,
      },
      profile_targets: defaultProfileTargets(vehicleTypes),
      fuel: { price_per_liter: 0, currency: "ARS", tolerance_pct: 10 },
      journeys: { break_hours: 10, min_km_route: 300, min_journeys_route: 3 },
      drivers: { min_km_ranking: 300 },
      ui: { default_days: 90, default_granularity: "week", milestone_window_days: 28 },
      editors: [],
    };
  }

  Object.assign(GI, {
    CATEGORIES, CATEGORY_BY_KEY, STOCK_RULES, SERVICE_TYPES,
    suggestCategory, isNoiseRule, defaultSettings, defaultProfileTargets, profileKey,
  });
})(window.GI);
