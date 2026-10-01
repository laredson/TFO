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
  assert.equal((await post("settings", { patch: { allowUpgrades: true }, confirmation: UPGRADE_WARNING })).status, 409);
  const { challenge } = await (await post("upgrade-confirmation", {})).json();
  const accepted = await post("settings", { patch: { allowUpgrades: true, upgradeCeiling: { model: "gpt-6-sol", reasoning: "medium" } }, confirmation: UPGRADE_WARNING, challenge });
  assert.equal((await accepted.json()).allowUpgrades, true);
  await post("settings", { patch: { allowUpgrades: false } });
  assert.equal((await post("settings", { patch: { allowUpgrades: true }, confirmation: UPGRADE_WARNING, challenge })).status, 409);
  assert.equal((await post("settings", { patch: { command: "untrusted" } })).status, 400);
  const html = await (await fetch(panel.origin)).text();
  assert.match(html, /ESTO GASTARÁ MÁS TOKENS/);
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
