import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const importer = path.resolve(here, "../import-legacy.mjs");
const fixtureRoot = path.join(here, "fixtures");
const settings = { version: 2, profile: "economy", economyEnabled: true, allowUpgrades: false, upgradeAcceptedAt: null, upgradeCeiling: null, maxCostMultiplier: 1, maxEstimatedUsd: 10, maxWeeklyUsedPercent: 100, timeMode: "continue", targetMinutes: 60, extraMinutes: 10 };
function fixture(name, mutate) {
  const root = path.join(fixtureRoot, name);
  fs.rmSync(root, { recursive: true, force: true });
  const source = path.join(root, "old");
  const target = path.join(root, "new");
  fs.mkdirSync(path.join(source, "runs", "done"), { recursive: true });
  fs.writeFileSync(path.join(source, "settings.json"), JSON.stringify(settings));
  fs.writeFileSync(path.join(source, "runs", "done", "state.json"), JSON.stringify({ status: "completed", steps: [{ prompt: "literal archived prompt" }] }));
  mutate?.({ source, target });
  return { source, target, root };
}
function run({ source, target }, preload) { return execFileSync(process.execPath, [...(preload ? ["--import", pathToFileURL(preload).href] : []), importer, "--source-data-dir", source, "--target-data-dir", target], { encoding: "utf8", stdio: "pipe" }); }
function injectPublicationFault(f, mode) {
  const preload = path.join(f.root, "publication-fault.mjs"), audit = path.join(f.root, "publication-attempts.json");
  fs.writeFileSync(preload, `
import fs from "node:fs";
import path from "node:path";
const target = ${JSON.stringify(f.target)}, audit = ${JSON.stringify(audit)}, mode = ${JSON.stringify(mode)};
const originalRename = fs.renameSync;
let calls = 0, stage;
fs.renameSync = (source, destination) => {
  if (destination !== target) return originalRename(source, destination);
  calls++; stage = source;
  if (mode === "race") {
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, "external.txt"), "existing unrelated destination");
    throw Object.assign(new Error("Injected competing destination"), { code: "EPERM" });
  }
  if (calls <= 2) throw Object.assign(new Error("Injected temporary Windows lock"), { code: calls === 1 ? "EPERM" : "EBUSY" });
  return originalRename(source, destination);
};
process.on("exit", () => fs.writeFileSync(audit, JSON.stringify({ calls, stage })));
`);
  return { preload, audit };
}
test.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
test("copies validated settings and archives literal prompts without activation", () => {
  const f = fixture("success");
  assert.match(run(f), /"status":"completed"/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.target, "settings.json"))), settings);
  assert.equal(fs.readFileSync(path.join(f.target, "migration-archive", "legacy-data", "runs", "done", "state.json"), "utf8"), fs.readFileSync(path.join(f.source, "runs", "done", "state.json"), "utf8"));
  assert.equal(fs.existsSync(path.join(f.target, "runs")), false);
});
test("preserves exact approved Sol 6.1 and legacy Sol ceilings when importing settings", () => {
  for (const model of ["gpt-6.1-sol", "gpt-6-sol"]) {
    const approved = { ...settings, allowUpgrades: true, upgradeAcceptedAt: "2026-09-30T00:00:00Z",
      upgradeCeiling: { model, reasoning: "ultra" } };
    const f = fixture(model, ({ source }) => fs.writeFileSync(path.join(source, "settings.json"), JSON.stringify(approved)));
    run(f);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.target, "settings.json"))), approved);
  }
});
test("preserves optional worker limit boundaries and rejects invalid limits without importing", () => {
  for (const maxParallelWorkers of [1, 100]) {
    const expected = { ...settings, maxParallelWorkers };
    const f = fixture(`cap-${maxParallelWorkers}`, ({ source }) => fs.writeFileSync(path.join(source, "settings.json"), JSON.stringify(expected)));
    run(f);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.target, "settings.json"))), expected);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.target, "migration-archive", "legacy-data", "settings.json"))), expected);
  }
  for (const [index, maxParallelWorkers] of [0, 101, 1.5, "2", null].entries()) {
    const f = fixture(`invalid-cap-${index}`, ({ source }) => fs.writeFileSync(path.join(source, "settings.json"), JSON.stringify({ ...settings, maxParallelWorkers })));
    assert.throws(() => run(f), error => /invalid maxParallelWorkers/.test(error.stderr));
    assert.equal(fs.existsSync(f.target), false);
  }
});
test("retries temporary directory publication locks before importing the complete archive", () => {
  const f = fixture("publication-retry"), { preload, audit } = injectPublicationFault(f, "retry");
  assert.match(run(f, preload), /"status":"completed"/);
  const attempts = JSON.parse(fs.readFileSync(audit, "utf8"));
  assert.equal(attempts.calls, 3);
  assert.equal(fs.existsSync(attempts.stage), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.target, "settings.json"))), settings);
  assert.equal(fs.readFileSync(path.join(f.target, "migration-archive", "legacy-data", "runs", "done", "state.json"), "utf8"), fs.readFileSync(path.join(f.source, "runs", "done", "state.json"), "utf8"));
});
test("refuses a destination created during publication and cleans only its own staging directory", () => {
  const f = fixture("publication-race"), { preload, audit } = injectPublicationFault(f, "race");
  assert.throws(() => run(f, preload), error => /Import refused: target already exists/.test(error.stderr));
  const attempts = JSON.parse(fs.readFileSync(audit, "utf8"));
  assert.equal(attempts.calls, 1);
  assert.equal(fs.existsSync(attempts.stage), false);
  assert.deepEqual(fs.readdirSync(f.target), ["external.txt"]);
  assert.equal(fs.readFileSync(path.join(f.target, "external.txt"), "utf8"), "existing unrelated destination");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.source, "settings.json"))), settings);
});
test("rejects active or uncertain work and leaves target absent", () => {
  for (const [name, mutate] of [
    ["active", ({ source }) => fs.writeFileSync(path.join(source, "runs", "done", "state.json"), JSON.stringify({ status: "paused" }))],
    ["reservation", ({ source }) => { fs.mkdirSync(path.join(source, "projects")); fs.writeFileSync(path.join(source, "projects", "resource-reservations.json"), JSON.stringify({ version: 1, reservations: [{ status: "held" }] })); }],
    ["ambiguous", ({ source }) => fs.writeFileSync(path.join(source, "runs", "done", "state.json"), JSON.stringify({ status: "mystery" }))],
    ["invalid-settings", ({ source }) => fs.writeFileSync(path.join(source, "settings.json"), JSON.stringify({ ...settings, maxEstimatedUsd: -1 }))],
  ]) {
    const f = fixture(name, mutate);
    assert.throws(() => run(f));
    assert.equal(fs.existsSync(f.target), false);
  }
});
test("rejects an occupied destination", () => {
  const f = fixture("conflict", ({ target }) => fs.mkdirSync(target));
  assert.throws(() => run(f));
});
test("rejects active native flows and pending web queues stored outside state.json", () => {
  for (const folder of ["native-flows", "web-queues"]) {
    const f = fixture(folder, ({ source }) => {
      fs.mkdirSync(path.join(source, folder));
      fs.writeFileSync(path.join(source, folder, "flow_example.json"), JSON.stringify({ status: "running" }));
    });
    assert.throws(() => run(f));
    assert.equal(fs.existsSync(f.target), false);
  }
});
test("terminal native flow history is archived without creating an active flow store", () => {
  const f = fixture("native-terminal", ({ source }) => {
    fs.mkdirSync(path.join(source, "native-flows"));
    fs.writeFileSync(path.join(source, "native-flows", "flow_example.json"), JSON.stringify({ status: "completed", prompt: "literal old prompt" }));
  });
  assert.match(run(f), /"status":"completed"/);
  assert.equal(fs.existsSync(path.join(f.target, "native-flows")), false);
  assert.equal(fs.readFileSync(path.join(f.target, "migration-archive", "legacy-data", "native-flows", "flow_example.json"), "utf8"), fs.readFileSync(path.join(f.source, "native-flows", "flow_example.json"), "utf8"));
});
