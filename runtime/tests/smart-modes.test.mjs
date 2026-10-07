import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS, createSettingsStore } from "../settings.mjs";
import { SMART_MODELS, SMART_PRESETS, decideTask } from "../smart-policy.mjs";
import { createWorkPolicyStore } from "../work-policy.mjs";
import { prepareWorkEntry } from "../work-entry.mjs";
import { readNativeSettings, updateNativeSettings } from "../native-settings.mjs";
import { addIndependentReview, assertReviewComplete, validateReviewTasks } from "../review-policy.mjs";
import { assertWorkBudget } from "../work-budget.mjs";
import { createNativeFlow } from "../native-flow.mjs";
import { canonicalPath } from "../project-workspace.mjs";
import { exportMeasurements } from "../measurements.mjs";
import { createChatRouter } from "../chat-route.mjs";
import { createPromptQueue } from "../prompt-queue.mjs";

const main = "11111111-1111-1111-1111-111111111111", worker = "22222222-2222-2222-2222-222222222222";
const luna = { model: SMART_MODELS[0], reasoning: "high" }, sol = { model: SMART_MODELS[1], reasoning: "high" }, astra = { model: SMART_MODELS[2], reasoning: "high" };
const catalog = SMART_MODELS.map(model => ({ model, supportedReasoningEfforts: (model === SMART_MODELS[0] ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high", "xhigh", "max", "ultra"]).map(reasoningEffort => ({ reasoningEffort })) }));
function directory(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-smart-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const task = (preset, normal = luna, extra = {}) => decideTask({ configuration: { ...DEFAULT_SETTINGS, smartPreset: preset }, normalSelection: normal, reason: "Evaluated bounded task", catalog, ...extra });

test("eight intelligent policies share the Normal reference; Quality raises only model tier", () => {
  assert.equal(SMART_PRESETS.length, 8);
  for (const preset of SMART_PRESETS) {
    const decision = task(preset);
    assert.deepEqual(decision.normalSelection, luna);
    assert.deepEqual(decision.selected, ["quality", "hq"].includes(preset) ? sol : luna);
    assert.equal(decision.reviewRequired, ["hq", "max_hq"].includes(preset));
  }
  assert.deepEqual(task("quality", sol).selected, astra);
  assert.deepEqual(task("quality", astra).selected, astra);
  assert.deepEqual(task("saving", luna, { recommendation: sol }).selected, sol);
  assert.deepEqual(task("maximum", luna).selected, luna);
  assert.equal(task("max_speed", luna, { recommendation: astra }).selected.reasoning, "high");
});
test("Custom is exact, effort availability and preserved old Sol ceilings are enforced", () => {
  assert.deepEqual(task("normal", sol, { configuration: { ...DEFAULT_SETTINGS, mode: "custom", customModel: luna.model, customEffort: "low" } }).selected, { ...luna, reasoning: "low" });
  assert.throws(() => task("quality", sol, { ceiling: { model: "gpt-6-sol", reasoning: "high" } }), /ceiling/);
  assert.deepEqual(task("quality", luna, { ceiling: { model: "gpt-6-sol", reasoning: "high" } }).selected, sol);
  assert.throws(() => task("quality", luna, { catalog: [catalog[0]] }), /unavailable/);
  assert.throws(() => task("normal", luna, { configuration: { ...DEFAULT_SETTINGS, customModel: luna.model, customEffort: "ultra" } }), /Unsupported/);
  assert.throws(() => task("normal", luna, { reason: " " }), /reason/);
});
test("fresh defaults and migration preserve explicit old settings without rewriting the source", t => {
  const dir = directory(t), store = createSettingsStore(dir);
  assert.equal(store.read().smartPreset, "normal"); assert.equal(store.read().permissionPolicy, "allow");
  const file = path.join(dir, "settings.json"), old = { ...DEFAULT_SETTINGS, version: 2, profile: "economy", maxEstimatedUsd: 3, maxParallelWorkers: 1 };
  delete old.smartPreset; delete old.explicitLimits;
  fs.writeFileSync(file, JSON.stringify(old));
  const before = fs.readFileSync(file, "utf8"), migrated = store.read();
  assert.equal(migrated.smartPreset, "saving"); assert.equal(migrated.maxEstimatedUsd, 3); assert.equal(migrated.maxParallelWorkers, 1);
  assert.ok(migrated.explicitLimits.includes("maxEstimatedUsd")); assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(store.update({ smartPreset: "quality" }).version, 3);
});
test("nine use/permission combinations ask once and preserve project/chain grants", t => {
  for (const usagePolicy of ["automatic", "plan_or_ask", "ask_once"]) for (const permissionPolicy of ["allow", "ask", "disabled"]) {
    const dir = directory(t), store = createSettingsStore(dir), policies = createWorkPolicyStore(dir);
    store.update({ usagePolicy, permissionPolicy });
    const work = policies.prepare({ projectPath: dir, mainThreadId: main }, catalog);
    assert.equal(policies.status(work.id).allowed, usagePolicy === "automatic" && permissionPolicy === "allow");
    policies.choose(work.id, { accepted: true });
    if (permissionPolicy === "ask") policies.grant(work.id, "chain");
    assert.equal(policies.status(work.id).allowed, permissionPolicy !== "disabled");
    policies.bind(work.id, "flow_a"); policies.bind(work.id, "flow_b");
    assert.equal(policies.get(work.id).usageAccepted, true);
    if (permissionPolicy === "disabled") assert.throws(() => policies.assertDispatch(work), /disabled/);
    else assert.ok(policies.assertDispatch(work));
  }
});
test("plans need acceptance; duplicated grants do not defeat revocation; global disable gates historical runs", t => {
  const dir = directory(t), settings = createSettingsStore(dir), policies = createWorkPolicyStore(dir);
  settings.update({ permissionPolicy: "ask" });
  const work = policies.prepare({ projectPath: dir, mainThreadId: main, invocation: "plan" }, catalog);
  policies.grant(work.id, "project"); policies.grant(work.id, "project");
  assert.equal(policies.list().grants.length, 1); assert.equal(policies.status(work.id).allowed, false);
  policies.choose(work.id, { accepted: true, planAccepted: true }); assert.equal(policies.status(work.id).allowed, true);
  const other = policies.prepare({ projectPath: dir, mainThreadId: worker }, catalog); assert.equal(policies.status(other.id).allowed, true);
  policies.revoke(policies.list().grants[0].id); assert.equal(policies.status(work.id).allowed, false); assert.equal(policies.status(other.id).allowed, false);
  policies.grant(work.id, "chain"); assert.equal(policies.status(other.id).allowed, false);
  policies.grant(work.id, "always"); assert.equal(settings.read().permissionPolicy, "allow");
  settings.update({ permissionPolicy: "disabled" }); assert.throws(() => policies.assertDispatch(null), /disabled/);
});
test("global changes apply to new jobs; existing work modes need an explicit choice", t => {
  const dir = directory(t), settings = createSettingsStore(dir), policies = createWorkPolicyStore(dir);
  const work = policies.prepare({ projectPath: dir, mainThreadId: main }, catalog);
  settings.update({ smartPreset: "quality", permissionPolicy: "ask" });
  assert.equal(policies.get(work.id).configuration.smartPreset, "normal"); assert.ok(policies.assertDispatch(work));
  policies.choose(work.id, { accepted: true, policy: { mode: "custom", customModel: astra.model, customEffort: "high" } });
  assert.throws(() => policies.assertMain(policies.get(work.id), sol), /new principal turn/);
  assert.doesNotThrow(() => policies.assertMain(policies.get(work.id), astra));
  assert.throws(() => policies.prepare({ projectPath: dir, mainThreadId: worker, workId: work.id }, catalog), /another project or chat/);
});
test("a prepared single-chat queue cannot switch to HQ without an independent review flow", t => {
  const dir = directory(t), policies = createWorkPolicyStore(dir);
  const work = policies.prepare({ projectPath: dir, mainThreadId: main }, catalog);
  policies.bind(work.id, "queue_example");
  for (const smartPreset of ["hq", "max_hq"]) assert.throws(() => policies.choose(work.id, { accepted: true, policy: { smartPreset } }), /independent review/);
  assert.equal(policies.get(work.id).configuration.smartPreset, "normal");
});
test("measurement export excludes content, retains missing data and deduplicates shared inline usage", t => {
  const dir = directory(t); fs.mkdirSync(path.join(dir, "native-flows"));
  const checkpoint = { turnId: "turn-1", requested: sol, observed: sol, response: "PRIVATE RESPONSE", report: { files: ["PRIVATE PATH"] },
    usage: { inputTokens: 100, outputTokens: 10 }, startedAt: "2026-10-07T00:00:00Z", completedAt: "2026-10-07T00:00:01Z", verification: "active_main_final_host_receipt" };
  fs.writeFileSync(path.join(dir, "native-flows", "flow_measure.json"), JSON.stringify({ status: "completed", createdAt: checkpoint.startedAt, updatedAt: checkpoint.completedAt,
    objective: "PRIVATE OBJECTIVE", nodes: ["first", "second"].map(id => ({ id, lane: "main", prompt: "PRIVATE PROMPT", checkpoint })) }));
  const result = exportMeasurements(dir, "flow_measure");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  assert.equal(result.turns[0].durationMs, 1000); assert.equal(result.turns[1].duplicateTurn, true); assert.equal(result.turns[1].usage, null);
  assert.equal(result.knownApiEquivalentUsd, result.turns[0].apiEquivalentUsd); assert.equal(result.weeklyQuotaDeltaPoints, null);
  assert.equal(result.turns[0].quality, null);
});
test("work entry returns a pending choice without dispatching and reuses it after approval", async t => {
  const dir = directory(t); createSettingsStore(dir).update({ usagePolicy: "ask_once" });
  const args = { projectPath: dir, mainThreadId: main, initialSelection: sol };
  const entry = await prepareWorkEntry(dir, args, async () => catalog);
  assert.equal(entry.pending.status, "awaiting_policy");
  createWorkPolicyStore(dir).choose(entry.pending.workId, { accepted: true });
  const accepted = await prepareWorkEntry(dir, { ...args, workId: entry.pending.workId }, async () => { throw new Error("Unnecessary catalog call"); });
  assert.equal(accepted.args.workPolicy.id, entry.pending.workId);
});
test("native settings and local store share persisted values and validate Custom against the host", async t => {
  const dir = directory(t), read = () => Promise.resolve(catalog);
  assert.equal((await readNativeSettings(dir, read)).values.smartPreset, "Normal");
  await updateNativeSettings(dir, { smartPreset: "Calidad", permissionPolicy: "Preguntar" }, read);
  assert.equal(createSettingsStore(dir).read().smartPreset, "quality");
  await assert.rejects(updateNativeSettings(dir, { mode: "Custom", customModel: "Luna 6", customEffort: "Ultra" }, read), /Unsupported/);
  await updateNativeSettings(dir, { mode: "Custom", customModel: "Luna 6", customEffort: "Bajo" }, read);
  assert.equal((await readNativeSettings(dir, read)).values.customEffort, "Bajo");
});
test("HQ closure requires an independent clean review covering all corrections", () => {
  const expanded = addIndependentReview({ initialSelection: astra, lanes: [{ id: "worker", access: "write" }], nodes: [{ id: "build", lane: "main", dependencies: [] }] }, { configuration: { ...DEFAULT_SETTINGS, smartPreset: "hq" } });
  const [build, review, close] = expanded.nodes;
  const state = { ...expanded, workPolicy: { reviewRequired: true }, nodes: [build, { ...review, status: "completed", checkpoint: { report: { findings: [] } } }, close] };
  assert.doesNotThrow(() => assertReviewComplete(state));
  state.nodes[1].checkpoint.report.findings.push({ id: "bug" }); assert.throws(() => assertReviewComplete(state), /outstanding/);
  state.nodes[1].checkpoint.report.findings = [];
  state.nodes.push({ id: "fix", lane: "worker", dependencies: [build.id] }); assert.throws(() => assertReviewComplete(state), /closure|cover/);
  assert.throws(() => validateReviewTasks([{ ...review, lane: "main" }], expanded.lanes), /separate read-only/);
  assert.throws(() => addIndependentReview({ ...expanded, workspaceMode: "scratch_folders" }, { configuration: { ...DEFAULT_SETTINGS, smartPreset: "hq" } }), /reviewWorkspace/);
  const scratch = addIndependentReview({ initialSelection: astra, workspaceMode: "scratch_folders", reviewWorkspace: "review-folder", lanes: [{ id: "worker", access: "write" }], nodes: [{ id: "build", lane: "main", dependencies: [] }] }, { configuration: { ...DEFAULT_SETTINGS, smartPreset: "hq" } });
  assert.equal(scratch.lanes.at(-1).workspace, "review-folder");
});
test("explicit monetary, weekly and time limits stop new work; unknown weekly usage is not zero", () => {
  const state = { createdAt: new Date().toISOString(), steps: [{ prompt: "Implement", selection: astra, normalSelection: luna }] };
  const work = { configuration: { ...DEFAULT_SETTINGS, maxEstimatedUsd: 0.01 } };
  assert.throws(() => assertWorkBudget(work, state, {}), /budget/);
  work.configuration.maxEstimatedUsd = 10; work.configuration.maxWeeklyUsedPercent = 80;
  assert.throws(() => assertWorkBudget(work, state, {}), /unavailable/);
  assert.throws(() => assertWorkBudget(work, state, { weeklyUsedPercent: 81 }), /limit/);
  assert.ok(assertWorkBudget(work, state, { weeklyUsedPercent: 20 }));
  work.configuration.explicitLimits = ["maxCostMultiplier"];
  assert.throws(() => assertWorkBudget(work, state, { weeklyUsedPercent: 20 }), /budget/);
  state.steps[0].selection = luna;
  assert.doesNotThrow(() => assertWorkBudget(work, state, { weeklyUsedPercent: 20 }), "A multiplier of one permits the Normal reference including its same reserve");
});

test("new ordinary chat routes enforce captured budgets without requiring the old budgeted entry", async t => {
  const dir = directory(t), settings = createSettingsStore(dir), policies = createWorkPolicyStore(dir);
  settings.update({ maxEstimatedUsd: 0.001 });
  const work = policies.prepare({ projectPath: dir, mainThreadId: main }, catalog);
  let sends = 0;
  const router = createChatRouter({ dataDir: dir, dispatch: async () => { sends++; } });
  await assert.rejects(router.start({ projectPath: dir, threadId: main, initialSelection: astra, objective: "Test budget", workPolicy: work,
    steps: [{ title: "Work", prompt: "Implement the small task", normalSelection: astra }] }), /budget/);
  assert.equal(sends, 0);
});
test("a cheaper explicit mode revision unblocks a budget-held queue without retrying an attempt", async t => {
  const dir = directory(t), policies = createWorkPolicyStore(dir);
  createSettingsStore(dir).update({ maxEstimatedUsd: 0.01 });
  const work = policies.prepare({ projectPath: dir, mainThreadId: main }, catalog);
  const host = { active: true, lastTurnId: "source", completedTurnId: null };
  const sent = [];
  const queue = createPromptQueue({ dataDir: dir, readHost: async () => host, dispatch: async (_id, _prompt, selection) => { sent.push(selection); return worker; } });
  const state = await queue.start({ threadId: main, projectPath: dir, initialSelection: astra, objective: "Change budget", workPolicy: work, steps: [{ prompt: "Work", selection: astra }] });
  Object.assign(host, { active: false, completedTurnId: "source" });
  assert.match((await queue.tick(state.id)).policyWaiting, /budget/); assert.equal(sent.length, 0);
  policies.choose(work.id, { accepted: true, policy: { mode: "custom", customModel: luna.model, customEffort: "low" } });
  assert.equal((await queue.tick(state.id)).status, "queued"); assert.deepEqual(sent, [{ ...luna, reasoning: "low" }]);
});

test("native Quality applies to workers, preserves receipts and blocks new sends after revocation", async t => {
  const root = directory(t), dataDir = path.join(root, "data");
  for (const name of ["worker", "release"]) fs.mkdirSync(path.join(root, name));
  const policies = createWorkPolicyStore(dataDir); createSettingsStore(dataDir).update({ permissionPolicy: "ask" });
  const work = policies.prepare({ projectPath: root, mainThreadId: main, policy: { smartPreset: "quality" } }, catalog);
  policies.grant(work.id, "chain");
  const states = new Map([[main, { ...astra, workspace: canonicalPath(root), threadId: main, lastTurnId: "source", active: true, userMessageCount: 1 }]]);
  let receipt;
  const host = { read: async id => states.get(id), find: async () => [], bootstrap: async () => receipt, receipt: async () => receipt };
  const flow = createNativeFlow({ dataDir, host });
  const prepared = await flow.prepare({ surface: "codex", objective: "Test Quality", projectId: main, mainThreadId: main, projectPath: root,
    initialSelection: astra, workspaceMode: "scratch_folders", mainWorkspace: path.join(root, "release"), workPolicy: work,
    lanes: [{ id: "worker", workspace: path.join(root, "worker"), access: "write" }], nodes: [
      { id: "first", lane: "worker", prompt: "Bounded task", dependencies: [], selection: luna },
      { id: "second", lane: "worker", prompt: "Continue task", dependencies: ["first"], selection: luna },
      { id: "join", lane: "main", prompt: "Integrate", dependencies: ["second"], selection: astra, normalSelection: sol }] });
  const action = await flow.claim(prepared.id, "first"); assert.equal(action.args.model, sol.model); assert.equal(action.args.thinking, "high");
  states.set(worker, { ...sol, workspace: canonicalPath(root), threadId: worker, lastTurnId: "worker-source", active: true });
  await flow.acknowledge(prepared.id, "first", worker);
  receipt = { turnId: "worker-turn", completed: true, bootstrapVerified: true, ...sol, finalResponse: JSON.stringify({ status: "completed", summary: "Done" }), usage: { input_tokens: 12, output_tokens: 3 } };
  Object.assign(states.get(worker), { lastTurnId: receipt.turnId, completedTurnId: receipt.turnId, active: false });
  await flow.observe(prepared.id);
  assert.deepEqual(flow.status(prepared.id).nodes[0].checkpoint.observed, sol);
  policies.revoke(policies.list().grants[0].id);
  await assert.rejects(flow.claim(prepared.id, "second"), /revocado/);
  assert.equal(flow.status(prepared.id).nodes[1].status, "pending");
});
