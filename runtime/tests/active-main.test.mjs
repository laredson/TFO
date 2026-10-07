import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createNativeFlow } from "../native-flow.mjs";
import { canonicalPath } from "../project-workspace.mjs";
import { createSettingsStore } from "../settings.mjs";

const main = "11111111-1111-1111-1111-111111111111", a = "22222222-2222-2222-2222-222222222222", b = "33333333-3333-3333-3333-333333333333";
const sol = { model: "gpt-6.1-sol", reasoning: "high" }, luna = { model: "gpt-6-luna", reasoning: "medium" };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-active-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ["a", "b", "release"]) fs.mkdirSync(path.join(root, dir));
  const states = new Map([main, a, b].map(id => [id, { workspace: canonicalPath(root), ...sol,
    threadId: id, lastTurnId: "source", completedTurnId: null, active: id === main, userMessageCount: 1 }]));
  const receipts = new Map(), queued = [], matches = new Map(); let time = 1000000;
  const host = { read: async id => states.get(id), bootstrap: async (id, prompt) => receipts.get(`${id}:${prompt}`),
    find: async (_id, prompt) => matches.get(prompt) || [], receipt: async (id, turnId) => receipts.get(`${id}:${turnId}`) || {},
    send: async (id, prompt) => { queued.push({ id, prompt }); return { queueMessageId: `q${queued.length}` }; } };
  const dataDir = path.join(root, "data"), flow = createNativeFlow({ dataDir, host, now: () => time });
  const args = { surface: "codex", objective: "Coordinate and integrate", projectId: main, mainThreadId: main,
    projectPath: root, workspaceMode: "scratch_folders", mainWorkspace: path.join(root, "release"), initialSelection: sol,
    lanes: ["a", "b"].map(id => ({ id, workspace: path.join(root, id), access: "write" })),
    nodes: [{ id: "a1", lane: "a", prompt: "First A", dependencies: [], selection: luna },
      { id: "a2", lane: "a", prompt: "Continue A", dependencies: ["a1"], selection: luna },
      { id: "b1", lane: "b", prompt: "First B", dependencies: [], selection: luna },
      { id: "join", lane: "main", prompt: "Integrate", dependencies: ["a2", "b1"], selection: sol }] };
  const finishWorker = (id, action, report = { status: "completed", summary: "Checked" }) => {
    const turnId = `turn-${receipts.size}`;
    const receipt = { turnId, completed: true, bootstrapVerified: true, model: action.args.model, reasoning: action.args.thinking,
      finalResponse: JSON.stringify(report), usage: { input_tokens: 20, output_tokens: 10 } };
    receipts.set(`${id}:${action.args.prompt}`, receipt); receipts.set(`${id}:${turnId}`, receipt);
    Object.assign(states.get(id), { lastTurnId: turnId, completedTurnId: turnId, active: false, model: receipt.model, reasoning: receipt.reasoning });
  };
  const finishMain = (marker, override = {}) => {
    const current = states.get(main), receipt = { turnId: current.lastTurnId, completed: true, userMessageCount: current.userMessageCount,
      model: current.model, reasoning: current.reasoning, finalResponse: `Integrated and verified\n${marker}`, ...override };
    receipts.set(`${main}:${current.lastTurnId}`, receipt); Object.assign(current, { active: false, completedTurnId: current.lastTurnId });
  };
  const dispatch = async (id, node, thread) => { const action = await flow.claim(id, node); await flow.acknowledge(id, node, thread); return action; };
  return { root, dataDir, args, flow, host, states, receipts, queued, matches, finishWorker, finishMain, dispatch,
    advance: ms => { time += ms; }, newEngine: () => createNativeFlow({ dataDir, host, now: () => time }) };
}

test("active main default keeps sequential worker chains moving and finalizes in the source turn", async t => {
  const f = fixture(t), state = await f.flow.prepare(f.args), id = state.id;
  assert.equal(state.coordinationMode, "active_main");
  const first = await f.dispatch(id, "a1", a), other = await f.dispatch(id, "b1", b);
  f.finishWorker(a, first); await f.flow.observe(id);
  const next = await f.dispatch(id, "a2", a);
  assert.equal(next.tool, "send_message_to_thread");
  assert.equal(f.states.get(main).active, true);
  assert.doesNotMatch(next.args.prompt, /"response":/);
  f.finishWorker(a, next); f.finishWorker(b, other); await f.flow.observe(id);
  await assert.rejects(f.flow.claim(id, "join"), /inline/);
  const finishing = await f.flow.finish(id, { summary: "Integrated" });
  assert.equal(finishing.status, "running");
  await assert.rejects(f.flow.setParallelism(id, 1), /unfinished/);
  assert.equal((await f.flow.observe(id)).status, "running");
  f.finishMain(finishing.mainCompleteMarker);
  assert.equal((await f.flow.observe(id)).status, "completed");
  assert.equal(f.flow.status(id).nodes.at(-1).checkpoint.verification, "active_main_final_host_receipt");
  assert.equal(f.queued.length, 0);
});

test("inline completion requires exact source final marker and model receipt", async t => {
  for (const fault of ["marker", "model"]) {
    const f = fixture(t), id = (await f.flow.prepare(f.args)).id;
    const first = await f.dispatch(id, "a1", a); f.finishWorker(a, first);
    const next = await f.dispatch(id, "a2", a), other = await f.dispatch(id, "b1", b);
    f.finishWorker(a, next); f.finishWorker(b, other);
    const finish = await f.flow.finish(id, { summary: "Integrated" });
    f.finishMain(fault === "marker" ? "wrong marker" : finish.mainCompleteMarker, fault === "model" ? luna : {});
    assert.equal((await f.flow.observe(id)).status, "needs_review");
  }
});

test("verified blocked evidence can be resolved by a new remediation without rewriting the attempt", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id;
  const first = await f.dispatch(id, "a1", a); f.finishWorker(a, first, { status: "blocked", summary: "Missing format" });
  const blocked = await f.flow.observe(id), preserved = structuredClone(blocked.nodes[0].checkpoint);
  assert.equal(blocked.status, "running"); assert.equal(blocked.nodes[0].status, "blocked");
  await assert.rejects(f.flow.claim(id, "a2"), /Dependencies/);
  await assert.rejects(f.flow.revise(id, { expectedRevision: blocked.revision, replaceNodes: [{ id: "a1", prompt: "Pretend fixed" }] }), /unattempted/);
  await f.flow.revise(id, { expectedRevision: blocked.revision,
    addNodes: [{ id: "fix", lane: "a", prompt: "Repair format", dependencies: ["a1"], selection: luna }],
    replaceNodes: [{ id: "a2", dependencies: ["fix"] }], resolveBlocked: [{ nodeId: "a1", withNodeId: "fix" }] });
  await assert.rejects(f.flow.revise(id, { expectedRevision: blocked.revision }), /revision changed/);
  const fix = await f.dispatch(id, "fix", a); f.finishWorker(a, fix); await f.flow.observe(id);
  assert.deepEqual(f.flow.status(id).nodes[0].checkpoint, preserved);
  assert.equal(f.flow.status(id).nodes[0].resolution.status, "resolved");
  assert.equal((await f.flow.claim(id, "a2")).tool, "send_message_to_thread");
});

test("compact cursor events and result pages do not repeat full worker reports", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id;
  const first = await f.dispatch(id, "a1", a); f.finishWorker(a, first, { status: "completed", summary: "x".repeat(20000), files: ["full.txt"] });
  const changes = await f.flow.wait(id, { afterCursor: 0, timeoutMs: 0 });
  assert.ok(changes.events.length <= 20); assert.equal(changes.counts.completed, 1);
  assert.ok(JSON.stringify(changes).length < 4000);
  const unchanged = await f.flow.wait(id, { afterCursor: changes.cursor, timeoutMs: 0 }); assert.equal(unchanged.events.length, 0);
  const page = await f.flow.results(id); assert.ok(page.nodes[0].summary.length <= 300);
  assert.equal((await f.flow.results(id, { nodeId: "a1" })).checkpoint.report.summary.length, 20000);
});

test("a 100-lane plan remains compact and cursor batches deliver at most 20 changes", async t => {
  const f = fixture(t);
  f.args.maxParallelWorkers = 100; f.args.lanes = []; f.args.nodes = [];
  for (let i = 0; i < 100; i++) {
    const lane = `w${i}`, workspace = path.join(f.root, lane); fs.mkdirSync(workspace);
    f.args.lanes.push({ id: lane, access: "write", workspace });
    f.args.nodes.push({ id: `${lane}_first`, lane, prompt: `Bounded worker ${i}`, dependencies: [], selection: luna });
  }
  f.args.nodes.push({ id: "join", lane: "main", prompt: "Integrate", dependencies: f.args.nodes.map(node => node.id), selection: sol });
  const id = (await f.flow.prepare(f.args)).id;
  const summary = f.flow.compact(id); assert.equal(summary.maxParallelWorkers, 100); assert.equal(summary.counts.pending, 101);
  assert.equal(summary.readyNodeIds.length, 20); assert.ok(JSON.stringify(summary).length < 6000);
  const page = await f.flow.results(id); assert.equal(page.nodes.length, 20); assert.equal(page.total, 101); assert.equal(page.nextPage, 1);
  for (let i = 0; i < 12; i++) { f.flow.pause(id); await f.flow.resume(id); }
  const first = await f.flow.wait(id, { afterCursor: 0, timeoutMs: 0 }); assert.equal(first.events.length, 20); assert.equal(first.hasMore, true);
  assert.equal(first.nextCursor, first.cursor);
  const next = await f.flow.wait(id, { afterCursor: first.nextCursor, timeoutMs: 0 });
  assert.ok(next.events.every(event => event.cursor > first.nextCursor)); assert.equal(next.hasMore, false);
});

test("concurrency increases require explicit request and reductions preserve active tasks", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id;
  await assert.rejects(f.flow.setParallelism(id, 3), /explicit user/);
  await f.flow.setParallelism(id, 3, true); const aa = await f.dispatch(id, "a1", a), bb = await f.dispatch(id, "b1", b);
  await f.flow.setParallelism(id, 1); assert.equal(f.flow.compact(id).activeNodeIds.length, 2);
  f.finishWorker(a, aa); await f.flow.observe(id);
  await assert.rejects(f.flow.claim(id, "a2"), /limit/);
  f.finishWorker(b, bb); await f.flow.observe(id); assert.equal((await f.flow.claim(id, "a2")).tool, "send_message_to_thread");
});

test("human worker cap configuration preserves a paused flow and inactive owner while invalidating stale plans", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id;
  await f.dispatch(id, "a1", a); const paused = f.flow.pause(id);
  Object.assign(f.states.get(main), { active: false, failedTurnId: "source", interruptedTurnId: "source" });
  const readHost = f.host.read; let reads = 0;
  f.host.read = async (...args) => { reads++; return readHost(...args); };
  await assert.rejects(f.flow.setParallelism(id, 0), /1-100/);
  await assert.rejects(f.flow.setParallelism(id, 101), /1-100/);
  const reduced = await f.flow.setParallelism(id, 1);
  assert.equal(reduced.status, "paused"); assert.equal(reduced.revision, paused.revision + 1);
  await assert.rejects(f.flow.setParallelism(id, 3), /explicit user/);
  const increased = await f.flow.setParallelism(id, 3, true);
  assert.equal(increased.status, "paused"); assert.equal(increased.revision, paused.revision + 2);
  assert.deepEqual(increased.nodes, paused.nodes); assert.deepEqual(increased.lanes, paused.lanes);
  assert.deepEqual(increased.coordinator, paused.coordinator);
  assert.deepEqual(increased.parallelismChanges.map(change => [change.previous, change.maxParallelWorkers, change.explicitUserIncrease]), [[2, 1, false], [1, 3, true]]);
  assert.equal(reads, 0); assert.equal(f.queued.length, 0);
  f.states.get(main).active = true;
  await assert.rejects(f.flow.revise(id, { expectedRevision: paused.revision }), /revision changed/);
  assert.equal(f.flow.status(id).status, "paused"); assert.equal(f.queued.length, 0);
});

test("pause drains receipts; cancel blocks new actions and preserves completed work", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id, aa = await f.dispatch(id, "a1", a);
  f.flow.pause(id); await assert.rejects(f.flow.claim(id, "b1"), /not available/);
  f.finishWorker(a, aa); assert.equal((await f.flow.observe(id)).nodes[0].status, "completed");
  await f.flow.resume(id); const bb = await f.dispatch(id, "b1", b);
  assert.equal((await f.flow.cancel(id)).status, "cancelling");
  f.finishWorker(b, bb); const cancelled = await f.flow.observe(id);
  assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.nodes[0].checkpoint.report.summary, "Checked");
  await assert.rejects(f.flow.claim(id, "a2"), /not available/); assert.equal(f.queued.length, 0);
});

test("legitimate active waits never recover; explicit abort and user intervention pause", async t => {
  for (const fault of ["waiting", "aborted", "input"]) {
    const f = fixture(t), id = (await f.flow.prepare(f.args)).id; f.flow.claimCoordinator(id);
    f.advance(10000000);
    if (fault === "aborted") Object.assign(f.states.get(main), { active: false, abortedTurnId: "source", interruptedTurnId: "source" });
    if (fault === "input") f.states.get(main).userMessageCount = 2;
    const state = await f.flow.tickCoordinator(id);
    assert.equal(state.status, fault === "waiting" ? "running" : "paused");
    assert.equal(f.queued.length, 0); assert.equal(state.coordinator.recovery.attempts.length, 0);
  }
});

test("verified technical failure waits one minute, queues once and recognizes exact recovered owner", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id;
  f.flow.claimCoordinator(id); assert.throws(() => f.newEngine().claimCoordinator(id), /live observer/);
  Object.assign(f.states.get(main), { active: false, failedTurnId: "source", interruptedTurnId: "source" });
  await f.flow.tickCoordinator(id); assert.equal(f.queued.length, 0);
  f.advance(59999); await f.flow.tickCoordinator(id); assert.equal(f.queued.length, 0);
  f.advance(1); await f.flow.tickCoordinator(id); await f.flow.tickCoordinator(id); assert.equal(f.queued.length, 1);
  const prompt = f.queued[0].prompt;
  f.matches.set(prompt, [{ turnId: "recovered" }]);
  f.receipts.set(`${main}:recovered`, { turnId: "recovered", promptMatched: true, userMessageCount: 1, ...sol, completed: false });
  Object.assign(f.states.get(main), { active: true, lastTurnId: "recovered", userMessageCount: 1 });
  assert.equal((await f.flow.recover(id)).coordinator.turnId, "recovered");
  assert.equal((await f.flow.claim(id, "a1")).tool, "create_thread");
  assert.equal(f.queued.length, 1);
  assert.equal(f.flow.compact(id).coordinator.recoveryAccess, null);
});

test("unavailable recovery queue stays scheduled until preflight is ready without duplicate attempts", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id; f.flow.claimCoordinator(id);
  Object.assign(f.states.get(main), { active: false, failedTurnId: "source", interruptedTurnId: "source" });
  let available = false, checks = 0;
  f.host.preflightRecovery = async threadId => { assert.equal(threadId, main); checks++; return { available, reason: available ? null : "Codex queue is read-only" }; };
  await f.flow.tickCoordinator(id); assert.equal(checks, 0);
  f.advance(60000);
  const unavailable = await f.flow.tickCoordinator(id), scheduled = unavailable.coordinator.recovery.attempts[0];
  assert.equal(scheduled.status, "scheduled"); assert.equal(scheduled.attemptedAt, undefined);
  assert.equal(unavailable.status, "running"); assert.equal(f.queued.length, 0);
  assert.deepEqual(f.flow.compact(id).coordinator.recoveryAccess, { attemptId: scheduled.id, available: false,
    reason: "Codex queue is read-only", changedAt: 1060000 });
  f.advance(1000); const unchanged = await f.flow.tickCoordinator(id);
  assert.equal(unchanged.eventSequence, unavailable.eventSequence);
  assert.deepEqual(unchanged.coordinator.recoveryAccess, unavailable.coordinator.recoveryAccess);
  available = true;
  const queued = await f.flow.tickCoordinator(id); await f.flow.tickCoordinator(id);
  assert.equal(queued.coordinator.recovery.attempts.length, 1); assert.equal(queued.coordinator.recovery.attempts[0].id, scheduled.id);
  assert.equal(queued.coordinator.recovery.attempts[0].status, "queued"); assert.equal(f.queued.length, 1);
  assert.equal(queued.coordinator.recoveryAccess.available, true); assert.equal(queued.coordinator.recoveryAccess.reason, null);
  assert.equal(checks, 3);
});

test("recovery preflight failure is a no-send observation and pause wins an in-flight readiness check", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id; f.flow.claimCoordinator(id);
  Object.assign(f.states.get(main), { active: false, failedTurnId: "source", interruptedTurnId: "source" });
  await f.flow.tickCoordinator(id); f.advance(60000);
  f.host.preflightRecovery = async () => { throw new Error("Queue access unavailable"); };
  const unavailable = await f.flow.tickCoordinator(id);
  assert.equal(unavailable.status, "running"); assert.equal(unavailable.coordinator.recoveryAccess.available, false);
  assert.match(unavailable.coordinator.recoveryAccess.reason, /Queue access unavailable/);
  let release, reached;
  const ready = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.host.preflightRecovery = async () => { reached(); await gate; return { available: true }; };
  const checking = f.flow.tickCoordinator(id); await ready; f.flow.pause(id); release();
  const paused = await checking;
  assert.equal(paused.status, "paused"); assert.equal(paused.coordinator.recovery.attempts[0].status, "scheduled");
  assert.equal(paused.coordinator.recovery.attempts[0].attemptedAt, undefined); assert.equal(f.queued.length, 0);
  await f.flow.tickCoordinator(id); assert.equal(f.queued.length, 0);
});

test("ready recovery preflight still re-reads the exact inactive source owner before sending", async t => {
  for (const change of ["active", "turn", "selection", "workspace", "input"]) {
    const f = fixture(t), id = (await f.flow.prepare(f.args)).id; f.flow.claimCoordinator(id);
    Object.assign(f.states.get(main), { active: false, failedTurnId: "source", interruptedTurnId: "source" });
    await f.flow.tickCoordinator(id); f.advance(60000);
    f.host.read = async threadId => structuredClone(f.states.get(threadId));
    f.host.preflightRecovery = async () => {
      const current = f.states.get(main);
      if (change === "active") current.active = true;
      if (change === "turn") current.lastTurnId = "intervening";
      if (change === "selection") current.model = luna.model;
      if (change === "workspace") current.workspace = canonicalPath(path.join(f.root, "a"));
      if (change === "input") current.userMessageCount = 2;
      return { available: true };
    };
    const state = await f.flow.tickCoordinator(id);
    assert.equal(state.coordinator.recoveryAccess.available, true);
    assert.equal(state.coordinator.recovery.attempts[0].status, "scheduled");
    assert.equal(state.coordinator.recovery.attempts[0].attemptedAt, undefined); assert.equal(f.queued.length, 0);
  }
});

test("global recovery delays are 1/3/10 minutes and stop after three attempts", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id; f.flow.claimCoordinator(id);
  for (const [index, delay] of [60000, 180000, 600000].entries()) {
    const current = f.states.get(main); Object.assign(current, { active: false, failedTurnId: current.lastTurnId, interruptedTurnId: current.lastTurnId });
    const scheduled = await f.flow.tickCoordinator(id); const attempt = scheduled.coordinator.recovery.attempts.at(-1);
    f.advance(delay - 1); await f.flow.tickCoordinator(id); assert.equal(f.queued.length, index);
    f.advance(1); await f.flow.tickCoordinator(id); assert.equal(f.queued.length, index + 1);
    const turnId = `recovered-${index}`; f.matches.set(attempt.prompt, [{ turnId }]);
    f.receipts.set(`${main}:${turnId}`, { turnId, promptMatched: true, userMessageCount: 1, ...sol });
    Object.assign(current, { active: true, lastTurnId: turnId }); await f.flow.tickCoordinator(id);
  }
  const current = f.states.get(main); Object.assign(current, { active: false, failedTurnId: current.lastTurnId, interruptedTurnId: current.lastTurnId });
  assert.equal((await f.flow.tickCoordinator(id)).status, "paused"); assert.equal(f.queued.length, 3);
});

test("uncertain recovery send is retained across restart and never resent", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id; f.flow.claimCoordinator(id);
  Object.assign(f.states.get(main), { active: false, completedTurnId: "source" });
  await f.flow.tickCoordinator(id); f.advance(60000);
  let attempts = 0; f.host.send = async () => { attempts++; throw new Error("connection lost after send"); };
  assert.equal((await f.flow.tickCoordinator(id)).status, "needs_review");
  await f.flow.tickCoordinator(id); await f.newEngine().tickCoordinator(id);
  assert.equal(attempts, 1); assert.equal(f.flow.status(id).coordinator.recovery.attempts[0].status, "dispatching");
});

test("host observation outages do not become a recovery authorization", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id; f.flow.claimCoordinator(id);
  f.host.read = async () => { throw new Error("Host unavailable temporarily"); };
  f.advance(10000000); assert.equal((await f.flow.tickCoordinator(id)).status, "running"); assert.equal(f.queued.length, 0);
});

test("concurrent observers serialize receipts while a successor starts in the same lane", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id, first = await f.dispatch(id, "a1", a);
  f.finishWorker(a, first);
  const original = f.host.bootstrap; let release, reached;
  const ready = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
  let blockedOnce = false;
  f.host.bootstrap = async (...args) => { if (!blockedOnce) { blockedOnce = true; reached(); await gate; } return original(...args); };
  const observerOne = f.flow.observe(id); await ready;
  const observerTwo = f.newEngine().observe(id); release(); await observerOne;
  const next = await f.dispatch(id, "a2", a);
  Object.assign(f.states.get(a), { active: true, lastTurnId: "next-running" });
  assert.equal((await observerTwo).status, "running");
  assert.equal(f.flow.status(id).nodes[0].status, "completed"); assert.equal(next.tool, "send_message_to_thread");
});

test("cancellation retains ownership until an already queued recovery turn drains", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id; f.flow.claimCoordinator(id);
  Object.assign(f.states.get(main), { active: false, failedTurnId: "source", interruptedTurnId: "source" });
  await f.flow.tickCoordinator(id); f.advance(60000); await f.flow.tickCoordinator(id);
  assert.equal((await f.flow.cancel(id)).status, "cancelling");
  const prompt = f.queued[0].prompt; f.matches.set(prompt, [{ turnId: "cancelled-recovery" }]);
  f.receipts.set(`${main}:cancelled-recovery`, { turnId: "cancelled-recovery", promptMatched: true, userMessageCount: 1, ...sol, completed: false });
  Object.assign(f.states.get(main), { lastTurnId: "cancelled-recovery", active: true });
  assert.equal((await f.flow.observe(id)).status, "cancelling");
  f.receipts.get(`${main}:cancelled-recovery`).completed = true;
  Object.assign(f.states.get(main), { active: false, completedTurnId: "cancelled-recovery" });
  assert.equal((await f.flow.observe(id)).status, "cancelled"); assert.equal(f.queued.length, 1);
});

test("no-send reconciliation repairs only exact acknowledged terminal evidence and its ledger", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id, first = await f.dispatch(id, "a1", a);
  f.finishWorker(a, first); await f.flow.observe(id);
  const next = await f.flow.claim(id, "a2"); f.finishWorker(a, next);
  f.flow.fail(id, "Acknowledgement lost after a continuation send");
  const repaired = await f.flow.reconcile(id);
  assert.equal(repaired.status, "paused"); assert.equal(repaired.nodes[1].status, "completed");
  await f.flow.resume(id); const other = await f.dispatch(id, "b1", b); assert.equal(other.tool, "create_thread");
  assert.equal(f.queued.length, 0);
});

test("a remediation which itself blocks propagates resolution from its successful successor", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id;
  const first = await f.dispatch(id, "a1", a); f.finishWorker(a, first, { status: "blocked", summary: "Missing data" }); await f.flow.observe(id);
  await f.flow.revise(id, { expectedRevision: 0, addNodes: [{ id: "fix", lane: "a", prompt: "Fix", dependencies: ["a1"], selection: luna }],
    replaceNodes: [{ id: "a2", dependencies: ["fix"] }], resolveBlocked: [{ nodeId: "a1", withNodeId: "fix" }] });
  const fix = await f.dispatch(id, "fix", a); f.finishWorker(a, fix, { status: "blocked", summary: "Needs format repair" }); await f.flow.observe(id);
  await f.flow.revise(id, { expectedRevision: 1, addNodes: [{ id: "fix2", lane: "a", prompt: "Fix again", dependencies: ["fix"], selection: luna }],
    replaceNodes: [{ id: "a2", dependencies: ["fix2"] }], resolveBlocked: [{ nodeId: "fix", withNodeId: "fix2" }] });
  const fix2 = await f.dispatch(id, "fix2", a); f.finishWorker(a, fix2); await f.flow.observe(id);
  const state = f.flow.status(id); assert.equal(state.nodes.find(node => node.id === "a1").resolution.status, "resolved");
  assert.equal(state.nodes.find(node => node.id === "fix").resolution.status, "resolved");
  assert.equal((await f.flow.claim(id, "a2")).tool, "send_message_to_thread");
});

test("Git creation remains read-only until exact registered isolated workspace is acknowledged", async t => {
  const f = fixture(t), repo = path.join(f.root, "repo"), worker = path.join(f.root, "worker"); fs.mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe", windowsHide: true });
  git("init", "-b", "main"); git("-c", "user.name=TFO", "-c", "user.email=tfo@example.invalid", "commit", "--allow-empty", "-m", "Initial");
  git("worktree", "add", "-b", "worker-a", worker);
  Object.assign(f.states.get(main), { workspace: canonicalPath(repo) }); Object.assign(f.states.get(a), { workspace: canonicalPath(worker) });
  f.args.projectPath = repo; f.args.workspaceMode = "git_worktrees"; f.args.mainWorkspace = repo;
  f.args.lanes = [{ id: "a", access: "write" }]; f.args.nodes = f.args.nodes.filter(node => node.lane !== "b"); f.args.nodes.at(-1).dependencies = ["a2"];
  const id = (await f.flow.prepare(f.args)).id, action = await f.flow.claim(id, "a1");
  assert.equal(action.args.target.environment.type, "worktree"); assert.match(action.args.prompt, /No edites archivos/);
  await assert.rejects(f.flow.acknowledge(id, "a1", a), /workspace/);
  await f.flow.acknowledge(id, "a1", a, worker);
  await assert.rejects(f.flow.claim(id, "a1"), /not available/);
  f.finishWorker(a, action); f.receipts.get(`${a}:${action.args.prompt}`).finalResponse = `TFO_WORKTREE_READY ${id} a1`;
  await f.flow.observe(id); const useful = await f.flow.claim(id, "a1");
  assert.equal(useful.tool, "send_message_to_thread"); assert.match(useful.args.prompt, /First A/);
  assert.equal(f.flow.status(id).nodes[0].provision.status, "completed");
});

test("a fast verified continuation can be acknowledged after its receipt without accepting another thread", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id;
  const first = await f.dispatch(id, "a1", a); f.finishWorker(a, first); await f.flow.observe(id);
  const next = await f.flow.claim(id, "a2"); f.finishWorker(a, next); await f.flow.observe(id);
  assert.equal(f.flow.status(id).nodes[1].status, "completed");
  const accepted = await f.flow.acknowledge(id, "a2", a); assert.equal(accepted.nodes[1].status, "completed");
  await assert.rejects(f.flow.acknowledge(id, "a2", b), /Wrong target/);
  await assert.rejects(f.flow.acknowledge(id, "a2", a, path.join(f.root, "b")), /workspace/);
  assert.equal(f.flow.status(id).nodes[1].checkpoint.verification, "native_host_receipt");
});

test("revision intent survives a failed final flow write after reservation extension", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id;
  const workspace = path.join(f.root, "c"); fs.mkdirSync(workspace);
  const target = path.join(f.dataDir, "native-flows", `${id}.json`), originalRename = fs.renameSync;
  let writes = 0;
  fs.renameSync = (source, destination) => {
    if (destination === target && ++writes === 2) { const error = new Error("Injected final revision write failure"); error.code = "EIO"; throw error; }
    return originalRename(source, destination);
  };
  try {
    await assert.rejects(f.flow.revise(id, { expectedRevision: 0, addLanes: [{ id: "c", access: "write", workspace }],
      addNodes: [{ id: "c1", lane: "c", prompt: "New task", dependencies: [], selection: luna }],
      replaceNodes: [{ id: "join", dependencies: ["a2", "b1", "c1"] }] }), /Injected/);
  } finally { fs.renameSync = originalRename; }
  const paused = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(paused.status, "paused"); assert.ok(paused.pendingRevision); assert.equal(paused.revision, 0);
  await assert.rejects(f.flow.setParallelism(id, 1), /unfinished/);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), paused);
  const ledger = JSON.parse(fs.readFileSync(path.join(f.dataDir, "projects", "resource-reservations.json"), "utf8"));
  assert.ok(ledger.reservations[0].claims.some(claim => claim.kind === "workspace" && claim.workspace === canonicalPath(workspace)));
  const restored = f.newEngine().status(id);
  assert.equal(restored.status, "running"); assert.equal(restored.revision, 1); assert.equal(restored.pendingRevision, undefined);
  assert.equal(restored.nodes.find(node => node.id === "c1").title, "c1"); assert.equal(f.queued.length, 0);
});

test("a conflicting paused revision stays unsent and can be cancelled without acquiring its new workspace", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id, workspace = path.join(f.root, "reserved-c"); fs.mkdirSync(workspace);
  const ledgerFile = path.join(f.dataDir, "projects", "resource-reservations.json"), ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  ledger.reservations.push({ runId: "flow_other", status: "held", claims: [{ kind: "workspace", key: `workspace:${canonicalPath(workspace)}`, mode: "write", workspace: canonicalPath(workspace) }] });
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
  await assert.rejects(f.flow.revise(id, { expectedRevision: 0, addLanes: [{ id: "c", access: "write", workspace }],
    addNodes: [{ id: "c1", lane: "c", prompt: "New task", dependencies: [], selection: luna }],
    replaceNodes: [{ id: "join", dependencies: ["a2", "b1", "c1"] }] }), /reserved/);
  assert.equal(f.flow.status(id).status, "paused"); assert.ok(f.flow.status(id).pendingRevision);
  assert.equal((await f.flow.cancel(id)).status, "cancelled"); assert.equal(f.queued.length, 0);
  const restored = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  assert.equal(restored.reservations.find(item => item.runId === "flow_other").status, "held");
  assert.equal(restored.reservations.find(item => item.runId === id).status, "released");
  assert.equal(f.flow.status(id).revisionHistory[0].status, "cancelled_before_commit");
});

test("legacy saved mode and worker limits remain separate from new persistent defaults", async t => {
  const f = fixture(t); f.args.coordinationMode = "deferred_join"; f.args.maxParallelWorkers = 1;
  const state = await f.flow.prepare(f.args), target = path.join(f.dataDir, "native-flows", `${state.id}.json`);
  delete state.coordinationMode; delete state.revision; delete state.events; delete state.eventSequence;
  fs.writeFileSync(target, JSON.stringify(state)); createSettingsStore(f.dataDir).update({ maxParallelWorkers: 100 });
  const restored = f.newEngine(); assert.equal(restored.compact(state.id).coordinationMode, "deferred_join");
  assert.equal(restored.status(state.id).maxParallelWorkers, 1); await restored.claim(state.id, "a1");
  await assert.rejects(restored.claim(state.id, "b1"), /limit/);
  const raw = JSON.parse(fs.readFileSync(target, "utf8")); delete raw.maxParallelWorkers; fs.writeFileSync(target, JSON.stringify(raw));
  assert.equal(f.newEngine().status(state.id).maxParallelWorkers, 2);
});

test("only structured definitive no-send capacity evidence defers an attempt and retains its audit", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id;
  await f.flow.claim(id, "a1");
  await assert.rejects(f.flow.deferDispatch(id, "a1", "too many workers"), /structured/);
  await assert.rejects(f.flow.deferDispatch(id, "a1", { code: "HOST_CAPACITY", deliveryAttempted: true }), /structured/);
  const deferred = await f.flow.deferDispatch(id, "a1", { code: "HOST_CAPACITY", deliveryAttempted: false });
  assert.equal(deferred.nodes[0].status, "pending"); assert.equal(deferred.nodes[0].dispatchAttempts[0].status, "proven_not_sent");
  assert.ok(deferred.nodes[0].dispatchAttempts[0].id); assert.ok(deferred.nodes[0].attemptedAt);
  assert.equal(deferred.capacityBackpressure.effectiveMaxParallelWorkers, 1);
  await assert.rejects(f.flow.claim(id, "a1"), /cooling down/);
  await assert.rejects(f.flow.revise(id, { expectedRevision: 0, replaceNodes: [{ id: "a1", prompt: "Change audited task" }] }), /unattempted/);
  f.advance(2000); const retried = await f.flow.claim(id, "a1");
  assert.equal(retried.tool, "create_thread"); assert.equal(f.flow.status(id).nodes[0].dispatchAttempts.length, 1);
  assert.notEqual(f.flow.status(id).nodes[0].attemptId, deferred.nodes[0].dispatchAttempts[0].id); assert.equal(f.queued.length, 0);
});

test("a delivered continuation cannot be deferred even with a capacity error label", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id;
  const first = await f.dispatch(id, "a1", a); f.finishWorker(a, first); await f.flow.observe(id);
  const next = await f.flow.claim(id, "a2"); f.finishWorker(a, next);
  await assert.rejects(f.flow.deferDispatch(id, "a2", { code: "HOST_CAPACITY", deliveryAttempted: false, retryAfterMs: 0 }), /activity|receipt/);
  assert.equal(f.flow.status(id).nodes[1].status, "dispatching");
});

test("active lifecycle metadata gates expensive exact receipt lookups before they run", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id; await f.dispatch(id, "a1", a);
  Object.assign(f.states.get(a), { active: true, lastTurnId: "work-running" });
  let reads = 0; f.host.bootstrap = async () => { reads++; throw new Error("Must not read exact history while active"); };
  assert.equal((await f.flow.observe(id)).status, "running"); assert.equal(reads, 0);
});
