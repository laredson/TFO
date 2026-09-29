import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createChatRouter } from "../chat-route.mjs";
import { createSettingsStore, UPGRADE_WARNING } from "../settings.mjs";

const threadId = "12345678-1234-1234-1234-123456789abc";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-chat-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sent = [];
  const dispatch = async (thread, prompt, selection) => {
    sent.push({ thread, prompt, selection });
    return `00000000-0000-0000-0000-${String(sent.length).padStart(12, "0")}`;
  };
  const args = { objective: "Create a two-step demonstration", projectPath: dir, threadId, initialSelection: { model: "gpt-6-astra", reasoning: "xhigh" },
    steps: [{ title: "First action", prompt: "Create note.txt." }, { title: "Second action", prompt: "Read note.txt and append a line." }] };
  return { dir, sent, dispatch, args };
}

test("saves each checkpoint before dispatching the next human-readable prompt", async t => {
  const f = fixture(t);
  let routeId;
  const router = createChatRouter({ dataDir: f.dir, dispatch: async (thread, prompt) => {
    if (f.sent.length === 1) {
      const saved = JSON.parse(fs.readFileSync(path.join(f.dir, "runs", routeId, "state.json"), "utf8"));
      assert.equal(saved.completedSteps.length, 1);
      assert.equal(saved.completedSteps[0].summary, "Created note.txt");
    }
    return f.dispatch(thread, prompt);
  } });
  const started = await router.start(f.args);
  routeId = started.id;
  assert.equal(started.status, "queued");
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].prompt, /Create note\.txt/);
  const next = await router.complete({ runId: routeId, stepId: "step-1", success: true, summary: "Created note.txt" });
  assert.equal(next.status, "queued");
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].prompt, /Created note\.txt/);
  const done = await router.complete({ runId: routeId, stepId: "step-2", success: true, summary: "Added line" });
  assert.equal(done.status, "completed");
  assert.equal(done.completedSteps.length, 2);
  assert.equal(f.sent.length, 2);
  await assert.rejects(router.complete({ runId: routeId, stepId: "step-2", success: true, summary: "Duplicate" }), /already completed/);
});

test("deferred supervisor saves prompts until the matching source turn ends", async t => {
  const f = fixture(t);
  const source = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  let hostTurnId = source;
  const router = createChatRouter({ dataDir: f.dir, dispatch: f.dispatch, deferDispatch: true,
    readMetrics: async () => ({ lastTurnId: hostTurnId, weeklyUsedPercent: 1 }) });
  const started = await router.start(f.args);
  assert.equal(started.status, "pending");
  assert.equal(started.pendingSourceTurnId, source);
  assert.equal(f.sent.length, 0);
  await assert.rejects(router.dispatchPending(started.id, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"), /does not match/);
  assert.equal(f.sent.length, 0);
  const first = await router.dispatchPending(started.id, source);
  assert.equal(first.status, "queued");
  assert.match(f.sent[0].prompt, /Enviado por TFO/);
  hostTurnId = first.dispatch.messageId;
  const next = await router.complete({ runId: started.id, stepId: "step-1", success: true, summary: "First step finished" });
  assert.equal(next.status, "pending");
  assert.equal(f.sent.length, 1);
  const paused = router.pause(started.id);
  assert.equal(paused.status, "paused");
  assert.equal(router.failPending(started.id, hostTurnId, "late worker").status, "paused");
  assert.equal((await router.resume(started.id)).status, "pending");
  assert.equal((await router.dispatchPending(started.id, hostTurnId)).status, "queued");
  assert.equal(f.sent.length, 2);
});

test("pause and cancel prevent dispatch of a later step", async t => {
  const f = fixture(t);
  const router = createChatRouter({ dataDir: f.dir, dispatch: f.dispatch });
  const started = await router.start(f.args);
  assert.equal(router.pause(started.id).status, "paused");
  const paused = await router.complete({ runId: started.id, stepId: "step-1", success: true, summary: "Finished while paused" });
  assert.equal(paused.status, "paused");
  assert.equal(f.sent.length, 1);
  const resumed = await router.resume(started.id);
  assert.equal(resumed.status, "queued");
  assert.equal(f.sent.length, 2);
  assert.equal(router.cancel(started.id).status, "cancelled");
  await assert.rejects(router.complete({ runId: started.id, stepId: "step-2", success: true, summary: "Too late" }), /cancelled/);
  assert.equal(f.sent.length, 2);
});

test("failed step and uncertain dispatch stop without an automatic retry", async t => {
  const f = fixture(t);
  const router = createChatRouter({ dataDir: f.dir, dispatch: f.dispatch });
  const started = await router.start(f.args);
  const failed = await router.complete({ runId: started.id, stepId: "step-1", success: false, summary: "Could not create the file" });
  assert.equal(failed.status, "needs_review");
  assert.equal(f.sent.length, 1);

  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-chat-error-"));
  t.after(() => fs.rmSync(otherDir, { recursive: true, force: true }));
  const uncertain = createChatRouter({ dataDir: otherDir, dispatch: async () => { throw new Error("transport failed"); } });
  const result = await uncertain.start({ ...f.args, projectPath: otherDir });
  assert.equal(result.status, "needs_review");
  assert.match(result.error, /transport failed/);
});

test("a restart after the first checkpoint preserves the queued second step without resending", async t => {
  const f = fixture(t);
  const first = createChatRouter({ dataDir: f.dir, dispatch: f.dispatch });
  const started = await first.start(f.args);
  await first.complete({ runId: started.id, stepId: "step-1", success: true, summary: "First step verified" });
  assert.equal(f.sent.length, 2);
  const restarted = createChatRouter({ dataDir: f.dir, dispatch: f.dispatch });
  const status = restarted.getStatus(started.id);
  assert.equal(status.status, "queued");
  assert.equal(status.completedSteps.length, 1);
  assert.equal(status.currentStep.id, "step-2");
  assert.equal(f.sent.length, 2);
  const done = await restarted.complete({ runId: started.id, stepId: "step-2", success: true, summary: "Second step verified" });
  assert.equal(done.status, "completed");
  assert.equal(f.sent.length, 2);
});

test("a longer chain lowers the model, persists its reason, then blocks a later increase", async t => {
  const f = fixture(t);
  const router = createChatRouter({ dataDir: f.dir, dispatch: f.dispatch });
  f.args.steps.push({ title: "Review", prompt: "Review architectural risks" });
  const started = await router.start(f.args);
  const next = await router.complete({ runId: started.id, stepId: "step-1", success: true, summary: "Designed the change",
    nextAssessment: { complexity: "routine", confidence: "high", reason: "Only append one known line" } });
  assert.deepEqual(f.sent[1].selection, { model: "gpt-6-luna", reasoning: "low" });
  assert.equal(next.modelDecisions[1].reason, "Only append one known line");
  assert.match(next.dispatch.prompt, /Carpeta autorizada:/);
  const blocked = await router.complete({ runId: started.id, stepId: "step-2", success: true, summary: "Line added",
    nextAssessment: { complexity: "complex", confidence: "high", reason: "Review requires Astra", recommendation: f.args.initialSelection } });
  assert.equal(blocked.status, "needs_review");
  assert.equal(blocked.completedSteps.length, 2);
  assert.equal(f.sent.length, 2);
  assert.match(blocked.error, /increase blocked/);
});

test("turning options off during a route preserves its last selection; explicit permission permits bounded increases", async t => {
  const f = fixture(t);
  const store = createSettingsStore(f.dir);
  f.args.steps[0].assessment = { complexity: "routine", confidence: "high", reason: "Simple first edit" };
  const router = createChatRouter({ dataDir: f.dir, dispatch: f.dispatch });
  const started = await router.start(f.args);
  assert.equal(f.sent[0].selection.model, "gpt-6-luna");
  store.update({ economyEnabled: false });
  store.update({ allowUpgrades: true, upgradeCeiling: f.args.initialSelection }, UPGRADE_WARNING);
  const next = await router.complete({ runId: started.id, stepId: "step-1", success: true, summary: "Done",
    nextAssessment: { complexity: "complex", confidence: "high", reason: "Authorized review", recommendation: f.args.initialSelection } });
  assert.equal(next.status, "queued");
  assert.deepEqual(f.sent[1].selection, f.args.initialSelection);
});

test("another client does not recover a live send; pause/resume cannot duplicate an in-flight prompt", async t => {
  const f = fixture(t);
  let release;
  const router = createChatRouter({ dataDir: f.dir, dispatch: async (...args) => {
    await new Promise(resolve => { release = resolve; });
    return f.dispatch(...args);
  } });
  const pending = router.start(f.args);
  const id = fs.readdirSync(path.join(f.dir, "runs"))[0];
  const second = createChatRouter({ dataDir: f.dir, dispatch: f.dispatch });
  assert.equal(second.getStatus(id).status, "dispatching");
  second.pause(id);
  await assert.rejects(second.resume(id), /pending or uncertain/);
  release();
  assert.equal((await pending).status, "paused");
  assert.equal((await second.resume(id)).status, "queued");
  assert.equal(f.sent.length, 1);
});

test("concurrent completion records a checkpoint and queues the next step only once", async t => {
  const f = fixture(t);
  const router = createChatRouter({ dataDir: f.dir, dispatch: f.dispatch });
  const started = await router.start(f.args);
  const args = { runId: started.id, stepId: "step-1", success: true, summary: "Done" };
  const results = await Promise.allSettled([router.complete(args), router.complete(args)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(router.getStatus(started.id).completedSteps.length, 1);
  assert.equal(f.sent.length, 2);
});

test("missing model ceiling and unsupported assessment cannot start a new route", async t => {
  const f = fixture(t);
  const router = createChatRouter({ dataDir: f.dir, dispatch: f.dispatch });
  await assert.rejects(router.start({ ...f.args, initialSelection: undefined }), /Unsupported/);
  await assert.rejects(router.start({ ...f.args, steps: [{ title: "Step", prompt: "Do", assessment: {} }] }), /Assessment requires/);
  assert.equal(f.sent.length, 0);
});

test("a host that ignores the requested downgrade cannot silently continue the chain", async t => {
  const f = fixture(t);
  f.args.steps[0].assessment = { complexity: "routine", confidence: "high", reason: "Simple edit" };
  const router = createChatRouter({ dataDir: f.dir, dispatch: f.dispatch, readObserved: async () => f.args.initialSelection });
  const started = await router.start(f.args);
  const done = await router.complete({ runId: started.id, stepId: "step-1", success: true, summary: "Edit complete" });
  assert.equal(done.status, "needs_review");
  assert.equal(done.completedSteps[0].success, false);
  assert.equal(done.completedSteps[0].observed.model, "gpt-6-astra");
  assert.match(done.error, /Host model verification failed/);
  assert.equal(f.sent.length, 1);
});
