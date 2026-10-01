import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideModel, MODELS, EFFORTS, validateSelection, preferredSelection, assertQueueSelection } from "../model-policy.mjs";
import { createSettingsStore, UPGRADE_WARNING } from "../settings.mjs";
import { turnStartParams, queueArguments, dispatchPrompt } from "../queue-transport.mjs";
const ceiling = { model: "gpt-6-astra", reasoning: "xhigh" };
const luna = { model: "gpt-6-luna", reasoning: "low" };
const settings = { economyEnabled: true, allowUpgrades: false };
const assessment = { complexity: "routine", confidence: "high", reason: "Deterministic two-line file edit" };

test("routine high-confidence work requests Luna low; absent/uncertain assessment preserves selection", () => {
  assert.deepEqual(decideModel({ current: ceiling, ceiling, assessment, settings }).selected, luna);
  assert.deepEqual(decideModel({ current: ceiling, ceiling, settings }).selected, ceiling);
  assert.deepEqual(decideModel({ current: ceiling, ceiling, assessment: { ...assessment, confidence: "low" }, settings }).selected, ceiling);
});
test("turning savings off preserves the reached level and never restores a higher model", () => {
  assert.deepEqual(decideModel({ current: ceiling, ceiling, assessment, settings: { ...settings, economyEnabled: false } }).selected, ceiling);
  assert.deepEqual(decideModel({ current: luna, ceiling, settings: { ...settings, economyEnabled: false } }).selected, luna);
});
test("every supported selection obeys both downward bounds, including crossed model/effort requests", () => {
  const selections = Object.entries(MODELS).flatMap(([model, spec]) => EFFORTS.slice(0, EFFORTS.indexOf(spec.maxEffort) + 1).map(reasoning => ({ model, reasoning })));
  for (const current of selections) for (const recommendation of selections) {
    const cap = { model: MODELS[current.model].family === "6" ? "gpt-6-astra" : current.model.startsWith("gpt-5.6-") ? "gpt-5.6-sol" : "gpt-5.5", reasoning: current.model === "gpt-5.5" ? "xhigh" : "ultra" };
    try {
      const decision = decideModel({ current, ceiling: cap, settings, assessment: { ...assessment, recommendation } });
      assert.equal(MODELS[decision.selected.model].family, MODELS[current.model].family);
      assert.ok(MODELS[decision.selected.model].rank <= MODELS[current.model].rank);
      assert.ok(EFFORTS.indexOf(decision.selected.reasoning) <= EFFORTS.indexOf(current.reasoning));
    } catch (error) { assert.match(error.message, /blocked|ceiling|generation/); }
  }
});
test("automatic Sol choices use 6.1 while exact validation and explicit old Sol stay pinned", () => {
  const oldSol = { model: "gpt-6-sol", reasoning: "medium" };
  const sol = { ...oldSol, model: "gpt-6.1-sol" };
  assert.deepEqual(validateSelection(oldSol), oldSol);
  assert.deepEqual(preferredSelection(oldSol), sol);
  for (const economyEnabled of [true, false]) {
    const options = { ...settings, economyEnabled };
    const automatic = decideModel({ current: oldSol, ceiling: oldSol, settings: options });
    assert.deepEqual(automatic.previous, oldSol);
    assert.deepEqual(automatic.selected, sol);
    assert.equal(automatic.changed, true);
    assert.deepEqual(decideModel({ current: oldSol, ceiling, settings: options,
      assessment: { ...assessment, recommendation: oldSol } }).selected, oldSol);
  }
  assert.deepEqual(decideModel({ current: sol, ceiling, settings,
    assessment: { ...assessment, recommendation: oldSol } }).selected, oldSol);
  assert.deepEqual(decideModel({ current: sol, ceiling: sol, settings, assessment }).selected, luna);
});
test("6.1 shares the Sol tier without bypassing effort, upgrade or generation limits", () => {
  const sol = { model: "gpt-6.1-sol", reasoning: "medium" };
  assert.doesNotThrow(() => assertQueueSelection(sol, { model: "gpt-6-sol", reasoning: "medium" }));
  assert.doesNotThrow(() => assertQueueSelection(sol, ceiling));
  assert.throws(() => assertQueueSelection({ ...sol, reasoning: "high" }, sol), /higher/);
  assert.throws(() => assertQueueSelection(sol, luna), /higher/);
  assert.throws(() => assertQueueSelection(sol, { model: "gpt-5.6-sol", reasoning: "medium" }, [sol]), /generation/);
  assert.throws(() => decideModel({ current: luna, ceiling, settings,
    assessment: { ...assessment, recommendation: sol } }), /blocked/);
  assert.deepEqual(validateSelection({ ...sol, reasoning: "ultra" }), { ...sol, reasoning: "ultra" });
  assert.throws(() => validateSelection({ ...sol, reasoning: "none" }), /Unsupported/);
});
test("upgrades require permission, remain below the initial ceiling and reject unsupported effort", () => {
  assert.throws(() => decideModel({ current: luna, ceiling, settings, assessment: { ...assessment, recommendation: ceiling } }), /blocked/);
  assert.deepEqual(decideModel({ current: luna, ceiling, settings: { ...settings, allowUpgrades: true }, assessment: { ...assessment, recommendation: ceiling } }).selected, ceiling);
  assert.throws(() => decideModel({ current: luna, ceiling, settings: { ...settings, allowUpgrades: true }, assessment: { ...assessment, recommendation: { ...ceiling, reasoning: "ultra" } } }), /ceiling/);
  assert.throws(() => validateSelection({ ...luna, reasoning: "ultra" }), /Unsupported/);
  assert.throws(() => validateSelection({ model: "unknown", reasoning: "low" }), /Unsupported/);
});
test("options default to down-only, require the warning, persist and fail closed on corruption", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-policy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createSettingsStore(dir);
  assert.equal(store.read().allowUpgrades, false);
  assert.throws(() => store.update({ allowUpgrades: true }), /confirmed/);
  store.update({ allowUpgrades: true, upgradeCeiling: ceiling }, UPGRADE_WARNING);
  assert.equal(createSettingsStore(dir).read().allowUpgrades, true);
  assert.ok(store.read().upgradeAcceptedAt);
  store.update({ allowUpgrades: false, economyEnabled: false });
  assert.equal(store.read().upgradeAcceptedAt, null);
  assert.equal(store.read().economyEnabled, false);
  fs.writeFileSync(path.join(dir, "settings.json"), "corrupt");
  assert.throws(() => store.read(), /stopped/);
});
test("App Server turn passes model and effort explicitly without a shell or fallback", () => {
  assert.deepEqual(turnStartParams("thread", "prompt with \"quotes\"", luna, "C:\\Dev"), { threadId: "thread", input: [{ type: "text", text: "prompt with \"quotes\"" }], model: "gpt-6-luna", effort: "low", cwd: "C:\\Dev" });
  assert.throws(() => turnStartParams("thread", "prompt"), /Unsupported/);
});
test("Desktop chat transport refuses model changes before sending a prompt", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-writer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.CODEX_HOME;
  const id = "12345678-1234-1234-1234-123456789abc";
  const sessions = path.join(dir, "sessions", "2026", "09", "26");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, `rollout-test-${id}.jsonl`), JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-sol", effort: "medium" } }));
  process.env.CODEX_HOME = dir;
  try {
    assert.deepEqual(queueArguments(id, "Visible prompt"), ["queue", "--thread", id, "--message", "Visible prompt"]);
    await assert.rejects(dispatchPrompt(id, "Visible prompt", { model: "gpt-6-luna", reasoning: "medium" }), /native queue cannot select another model/);
  } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});
