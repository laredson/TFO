import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { validateSelection } from "./model-policy.mjs";
import { replaceAtomicFile } from "./atomic-file.mjs";
import { POLICY_KEYS, validateSmartOptions } from "./smart-policy.mjs";

export const UPGRADE_WARNING = "ESTO GASTARÁ MÁS TOKENS";
export const DEFAULT_SETTINGS = Object.freeze({ version: 3, profile: "hybrid", economyEnabled: true, allowUpgrades: false,
  usagePolicy: "automatic", permissionPolicy: "allow", mode: "intelligent", smartPreset: "normal",
  customModel: "gpt-6.1-sol", customEffort: "medium",
  explicitLimits: [],
  upgradeAcceptedAt: null, upgradeCeiling: null, maxCostMultiplier: 1, maxEstimatedUsd: 10, maxWeeklyUsedPercent: 100,
  timeMode: "continue", targetMinutes: 60, extraMinutes: 10, maxParallelWorkers: 2 });
const keys = [...POLICY_KEYS, "profile", "economyEnabled", "allowUpgrades", "upgradeCeiling", "maxCostMultiplier", "maxEstimatedUsd", "maxWeeklyUsedPercent", "timeMode", "targetMinutes", "extraMinutes", "maxParallelWorkers"];
function validate(data) {
  validateSmartOptions(data);
  if (!["economy", "hybrid"].includes(data.profile) || typeof data.economyEnabled !== "boolean" || typeof data.allowUpgrades !== "boolean") throw new Error("Invalid TFO options; dispatch stopped");
  if (data.upgradeCeiling != null) validateSelection(data.upgradeCeiling);
  if (data.allowUpgrades && (!data.upgradeAcceptedAt || !data.upgradeCeiling)) throw new Error("Upgrade limits and confirmation are required");
  if (!Number.isFinite(data.maxCostMultiplier) || data.maxCostMultiplier < 1 || data.maxCostMultiplier > 20) throw new Error("Maximum cost multiplier must be between 1 and 20");
  if (!Number.isFinite(data.maxEstimatedUsd) || data.maxEstimatedUsd <= 0 || data.maxEstimatedUsd > 1000) throw new Error("Maximum estimated API-equivalent cost must be above zero and at most $1000");
  if (!Number.isFinite(data.maxWeeklyUsedPercent) || data.maxWeeklyUsedPercent < 1 || data.maxWeeklyUsedPercent > 100) throw new Error("Weekly limit must be between 1% and 100%");
  if (!["continue", "deliver_at_time"].includes(data.timeMode)) throw new Error("Invalid time mode");
  if (!Number.isInteger(data.targetMinutes) || data.targetMinutes < 5 || data.targetMinutes > 10080) throw new Error("Target time must be 5–10080 minutes");
  if (!Number.isInteger(data.extraMinutes) || data.extraMinutes < 0 || data.extraMinutes > 1440) throw new Error("Extra time must be 0–1440 minutes");
  if (!Number.isInteger(data.maxParallelWorkers) || data.maxParallelWorkers < 1 || data.maxParallelWorkers > 100) throw new Error("Maximum active workers must be 1-100");
  return data;
}
export function createSettingsStore(dataDir) {
  const file = path.join(dataDir, "settings.json");
  const read = () => {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return { ...DEFAULT_SETTINGS }; throw new Error("Cannot read TFO options; dispatch stopped until the file is repaired"); }
    if ([1, 2].includes(data.version)) return validate({ ...DEFAULT_SETTINGS, ...data, version: 3,
      profile: data.profile || "economy", smartPreset: (data.profile || "economy") === "economy" ? "saving" : "normal",
      explicitLimits: Object.keys(data).filter(key => ["maxCostMultiplier", "maxEstimatedUsd", "maxWeeklyUsedPercent", "upgradeCeiling"].includes(key)),
      upgradeCeiling: data.upgradeCeiling || (data.version === 1 && data.allowUpgrades ? { model: "gpt-6-sol", reasoning: "medium" } : null) });
    if (data.version !== 3) throw new Error("Invalid TFO options version; dispatch stopped");
    return validate({ ...DEFAULT_SETTINGS, ...data });
  };
  const update = (patch, confirmation = "") => {
    if (!patch || typeof patch !== "object" || Object.keys(patch).some(key => !keys.includes(key))) throw new Error("Invalid options update");
    fs.mkdirSync(dataDir, { recursive: true });
    const lock = `${file}.lock`;
    let fd;
    try { fd = fs.openSync(lock, "wx"); }
    catch (error) { if (error.code === "EEXIST") throw new Error("Options are being changed in another panel. Retry after reviewing the current settings."); throw error; }
    try {
    const previous = read();
    if (patch.allowUpgrades === true && !previous.allowUpgrades && confirmation !== UPGRADE_WARNING) throw new Error("The upgrade warning must be explicitly confirmed");
    const next = { ...previous, ...patch, version: 3, updatedAt: new Date().toISOString() };
    next.explicitLimits = [...new Set([...(previous.explicitLimits || []), ...Object.keys(patch).filter(key => ["maxCostMultiplier", "maxEstimatedUsd", "maxWeeklyUsedPercent", "upgradeCeiling"].includes(key))])];
    if (patch.profile && !patch.smartPreset) next.smartPreset = patch.profile === "economy" ? "saving" : "normal";
    if (patch.smartPreset) next.profile = patch.smartPreset === "saving" ? "economy" : "hybrid";
    if (patch.allowUpgrades === true && !previous.allowUpgrades) next.upgradeAcceptedAt = next.updatedAt;
    if (!next.allowUpgrades) next.upgradeAcceptedAt = null;
    validate(next);
    fs.mkdirSync(dataDir, { recursive: true });
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), "utf8");
    replaceAtomicFile(temporary, file);
    return next;
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  };
  return { read, update };
}
