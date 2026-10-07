import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createProjectFlow, validateFlow } from "../project-flow.mjs";
import { verifyWorkspace, verifyScratchWorkspace, canonicalPath } from "../project-workspace.mjs";
import { reserveChatSlot } from "../prompt-queue.mjs";
import { createSettingsStore } from "../settings.mjs";

const main = "11111111-1111-1111-1111-111111111111", a = "22222222-2222-2222-2222-222222222222", b = "33333333-3333-3333-3333-333333333333", p = "44444444-4444-4444-4444-444444444444";
const selection = { model: "gpt-6-sol", reasoning: "medium" };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-project-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo"), wa = path.join(dir, "a"), wb = path.join(dir, "b"), dataDir = path.join(dir, "data");
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true, stdio: "pipe" });
  git("init", "-b", "main"); git("-c", "user.name=TFO test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "test fixture");
  git("worktree", "add", "-b", "task-a", wa); git("worktree", "add", "-b", "task-b", wb);
  const history = new Map(), states = new Map(), sent = [];
  let count = 0, clock = Date.now();
  const init = (id, workspace, active = false) => states.set(id, { threadId: id, workspace: canonicalPath(workspace),
    lastTurnId: `source-${id}`, completedTurnId: `source-${id}`, active, ...selection });
  init(main, repo, true); init(a, wa); init(b, wb);
  function complete(id, prompt, response, options = {}) {
    const turnId = options.turnId || states.get(id).lastTurnId;
    history.set(`${id}:${turnId}`, { turnId, completed: true, promptMatched: true, userMessageCount: 1,
      finalResponse: response, ...selection, ...options, prompt });
    Object.assign(states.get(id), { lastTurnId: turnId, completedTurnId: turnId, active: false, ...selection });
  }
  const host = {
    read: async id => ({ ...states.get(id) }),
    find: async (id, prompt) => [...history.entries()].filter(([key, item]) => key.startsWith(`${id}:`) && item.prompt === prompt).map(([, item]) => ({ turnId: item.turnId })),
    receipt: async (id, turnId) => history.get(`${id}:${turnId}`) || { turnId, completed: false },
    send: async (id, prompt) => {
      const turnId = `turn-${++count}`;
      sent.push({ id, prompt, turnId }); Object.assign(states.get(id), { lastTurnId: turnId, active: true });
      history.set(`${id}:${turnId}`, { turnId, prompt, completed: false });
      return { queueMessageId: `queued-${count}` };
    },
  };
  let flow;
  flow = createProjectFlow({ dataDir, host, now: () => clock, launch: async id => flow.claim(id) });
  const args = { surface: "codex", mainThreadId: main, projectId: main, projectPath: repo, objective: "Parallel project test",
    initialSelection: selection, lanes: [{ id: "a", access: "write" }, { id: "b", access: "write" }],
    nodes: [{ id: "a1", lane: "a", prompt: "Implement X", dependencies: [] },
      { id: "a2", lane: "a", prompt: "Extend X", dependencies: ["a1"] },
      { id: "b1", lane: "b", prompt: "Implement Y", dependencies: [] },
      { id: "b2", lane: "b", prompt: "Extend Y", dependencies: ["b1"] },
      { id: "integrate", lane: "main", prompt: "Integrate X and Y and validate", dependencies: ["a2", "b2"] }] };
  async function prepare(input = args) {
    let state = await flow.prepare(input);
    for (const [id, threadId, workspace] of [["a", a, wa], ["b", b, wb]]) {
      const lane = state.lanes.find(lane => lane.id === id);
      complete(threadId, lane.bootstrapPrompt, lane.bootstrapResponse);
      state = await flow.bind({ runId: state.id, laneId: id, threadId, workspace });
    }
    await flow.start(state.id); return state.id;
  }
  const finish = (id, response = JSON.stringify({ status: "completed", summary: "Implemented and checked", files: ["result.txt"], tests: ["pass"] }), options) => {
    const send = sent.findLast(send => send.id === id); complete(id, send.prompt, response, options);
  };
  return { dir, repo, wa, wb, dataDir, git, flow, host, states, history, sent, args, prepare, finish, complete, advance: ms => { clock += ms; } };
}

test("two dependency chains run concurrently and main gets both complete handoffs exactly once", async t => {
  const f = fixture(t), id = await f.prepare();
  const started = await f.flow.tick(id); assert.deepEqual(f.sent.map(s => s.id), [a, b], started.error || "both ready workers dispatch");
  f.finish(a); await f.flow.tick(id); assert.equal(f.sent.length, 3); assert.match(f.sent[2].prompt, /Implemented and checked/);
  f.finish(a); await f.flow.tick(id); assert.equal(f.sent.length, 3, "must wait for the second branch");
  f.finish(b); await f.flow.tick(id); assert.equal(f.sent.length, 4);
  f.finish(b); await f.flow.tick(id); assert.equal(f.sent.length, 4, "main is still working");
  f.states.get(main).active = false;
  const joinState = await f.flow.tick(id); assert.equal(f.sent.length, 5, joinState.error || "all workers finished and main is idle");
  assert.match(f.sent[4].prompt, /"node": "a2"/); assert.match(f.sent[4].prompt, /"node": "b2"/);
  assert.match(f.sent[4].prompt, /refs\/heads\/task-a/);
  f.finish(main, "Final integrated deliverable");
  assert.equal((await f.flow.tick(id)).status, "completed");
  await f.flow.tick(id); assert.equal(f.sent.length, 5);
});

test("new project flows snapshot persistent parallelism and explicit overrides", async t => {
  const f = fixture(t), settings = createSettingsStore(f.dataDir);
  settings.update({ maxParallelWorkers: 1 });
  const id = await f.prepare();
  assert.equal(f.flow.status(id).maxParallelWorkers, 1);
  settings.update({ maxParallelWorkers: 100 });
  await f.flow.tick(id);
  assert.deepEqual(f.sent.map(item => item.id), [a], "changing defaults must not raise a prepared flow");
  f.finish(a); await f.flow.tick(id);
  assert.equal(f.sent.at(-1).id, a, "one worker slot remains enforced across continuations");

  const explicit = fixture(t);
  createSettingsStore(explicit.dataDir).update({ maxParallelWorkers: 1 });
  explicit.args.maxParallelWorkers = 2;
  const overrideId = await explicit.prepare(); await explicit.flow.tick(overrideId);
  assert.equal(explicit.sent.length, 2);
});

test("live reductions drain active workers and increases require user authorization", async t => {
  const f = fixture(t), id = await f.prepare(); await f.flow.tick(id);
  assert.equal(f.sent.length, 2);
  f.flow.setParallelism(id, 1);
  f.finish(a); await f.flow.tick(id);
  assert.equal(f.sent.length, 2, "the remaining active worker holds the reduced slot");
  assert.equal(f.states.get(b).active, true, "lowering does not interrupt existing work");
  f.finish(b); await f.flow.tick(id);
  assert.equal(f.sent.length, 3);
  assert.throws(() => f.flow.setParallelism(id, 100), /explicit user/);
  assert.equal(f.flow.setParallelism(id, 100, true).maxParallelWorkers, 100);
  await f.flow.tick(id); assert.equal(f.sent.length, 4);
  for (const value of [0, 101, 1.5]) assert.throws(() => f.flow.setParallelism(id, value), /1-100/);
});

test("conventional flows preserve deferred execution and old saved worker caps", async t => {
  const f = fixture(t);
  await assert.rejects(f.flow.prepare({ ...f.args, coordinationMode: "active_main" }), /native driver/);
  const id = await f.prepare(), stateFile = path.join(f.dataDir, "parallel", id, "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  delete state.maxParallelWorkers; delete state.coordinationMode;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  createSettingsStore(f.dataDir).update({ maxParallelWorkers: 1 });
  await f.flow.tick(id);
  assert.equal(f.sent.length, 2, "saved flows lacking a cap retain the old capacity up to eight");
  assert.throws(() => f.flow.setParallelism(id, 9), /explicit user/);
});

test("main can perform a prerequisite in the preparing turn while workers run", async t => {
  const f = fixture(t); f.args.currentNodeId = "interface";
  f.args.nodes.unshift({ id: "interface", lane: "main", prompt: "Prepare interface now", dependencies: [] });
  f.args.nodes.at(-1).dependencies.push("interface");
  const id = await f.prepare(); await f.flow.tick(id);
  assert.equal(f.sent.length, 2);
  f.complete(main, "original user request", "Interface ready", { promptMatched: false, userMessageCount: 2 });
  const state = await f.flow.tick(id);
  assert.equal(state.nodes[0].checkpoint.response, "Interface ready");
  assert.equal(f.sent.length, 2);
});

test("pause collects receipts without launching successors; resume preserves checkpoints", async t => {
  const f = fixture(t), id = await f.prepare(); await f.flow.tick(id);
  f.flow.pause(id); f.finish(a); f.finish(b); await f.flow.tick(id);
  assert.equal(f.sent.length, 2); assert.equal(f.flow.status(id).nodes.filter(n => n.checkpoint).length, 2);
  f.flow.resume(id); await f.flow.tick(id); assert.equal(f.sent.length, 4);
});

test("cancel drains active turns, keeps files and never integrates", async t => {
  const f = fixture(t), id = await f.prepare(); await f.flow.tick(id);
  assert.equal(f.flow.cancel(id).status, "cancelling");
  f.finish(a); f.finish(b); assert.equal((await f.flow.tick(id)).status, "cancelled");
  assert.equal(f.sent.length, 2); assert.ok(fs.existsSync(f.wa));
});

for (const [name, response, options] of [
  ["blocked report", '{"status":"blocked","summary":"need input"}', {}],
  ["changed selection", '{"status":"completed","summary":"ok"}', { model: "gpt-6-astra" }],
  ["extra user input", '{"status":"completed","summary":"ok"}', { userMessageCount: 2 }],
  ["interrupted turn", "no", { interrupted: true }],
  ["malformed result", "Finished", {}],
]) test(`${name} prevents dependent tasks`, async t => {
  const f = fixture(t), id = await f.prepare(); await f.flow.tick(id); f.finish(a, response, options);
  assert.equal((await f.flow.tick(id)).status, "needs_review");
  await f.flow.tick(id); assert.equal(f.sent.length, 2);
});

test("an uncertain send persists intent and never retries after a restart", async t => {
  const f = fixture(t), id = await f.prepare(); let attempts = 0;
  f.host.send = async () => { attempts++; throw new Error("connection lost after send"); };
  const result = await f.flow.tick(id); assert.equal(result.status, "needs_review");
  assert.equal(result.nodes[0].status, "dispatching");
  const again = createProjectFlow({ dataDir: f.dataDir, host: f.host });
  await again.tick(id); assert.equal(attempts, 1);
  assert.throws(() => again.resume(id), /Cannot resume/);
});

test("verified capacity rejection retains its audit and safely retries after cooldown", async t => {
  const f = fixture(t), id = await f.prepare(), send = f.host.send;
  let attempts = 0;
  f.host.send = async (...args) => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error("verified host capacity preflight"), { code: "HOST_CAPACITY", deliveryAttempted: false, retryAfterMs: 2500 });
    return send(...args);
  };
  const blocked = await f.flow.tick(id);
  assert.equal(blocked.status, "running"); assert.equal(blocked.nodes[0].status, "pending");
  assert.equal(blocked.nodes[0].dispatchAttempts[0].status, "capacity_rejected");
  assert.equal(blocked.nodes[0].dispatchAttempts[0].deliveryAttempted, false);
  assert.equal(blocked.maxParallelWorkers, 2);
  assert.equal(blocked.capacityBackpressure.effectiveMaxParallelWorkers, 1);
  await f.flow.tick(id); assert.equal(attempts, 1);
  f.advance(2500); await f.flow.tick(id);
  assert.equal(attempts, 2); assert.equal(f.sent.length, 1, "reduced effective cap permits one worker");
  const node = f.flow.status(id).nodes[0];
  assert.equal(node.dispatchAttempts.length, 2);
  assert.notEqual(node.dispatchAttempts[0].id, node.dispatchAttempts[1].id);
  assert.equal(node.dispatchAttempts[1].status, "queued");
  assert.equal(node.dispatchAttempts[0].promptSha256, node.dispatchAttempts[1].promptSha256);
});

test("unproven capacity errors retain uncertain delivery without a retry", async t => {
  for (const error of [new Error("host capacity exceeded"), Object.assign(new Error("capacity"), { code: "HOST_CAPACITY", deliveryAttempted: true })]) {
    const f = fixture(t), id = await f.prepare(); let attempts = 0;
    f.host.send = async () => { attempts++; throw error; };
    assert.equal((await f.flow.tick(id)).status, "needs_review");
    f.advance(60000); await f.flow.tick(id); assert.equal(attempts, 1);
    assert.equal(f.flow.status(id).nodes[0].status, "dispatching");
  }
});

test("new user activity in main prevents the automatic join prompt", async t => {
  const f = fixture(t), id = await f.prepare();
  await f.flow.tick(id); f.finish(a); f.finish(b); await f.flow.tick(id);
  f.finish(a); f.finish(b); f.states.get(main).lastTurnId = "user-intervened";
  assert.equal((await f.flow.tick(id)).status, "needs_review"); assert.equal(f.sent.length, 4);
});

test("task_started preceding the prompt is a bounded observation wait, not an intervention", async t => {
  const f = fixture(t), id = await f.prepare();
  await f.flow.tick(id); const find = f.host.find;
  let hidePrompt = true;
  f.host.find = async (thread, prompt) => hidePrompt && prompt.startsWith("TFO ") ? [] : find(thread, prompt);
  f.states.get(a).userMessageCount = 0; f.states.get(b).userMessageCount = 0;
  assert.equal((await f.flow.tick(id)).status, "running");
  assert.equal(f.sent.length, 2, "no resends during receipt delay");
  hidePrompt = false; f.finish(a); f.finish(b);
  assert.equal((await f.flow.tick(id)).status, "running");
  assert.equal(f.sent.length, 4, "successors run only after actual receipts");
});

test("the prompt can appear between the first search and the lifecycle read", async t => {
  const f = fixture(t), id = await f.prepare(); await f.flow.tick(id);
  const find = f.host.find; let reads = 0;
  f.states.get(a).userMessageCount = 1;
  f.host.find = async (thread, prompt) => thread === a && prompt.startsWith("TFO ") && reads++ === 0 ? [] : find(thread, prompt);
  assert.equal((await f.flow.tick(id)).status, "running");
  assert.equal(f.sent.length, 2);
});

test("a foreign user prompt after dispatch still stops without retrying", async t => {
  const f = fixture(t), id = await f.prepare(); await f.flow.tick(id);
  f.host.find = async () => [];
  Object.assign(f.states.get(a), { lastTurnId: "foreign-turn", userMessageCount: 1 });
  assert.equal((await f.flow.tick(id)).status, "needs_review");
  assert.equal(f.sent.length, 2);
});

test("FIFO and another project cannot steal a reserved main chat", async t => {
  const f = fixture(t), id = await f.prepare();
  assert.throws(() => reserveChatSlot(path.join(f.dataDir, "runs"), main, () => {}), /reserved by a project/);
  await assert.rejects(f.flow.prepare(f.args), /reserved by a project/);
  f.flow.cancel(id);
  assert.doesNotThrow(() => reserveChatSlot(path.join(f.dataDir, "runs"), main, () => {}));
});

test("real Git worktrees pass but subdirectories of one checkout and detached branches fail", t => {
  const f = fixture(t);
  assert.equal(verifyWorkspace(f.repo, f.wa, [{ workspace: f.repo, access: "write" }], "write").branch, "refs/heads/task-a");
  const sub = path.join(f.repo, "ordinary-folder"); fs.mkdirSync(sub);
  assert.throws(() => verifyWorkspace(f.repo, sub, [], "write"), /registered Git worktree/);
  assert.throws(() => verifyWorkspace(f.repo, f.repo, [{ workspace: f.repo, access: "write" }], "write"), /different verified/);
});

test("cycles, missing dependencies, unordered lane tasks and early joins are rejected before launch", t => {
  const f = fixture(t);
  for (const modify of [
    args => args.nodes[0].dependencies.push("a2"),
    args => args.nodes[0].dependencies.push("missing"),
    args => args.nodes[1].dependencies = [],
    args => args.nodes.at(-1).dependencies = ["a2"],
    args => args.surface = "chatgpt-chat",
  ]) { const args = structuredClone(f.args); modify(args); assert.throws(() => validateFlow(args)); }
});

test("bootstrap must match the exact token and cannot raise the main model ceiling", async t => {
  const f = fixture(t), id = await f.prepare();
  const lane = f.flow.status(id).lanes.find(lane => lane.id === "a");
  f.complete(a, lane.bootstrapPrompt, lane.bootstrapResponse, { model: "gpt-6-astra" });
  assert.equal((await f.flow.tick(id)).status, "needs_review"); assert.equal(f.sent.length, 0);
});

test("scratch folders support two builders, one integrator and a final main verification", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-scratch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, "project"), content = path.join(project, "content"), engine = path.join(project, "engine");
  const principal = path.join(project, "principal"), release = path.join(project, "release"), dataDir = path.join(dir, "data");
  for (const folder of [project, content, engine, principal, release]) fs.mkdirSync(folder, { recursive: true });

  const states = new Map(), history = new Map(), sent = [];
  let count = 0;
  for (const id of [main, a, b, p]) states.set(id, { threadId: id, workspace: canonicalPath(dir),
    lastTurnId: `source-${id}`, completedTurnId: `source-${id}`, active: id === main, ...selection });
  const complete = (id, prompt, response) => {
    const turnId = states.get(id).lastTurnId;
    history.set(`${id}:${turnId}`, { turnId, prompt, completed: true, promptMatched: true,
      userMessageCount: 1, finalResponse: response, ...selection });
    Object.assign(states.get(id), { lastTurnId: turnId, completedTurnId: turnId, active: false });
  };
  const host = {
    read: async id => ({ ...states.get(id) }),
    find: async (id, prompt) => [...history.entries()].filter(([key, item]) => key.startsWith(`${id}:`) && item.prompt === prompt).map(([, item]) => ({ turnId: item.turnId })),
    receipt: async (id, turnId) => history.get(`${id}:${turnId}`) || { turnId, completed: false },
    send: async (id, prompt) => {
      const turnId = `sent-${++count}`;
      sent.push({ id, prompt, turnId }); Object.assign(states.get(id), { lastTurnId: turnId, active: true });
      history.set(`${id}:${turnId}`, { turnId, prompt, completed: false });
      return { queueMessageId: turnId };
    },
  };
  let flow;
  flow = createProjectFlow({ dataDir, host, launch: async id => flow.claim(id) });
  let state = await flow.prepare({ surface: "codex", objective: "Hierarchical scratch test", projectPath: project,
    projectId: main, mainThreadId: main, initialSelection: selection, workspaceMode: "scratch_folders",
    mainWorkspace: release, lanes: [
      { id: "content", access: "write", workspace: content },
      { id: "engine", access: "write", workspace: engine },
      { id: "principal", access: "write", workspace: principal },
    ], nodes: [
      { id: "content_source", lane: "content", prompt: "Create content", dependencies: [] },
      { id: "engine_source", lane: "engine", prompt: "Create engine", dependencies: [] },
      { id: "assemble", lane: "principal", prompt: "Assemble both", dependencies: ["content_source", "engine_source"] },
      { id: "verify_release", lane: "main", prompt: "Test and deliver", dependencies: ["assemble"] },
    ] });
  for (const [laneId, threadId, workspace] of [["content", a, content], ["engine", b, engine], ["principal", p, principal]]) {
    const lane = state.lanes.find(item => item.id === laneId);
    complete(threadId, lane.bootstrapPrompt, lane.bootstrapResponse);
    state = await flow.bind({ runId: state.id, laneId, threadId, workspace });
  }
  await flow.start(state.id);
  await flow.tick(state.id);
  assert.deepEqual(sent.map(item => item.id), [a, b]);
  for (const threadId of [a, b]) {
    const task = sent.find(item => item.id === threadId);
    complete(threadId, task.prompt, JSON.stringify({ status: "completed", summary: "component ready", files: [], tests: [], risks: [] }));
  }
  const afterWorkers = await flow.tick(state.id);
  assert.equal(afterWorkers.status, "running", afterWorkers.error);
  assert.deepEqual(sent.map(item => item.id), [a, b, p]);
  assert.match(sent.at(-1).prompt, /content_source/); assert.match(sent.at(-1).prompt, /engine_source/);
  complete(p, sent.at(-1).prompt, JSON.stringify({ status: "completed", summary: "package integrated", files: [], tests: [], risks: [] }));
  await flow.tick(state.id);
  assert.equal(sent.length, 3, "main remains a source-turn barrier");
  Object.assign(states.get(main), { active: false, completedTurnId: states.get(main).lastTurnId });
  await flow.tick(state.id);
  assert.equal(sent.at(-1).id, main); assert.match(sent.at(-1).prompt, /package integrated/);
  complete(main, sent.at(-1).prompt, "Product tested and delivered");
  assert.equal((await flow.tick(state.id)).status, "completed");
  assert.equal(verifyScratchWorkspace(project, content, [{ workspace: engine }]).workspace, canonicalPath(content));
  const nested = path.join(content, "nested"); fs.mkdirSync(nested);
  assert.throws(() => verifyScratchWorkspace(project, content, [{ workspace: nested }]), /non-overlapping/);
});
