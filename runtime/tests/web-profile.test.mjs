import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createWebQueueStore } from "../web-queue.mjs";
import { createWebHandler } from "../web-server.mjs";

const requestId = "11111111-2222-3333-4444-555555555555";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-web-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const args = { requestId, chatUrl: "https://chatgpt.com/c/6a76fc5c-5c84-83e8-a218-55de46b18d29", projectLabel: "IGTAP Mod", objective: "Preparar análisis y revisión",
    steps: ["Análisis", "Revisión"].map(title => ({ title, prompt: `Realizar ${title}`, selection: { modelLabel: "Modelo visible", effortLabel: "Very High" } })) };
  return { dir, args, store: createWebQueueStore(dir), handle: createWebHandler(dir) };
}
test("web queue persists exact labels, is idempotent and never claims an executed turn", t => {
  const f = fixture(t);
  const state = f.store.prepare(f.args);
  assert.equal(state.status, "awaiting_host_adapter");
  assert.equal(state.confirmedSends, 0);
  assert.equal(state.targetVerified, false);
  assert.equal(state.sendEnabled, false);
  assert.equal(state.steps[0].selection.effortLabel, "Very High");
  assert.deepEqual(f.store.prepare(f.args), state);
  assert.deepEqual(createWebQueueStore(f.dir).get(state.id), state);
  assert.throws(() => f.store.prepare({ ...f.args, objective: "Different" }), /different plan/);
  assert.equal(f.store.cancel(state.id).status, "cancelled");
  assert.equal(f.store.prepare(f.args).status, "cancelled");
  assert.equal(f.store.cancel(state.id).revision, 2);
});
test("web queue rejects foreign URLs, traversal and invalid prompts before storage", t => {
  const f = fixture(t);
  for (const chatUrl of ["https://evil.invalid/c/" + requestId, "https://chatgpt.com/c/" + requestId + "?key=secret", "file:///C:/other"]) {
    assert.throws(() => f.store.prepare({ ...f.args, chatUrl }));
  }
  assert.throws(() => f.store.prepare({ ...f.args, requestId: "../other" }));
  assert.throws(() => f.store.prepare({ ...f.args, steps: [] }));
  assert.throws(() => f.store.get("../../other"));
  assert.equal(fs.existsSync(path.join(f.dir, "web-queues")), false);
});
test("web MCP exposes only the private profile, UI resources and persistent preparation", async t => {
  const f = fixture(t);
  const call = (method, params = {}) => f.handle({ jsonrpc: "2.0", id: 1, method, params });
  const init = await call("initialize", { protocolVersion: "2025-11-25" });
  assert.equal(init.result.serverInfo.name, "tfo-web");
  const tools = (await call("tools/list")).result.tools;
  assert.equal(tools.length, 7);
  assert.ok(tools.every(tool => tool.outputSchema && tool.annotations));
  for (const name of ["tfo_start", "tfo_queue_start", "tfo_catalog"]) {
    assert.equal((await call("tools/call", { name, arguments: {} })).result.isError, true);
  }
  const health = (await call("tools/call", { name: "tfo_health" })).result.structuredContent;
  assert.equal(health.profile, "private-web");
  assert.equal(health.automaticDelivery, false);
  const prepared = (await call("tools/call", { name: "tfo_web_prepare", arguments: f.args })).result.structuredContent;
  const panel = (await call("tools/call", { name: "tfo_web_panel", arguments: { runId: prepared.id } })).result;
  assert.equal(panel.structuredContent.steps.length, 2);
  const uri = tools.find(tool => tool.name === "tfo_web_panel")._meta.ui.resourceUri;
  const resource = (await call("resources/read", { uri })).result.contents[0];
  assert.equal(resource.mimeType, "text/html;profile=mcp-app");
  assert.doesNotMatch(resource.text, /ui\/message|sendFollowUpMessage|innerHTML/);
  const denied = await call("resources/read", { uri: "file:///C:/secret" });
  assert.equal(denied.error.code, -32602);
});
test("web stdio entry speaks MCP without starting the Codex runtime", t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../web-server.mjs", import.meta.url))], {
    input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tfo_health" } }) + "\n",
    encoding: "utf8", timeout: 5000, windowsHide: true, env: { ...process.env, TFO_WEB_DATA_DIR: f.dir },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result.structuredContent.profile, "private-web");
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test("web panel negotiates, renders escaped prompts and only cancels on user action", async t => {
  const f = fixture(t), state = f.store.prepare(f.args);
  state.steps[0].prompt = '<script>untrusted prompt</script>';
  const html = fs.readFileSync(new URL("../ui/web-queue.html", import.meta.url), "utf8");
  const sent = [], labels = {};
  const element = () => ({ children: [], disabled: true, append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; } });
  let handler;
  const parent = { postMessage: value => sent.push(value) };
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    window: { parent, addEventListener: (_type, fn) => { handler = fn; } },
    document: { getElementById: id => labels[id] ||= element(), createElement: element },
    setTimeout: () => 1, clearTimeout() {},
  });
  const initialized = { jsonrpc: "2.0", id: sent[0].id, result: {} };
  handler({ source: {}, data: initialized });
  await Promise.resolve();
  assert.equal(sent.length, 1);
  handler({ source: parent, data: initialized });
  await Promise.resolve();
  handler({ source: parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: state } } });
  assert.equal(labels.steps.children[0].children[2].textContent, state.steps[0].prompt);
  assert.equal(labels.cancel.disabled, false);
  assert.deepEqual(sent.map(item => item.method), ["ui/initialize", "ui/notifications/initialized"]);
  const pending = labels.cancel.onclick();
  const last = sent.at(-1);
  assert.equal(last.method, "tools/call");
  assert.equal(last.params.name, "tfo_web_cancel");
  handler({ source: parent, data: { jsonrpc: "2.0", id: last.id, result: { structuredContent: f.store.cancel(state.id) } } });
  await pending;
  assert.equal(labels.cancel.disabled, true);
  assert.match(labels.status.textContent, /cancelada/);
  assert.equal(sent.length, 3);
});
