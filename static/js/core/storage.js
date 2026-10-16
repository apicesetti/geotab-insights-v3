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
(function (GI) {
  "use strict";

  const ADDIN_ID = "a2jBAg7PpaFdQpimkOJ7Ajg";
  const CHUNK_SIZE = 8000;
  const ACCESS_GROUPS = [{ id: "GroupCompanyId" }];

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
    const milestones = [];
    for (const rec of all) {
      const d = parseDetails(rec);
      if (!d) continue;
      if (d.kind === "settings") settingsParts.push({ id: rec.id, ...d });
      else if (d.kind === "milestone") milestones.push({ ...d, id: rec.id });
    }
    let settings = null;
    const byRev = GI.groupBy(settingsParts, p => p.rev);
    const revs = [...byRev.keys()].sort((a, b) => b - a);
    for (const rev of revs) {
      const parts = byRev.get(rev).sort((a, b) => a.part - b.part);
      if (parts.length !== parts[0].parts) continue; // rev incompleto
      try {
        settings = JSON.parse(parts.map(p => p.chunk).join(""));
        settings._rev = rev;
        break;
      } catch (e) { /* siguiente rev */ }
    }
    milestones.sort((a, b) => (a.date < b.date ? -1 : 1));
    return { settings, milestones, _settingsRecords: settingsParts };
  }

  async function saveSettings(api, settings) {
    const clean = { ...settings };
    delete clean._rev;
    clean.updated_at = new Date().toISOString();
    const text = JSON.stringify(clean);
    const chunks = [];
    for (let i = 0; i < text.length; i += CHUNK_SIZE) chunks.push(text.slice(i, i + CHUNK_SIZE));
    const rev = Date.now();
    const before = (await getAll(api)).filter(r => (parseDetails(r) || {}).kind === "settings");
    await api.multiCall(chunks.map((chunk, part) => ["Add", {
      typeName: "AddInData",
      entity: { addInId: ADDIN_ID, groups: ACCESS_GROUPS, details: { kind: "settings", rev, part, parts: chunks.length, chunk } },
    }]));
    if (before.length) {
      await api.multiCall(before.map(r => ["Remove", { typeName: "AddInData", entity: { id: r.id } }]));
    }
    clean._rev = rev;
    return clean;
  }

  async function addMilestone(api, m) {
    const details = { kind: "milestone", ...m, created_at: new Date().toISOString() };
    delete details.id;
    const id = await api.call("Add", { typeName: "AddInData", entity: { addInId: ADDIN_ID, groups: ACCESS_GROUPS, details } });
    return { ...details, id };
  }

  async function updateMilestone(api, m) {
    const details = { kind: "milestone", ...m };
    delete details.id;
    await api.call("Set", { typeName: "AddInData", entity: { id: m.id, addInId: ADDIN_ID, groups: ACCESS_GROUPS, details } });
    return m;
  }

  async function removeMilestone(api, id) {
    await api.call("Remove", { typeName: "AddInData", entity: { id } });
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

  Object.assign(GI, { ADDIN_ID, loadShared, saveSettings, addMilestone, updateMilestone, removeMilestone, resolveIsAdmin });
})(window.GI);
