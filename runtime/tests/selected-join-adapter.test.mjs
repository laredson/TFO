import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createSelectedJoinAdapter } from "../selected-join-adapter.mjs";
import { verifyUiSendGuard } from "../ui-send-guard.mjs";
import { snapshotNativeJoin } from "../native-join-supervisor.mjs";
import { snapshotSupervisor } from "../supervisor-launch.mjs";
import { snapshotProjectSupervisor } from "../project-supervisor.mjs";

const threadId = "11111111-1111-1111-1111-111111111111", sourceTurnId = "source-turn";
const runId = "flow_selected_test", marker = `TFO_MAIN_JOIN ${runId} ${threadId}`;
const sourceSelection = { model: "gpt-6-astra", reasoning: "high" };
const requestedSelection = { model: "gpt-6-sol", reasoning: "medium" };
const layout = { window: [0, 0, 1200, 900], marker: [400, 500, 200, 30],
  editor: [300, 700, 700, 100], selector: [800, 820, 150, 30] };

function guardFixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-selected-guard-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const dir = path.join(dataDir, "native-flows"); fs.mkdirSync(dir);
  const stateFile = path.join(dir, `${runId}.json`), ownerPid = process.pid;
  const state = { id: runId, status: "running", mainThreadId: threadId, mainJoinMarker: marker,
    deferredJoin: { status: "dispatching", transport: "selected_join", ownerPid,
      sourceTurnId, sourceUserMessageCount: 1, sourceSelection, requestedSelection,
      selectionReason: "Integración acotada", nodeId: "join", marker },
    nodes: [{ id: "join", status: "dispatching", deliveryKind: "selected_join", selection: requestedSelection,
      visiblePrompt: "Integrar" }],
    lanes: [{ id: "main", threadId, hostWorkspace: dataDir, selection: sourceSelection }] };
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state)); save();
  const host = { workspace: dataDir, active: false, lastTurnId: sourceTurnId, completedTurnId: sourceTurnId,
    userMessageCount: 1, ...sourceSelection };
  const deps = { readThread: async () => host,
    reservationStore: () => ({ get: () => ({ status: "held", claims: [{ key: `chat:${threadId}` }] }) }) };
  const check = () => verifyUiSendGuard(stateFile, runId, sourceTurnId, ownerPid, deps);
  return { state, host, save, check, stateFile, deps, ownerPid };
}

test("flow UI guard verifies owner, reservation, exact chat, source and requested selection", async t => {
  const f = guardFixture(t);
  assert.equal((await f.check()).threadId, threadId);
  for (const mutate of [
    () => { f.state.deferredJoin.ownerPid++; },
    () => { f.state.deferredJoin.ownerPid--; f.state.lanes[0].threadId = "22222222-2222-2222-2222-222222222222"; },
    () => { f.state.lanes[0].threadId = threadId; f.state.deferredJoin.requestedSelection = sourceSelection; },
    () => { f.state.deferredJoin.requestedSelection = requestedSelection; f.host.userMessageCount++; },
  ]) {
    mutate(); f.save(); await assert.rejects(f.check());
  }
  f.host.userMessageCount = 1;
  f.deps.reservationStore = () => ({ get: () => ({ status: "needs_review", claims: [] }) });
  await assert.rejects(f.check(), /reservation/);
  await assert.rejects(verifyUiSendGuard(f.stateFile, runId, sourceTurnId, f.ownerPid + 1, f.deps));
});

function adapterFixture(overrides = {}) {
  const calls = [];
  let sent = false;
  const adapter = createSelectedJoinAdapter({
    readThread: async () => ({ active: false, lastTurnId: sourceTurnId, completedTurnId: sourceTurnId,
      userMessageCount: 1, ...sourceSelection }),
    readReceipt: async () => ({ completed: true, finalResponse: `Ready ${marker}` }),
    readTurn: async () => sent ? { lastTurnId: "new-turn", selectionTurnId: "new-turn", ...requestedSelection }
      : { lastTurnId: sourceTurnId, completedTurnId: sourceTurnId },
    containsPrompt: async () => true,
    checkCapability: async () => ({ selectionSupported: true, guardedTarget: true }),
    guard: async () => { calls.push("guard"); },
    ui: async mode => { calls.push(mode); if (mode === "send") sent = true;
      return mode === "probe" ? { status: "ready", selector: "GPT-6 Astra Alto", editorEmpty: true, layout }
        : { status: "attempted", selector: "GPT-6 Sol Medio" }; },
    wait: async () => {}, confirmationPollMs: 1, confirmationTimeoutMs: 2, ...overrides,
  });
  const args = { threadId, prompt: "Integrar\nresultado", sourceTurnId, sourceUserMessageCount: 1,
    sourceSelection, requestedSelection, marker, ownerPid: process.pid, runId, dataDir: "unused" };
  return { adapter, args, calls };
}

test("capability preflight works while source turn is active and never opens the UI", async () => {
  const f = adapterFixture({ readThread: async () => { throw new Error("must not read source at arm"); } });
  const access = await f.adapter.preflight(f.args);
  assert.equal(access.readinessChecked, undefined);
  assert.equal(access.sourceTurnMayStillBeActive, true);
  assert.deepEqual(f.calls, []);
});

test("selected adapter sends once and confirms exact prompt and selected turn", async () => {
  const f = adapterFixture();
  const result = await f.adapter.send(f.args);
  assert.equal(result.turnId, "new-turn");
  assert.equal(result.selectionConfirmed, true);
  assert.deepEqual(f.calls, ["guard", "guard", "probe", "guard", "probe", "guard", "send"]);
});

test("missing source marker, wrong visible chat and changed host selection send nothing", async () => {
  const missing = adapterFixture({ readReceipt: async () => ({ completed: true, finalResponse: "No marker" }) });
  await assert.rejects(missing.adapter.send(missing.args), /unique join marker/);
  assert.ok(!missing.calls.includes("send"));
  const wrongChat = adapterFixture({ ui: async mode => { wrongChat.calls.push(mode);
    return { status: "awaiting_render", reason: "route_marker_not_visible" }; } });
  await assert.rejects(wrongChat.adapter.send(wrongChat.args), /read-only wait/);
  assert.ok(!wrongChat.calls.includes("send"));
  const changed = adapterFixture({ readThread: async () => ({ active: false, lastTurnId: "other", completedTurnId: "other",
    userMessageCount: 2, ...sourceSelection }) });
  await assert.rejects(changed.adapter.send(changed.args), /source turn changed/);
  assert.ok(!changed.calls.includes("send"));
});

test("uncertain UI attempt and wrong observed model never fall back or retry", async () => {
  let attempts = 0;
  const uncertain = adapterFixture({ ui: async mode => { uncertain.calls.push(mode);
    if (mode === "probe") return { status: "ready", selector: "GPT-6 Astra Alto", editorEmpty: true, layout };
    attempts++; return { status: "attempted", selector: "GPT-6 Astra Alto" }; } });
  await assert.rejects(uncertain.adapter.send(uncertain.args), /uncertain/);
  assert.equal(attempts, 1);
  const wrong = adapterFixture({ readTurn: async () => ({ lastTurnId: "new-turn", selectionTurnId: "new-turn",
    model: "gpt-6-astra", reasoning: "high" }) });
  await assert.rejects(wrong.adapter.send(wrong.args), /wrong model\/effort/);
  assert.equal(wrong.calls.filter(x => x === "send").length, 1);
});

test("immutable join snapshot carries the UI adapter and guard dependencies", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-selected-snapshot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const snapshot = snapshotNativeJoin(dir);
  for (const name of ["selected-join-adapter.mjs", "queue-transport.mjs", "ui-send-guard.mjs", "ui-bridge.ps1"])
    assert.ok(fs.existsSync(path.join(snapshot, name)), name);
  const copied = await import(pathToFileURL(path.join(snapshot, "project-host.mjs")).href);
  assert.equal(typeof copied.nativeProjectHost.selectedJoin.send, "function");
  fs.appendFileSync(path.join(snapshot, "ui-send-guard.mjs"), "\n// tampered");
  assert.throws(() => snapshotNativeJoin(dir), /integrity/);
});

test("queue and project snapshots load the transitive adapter and guard imports", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-all-snapshots-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const snapshot of [snapshotSupervisor(dir).root, snapshotProjectSupervisor(dir)]) {
    const guard = await import(pathToFileURL(path.join(snapshot, "ui-send-guard.mjs")).href);
    const host = await import(pathToFileURL(path.join(snapshot, "project-host.mjs")).href);
    assert.equal(typeof guard.verifyUiSendGuard, "function");
    assert.equal(typeof host.nativeProjectHost.selectedJoin.send, "function");
  }
});

test("join guard rechecks worker completion immediately before UI mutation", async t => {
  const f = guardFixture(t);
  f.state.nodes.push({ id: "worker", status: "queued", checkpoint: null });
  f.save();
  await assert.rejects(f.check(), /prerequisites/);
  Object.assign(f.state.nodes[1], { status: "completed", checkpoint: { turnId: "worker-result" } });
  f.save();
  assert.equal((await f.check()).threadId, threadId);
});
