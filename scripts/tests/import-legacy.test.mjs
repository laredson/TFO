import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
function run({ source, target }) { return execFileSync(process.execPath, [importer, "--source-data-dir", source, "--target-data-dir", target], { encoding: "utf8", stdio: "pipe" }); }
test.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
test("copies validated settings and archives literal prompts without activation", () => {
  const f = fixture("success");
  assert.match(run(f), /"status":"completed"/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.target, "settings.json"))), settings);
  assert.equal(fs.readFileSync(path.join(f.target, "migration-archive", "legacy-data", "runs", "done", "state.json"), "utf8"), fs.readFileSync(path.join(f.source, "runs", "done", "state.json"), "utf8"));
  assert.equal(fs.existsSync(path.join(f.target, "runs")), false);
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
