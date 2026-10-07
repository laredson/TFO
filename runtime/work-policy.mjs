import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createSettingsStore } from "./settings.mjs";
import { POLICY_KEYS, validateSmartOptions, decideTask, assertAvailable } from "./smart-policy.mjs";
import { replaceAtomicFile } from "./atomic-file.mjs";

const same = (a, b) => a?.model === b?.model && a?.reasoning === b?.reasoning;
export function createWorkPolicyStore(dataDir) {
  const root = path.join(dataDir, "work-policies"), settings = createSettingsStore(dataDir);
  const file = id => { if (!/^work_[a-f0-9]{24}$/.test(id)) throw new Error("Invalid work policy ID"); return path.join(root, `${id}.json`); };
  function write(target, value) {
    fs.mkdirSync(root, { recursive: true });
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { flag: "wx" });
    replaceAtomicFile(temp, target); return value;
  }
  const get = id => JSON.parse(fs.readFileSync(file(id), "utf8"));
  function locked(callback) {
    fs.mkdirSync(root, { recursive: true });
    const lock = path.join(root, "policy.lock");
    let fd;
    try { fd = fs.openSync(lock, "wx"); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = Number(fs.readFileSync(lock, "utf8"));
      if (!Number.isInteger(owner) || owner <= 0) throw new Error("Work policy lock needs review");
      let alive = true;
      try { process.kill(owner, 0); } catch (failure) { if (failure.code === "ESRCH") alive = false; }
      if (alive) throw new Error("Work policy is busy; retry after reading its current state");
      fs.unlinkSync(lock); fd = fs.openSync(lock, "wx");
    }
    fs.writeFileSync(fd, String(process.pid));
    try { return callback(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  function grants() {
    try { return JSON.parse(fs.readFileSync(path.join(root, "grants.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
  function prepare(args, catalog) {
    const projectKey = fs.realpathSync(path.resolve(args.projectPath));
    const chainId = args.mainThreadId || args.threadId;
    if (!/^[a-f0-9-]{36}$/.test(chainId || "")) throw new Error("A real source chat is required for work policy");
    if (args.workId) {
      const previous = get(args.workId);
      if (previous.projectKey !== projectKey || previous.chainId !== chainId) throw new Error("Work policy belongs to another project or chat chain");
      if (args.policy && Object.keys(args.policy).length) throw new Error("Update an existing work through Options; do not replace its captured policy");
      return previous;
    }
    const global = settings.read(), override = args.policy || {};
    if (Object.keys(override).some(key => !POLICY_KEYS.includes(key))) throw new Error("Unknown work policy option");
    if (override.permissionPolicy === "allow" && global.permissionPolicy !== "allow") throw new Error("Grant permission in Options before allowing this work");
    const configuration = validateSmartOptions({ ...global, ...override });
    const invocation = args.invocation || "prompt";
    if (!["prompt", "plan"].includes(invocation)) throw new Error("Unknown invocation context");
    const work = { id: `work_${crypto.randomBytes(12).toString("hex")}`, version: 1, revision: 0,
      projectKey, chainId, objective: String(args.objective || "Trabajo TFO"), configuration, catalog,
      invocation, planAccepted: args.planAccepted === true,
      usageAccepted: args.usageAccepted === true || (configuration.usagePolicy === "automatic" && invocation === "prompt") ||
        (configuration.usagePolicy !== "ask_once" && invocation === "plan" && args.planAccepted === true),
      createdAt: new Date().toISOString(), boundRunIds: [], disabled: false };
    return locked(() => write(file(work.id), work));
  }
  function status(id) {
    const work = get(id), global = settings.read();
    if (global.permissionPolicy === "disabled" || work.configuration.permissionPolicy === "disabled" || work.disabled) return { allowed: false, reason: "TFO deshabilitado para nuevos envíos.", work };
    if (work.invocation === "plan" && !work.planAccepted) return { allowed: false, reason: "Esperando la aceptación del plan.", work };
    if (!work.usageAccepted) return { allowed: false, reason: "Elige si quieres utilizar TFO para este trabajo.", work };
    if (work.configuration.permissionPolicy === "ask") {
      const permission = grants().some(g => !g.revokedAt && (g.scope === "project" ? g.key === work.projectKey : g.key === work.chainId));
      if (!permission) return { allowed: false, reason: "Permiso de TFO pendiente o revocado.", work };
    }
    return { allowed: true, reason: null, work };
  }
  function assertDispatch(policy) {
    if (settings.read().permissionPolicy === "disabled") { const error = new Error("TFO disabled: no new dispatch or recovery allowed"); error.code = "TFO_POLICY_PENDING"; throw error; }
    if (!policy) return null; // Historical runs retain their previous selection and approval semantics.
    const result = status(policy.id);
    if (!result.allowed) { const error = new Error(result.reason); error.code = "TFO_POLICY_PENDING"; error.workId = policy.id; throw error; }
    return result.work;
  }
  function bind(id, runId) { return locked(() => { const work = get(id); if (!work.boundRunIds.includes(runId)) work.boundRunIds.push(runId); return write(file(id), work); }); }
  function choose(id, { accepted, planAccepted, policy } = {}) {
    return locked(() => {
      const work = get(id);
      if (typeof accepted !== "boolean") throw new Error("An explicit use choice is required");
      if (policy && Object.keys(policy).some(key => !["mode", "smartPreset", "customModel", "customEffort"].includes(key))) throw new Error("Only mode choices can be changed here");
      work.configuration = validateSmartOptions({ ...work.configuration, ...policy });
      if (work.configuration.mode === "intelligent" && ["hq", "max_hq"].includes(work.configuration.smartPreset) && work.boundRunIds.some(id => /^(queue|chat)_/.test(id)))
        throw new Error("HQ/MaxHQ require a native flow with an independent review chat; this work is already bound to a single-chat route");
      if (work.configuration.mode === "custom") assertAvailable({ model: work.configuration.customModel, reasoning: work.configuration.customEffort }, work.catalog);
      work.usageAccepted = accepted; work.disabled = !accepted;
      if (planAccepted === true) work.planAccepted = true;
      work.revision++; return write(file(id), work);
    });
  }
  function grant(id, scope) {
    if (!["project", "chain", "always"].includes(scope)) throw new Error("Unknown permission scope");
    const work = get(id);
    locked(() => {
      const current = grants(), entry = { id: crypto.randomUUID(), scope: scope === "always" ? "chain" : scope,
        key: scope === "project" ? work.projectKey : work.chainId, grantedAt: new Date().toISOString(), revokedAt: null };
      if (!current.some(g => !g.revokedAt && g.scope === entry.scope && g.key === entry.key)) current.push(entry);
      write(path.join(root, "grants.json"), current);
    });
    if (scope === "always") settings.update({ permissionPolicy: "allow" });
    return status(id);
  }
  function revoke(grantId) { return locked(() => { const current = grants(), item = current.find(g => g.id === grantId); if (!item) throw new Error("Unknown grant"); item.revokedAt = new Date().toISOString(); write(path.join(root, "grants.json"), current); return item; }); }
  function list() {
    if (!fs.existsSync(root)) return { works: [], grants: [] };
    return { works: fs.readdirSync(root).filter(name => /^work_[a-f0-9]{24}\.json$/.test(name)).map(name => status(name.slice(0, -5))), grants: grants() };
  }
  function decision(policy, node, fallback) {
    const work = get(policy.id);
    return decideTask({ configuration: work.configuration, normalSelection: node.normalSelection || node.selection || fallback,
      recommendation: node.normalSelection ? node.selection : node.recommendation,
      reason: node.selectionReason || node.reason || "Selección explícita evaluada para esta tarea.", catalog: work.catalog,
      ceiling: work.configuration.upgradeCeiling });
  }
  function assertMain(policy, initial) {
    if (policy.configuration.mode === "custom" && !same(initial, { model: policy.configuration.customModel, reasoning: policy.configuration.customEffort }))
      throw new Error("Custom requires a new principal turn with the fixed model/effort; the active turn cannot be switched");
  }
  return { prepare, get, status, assertDispatch, bind, choose, grant, revoke, list, decision, assertMain };
}
