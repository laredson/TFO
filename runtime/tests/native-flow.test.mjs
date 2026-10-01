import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNativeFlow } from "../native-flow.mjs";
import { canonicalPath } from "../project-workspace.mjs";
const main = "11111111-1111-1111-1111-111111111111", a = "22222222-2222-2222-2222-222222222222", b = "33333333-3333-3333-3333-333333333333";
const luna = reasoning => ({ model: "gpt-6-luna", reasoning }), sol = reasoning => ({ model: "gpt-6-sol", reasoning });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-native-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ["a", "b", "release"]) fs.mkdirSync(path.join(root, dir));
  const states = new Map([main, a, b].map(id => [id, { workspace: canonicalPath(root), ...sol("high"), lastTurnId: "source", active: id === main }]));
  const receipts = new Map();
  const host = { read: async id => states.get(id), bootstrap: async (id, prompt) => receipts.get(`${id}:${prompt}`) };
  const flow = createNativeFlow({ dataDir: path.join(root, "data"), host });
  const args = { surface: "codex", projectId: main, mainThreadId: main, projectPath: root, initialSelection: sol("high"),
    objective: "Native selections", workspaceMode: "scratch_folders", mainWorkspace: path.join(root, "release"),
    lanes: ["a", "b"].map(id => ({ id, workspace: path.join(root, id), access: "write" })),
    nodes: [{ id: "a1", lane: "a", prompt: "Create text", dependencies: [], selection: luna("medium") },
      { id: "a2", lane: "a", prompt: "Extend text", dependencies: ["a1"], selection: luna("low") },
      { id: "b1", lane: "b", prompt: "Create launcher", dependencies: [], selection: sol("medium") },
      { id: "b2", lane: "b", prompt: "Complete launcher", dependencies: ["b1"], selection: sol("low") },
      { id: "join", lane: "main", prompt: "Join", dependencies: ["a2", "b2"], selection: luna("high") }] };
  const finish = (id, action, override = {}) => {
    const turnId = `${id}-${receipts.size}`;
    const receipt = { turnId, completed: true, bootstrapVerified: true, model: action.args.model, reasoning: action.args.thinking,
      finalResponse: JSON.stringify({ status: "completed", summary: "Done" }), usage: { input_tokens: 10, output_tokens: 5 }, ...override };
    receipts.set(`${id}:${action.args.prompt}`, receipt);
    states.set(id, { ...states.get(id), lastTurnId: turnId, active: false, model: receipt.model, reasoning: receipt.reasoning });
  };
  return { root, flow, args, states, finish, host };
}
test("native actions carry per-node models, preserve chats, wait for both chains and retain actual usage", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id;
  const aa = await f.flow.claim(id, "a1"), bb = await f.flow.claim(id, "b1");
  assert.equal(aa.tool, "create_thread"); assert.equal(aa.args.model, "gpt-6-luna"); assert.equal(bb.args.thinking, "medium");
  await f.flow.acknowledge(id, "a1", a); await f.flow.acknowledge(id, "b1", b);
  await assert.rejects(f.flow.claim(id, "join"), /Dependencies|Cannot switch the active main/);
  f.finish(a, aa); f.finish(b, bb); await f.flow.observe(id);
  const a2 = await f.flow.claim(id, "a2"), b2 = await f.flow.claim(id, "b2");
  assert.equal(a2.tool, "send_message_to_thread"); assert.equal(a2.args.threadId, a); assert.equal(a2.args.thinking, "low");
  await f.flow.acknowledge(id, "a2", a); await f.flow.acknowledge(id, "b2", b);
  f.finish(a, a2); f.finish(b, b2); await f.flow.observe(id);
  await assert.rejects(f.flow.claim(id, "join"), /Cannot switch the active main/);
  f.states.get(main).active = false;
  const join = await f.flow.claim(id, "join"); assert.equal(join.args.model, "gpt-6-luna"); assert.equal(join.args.thinking, "high");
  await f.flow.acknowledge(id, "join", main); f.finish(main, join);
  const state = await f.flow.observe(id); assert.equal(state.status, "completed");
  assert.equal(state.nodes[0].checkpoint.usage.inputTokens, 10); assert.ok(state.nodes[0].checkpoint.apiEquivalentUsd > 0);
});
test("worker concurrency limit and uncertain delivery never permit duplicate attempts", async t => {
  const f = fixture(t); f.args.maxParallelWorkers = 1;
  const id = (await f.flow.prepare(f.args)).id;
  await f.flow.claim(id, "a1");
  await assert.rejects(f.flow.claim(id, "b1"), /limit/);
  await assert.rejects(f.flow.claim(id, "a1"), /never retry/);
  f.flow.fail(id, "Uncertain native delivery"); await assert.rejects(f.flow.claim(id, "b1"), /not available/);
});
test("native Sol 6.1 tasks dispatch exact IDs and reject old Sol receipts", async t => {
  for (const observedModel of ["gpt-6.1-sol", "gpt-6-sol"]) {
    const f = fixture(t);
    f.args.nodes.find(node => node.id === "b1").selection.model = "gpt-6.1-sol";
    const id = (await f.flow.prepare(f.args)).id;
    const action = await f.flow.claim(id, "b1");
    assert.equal(action.args.model, "gpt-6.1-sol");
    await f.flow.acknowledge(id, "b1", b);
    f.finish(b, action, { model: observedModel });
    const state = await f.flow.observe(id);
    if (observedModel === "gpt-6-sol") {
      assert.equal(state.status, "needs_review");
      await assert.rejects(f.flow.claim(id, "b2"), /not available/);
    } else {
      assert.equal(state.nodes.find(node => node.id === "b1").status, "completed");
      assert.ok(state.nodes.find(node => node.id === "b1").checkpoint.apiEquivalentUsd > 0);
      const explicitOldSol = await f.flow.claim(id, "b2");
      assert.equal(explicitOldSol.args.model, "gpt-6-sol");
    }
  }
});
test("wrong observed model prevents successors even when the requested selection was correct", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id, action = await f.flow.claim(id, "a1");
  await f.flow.acknowledge(id, "a1", a); f.finish(a, action, { model: "gpt-6-sol" });
  assert.equal((await f.flow.observe(id)).status, "needs_review");
  await assert.rejects(f.flow.claim(id, "a2"), /not available/);
});
test("overlapping scratch directories and unsupported selections fail before dispatch", async t => {
  const f = fixture(t); f.args.lanes[1].workspace = f.args.lanes[0].workspace;
  await assert.rejects(f.flow.prepare(f.args), /overlap/);
  f.args.lanes[1].workspace = path.join(f.root, "b"); f.args.nodes[0].selection = luna("ultra");
  await assert.rejects(f.flow.prepare(f.args), /Unsupported/);
});

async function joinFixture(t, { selected = false } = {}) {
  const f = fixture(t); f.args.nodes.at(-1).selection = sol(selected ? "medium" : "high");
  if (selected) f.args.nodes.at(-1).selectionReason = "La integración es acotada y Sol medio basta";
  const id = (await f.flow.prepare(f.args)).id;
  for (const suffix of ["1", "2"]) {
    for (const [lane, threadId] of [["a", a], ["b", b]]) {
      const action = await f.flow.claim(id, lane + suffix);
      await f.flow.acknowledge(id, lane + suffix, threadId);
      if (suffix === "1") f.finish(threadId, action);
      else f[lane] = action;
    }
    await f.flow.observe(id);
  }
  const sent = [];
  f.host.send = async (threadId, prompt) => { sent.push({ threadId, prompt }); return { queueMessageId: "native-queue" }; };
  f.host.find = async () => [];
  if (selected) f.host.selectedJoin = {
    preflight: async () => ({ selectionSupported: true, guardedTarget: true }),
    send: async args => { sent.push(args); return { sendAttempted: true, selectionConfirmed: true, turnId: "selected-main" }; },
  };
  return { ...f, id, sent };
}

for (const mainFirst of [false, true]) test(`deferred main join waits for both barriers (main finishes first: ${mainFirst}) and sends once`, async t => {
  const f = await joinFixture(t);
  await f.flow.armJoin(f.id); f.flow.claimJoin(f.id);
  await assert.rejects(f.flow.claim(f.id, "join"), /persistent join/);
  assert.throws(() => f.flow.claimJoin(f.id), /owner/);
  if (mainFirst) Object.assign(f.states.get(main), { active: false, completedTurnId: "source" });
  await f.flow.tickJoin(f.id); assert.equal(f.sent.length, 0);
  f.finish(a, f.a); await f.flow.tickJoin(f.id); assert.equal(f.sent.length, 0);
  f.finish(b, f.b); await f.flow.tickJoin(f.id);
  assert.equal(f.sent.length, mainFirst ? 1 : 0);
  if (!mainFirst) {
    Object.assign(f.states.get(main), { active: false, completedTurnId: "source" });
    await f.flow.tickJoin(f.id);
  }
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].prompt, /"node": "a2"/); assert.match(f.sent[0].prompt, /"node": "b2"/);
  await f.flow.tickJoin(f.id); assert.equal(f.sent.length, 1);
  f.host.find = async () => [{ turnId: "main-final" }];
  f.host.receipt = async () => ({ turnId: "main-final", completed: true, promptMatched: true, userMessageCount: 1,
    model: "gpt-6-sol", reasoning: "high", finalResponse: "Integrated and tested" });
  Object.assign(f.states.get(main), { lastTurnId: "main-final", completedTurnId: "main-final", active: false });
  assert.equal((await f.flow.tickJoin(f.id)).status, "completed");
  assert.equal(f.flow.status(f.id).nodes.at(-1).checkpoint.verification, "native_queue_host_receipt");
  assert.equal(f.flow.status(f.id).deferredJoin.status, "completed");
});

test("deferred join preserves uncertain sends and refuses source intervention or model changes", async t => {
  for (const fault of ["send", "user", "model"]) {
    const f = await joinFixture(t); let attempts = 0;
    await f.flow.armJoin(f.id); f.flow.claimJoin(f.id);
    f.finish(a, f.a); f.finish(b, f.b);
    Object.assign(f.states.get(main), { active: false, completedTurnId: "source" });
    if (fault === "send") f.host.send = async () => { attempts++; throw new Error("uncertain transport"); };
    if (fault === "user") f.states.get(main).lastTurnId = "new-user-turn";
    if (fault === "model") f.states.get(main).model = "gpt-6-astra";
    assert.equal((await f.flow.tickJoin(f.id)).status, "needs_review");
    await f.flow.tickJoin(f.id);
    assert.equal(attempts, fault === "send" ? 1 : 0);
  }
});

test("deferred join cannot silently change the main model or arm before worker dispatch", async t => {
  const f = fixture(t), id = (await f.flow.prepare(f.args)).id;
  await assert.rejects(f.flow.armJoin(id), /Dispatch all worker/);
  const g = await joinFixture(t);
  const stateFile = path.join(g.root, "data", "native-flows", `${g.id}.json`);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8")); state.nodes.at(-1).selection = luna("medium");
  fs.writeFileSync(stateFile, JSON.stringify(state));
  await assert.rejects(g.flow.armJoin(g.id), /selection reason/);
});

test("selected main join waits for both barriers, carries the AI reason, and verifies the observed model", async t => {
  const f = await joinFixture(t, { selected: true });
  const armed = await f.flow.armJoin(f.id);
  assert.deepEqual(armed.deferredJoin.sourceSelection, sol("high"));
  assert.deepEqual(armed.deferredJoin.requestedSelection, sol("medium"));
  assert.match(armed.deferredJoin.selectionReason, /Sol medio/);
  f.flow.claimJoin(f.id);
  f.finish(a, f.a); await f.flow.tickJoin(f.id); assert.equal(f.sent.length, 0);
  f.finish(b, f.b); await f.flow.tickJoin(f.id); assert.equal(f.sent.length, 0);
  Object.assign(f.states.get(main), { active: false, completedTurnId: "source" });
  await f.flow.tickJoin(f.id);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].threadId, main);
  assert.equal(f.sent[0].sourceTurnId, "source");
  assert.deepEqual(f.sent[0].requestedSelection, sol("medium"));
  assert.equal(f.flow.status(f.id).nodes.at(-1).deliveryKind, "selected_join");
  f.host.find = async (_thread, prompt) => {
    assert.equal(prompt.includes("\n"), false, "UI composer flattens the visible prompt");
    return [{ turnId: "selected-main" }];
  };
  f.host.receipt = async () => ({ turnId: "selected-main", completed: true, promptMatched: true, userMessageCount: 1,
    model: "gpt-6-sol", reasoning: "medium", finalResponse: "Integrated" });
  Object.assign(f.states.get(main), { lastTurnId: "selected-main", completedTurnId: "selected-main", active: false,
    model: "gpt-6-sol", reasoning: "medium" });
  const completed = await f.flow.tickJoin(f.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.deferredJoin.status, "completed");
  assert.equal(completed.nodes.at(-1).checkpoint.verification, "selected_join_host_receipt");
  assert.deepEqual(completed.nodes.at(-1).checkpoint.observed, sol("medium"));
});

test("selected join without a guarded selection transport cannot arm or send", async t => {
  const f = await joinFixture(t, { selected: true });
  delete f.host.selectedJoin;
  await assert.rejects(f.flow.armJoin(f.id), /transport is unavailable/);
  assert.equal(f.flow.status(f.id).deferredJoin, undefined);
  assert.equal(f.sent.length, 0);
});

test("selected join rejects source intervention and uncertain send without retry", async t => {
  for (const fault of ["source", "send"]) {
    const f = await joinFixture(t, { selected: true }); let sends = 0;
    await f.flow.armJoin(f.id); f.flow.claimJoin(f.id);
    f.finish(a, f.a); f.finish(b, f.b);
    Object.assign(f.states.get(main), { active: false, completedTurnId: "source" });
    if (fault === "source") f.states.get(main).lastTurnId = "intervened";
    else f.host.selectedJoin.send = async () => { sends++; throw new Error("uncertain UI send"); };
    assert.equal((await f.flow.tickJoin(f.id)).status, "needs_review");
    await f.flow.tickJoin(f.id);
    assert.equal(sends, fault === "send" ? 1 : 0);
  }
});

test("selected join blocks a receipt whose actual selection differs from the requested one", async t => {
  const f = await joinFixture(t, { selected: true });
  await f.flow.armJoin(f.id); f.flow.claimJoin(f.id);
  f.finish(a, f.a); f.finish(b, f.b);
  Object.assign(f.states.get(main), { active: false, completedTurnId: "source" });
  await f.flow.tickJoin(f.id);
  f.host.find = async () => [{ turnId: "selected-main" }];
  f.host.receipt = async () => ({ turnId: "selected-main", completed: true, promptMatched: true, userMessageCount: 1,
    model: "gpt-6-sol", reasoning: "high", finalResponse: "Integrated" });
  Object.assign(f.states.get(main), { lastTurnId: "selected-main", completedTurnId: "selected-main", active: false });
  assert.equal((await f.flow.tickJoin(f.id)).status, "needs_review");
  assert.equal(f.sent.length, 1);
});
