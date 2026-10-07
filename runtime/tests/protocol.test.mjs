import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("MCP exposes active coordination, compact waiting and configurable 100-worker limits", async t => {
  const client = await createClient(t);
  const listed = (await client.call("tools/list")).result.tools;
  assert.equal(new Set(listed.map(tool => tool.name)).size, listed.length);
  const find = name => listed.find(tool => tool.name === name);
  const native = find("tfo_native_prepare").inputSchema.properties;
  assert.equal(native.coordinationMode.default, "active_main");
  assert.ok(native.workspaceMode.enum.includes("git_worktrees"));
  assert.equal(native.maxParallelWorkers.maximum, 100);
  assert.equal(native.lanes.maxItems, 100);
  assert.equal(native.nodes.maxItems, 1000);
  assert.equal(find("tfo_native_wait").inputSchema.properties.timeoutMs.maximum, 60000);
  for (const operation of ["results", "defer_dispatch", "revise", "checkpoint", "finish", "pause", "resume", "cancel", "reconcile", "recover"]) assert.ok(find(`tfo_native_${operation}`), operation);
  assert.ok(find("tfo_parallel_set_parallelism"));
  const options = (await client.call("tools/call", { name: "tfo_settings", arguments: {} })).result.structuredContent;
  assert.equal(options.maxParallelWorkers, 2);
});

test("MCP advertises Sol 6.1 in every selection enum and marks Sol 6 explicit-only", async t => {
  const client = await createClient(t);
  const listed = await client.call("tools/list");
  let selections = 0;
  function inspect(schema) {
    if (!schema || typeof schema !== "object") return;
    if (schema.enum?.includes("gpt-6-sol")) {
      assert.ok(schema.enum.includes("gpt-6.1-sol")); selections++;
    }
    for (const child of Object.values(schema)) inspect(child);
  }
  for (const tool of listed.result.tools) inspect(tool.inputSchema);
  assert.ok(selections >= 5);
  const result = await client.call("tools/call", { name: "tfo_settings", arguments: {} });
  const settings = JSON.parse(result.result.content[0].text);
  assert.equal(settings.defaultSolModel, "gpt-6.1-sol");
  assert.equal(settings.models["gpt-6-sol"].explicitOnly, true);
  assert.equal(settings.models["gpt-6-sol"].replacement, "gpt-6.1-sol");
});

async function createClient(t, extraEnv = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-test-"));
  const child = spawn(process.execPath, [path.join(runtime, "server.mjs")], {
    env: { ...process.env, TFO_DATA_DIR: dataDir, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const waiting = new Map();
  let sequence = 0;
  lines.on("line", line => {
    const message = JSON.parse(line);
    const resolve = waiting.get(message.id);
    if (resolve) { waiting.delete(message.id); resolve(message); }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, error => error && reject(error));
    setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); reject(new Error(`Timeout calling ${method}`)); } }, 10000).unref();
  });
  t.after(async () => {
    child.kill();
    await once(child, "exit").catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { call, dataDir };
}

test("initializes as MCP and exposes the first route tools", async t => {
  const client = await createClient(t);
  const initialized = await client.call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(initialized.result.protocolVersion, "2025-03-26");
  assert.equal(initialized.result.serverInfo.name, "tfo");
  const listed = await client.call("tools/list");
  assert.deepEqual(listed.result.tools.map(tool => tool.name), [
    "tfo_parallel_prepare", "tfo_parallel_bind", "tfo_parallel_set_parallelism", "tfo_parallel_start", "tfo_parallel_status", "tfo_parallel_pause", "tfo_parallel_resume", "tfo_parallel_cancel",
    "tfo_native_prepare", "tfo_native_claim", "tfo_native_acknowledge", "tfo_native_observe", "tfo_native_status", "tfo_native_fail",
    "tfo_native_wait", "tfo_native_results", "tfo_native_defer_dispatch", "tfo_native_revise", "tfo_native_checkpoint", "tfo_native_finish", "tfo_native_pause", "tfo_native_resume", "tfo_native_cancel", "tfo_native_reconcile", "tfo_native_recover",
    "tfo_health", "tfo_connection_check", "tfo_connection_panel", "tfo_ui_diagnostic", "tfo_queue_start", "tfo_queue_status", "tfo_queue_pause", "tfo_queue_cancel", "tfo_queue_resume", "tfo_queue_reconcile",
    "tfo_project_prepare", "tfo_project_status", "tfo_project_pause", "tfo_project_resume", "tfo_project_cancel", "tfo_project_recover",
    "tfo_start", "tfo_get_status", "tfo_pause", "tfo_resume", "tfo_cancel",
    "tfo_chat_start", "tfo_catalog", "tfo_preview", "tfo_budgeted_chat_start", "tfo_chat_status", "tfo_chat_complete", "tfo_chat_pause", "tfo_chat_resume", "tfo_chat_cancel",
    "tfo_settings", "tfo_options", "tfo_work_prepare", "tfo_settings_read", "tfo_settings_update", "tfo_measurements",
  ]);
});

test("normal Chat connection tools expose a read-only MCP Apps panel without arming Codex delivery", async t => {
  const client = await createClient(t);
  const result = await client.call("tools/call", { name: "tfo_connection_check", arguments: { surface: "chatgpt-chat" } });
  assert.equal(result.result.structuredContent.mcpConnected, true);
  assert.equal(result.result.structuredContent.sendEnabled, false);
  assert.equal(result.result.structuredContent.automaticDelivery, "adapter_missing");
  const invalid = await client.call("tools/call", { name: "tfo_connection_check", arguments: { surface: "unknown" } });
  assert.equal(invalid.result.isError, true);
  const listed = await client.call("resources/list");
  const resource = await client.call("resources/read", { uri: listed.result.resources[0].uri });
  assert.match(resource.result.contents[0].text, /ui\/initialize/);
  assert.doesNotMatch(resource.result.contents[0].text, /ui\/message|sendFollowUpMessage|tools\/call/);
  const unknown = await client.call("resources/read", { uri: "file:///other" });
  assert.equal(unknown.error.code, -32602);
  const start = await client.call("tools/call", { name: "tfo_queue_start", arguments: { surface: "chatgpt-chat" } });
  assert.equal(start.result.isError, true);
  assert.match(start.result.content[0].text, /No queue was armed/);
});

test("Codex capability diagnostic distinguishes supervised selection from independent main return", async t => {
  const client = await createClient(t);
  const result = await client.call("tools/call", { name: "tfo_connection_check", arguments: { surface: "codex" } });
  const capabilities = result.result.structuredContent;
  assert.equal(capabilities.perTaskSelection.unattended, false);
  assert.match(capabilities.parallelProjects.mainJoin, /independent_deferred_return/);
  assert.equal(capabilities.parallelProjects.mainSelectionChange, "guarded_visible_composer_connected_live_unverified");
  assert.equal(capabilities.parallelProjects.branchIsolation, "unverified");
  assert.ok(capabilities.blockers.some(item => item.includes("Web delivery")));
});

test("desktop diagnostic is read-only and reports access from the MCP process", async t => {
  const client = await createClient(t);
  const result = await client.call("tools/call", { name: "tfo_ui_diagnostic", arguments: {} });
  assert.equal(result.result.isError, undefined);
  assert.match(result.result.structuredContent.status, /^(observed|unavailable)$/);
  const diagnostic = result.result.structuredContent;
  assert.ok(diagnostic.windowCount === null || typeof diagnostic.windowCount === "number");
  if (diagnostic.windowCount === null) {
    assert.equal(diagnostic.status, "unavailable");
    assert.equal(diagnostic.readinessChecked, false);
    assert.ok(diagnostic.reason);
  }
});

test("health returns readiness without logging to stdout", async t => {
  const client = await createClient(t);
  const result = await client.call("tools/call", { name: "tfo_health", arguments: {} });
  assert.equal(result.result.structuredContent.ok, true);
  assert.match(result.result.structuredContent.dataDir, /tfo-test-/);
});

test("rejects routes with missing project paths and unsupported models", async t => {
  const client = await createClient(t);
  const missingPath = await client.call("tools/call", { name: "tfo_start", arguments: {
    objective: "Test", projectPath: path.join(os.tmpdir(), "tfo-does-not-exist"),
    steps: [{ title: "Do it", instruction: "Run it" }],
  } });
  assert.equal(missingPath.result.isError, true);
  const unsupportedModel = await client.call("tools/call", { name: "tfo_start", arguments: {
    objective: "Test", projectPath: os.tmpdir(),
    steps: [{ title: "Do it", instruction: "Run it", model: "not-a-model" }],
  } });
  assert.equal(unsupportedModel.result.isError, true);
});

test("saved legacy routes can resume while new legacy entry points redirect to policy-aware tools", async t => {
  const client = await createClient(t, { TFO_CODEX_COMMAND: "tfo-codex-command-that-does-not-exist" });
  const started = await client.call("tools/call", { name: "tfo_start", arguments: {
    objective: "Exercise persisted route state",
    projectPath: os.tmpdir(),
    constraints: "No external actions",
    steps: [{ id: "first", title: "First bounded step", instruction: "Do not modify files", model: "gpt-6-luna", reasoning: "high" }],
  } });
  assert.equal(started.result.isError, true);
  assert.match(started.result.content[0].text, /legacy entry point/);
  const id = "route_legacy_saved", dir = path.join(client.dataDir, "runs", id);
  fs.mkdirSync(dir, { recursive: true });
  const initial = { model: "gpt-6-luna", reasoning: "high" };
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ id, status: "paused", projectPath: os.tmpdir(), objective: "Saved legacy route",
    steps: [{ id: "first", title: "First bounded step", instruction: "Do not modify files", ...initial }], currentIndex: 0, completedSteps: [],
    execution: { current: initial, ceiling: initial }, modelDecisions: [], startedAt: new Date().toISOString() }));
  const resumed = await client.call("tools/call", { name: "tfo_resume", arguments: { runId: id } });
  const route = resumed.result.structuredContent;
  assert.equal(route.status, "running");
  assert.equal(route.totalSteps, 1);
  assert.equal(route.currentStep.model, "gpt-6-luna");

  let status;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    status = await client.call("tools/call", { name: "tfo_get_status", arguments: { runId: route.id } });
    if (status.result.structuredContent.status === "needs_ai") break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(status.result.structuredContent.status, "needs_ai");
  assert.match(status.result.structuredContent.error, /ENOENT/i);
});
