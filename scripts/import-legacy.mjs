// One-time, explicit archive import. Never opens or dispatches an archived prompt.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const usage = "Usage: node scripts/import-legacy.mjs --source-data-dir <existing legacy data> --target-data-dir <new TFO data>";
function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1] || process.argv[index + 1].startsWith("--")) throw new Error(usage);
  return path.resolve(process.argv[index + 1]);
}
function fail(message) { throw new Error(`Import refused: ${message}`); }
function json(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { fail(`invalid JSON at ${file}`); }
}
function validateSettings(raw) {
  if (!raw || raw.version !== 2) fail("settings version is unsupported or ambiguous");
  if (!["economy", "hybrid"].includes(raw.profile) || typeof raw.economyEnabled !== "boolean" || typeof raw.allowUpgrades !== "boolean") fail("invalid settings profile");
  if (raw.allowUpgrades && (!raw.upgradeAcceptedAt || !raw.upgradeCeiling)) fail("upgrade authorization is incomplete");
  if (raw.upgradeCeiling !== null && raw.upgradeCeiling !== undefined) {
    const limits = { "gpt-6-luna": "max", "gpt-6.1-sol": "ultra", "gpt-6-sol": "ultra", "gpt-6-astra": "ultra", "gpt-5.6-luna": "max", "gpt-5.6-terra": "ultra", "gpt-5.6-sol": "ultra", "gpt-5.5": "xhigh" };
    const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
    const limit = limits[raw.upgradeCeiling?.model];
    if (!limit || efforts.indexOf(raw.upgradeCeiling?.reasoning) < 0 || efforts.indexOf(raw.upgradeCeiling.reasoning) > efforts.indexOf(limit) || Object.keys(raw.upgradeCeiling).some(key => !["model", "reasoning"].includes(key))) fail("invalid upgrade ceiling");
  }
  for (const [key, min, max] of [["maxCostMultiplier", 1, 20], ["maxEstimatedUsd", Number.EPSILON, 1000], ["maxWeeklyUsedPercent", 1, 100]]) {
    if (!Number.isFinite(raw[key]) || raw[key] < min || raw[key] > max) fail(`invalid ${key}`);
  }
  if (!["continue", "deliver_at_time"].includes(raw.timeMode)) fail("invalid time mode");
  for (const [key, min, max] of [["targetMinutes", 5, 10080], ["extraMinutes", 0, 1440]]) {
    if (!Number.isInteger(raw[key]) || raw[key] < min || raw[key] > max) fail(`invalid ${key}`);
  }
  const keys = ["version", "profile", "economyEnabled", "allowUpgrades", "upgradeAcceptedAt", "upgradeCeiling", "maxCostMultiplier", "maxEstimatedUsd", "maxWeeklyUsedPercent", "timeMode", "targetMinutes", "extraMinutes", "updatedAt"];
  if (Object.keys(raw).some(key => !keys.includes(key))) fail("unrecognized settings field");
  return raw;
}
function inspectTree(root) {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) fail(`linked data at ${full}`);
      if (entry.name.endsWith(".lock") || entry.name === "lock" || entry.name === "owner.json") fail(`lock or owner marker at ${full}`);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
      else fail(`unsupported entry at ${full}`);
    }
  }
  visit(root);
  return files;
}
function inspectStates(source, files) {
  const runs = path.join(source, "runs");
  if (fs.existsSync(runs)) {
    for (const entry of fs.readdirSync(runs, { withFileTypes: true })) {
      if (!entry.isDirectory()) fail("unexpected run entry");
      const stateFile = path.join(runs, entry.name, "state.json");
      if (!fs.existsSync(stateFile)) fail(`run ${entry.name} has no state`);
    }
  }
  const stateFiles = files.filter(file => {
    const relative = path.relative(source, file).split(path.sep);
    return path.basename(file) === "state.json" ||
      (relative.length === 2 && ["native-flows", "web-queues"].includes(relative[0]) && file.endsWith(".json"));
  });
  for (const file of stateFiles) {
    const state = json(file);
    if (!["completed", "cancelled", "canceled"].includes(state?.status)) fail(`active, uncertain, or unknown state at ${file}`);
    if (state.dispatch?.sending || state.status === "needs_review") fail(`uncertain dispatch at ${file}`);
  }
  const ledgerFile = path.join(source, "projects", "resource-reservations.json");
  if (fs.existsSync(ledgerFile)) {
    const ledger = json(ledgerFile);
    if (ledger?.version !== 1 || !Array.isArray(ledger.reservations) || ledger.reservations.some(item => item.status !== "released")) fail("active, uncertain, or invalid reservations");
  }
  for (const file of files.filter(file => path.basename(file) === "resource-reservations.json" && file !== ledgerFile)) fail(`unexpected reservation ledger at ${file}`);
}

const source = arg("--source-data-dir");
const target = arg("--target-data-dir");
if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) fail("source directory is missing");
if (fs.existsSync(target)) fail("target already exists; no merge or overwrite is allowed");
if (!fs.existsSync(path.dirname(target))) fail("target parent is missing");
if (fs.lstatSync(source).isSymbolicLink()) fail("source root is linked");
const canonical = value => process.platform === "win32" ? value.toLowerCase() : value;
const sourceReal = canonical(fs.realpathSync(source));
const targetReal = canonical(path.join(fs.realpathSync(path.dirname(target)), path.basename(target)));
if (sourceReal === targetReal || targetReal.startsWith(sourceReal + path.sep) || sourceReal.startsWith(targetReal + path.sep)) fail("source and target overlap");
const files = inspectTree(source);
inspectStates(source, files);
const settingsFile = path.join(source, "settings.json");
const settings = fs.existsSync(settingsFile) ? validateSettings(json(settingsFile)) : null;
const stage = path.join(path.dirname(target), `.tfo-import-${crypto.randomUUID()}`);
try {
  fs.mkdirSync(stage, { recursive: false });
  const archive = path.join(stage, "migration-archive", "legacy-data");
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.cpSync(source, archive, { recursive: true, errorOnExist: true, force: false });
  if (settings) fs.writeFileSync(path.join(stage, "settings.json"), JSON.stringify(settings, null, 2) + "\n", { flag: "wx" });
  fs.writeFileSync(path.join(stage, "migration-archive", "import.json"), JSON.stringify({ format: 1, importedAt: new Date().toISOString(), archivedFiles: files.length, activePromptsImported: 0 }, null, 2) + "\n", { flag: "wx" });
  fs.renameSync(stage, target);
  console.log(JSON.stringify({ status: "completed", target, archivedFiles: files.length, settingsImported: Boolean(settings), activePromptsImported: 0 }));
} catch (error) {
  const parent = path.resolve(path.dirname(target));
  if (!path.resolve(stage).startsWith(parent + path.sep) || !path.basename(stage).startsWith(".tfo-import-")) throw new Error("Unexpected import staging path");
  if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
  throw error;
}
