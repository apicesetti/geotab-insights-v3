// Configuración e hitos compartidos por todos los usuarios de la base,
// guardados en AddInData (Storage API de MyGeotab) bajo el id del add-in.
//
// - settings: un único JSON. AddInData limita el tamaño de "details", así
//   que se parte en chunks de texto ({kind:"settings", rev, part, parts,
//   chunk}). Al guardar se escriben todas las partes con un rev nuevo y
//   recién después se borran las del rev anterior: si algo falla a mitad de
//   camino, la versión vieja sigue completa y es la que se lee.
// - milestone: un registro por hito ({kind:"milestone", ...}).
//
// La restricción de edición (solo administradores) es de la interfaz: la
// Storage API no permite limitar escritura por usuario.
//
// Visibilidad: AddInData se rige por grupos como cualquier entidad. Un
// usuario cuyo acceso a datos es un subgrupo NO ve un registro guardado solo
// en el grupo de la empresa. Por eso cada registro se guarda en el grupo de
// la empresa + todos los grupos de acceso de los usuarios de la base.
(function (GI) {
  "use strict";

  const ADDIN_ID = "a2jBAg7PpaFdQpimkOJ7Ajg";
  const CHUNK_SIZE = 8000;
  const ACCESS_GROUPS = [{ id: "GroupCompanyId" }];

  // Grupos de acceso a datos de todos los usuarios (los "companyGroups").
  // Requiere permiso para ver usuarios: lo usa el administrador al guardar.
  // Árbol de grupos: hijo -> padre (para saber quién contiene a quién).
  async function groupParents(api) {
    const groups = (await api.call("Get", { typeName: "Group", propertySelector: { fields: ["id", "children"], isIncluded: true } })) || [];
    const parent = new Map();
    for (const g of groups) for (const c of g.children || []) { const cid = GI.idOf(c); if (cid && !parent.has(cid)) parent.set(cid, g.id); }
    return parent;
  }
  function ancestorsOf(id, parent) {
    const out = [];
    const seen = new Set([id]);
    let cur = parent.get(id);
    while (cur && !seen.has(cur)) { out.push(cur); seen.add(cur); cur = parent.get(cur); }
    return out;
  }
  // MyGeotab no acepta guardar un registro en dos grupos donde uno contiene
  // al otro. Un usuario ve el registro si está en su grupo de acceso o en
  // algún subgrupo, así que alcanza con quedarse con los grupos "más
  // profundos": se descarta todo grupo que contenga a otro de la lista.
  function deepestOnly(ids, parent) {
    const set = new Set(ids);
    const drop = new Set();
    for (const id of set) for (const a of ancestorsOf(id, parent)) if (set.has(a)) drop.add(a);
    const out = [...set].filter(id => !drop.has(id));
    return out.length ? out : ["GroupCompanyId"];
  }
  async function userScopeGroups(api) {
    const users = (await api.call("Get", { typeName: "User", propertySelector: { fields: ["id", "companyGroups"], isIncluded: true } })) || [];
    const ids = new Set(["GroupCompanyId"]);
    for (const u of users) for (const g of u.companyGroups || []) { const id = GI.idOf(g); if (id) ids.add(id); }
    const parent = await groupParents(api);
    return deepestOnly([...ids], parent);
  }
  async function shareGroups(api) {
    try { return (await userScopeGroups(api)).map(id => ({ id })); }
    catch (e) { return ACCESS_GROUPS; }
  }

  // ¿Qué usuarios no ven la configuración? (grupos de acceso que no están en
  // los registros). Devuelve { missingGroups, missingUsers } o null si no se pudo.
  async function sharingStatus(api, settingsRecords) {
    try {
      const [users, parent] = await Promise.all([
        api.call("Get", { typeName: "User", propertySelector: { fields: ["id", "name", "companyGroups"], isIncluded: true } }).then(r => r || []),
        groupParents(api),
      ]);
      const have = new Set();
      for (const r of settingsRecords || []) for (const g of r.groups || []) have.add(GI.idOf(g));
      // El usuario de grupo U ve el registro si alguno de sus grupos es U o un subgrupo de U.
      const visibleTo = new Set();
      for (const g of have) { visibleTo.add(g); for (const a of ancestorsOf(g, parent)) visibleTo.add(a); }
      const missingGroups = new Set(), missingUsers = [];
      for (const u of users) {
        const gs = (u.companyGroups || []).map(GI.idOf).filter(Boolean);
        if (!gs.length || gs.some(g => visibleTo.has(g))) continue;
        gs.forEach(g => missingGroups.add(g));
        missingUsers.push(u.name || u.id);
      }
      return { missingGroups: [...missingGroups], missingUsers };
    } catch (e) { return null; }
  }

  async function getAll(api) {
    return (await api.call("Get", { typeName: "AddInData", search: { addInId: ADDIN_ID } })) || [];
  }

  function parseDetails(rec) {
    const d = rec.details;
    if (typeof d === "string") {
      try { return JSON.parse(d); } catch (e) { return null; }
    }
    return d || null;
  }

  // -> { settings: obj|null, milestones: [...] }
  async function loadShared(api) {
    const all = await getAll(api);
    const settingsParts = [];
    const benchParts = [];
    const milestones = [];
    const fcases = [];
    for (const rec of all) {
      const d = parseDetails(rec);
      if (!d) continue;
      if (d.kind === "settings") settingsParts.push({ id: rec.id, groups: rec.groups || [], ...d });
      else if (d.kind === "benchmark") benchParts.push({ id: rec.id, ...d });
      else if (d.kind === "milestone") milestones.push({ ...d, id: rec.id });
      else if (d.kind === "fcase") fcases.push({ ...d, id: rec.id });
    }
    // Arma el último rev completo de un objeto guardado en partes.
    const assemble = list => {
      const byRev = GI.groupBy(list, p => p.rev);
      for (const rev of [...byRev.keys()].sort((a, b) => b - a)) {
        const parts = byRev.get(rev).sort((a, b) => a.part - b.part);
        if (parts.length !== parts[0].parts) continue; // rev incompleto
        try { const o = JSON.parse(parts.map(p => p.chunk).join("")); o._rev = rev; return o; } catch (e) { /* siguiente rev */ }
      }
      return null;
    };
    const settings = assemble(settingsParts);
    const benchmark = assemble(benchParts);
    milestones.sort((a, b) => (a.date < b.date ? -1 : 1));
    return { settings, milestones, benchmark, fcases, _settingsRecords: settingsParts };
  }

  // Guarda un objeto grande en partes (kind = "settings" | "benchmark"):
  // primero las partes nuevas y recién después se borran las anteriores.
  async function saveChunked(api, kind, obj) {
    const text = JSON.stringify(obj);
    const chunks = [];
    for (let i = 0; i < text.length; i += CHUNK_SIZE) chunks.push(text.slice(i, i + CHUNK_SIZE));
    const rev = Date.now();
    const before = (await getAll(api)).filter(r => (parseDetails(r) || {}).kind === kind);
    const groups = await shareGroups(api);
    for (let i = 0; i < chunks.length; i += 50) {
      await api.multiCall(chunks.slice(i, i + 50).map((chunk, k) => ["Add", {
        typeName: "AddInData",
        entity: { addInId: ADDIN_ID, groups, details: { kind, rev, part: i + k, parts: chunks.length, chunk } },
      }]));
    }
    if (before.length) {
      await api.multiCall(before.map(r => ["Remove", { typeName: "AddInData", entity: { id: r.id } }]));
    }
    return rev;
  }

  async function saveSettings(api, settings) {
    const clean = { ...settings };
    delete clean._rev;
    clean.updated_at = new Date().toISOString();
    clean._rev = await saveChunked(api, "settings", clean);
    return clean;
  }

  // Valores de referencia de la flota (sin nombres): los publica un
  // administrador para que supervisores y conductores comparen contra la
  // empresa sin ver los datos de otros.
  async function saveBenchmark(api, bench) {
    const b = { ...bench, published_at: new Date().toISOString() };
    await saveChunked(api, "benchmark", b);
    return b;
  }

  async function addMilestone(api, m) {
    const details = { kind: "milestone", ...m, created_at: new Date().toISOString() };
    delete details.id;
    const id = await api.call("Add", { typeName: "AddInData", entity: { addInId: ADDIN_ID, groups: await shareGroups(api), details } });
    return { ...details, id };
  }

  async function updateMilestone(api, m) {
    const details = { kind: "milestone", ...m };
    delete details.id;
    await api.call("Set", { typeName: "AddInData", entity: { id: m.id, addInId: ADDIN_ID, groups: await shareGroups(api), details } });
    return m;
  }

  async function removeMilestone(api, id) {
    await api.call("Remove", { typeName: "AddInData", entity: { id } });
  }

  // Seguimiento de casos de fatiga: un registro por jornada revisada
  // ({kind:"fcase", key: "conductor|inicio", status, owner, action, notes}).
  async function saveFatigueCase(api, c) {
    const details = { kind: "fcase", ...c, updated_at: new Date().toISOString(), first_at: c.first_at || new Date().toISOString() };
    delete details.id;
    const entity = { addInId: ADDIN_ID, groups: await shareGroups(api), details };
    if (c.id) { await api.call("Set", { typeName: "AddInData", entity: { id: c.id, ...entity } }); return { ...details, id: c.id }; }
    const id = await api.call("Add", { typeName: "AddInData", entity });
    return { ...details, id };
  }

  async function loadFatigueCases(api) {
    const out = [];
    for (const rec of await getAll(api)) {
      const d = parseDetails(rec);
      if (d && d.kind === "fcase") out.push({ ...d, id: rec.id });
    }
    return out;
  }

  // Diagrama de trabajo fijado a mano para un conductor ({kind:"roster", drv, work, off} o {none:true}).
  async function saveRoster(api, r) {
    const details = { kind: "roster", drv: r.drv, work: r.work || 0, off: r.off || 0, none: !!r.none, by: r.by || "", updated_at: new Date().toISOString() };
    const entity = { addInId: ADDIN_ID, groups: await shareGroups(api), details };
    if (r.id) { await api.call("Set", { typeName: "AddInData", entity: { id: r.id, ...entity } }); return { ...details, id: r.id }; }
    const id = await api.call("Add", { typeName: "AddInData", entity });
    return { ...details, id };
  }
  async function removeRoster(api, id) { await api.call("Remove", { typeName: "AddInData", entity: { id } }); }
  async function loadRosters(api) {
    const out = [];
    for (const rec of await getAll(api)) { const d = parseDetails(rec); if (d && d.kind === "roster") out.push({ ...d, id: rec.id }); }
    return out;
  }

  // Datos del usuario actual (id, si es conductor). null si no se pudo.
  async function currentUser(api, userName) {
    try {
      const users = await api.call("Get", { typeName: "User", search: { name: userName } });
      const u = users && users[0];
      return u ? { id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.name, isDriver: !!u.isDriver,
        // MyGeotab: "Impedir que el conductor acceda a los datos compartidos"
        ownDataOnly: !!u.viewDriversOwnDataOnly,
        everything: (u.securityGroups || []).some(g => GI.idOf(g) === "GroupEverythingSecurityId") } : null;
    } catch (e) { return null; }
  }

  // Administrador = clearance "Everything" de MyGeotab, o usuario listado
  // como editor en la config compartida.
  async function resolveIsAdmin(api, userName, settings) {
    const editors = ((settings && settings.editors) || []).map(s => s.toLowerCase());
    if (userName && editors.includes(userName.toLowerCase())) return true;
    try {
      const users = await api.call("Get", { typeName: "User", search: { name: userName } });
      const u = users && users[0];
      return !!(u && (u.securityGroups || []).some(g => GI.idOf(g) === "GroupEverythingSecurityId"));
    } catch (e) {
      return false;
    }
  }

  // Vuelve a guardar la config y los hitos con los grupos de todos los usuarios.
  async function shareWithAll(api, settings, milestones) {
    const saved = await saveSettings(api, settings);
    for (const m of milestones || []) await updateMilestone(api, m);
    return saved;
  }

  Object.assign(GI, { _deepestOnly: deepestOnly, shareGroups, ADDIN_ID, loadShared, saveSettings, saveBenchmark, currentUser, sharingStatus, shareWithAll, addMilestone, updateMilestone, removeMilestone, resolveIsAdmin, saveFatigueCase, loadFatigueCases, saveRoster, removeRoster, loadRosters });
})(window.GI);
