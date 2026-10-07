import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createOptionsServer } from "../options-server.mjs";
import { UPGRADE_WARNING } from "../settings.mjs";
import { createPromptQueue } from "../prompt-queue.mjs";

test("local Options API blocks foreign requests and requires a fresh confirmation before upgrades", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-options-"));
  const panel = await createOptionsServer(dir);
  t.after(async () => { await new Promise(resolve => panel.server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const headers = { Authorization: `Bearer ${panel.token}`, Origin: panel.origin, "Content-Type": "application/json" };
  const preview = await fetch(panel.connectionPreviewUrl);
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-security-policy"), /script-src 'sha256-/);
  const previewHtml = await preview.text();
  assert.match(previewHtml, /Vista previa local/);
  assert.ok(!previewHtml.includes(panel.token));
  const post = (endpoint, data) => fetch(`${panel.origin}/api/${endpoint}`, { method: "POST", headers, body: JSON.stringify(data) });
  assert.equal((await fetch(`${panel.origin}/api/settings`)).status, 403);
  assert.equal((await fetch(`${panel.origin}/api/settings`, { headers: { ...headers, Origin: "https://external.invalid" } })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    http.get(`${panel.origin}/api/settings`, { headers: { ...headers, Host: "external.invalid" } }, res => { res.resume(); resolve(res.statusCode); }).once("error", reject);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await (await fetch(`${panel.origin}/api/settings`, { headers })).json()).allowUpgrades, false);
  assert.equal((await post("settings", { patch: { economyEnabled: false } })).status, 200);
  assert.equal((await post("settings", { patch: { maxParallelWorkers: 100 } })).status, 200);
  assert.equal((await post("settings", { patch: { maxParallelWorkers: 101 } })).status, 400);
  assert.equal((await (await fetch(`${panel.origin}/api/settings`, { headers })).json()).maxParallelWorkers, 100);
  assert.equal((await post("settings", { patch: { allowUpgrades: true }, confirmation: UPGRADE_WARNING })).status, 409);
  const { challenge } = await (await post("upgrade-confirmation", {})).json();
  const accepted = await post("settings", { patch: { allowUpgrades: true, upgradeCeiling: { model: "gpt-6-sol", reasoning: "medium" } }, confirmation: UPGRADE_WARNING, challenge });
  assert.equal((await accepted.json()).allowUpgrades, true);
  await post("settings", { patch: { allowUpgrades: false } });
  assert.equal((await post("settings", { patch: { allowUpgrades: true }, confirmation: UPGRADE_WARNING, challenge })).status, 409);
  assert.equal((await post("settings", { patch: { command: "untrusted" } })).status, 400);
  const html = await (await fetch(panel.origin)).text();
  assert.match(html, /id="permission-policy"/);
  assert.match(html, /id="mode-custom"/);
  assert.match(html, /id="parallel-workers"/);
  const runId = "chat_options_1234";
  const runDir = path.join(dir, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify({ id: runId, kind: "chat", objective: "Revisar ruta", status: "pending",
    threadId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", currentIndex: 0,
    steps: [{ id: "step-1", title: "Primer paso", prompt: "Di hola", assessment: null }], completedSteps: [],
    execution: { current: { model: "gpt-6-sol", reasoning: "medium" }, ceiling: { model: "gpt-6-sol", reasoning: "medium" } },
    modelDecisions: [], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  const routes = await (await fetch(`${panel.origin}/api/routes`, { headers })).json();
  assert.equal(routes[0].pendingPrompt, "Di hola");
  assert.deepEqual(routes[0].plannedSelection, { model: "gpt-6.1-sol", reasoning: "medium" });
  assert.equal(routes[0].execution.current.model, "gpt-6-sol", "observed source stays exact");
  assert.equal((await post("routes/control", { runId, action: "pause" })).status, 200);
  assert.equal((await post("routes/control", { runId, action: "cancel" })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8")).status, "cancelled");
  const queue = createPromptQueue({ dataDir:dir, readHost:async()=>({active:true,lastTurnId:"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}) });
  const selection={model:"gpt-6-luna",reasoning:"medium"};
  const prepared=await queue.start({threadId:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",projectPath:dir,objective:"Cola de prueba",initialSelection:selection,
    steps:[{prompt:"Di hola",selection},{prompt:"Di dos",selection}]});
  const listed=await (await fetch(`${panel.origin}/api/routes`,{headers})).json();
  const visible=listed.find(route=>route.id===prepared.id);
  assert.equal(visible.remainingPrompts.length,2);
  assert.match(visible.pendingPrompt,/Enviado por TFO/);
  assert.equal((await post("routes/control",{runId:prepared.id,action:"pause"})).status,200);
  assert.equal(queue.getStatus(prepared.id).status,"paused");
  assert.equal((await post("routes/control",{runId:prepared.id,action:"cancel"})).status,200);
  assert.equal(queue.getStatus(prepared.id).status,"cancelled");
});

test("Options lists flow counts without reports and applies explicit live cap changes", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-options-flow-"));
  const panel = await createOptionsServer(dir);
  t.after(async () => { await new Promise(resolve => panel.server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const headers = { Authorization: `Bearer ${panel.token}`, Origin: panel.origin, "Content-Type": "application/json" };
  const runId = "flow_options_test", stateDir = path.join(dir, "parallel", runId);
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ id: runId, kind: "project_flow", objective: "Parallel work", status: "running",
    maxParallelWorkers: 2, nodes: [{ lane: "a", status: "queued" }, { lane: "b", status: "queued" },
      { lane: "main", status: "completed", checkpoint: { response: "private full result" } }], updatedAt: new Date().toISOString() }));
  const routes = await (await fetch(`${panel.origin}/api/routes`, { headers })).json();
  assert.equal(routes[0].activeWorkers, 2); assert.equal(routes[0].completed, 1);
  assert.ok(!JSON.stringify(routes).includes("private full result"));
  const nativeId = "flow_native_options_test";
  fs.writeFileSync(path.join(dir, "native-flows", `${nativeId}.json`), JSON.stringify({ id: nativeId, kind: "native_tool_flow",
    objective: "Worktree provisioning", status: "running", maxParallelWorkers: 100,
    nodes: Array.from({ length: 100 }, (_, index) => ({ lane: `worker_${index}`, status: index % 2 ? "provisioning" : "provisioning_dispatching" })),
    updatedAt: new Date().toISOString() }));
  const withProvisioning = await (await fetch(`${panel.origin}/api/routes`, { headers })).json();
  assert.equal(withProvisioning.find(route => route.id === nativeId).activeWorkers, 100, "worktree bootstraps hold native worker slots");
  const post = value => fetch(`${panel.origin}/api/routes/control`, { method: "POST", headers, body: JSON.stringify(value) });
  assert.equal((await fetch(`${panel.origin}/api/routes/control`, { method: "POST", headers: { Origin: panel.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ runId, action: "set_parallelism", maxParallelWorkers: 100 }) })).status, 403);
  assert.equal((await post({ runId, action: "set_parallelism", maxParallelWorkers: 1 })).status, 200);
  assert.equal((await post({ runId, action: "set_parallelism", maxParallelWorkers: 100 })).status, 200);
  assert.equal((await post({ runId, action: "set_parallelism", maxParallelWorkers: 101 })).status, 400);
  const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(saved.maxParallelWorkers, 100);
  assert.equal(saved.nodes.filter(node => node.status === "queued").length, 2, "live controls do not interrupt active workers");
});

test("Options counts a blocked native result only after its preserved outcome is resolved", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-options-blocked-"));
  const panel = await createOptionsServer(dir);
  t.after(async () => { await new Promise(resolve => panel.server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const headers = { Authorization: `Bearer ${panel.token}`, Origin: panel.origin };
  const runId = "flow_native_blocked_options", stateFile = path.join(dir, "native-flows", `${runId}.json`);
  const state = { id: runId, kind: "native_tool_flow", objective: "Resolve worker outcome", status: "running", maxParallelWorkers: 2,
    nodes: [{ id: "finished", lane: "a", status: "completed", checkpoint: { turnId: "finished-turn" } },
      { id: "blocked", lane: "b", status: "blocked", checkpoint: { turnId: "blocked-turn", report: { status: "blocked" } },
        resolution: { status: "pending", remediationNodeId: "repair" } },
      { id: "repair", lane: "b", status: "pending" }, { id: "final", lane: "main", status: "pending" }],
    updatedAt: new Date().toISOString() };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const listed = async () => (await (await fetch(`${panel.origin}/api/routes`, { headers })).json()).find(route => route.id === runId);
  const unresolved = await listed();
  assert.equal(unresolved.completed, 1, "a preserved blocked receipt is not completed work");
  assert.equal(unresolved.total, 4);
  state.nodes[1].resolution.status = "resolved";
  state.nodes[1].resolution.completedTurnId = "repair-turn";
  state.nodes[2].status = "completed";
  state.nodes[2].checkpoint = { turnId: "repair-turn" };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const resolved = await listed();
  assert.equal(resolved.completed, 3, "resolved blocked outcome and its completed remedy both satisfy finish prerequisites");
  assert.equal(resolved.total, 4, "pending main integration remains incomplete");
  assert.equal(state.nodes[1].status, "blocked", "progress does not require rewriting the original blocked outcome");
});

test("Options preserves distinct historical native and conventional caps when saved flows omit their limit", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-options-legacy-caps-"));
  const panel = await createOptionsServer(dir);
  t.after(async () => { await new Promise(resolve => panel.server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const headers = { Authorization: `Bearer ${panel.token}`, Origin: panel.origin, "Content-Type": "application/json" };
  assert.equal((await fetch(`${panel.origin}/api/settings`, { method: "POST", headers,
    body: JSON.stringify({ patch: { maxParallelWorkers: 100 } }) })).status, 200);
  const nativeId = "flow_native_legacy_cap", conventionalId = "flow_parallel_legacy_cap";
  const nativeFile = path.join(dir, "native-flows", `${nativeId}.json`), parallelDir = path.join(dir, "parallel", conventionalId);
  fs.mkdirSync(parallelDir, { recursive: true });
  const parallelFile = path.join(parallelDir, "state.json");
  const legacy = { objective: "Historical worker limit", status: "running", nodes: [{ lane: "worker", status: "queued" }], updatedAt: new Date().toISOString() };
  fs.writeFileSync(nativeFile, JSON.stringify({ ...legacy, id: nativeId, kind: "native_tool_flow" }));
  fs.writeFileSync(parallelFile, JSON.stringify({ ...legacy, id: conventionalId, kind: "project_flow" }));
  const routes = await (await fetch(`${panel.origin}/api/routes`, { headers })).json();
  const native = routes.find(route => route.id === nativeId), conventional = routes.find(route => route.id === conventionalId);
  assert.equal(native.maxParallelWorkers, 2);
  assert.equal(native.effectiveMaxParallelWorkers, 2, "old native flow does not inherit the new default of 100 or conventional cap of 8");
  assert.equal(conventional.maxParallelWorkers, 8);
  assert.equal(conventional.effectiveMaxParallelWorkers, 8, "old conventional flow retains its original cap");
  assert.ok(!("maxParallelWorkers" in JSON.parse(fs.readFileSync(nativeFile, "utf8"))), "listing leaves historical state untouched");
  assert.ok(!("maxParallelWorkers" in JSON.parse(fs.readFileSync(parallelFile, "utf8"))), "listing does not rewrite conventional state");
});
