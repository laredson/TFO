import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FLOW_LIMITS, validateFlow, nodePrompt } from "../project-flow.mjs";
import { projectFlowTools } from "../project-flow-tools.mjs";
import { createSettingsStore } from "../settings.mjs";
import { canonicalPath } from "../project-workspace.mjs";

const identity = "11111111-1111-1111-1111-111111111111";
function plan(t, workers = 100, count = 1000) {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-scale-"));
  t.after(() => fs.rmSync(projectPath, { recursive: true, force: true }));
  const lanes = Array.from({ length: workers }, (_, index) => ({ id: `worker_${index}`, access: "read" }));
  const nodes = Array.from({ length: count - 1 }, (_, index) => ({ id: `task_${index}`, lane: lanes[index % workers].id,
    prompt: "Inspect assigned task", dependencies: index ? [`task_${index - 1}`] : [] }));
  nodes.push({ id: "join", lane: "main", prompt: "Integrate", dependencies: [nodes.at(-1).id] });
  return { surface: "codex", objective: "Scale validation", projectPath, projectId: identity, mainThreadId: identity,
    initialSelection: { model: "gpt-6.1-sol", reasoning: "medium" }, lanes, nodes, maxParallelWorkers: 100 };
}

test("schemas and validation accept 100 worker lanes with 1000 tasks", t => {
  const args = plan(t), validated = validateFlow(args);
  assert.equal(validated.lanes.length, FLOW_LIMITS.maxWorkerLanes);
  assert.equal(validated.nodes.length, FLOW_LIMITS.maxNodes);
  const schema = projectFlowTools[0].inputSchema;
  assert.equal(schema.properties.lanes.maxItems, 100);
  assert.equal(schema.properties.nodes.maxItems, 1000);
  assert.equal(schema.properties.maxParallelWorkers.maximum, 100);
  assert.equal(schema.properties.maxParallelWorkers.default, undefined, "persistent settings provide the default");
  args.lanes.push({ id: "overflow", access: "read" });
  assert.throws(() => validateFlow(args), /1-100 worker/);
  args.lanes.pop(); args.nodes.push({ id: "overflow", lane: "main", prompt: "extra", dependencies: ["join"] });
  assert.throws(() => validateFlow(args), /2-1000/);
});

test("Git lane workspace paths survive validation and concurrency boundaries fail closed", t => {
  const args = plan(t, 1, 2);
  args.lanes[0].workspace = args.projectPath;
  assert.equal(validateFlow(args).lanes[0].workspace, canonicalPath(args.projectPath));
  for (const value of [0, 101, 1.5, "2"]) assert.throws(() => validateFlow({ ...args, maxParallelWorkers: value }), /1-100/);
  assert.throws(() => validateFlow({ ...args, coordinationMode: "unknown" }), /coordination/);
});

test("active principal receives compact evidence references instead of full reports", () => {
  const state = { id: "flow_compact", coordinationMode: "active_main", objective: "Integrate reports", constraints: "",
    lanes: [{ id: "main", access: "write", workspace: "principal" }, { id: "worker", access: "write", workspace: "worker", isolation: { branch: "task" } }],
    nodes: [{ id: "worker_task", lane: "worker", status: "completed", checkpoint: { response: "private-raw-report".repeat(10000), report: { summary: "Verified result" } } },
      { id: "join", lane: "main", title: "Integrate", prompt: "Review and integrate", dependencies: ["worker_task"] }] };
  const prompt = nodePrompt(state, state.nodes[1]);
  assert.ok(prompt.length < 3000);
  assert.match(prompt, /Verified result/);
  assert.match(prompt, /resultRef/); assert.match(prompt, /tfo_native_results/);
  assert.ok(!prompt.includes("private-raw-report"));
  assert.match(prompt, /Solo el principal realiza commits/);
  const workerPrompt = nodePrompt(state, { ...state.nodes[1], lane: "worker" });
  assert.match(workerPrompt, /No abras más chats/);
  assert.match(workerPrompt, /No cambies de rama ni realices commits/);
  const many = Array.from({ length: 999 }, (_, index) => ({ ...state.nodes[0], id: `task_${index}`,
    checkpoint: { response: "raw".repeat(10000), report: { summary: "s".repeat(1000) } } }));
  const join = { ...state.nodes[1], dependencies: many.map(node => node.id) };
  const manyPrompt = nodePrompt({ ...state, nodes: [...many, join] }, join);
  assert.ok(manyPrompt.length < 50000, "even a broad 1000-task join has bounded handoff detail");
  assert.match(manyPrompt, /remainingNodeIds/);
});

test("existing settings gain the default cap and save user caps through 100", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-settings-scale-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createSettingsStore(dir);
  const old = store.read(); delete old.maxParallelWorkers;
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(old));
  assert.equal(store.read().maxParallelWorkers, 2);
  assert.equal(store.update({ maxParallelWorkers: 100 }).maxParallelWorkers, 100);
  for (const value of [0, 101, 1.5]) assert.throws(() => store.update({ maxParallelWorkers: value }), /1-100/);
  assert.equal(store.read().maxParallelWorkers, 100, "invalid settings never replace the saved value");
});
