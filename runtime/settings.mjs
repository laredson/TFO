import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { validateSelection } from "./model-policy.mjs";

export const UPGRADE_WARNING = "ESTO GASTARÁ MÁS TOKENS";
export const DEFAULT_SETTINGS = Object.freeze({ version: 2, profile: "economy", economyEnabled: true, allowUpgrades: false,
  upgradeAcceptedAt: null, upgradeCeiling: null, maxCostMultiplier: 1, maxEstimatedUsd: 10, maxWeeklyUsedPercent: 100,
  timeMode: "continue", targetMinutes: 60, extraMinutes: 10 });
const keys = ["profile", "economyEnabled", "allowUpgrades", "upgradeCeiling", "maxCostMultiplier", "maxEstimatedUsd", "maxWeeklyUsedPercent", "timeMode", "targetMinutes", "extraMinutes"];
function validate(data) {
  if (!["economy", "hybrid"].includes(data.profile) || typeof data.economyEnabled !== "boolean" || typeof data.allowUpgrades !== "boolean") throw new Error("Invalid TFO options; dispatch stopped");
  if (data.upgradeCeiling != null) validateSelection(data.upgradeCeiling);
  if (data.allowUpgrades && (!data.upgradeAcceptedAt || !data.upgradeCeiling)) throw new Error("Upgrade limits and confirmation are required");
  if (!Number.isFinite(data.maxCostMultiplier) || data.maxCostMultiplier < 1 || data.maxCostMultiplier > 20) throw new Error("Maximum cost multiplier must be between 1 and 20");
  if (!Number.isFinite(data.maxEstimatedUsd) || data.maxEstimatedUsd <= 0 || data.maxEstimatedUsd > 1000) throw new Error("Maximum estimated API-equivalent cost must be above zero and at most $1000");
  if (!Number.isFinite(data.maxWeeklyUsedPercent) || data.maxWeeklyUsedPercent < 1 || data.maxWeeklyUsedPercent > 100) throw new Error("Weekly limit must be between 1% and 100%");
  if (!["continue", "deliver_at_time"].includes(data.timeMode)) throw new Error("Invalid time mode");
  if (!Number.isInteger(data.targetMinutes) || data.targetMinutes < 5 || data.targetMinutes > 10080) throw new Error("Target time must be 5–10080 minutes");
  if (!Number.isInteger(data.extraMinutes) || data.extraMinutes < 0 || data.extraMinutes > 1440) throw new Error("Extra time must be 0–1440 minutes");
  return data;
}
export function createSettingsStore(dataDir) {
  const file = path.join(dataDir, "settings.json");
  const read = () => {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return { ...DEFAULT_SETTINGS }; throw new Error("Cannot read TFO options; dispatch stopped until the file is repaired"); }
    if (data.version === 1) return validate({ ...DEFAULT_SETTINGS, economyEnabled: data.economyEnabled, allowUpgrades: data.allowUpgrades,
      upgradeAcceptedAt: data.upgradeAcceptedAt, upgradeCeiling: data.allowUpgrades ? { model: "gpt-6-sol", reasoning: "medium" } : null });
    if (data.version !== 2) throw new Error("Invalid TFO options version; dispatch stopped");
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
    const next = { ...previous, ...patch, version: 2, updatedAt: new Date().toISOString() };
    if (patch.allowUpgrades === true && !previous.allowUpgrades) next.upgradeAcceptedAt = next.updatedAt;
    if (!next.allowUpgrades) next.upgradeAcceptedAt = null;
    validate(next);
    fs.mkdirSync(dataDir, { recursive: true });
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(temporary, file);
    return next;
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  };
  return { read, update };
}
