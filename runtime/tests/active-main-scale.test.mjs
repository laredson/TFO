import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNativeFlow } from "../native-flow.mjs";
import { canonicalPath } from "../project-workspace.mjs";
import { createSettingsStore } from "../settings.mjs";

const main = "11111111-1111-1111-1111-111111111111";
const coordinatorSelection = { model: "gpt-6.1-sol", reasoning: "high" };
const workerSelection = { model: "gpt-6-luna", reasoning: "low" };
const workerId = index => `worker${String(index).padStart(3, "0")}`;
const workerThread = index => `22222222-2222-2222-2222-${String(index + 1).padStart(12, "0")}`;

function fixture(t, count) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-active-scale-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "release"));
  const lanes = Array.from({ length: count }, (_, index) => {
    const id = workerId(index), workspace = path.join(root, id); fs.mkdirSync(workspace);
    return { id, title: `Worker ${index + 1}`, workspace, access: "write" };
  });
  const nodes = lanes.flatMap(lane => [
    { id: `${lane.id}_first`, lane: lane.id, prompt: "Produce the first verified component", dependencies: [], selection: workerSelection },
    { id: `${lane.id}_next`, lane: lane.id, prompt: "Review and extend the previous component", dependencies: [`${lane.id}_first`], selection: workerSelection },
  ]);
  nodes.push({ id: "join", lane: "main", prompt: "Integrate all verified components", dependencies: lanes.map(lane => `${lane.id}_next`), selection: coordinatorSelection });
  const workspace = canonicalPath(root);
  const states = new Map([[main, { threadId: main, workspace, ...coordinatorSelection, active: true,
    lastTurnId: "main-source", userMessageCount: 1, completedTurnId: null }]]);
  const receipts = new Map(), actions = new Map();
  const host = {
    read: async thread => { const state = states.get(thread); assert.ok(state, `unknown mock host thread ${thread}`); return state; },
    bootstrap: async (thread, prompt) => receipts.get(`${thread}:${prompt}`),
    receipt: async (thread, turn) => receipts.get(`${thread}:${turn}`) || {},
    find: async () => [],
    send: async () => { throw new Error("Scale fixture forbids external dispatch"); },
  };
  const dataDir = path.join(root, "data"), flow = createNativeFlow({ dataDir, host });
  const args = { surface: "codex", projectId: main, mainThreadId: main, projectPath: root,
    objective: "Coordinate independent two-step chains and verify one final integration", initialSelection: coordinatorSelection,
    workspaceMode: "scratch_folders", mainWorkspace: path.join(root, "release"), lanes, nodes };
  const dispatch = async (runId, index, step) => {
    const nodeId = `${workerId(index)}_${step}`, action = await flow.claim(runId, nodeId), thread = workerThread(index);
    assert.equal(action.tool, step === "first" ? "create_thread" : "send_message_to_thread");
    if (step !== "first") assert.equal(action.args.threadId, thread, "each chain must reuse its original chat");
    states.set(thread, { threadId: thread, workspace, active: true, lastTurnId: `${nodeId}-turn`, userMessageCount: 0,
      model: action.args.model, reasoning: action.args.thinking, completedTurnId: states.get(thread)?.completedTurnId || null });
    await flow.acknowledge(runId, nodeId, thread);
    actions.set(nodeId, action);
    return action;
  };
  const complete = (index, step, summary = `${workerId(index)} ${step} verified`) => {
    const nodeId = `${workerId(index)}_${step}`, action = actions.get(nodeId), thread = workerThread(index), state = states.get(thread);
    assert.ok(action, "only an acknowledged action can have a host completion");
    const report = { status: "completed", summary, files: [`${workerId(index)}/${step}.txt`], evidence: `evidence-${nodeId}` };
    const receipt = { turnId: state.lastTurnId, completed: true, bootstrapVerified: true, userMessageCount: 0,
      model: state.model, reasoning: state.reasoning, finalResponse: JSON.stringify(report), usage: { input_tokens: 20, output_tokens: 10 } };
    receipts.set(`${thread}:${action.args.prompt}`, receipt); receipts.set(`${thread}:${state.lastTurnId}`, receipt);
    Object.assign(state, { active: false, completedTurnId: state.lastTurnId });
    return receipt;
  };
  const finishMain = marker => {
    const state = states.get(main), receipt = { turnId: state.lastTurnId, completed: true, userMessageCount: 1,
      ...coordinatorSelection, finalResponse: `All components integrated and verified\n${marker}` };
    receipts.set(`${main}:${state.lastTurnId}`, receipt); Object.assign(state, { active: false, completedTurnId: state.lastTurnId });
  };
  return { root, dataDir, args, flow, states, dispatch, complete, finishMain };
}

test("one hundred real scratch lanes complete two-step chains with lossless bounded event/result pages", { timeout: 180000 }, async t => {
  const f = fixture(t, 100), prepared = await f.flow.prepare({ ...f.args, maxParallelWorkers: 100 }), runId = prepared.id;
  assert.equal(prepared.lanes.length, 101); assert.equal(prepared.nodes.length, 201);
  assert.equal(prepared.maxParallelWorkers, 100); assert.equal(prepared.coordinationMode, "active_main");
  for (let index = 0; index < 100; index++) await f.dispatch(runId, index, "first");
  const initial = f.flow.compact(runId), beginningCursor = initial.cursor;
  assert.equal(initial.counts.queued, 100); assert.equal(initial.activeNodeIds.length, 20);
  assert.equal(initial.coordinator.turnId, "main-source");
  assert.ok(JSON.stringify(initial).length < 6000);

  // Multiplication by 37 permutes 0..99. Each observation receives completions
  // from a different slice, exercising early results independently of lane order.
  const completionOrder = Array.from({ length: 100 }, (_, index) => (index * 37) % 100);
  const largeSummary = `full worker evidence ${"x".repeat(20000)}`;
  for (let offset = 0; offset < completionOrder.length; offset += 25) {
    for (const index of completionOrder.slice(offset, offset + 25)) f.complete(index, "first", index === 0 ? largeSummary : undefined);
    assert.equal((await f.flow.observe(runId)).status, "running");
    assert.equal(f.states.get(main).active, true);
  }
  let cursor = beginningCursor; const deliveredEvents = [], pageCursors = [];
  for (let page = 0; page < 10; page++) {
    const changes = await f.flow.wait(runId, { afterCursor: cursor, timeoutMs: 0 });
    assert.equal(changes.cursorExpired, false); assert.ok(changes.events.length <= 20);
    assert.ok(JSON.stringify(changes).length < 6000, "wait responses must not include full worker evidence");
    deliveredEvents.push(...changes.events); pageCursors.push(changes.cursor);
    assert.ok(changes.cursor > cursor); cursor = changes.cursor;
    if (!changes.hasMore) break;
  }
  const completedEvents = deliveredEvents.filter(event => event.type === "completed");
  assert.equal(completedEvents.length, 100); assert.equal(pageCursors.length, 5);
  assert.equal(new Set(deliveredEvents.map(event => event.cursor)).size, deliveredEvents.length, "event cursors never duplicate");
  assert.deepEqual(new Set(completedEvents.map(event => event.nodeId)), new Set(f.args.lanes.map(lane => `${lane.id}_first`)));
  assert.equal(cursor, f.flow.compact(runId).cursor);
  assert.equal((await f.flow.wait(runId, { afterCursor: cursor, timeoutMs: 0 })).events.length, 0);

  const pagedIds = [];
  for (let page = 0; page !== null; ) {
    const results = await f.flow.results(runId, { page });
    assert.equal(results.total, 201); assert.ok(results.nodes.length <= 20);
    assert.ok(results.nodes.every(node => !node.summary || node.summary.length <= 300));
    assert.ok(JSON.stringify(results).length < 12000);
    pagedIds.push(...results.nodes.map(node => node.id)); page = results.nextPage;
  }
  assert.equal(pagedIds.length, 201); assert.equal(new Set(pagedIds).size, 201);
  const detailed = await f.flow.results(runId, { nodeId: "worker000_first" });
  assert.equal(detailed.checkpoint.report.summary, largeSummary);
  assert.equal(JSON.parse(detailed.checkpoint.response).summary, largeSummary);

  for (const index of [...completionOrder].reverse()) {
    const action = await f.dispatch(runId, index, "next");
    assert.ok(action.args.prompt.length < 10000, "continuations receive references and bounded summaries");
    assert.ok(!action.args.prompt.includes(largeSummary));
  }
  assert.equal(f.flow.compact(runId).counts.queued, 100);
  for (const index of completionOrder) f.complete(index, "next");
  await f.flow.observe(runId);
  assert.deepEqual(f.flow.compact(runId).readyNodeIds, ["join"]);
  const finish = await f.flow.finish(runId, { nodeId: "join", summary: "All one hundred components integrated" });
  assert.equal(finish.status, "running"); assert.equal(finish.coordinator.turnId, "main-source");
  f.finishMain(finish.mainCompleteMarker);
  const final = await f.flow.observe(runId);
  assert.equal(final.status, "completed"); assert.equal(final.nodes.filter(node => node.status === "completed").length, 201);
  assert.equal(final.nodes.at(-1).checkpoint.verification, "active_main_final_host_receipt");
  assert.equal(final.coordinator.recovery.attempts.length, 0);
});

test("default two-worker limit is enforced; run-local one hundred is allowed and one hundred one is rejected", async t => {
  const f = fixture(t, 3);
  await assert.rejects(f.flow.prepare({ ...f.args, maxParallelWorkers: 101 }), /1-100/);
  const runId = (await f.flow.prepare(f.args)).id;
  assert.equal(f.flow.compact(runId).maxParallelWorkers, 2);
  await f.dispatch(runId, 0, "first"); await f.dispatch(runId, 1, "first");
  await assert.rejects(f.flow.claim(runId, "worker002_first"), /limit/);
  await assert.rejects(f.flow.setParallelism(runId, 100), /explicit user/);
  await f.flow.setParallelism(runId, 100, true);
  assert.equal(f.flow.compact(runId).maxParallelWorkers, 100);
  assert.equal(createSettingsStore(f.dataDir).read().maxParallelWorkers, 2, "a run override preserves the global default");
  await f.dispatch(runId, 2, "first");
  await assert.rejects(f.flow.setParallelism(runId, 101, true), /1-100/);
  assert.equal(f.flow.compact(runId).maxParallelWorkers, 100);
});
