import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPromptQueue } from "../prompt-queue.mjs";
import { createChatRouter } from "../chat-route.mjs";

const threadId = "12345678-1234-1234-1234-123456789abc";
const sourceTurn = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const selection = reasoning => ({ model: "gpt-6-luna", reasoning });
test("failed startup is visible immediately and does not leave an armed queue", async t => {
  const f=fixture(t,{startSupervisor:async()=>{throw new Error("spawn failed");}});
  const s=await f.queue.start(f.args);
  assert.equal(s.status,"needs_review"); assert.match(s.error,/spawn failed/);
  await f.queue.tick(s.id); assert.equal(f.sent.length,0);
});
test("paused preparation does not launch a process and resume launches exactly once", async t => {
  let launches=0;
  const f=fixture(t,{startSupervisor:async()=>{launches++;}});
  const s=await f.queue.start({...f.args,startPaused:true});
  assert.equal(launches,0);
  await f.queue.resume(s.id); assert.equal(launches,1);
});
test("arming and resume require hook evidence; paused preparation does not", async t => {
  const f = fixture(t, { verifyHook: () => { throw new Error("Unverified installation"); } });
  await assert.rejects(f.queue.start(f.args), /Unverified installation/);
  const paused = await f.queue.start({...f.args, startPaused:true});
  await assert.rejects(f.queue.resume(paused.id), /Unverified installation/);
  assert.equal(f.sent.length, 0);
});
test("status reports missing Stop acknowledgement after timeout without dispatch", async t => {
  const f = fixture(t);
  const s = await f.queue.start(f.args);
  const file = path.join(f.dir, "runs", s.id, "state.json");
  const state = JSON.parse(fs.readFileSync(file));
  state.waitingSince = "2000-01-01T00:00:00.000Z";
  fs.writeFileSync(file, JSON.stringify(state));
  assert.equal(f.queue.getStatus(s.id).status, "needs_review");
  assert.equal(f.sent.length, 0);
});
test("normal Chat is rejected before reading Codex files or creating a live queue", async t => {
  const f = fixture(t, { readHost: async () => { throw new Error("must not read Codex"); } });
  await assert.rejects(f.queue.start({ ...f.args, surface: "chatgpt-chat" }), /No queue was armed/);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, "runs")), []);
});
test("a read-only preflight failure is recorded as unsent and never retried", async t => {
  let calls = 0;
  const f = fixture(t, { dispatch: async () => {
    calls++;
    const error = new Error("The TFO route marker is not visible in this chat");
    error.deliveryStage = "preflight";
    throw error;
  } });
  const started = await f.queue.start(f.args);
  f.finishSource();
  const stopped = await f.queue.tick(started.id);
  assert.equal(stopped.status, "needs_review");
  assert.equal(stopped.dispatch.deliveryStage, "preflight_failed");
  assert.equal(stopped.dispatch.sendAttempted, false);
  assert.equal(stopped.dispatch.sending, false);
  await f.queue.tick(started.id);
  assert.equal(calls, 1);
});
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-fifo-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let host = { active: true, lastTurnId: sourceTurn, completedTurnId: null };
  let receipt, promptTurns=[];
  const sent = [];
  const deps = { dataDir: dir, readHost: async () => ({ ...host }), readReceipt: async () => receipt,
    findPromptTurns: async()=>promptTurns,
    dispatch: async (thread, prompt, requested, authorization) => {
      const id = `00000000-0000-0000-0000-${String(sent.length + 1).padStart(12,"0")}`;
      sent.push({ thread, prompt, requested, authorization, id });
      host = { active: true, lastTurnId: id, completedTurnId: host.completedTurnId };
      return id;
    }, ...overrides };
  const args = { threadId, projectPath: dir, objective: "Sequential replies", initialSelection: selection("medium"), allowPlannedIncreases: true,
    steps: ["medium", "low", "medium"].map((effort,index) => ({ title: `Reply ${index+1}`, prompt: `Reply only ${index+1}`, selection: selection(effort), expectedResponse: String(index+1) })) };
  const queue = createPromptQueue(deps);
  return { dir, queue, sent, args, deps, setHost: value => { host = value; }, setReceipt: value => { receipt = value; }, setPromptTurns: value => { promptTurns=value; },
    finishSource: () => { host = { active: false, lastTurnId: sourceTurn, completedTurnId: sourceTurn }; },
    finish: (text = String(sent.length), extra = {}) => {
      const message = sent.at(-1);
      host = { active: false, lastTurnId: message.id, completedTurnId: message.id };
      receipt = { completed: true, promptMatched: true, userMessageCount: 1, finalResponse: text,
        model: message.requested.model, reasoning: message.requested.reasoning, ...extra };
    } };
}

test("FIFO stores all prompts, waits for actual completion, and advances medium/low/medium without an AI checkpoint", async t => {
  const f = fixture(t);
  const started = await f.queue.start(f.args);
  assert.equal(f.sent.length, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(f.dir,"runs",started.id,"state.json"),"utf8"));
  assert.equal(saved.steps.length, 3);
  assert.match(saved.steps[2].visiblePrompt, /Reply only 3/);
  for (let i=0;i<3;i++) await f.queue.tick(started.id);
  assert.equal(f.sent.length, 0);
  f.finishSource();
  await f.queue.tick(started.id);
  assert.equal(f.sent.length,1);
  assert.equal(f.queue.getStatus(started.id).completedSteps.length,0);
  for (let i=0;i<3;i++) await f.queue.tick(started.id);
  assert.equal(f.sent.length,1);
  for (let i=1;i<=3;i++) {
    f.finish();
    await Promise.all([f.queue.tick(started.id), f.queue.tick(started.id)]);
    assert.equal(f.queue.getStatus(started.id).completedSteps.length,i);
    assert.equal(f.sent.length,Math.min(3,i+1));
  }
  assert.equal(f.queue.getStatus(started.id).status,"completed");
  assert.deepEqual(f.sent.map(x=>x.requested.reasoning),["medium","low","medium"]);
  assert.ok(f.sent.every(x=>x.thread===threadId));
});

test("wrong response, wrong model, interrupted turn and injected user input each stop the remaining queue", async t => {
  for (const scenario of ["reply", "selection", "interrupt", "injection", "other-turn"]) {
    const f = fixture(t);
    const started = await f.queue.start(f.args);
    f.finishSource(); await f.queue.tick(started.id);
    if (scenario === "reply") f.finish("unexpected");
    if (scenario === "selection") f.finish("1", { reasoning: "high" });
    if (scenario === "injection") f.finish("1", { userMessageCount: 2 });
    if (scenario === "interrupt") f.setHost({ active: true, lastTurnId:f.sent[0].id, interruptedTurnId:f.sent[0].id });
    if (scenario === "other-turn") f.setHost({ active: true, lastTurnId:"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" });
    const stopped = await f.queue.tick(started.id);
    assert.equal(stopped.status,"needs_review",scenario);
    await f.queue.tick(started.id);
    assert.equal(f.sent.length,1,scenario);
    assert.equal(stopped.completedSteps.length,0,scenario);
  }
});

test("pause and cancel preserve the queue without launching another prompt", async t => {
  for (const control of ["pause", "cancel"]) {
    const f = fixture(t);
    const started = await f.queue.start(f.args);
    f.finishSource(); await f.queue.tick(started.id);
    f.queue[control](started.id);
    f.finish(); await f.queue.tick(started.id);
    assert.equal(f.sent.length,1);
    assert.equal(f.queue.getStatus(started.id).status,control==="pause"?"paused":"cancelled");
  }
});

test("duplicate Stop signals have one supervisor and a dead supervisor never resends on restart", async t => {
  const f = fixture(t);
  const started = await f.queue.start(f.args);
  assert.equal(f.queue.attachSupervisor(started.id,sourceTurn).attached,true);
  const second = createPromptQueue(f.deps);
  assert.equal(second.attachSupervisor(started.id,sourceTurn).attached,false);
  f.finishSource(); await f.queue.tick(started.id);
  const file = path.join(f.dir,"runs",started.id,"state.json");
  const state = JSON.parse(fs.readFileSync(file,"utf8"));
  state.supervisor.ownerPid = 2147483647;
  fs.writeFileSync(file,JSON.stringify(state));
  const recovered = second.recover(started.id);
  assert.equal(recovered.status,"paused");
  await second.tick(started.id);
  assert.equal(f.sent.length,1);
  assert.equal(recovered.dispatch.messageId,f.sent[0].id);
  f.finish("1");
  const resumeTurn="cccccccc-cccc-cccc-cccc-cccccccccccc";
  f.setHost({active:true,lastTurnId:resumeTurn});
  const resumed=await second.resume(started.id);
  assert.equal(resumed.completedSteps.length,1);
  await second.tick(started.id);
  assert.equal(f.sent.length,1);
  f.setHost({active:false,lastTurnId:resumeTurn,completedTurnId:resumeTurn});
  await second.tick(started.id);
  assert.equal(f.sent.length,2);
  assert.equal(f.sent[1].requested.reasoning,"low");
});

test("ambiguous send persists one attempt and cannot be retried by later ticks", async t => {
  let attempts=0;
  const f = fixture(t,{dispatch:async()=>{attempts++;throw new Error("unknown acceptance");}});
  const started=await f.queue.start(f.args);
  f.finishSource();
  await f.queue.tick(started.id);
  await f.queue.tick(started.id);
  assert.equal(attempts,1);
  assert.equal(f.queue.getStatus(started.id).status,"needs_review");
  assert.ok(f.queue.getStatus(started.id).dispatch.attemptId);
});

test("only the expressly authorized fixed sequence may increase and only one queue may bind a chat", async t => {
  const f=fixture(t);
  await assert.rejects(f.queue.start({...f.args,allowPlannedIncreases:false}),/higher/);
  await assert.rejects(f.queue.start({...f.args,steps:[{prompt:"too high",selection:selection("high") }]}),/higher/);
  const started=await f.queue.start(f.args);
  await assert.rejects(f.queue.start(f.args),/already has/);
  const legacy=createChatRouter({dataDir:f.dir,dispatch:async()=>{throw new Error("must not send");}});
  await assert.rejects(legacy.start({...f.args,steps:[{title:"Legacy",prompt:"do not send"}]}),/already has/);
  f.queue.cancel(started.id);
  assert.equal((await f.queue.start(f.args)).status,"pending");
});

test("a pause during an accepted send preserves its receipt and prohibits an automatic resume", async t => {
  let release;
  const f=fixture(t,{dispatch:async()=>new Promise(resolve=>{release=resolve;})});
  const started=await f.queue.start(f.args);
  f.finishSource();
  const delivery=f.queue.tick(started.id);
  while (!release) await new Promise(resolve=>setImmediate(resolve));
  f.queue.pause(started.id);
  release("00000000-0000-0000-0000-000000000001");
  const state=await delivery;
  assert.equal(state.status,"paused");
  assert.equal(state.dispatch.sending,false);
  assert.equal(state.resumeStatus,"queued");
  f.setHost({active:true,lastTurnId:sourceTurn});
  await assert.rejects(f.queue.resume(started.id),/awaiting review/);
});

test("the host becoming busy between completion and dispatch stops before the external effect", async t => {
  let reads=0, sends=0;
  const f=fixture(t,{readHost:async()=>{
    reads++;
    return {lastTurnId:sourceTurn,completedTurnId:sourceTurn,active:reads===1||reads>=3};
  },dispatch:async()=>{sends++;}});
  const started=await f.queue.start(f.args);
  const result=await f.queue.tick(started.id);
  assert.equal(result.status,"needs_review");
  assert.equal(result.dispatch.sending,false);
  assert.equal(result.dispatch.sendAttempted,false);
  assert.equal(result.dispatch.deliveryStage,"before_send_failed");
  assert.equal(sends,0);
});

test("a prepared paused queue cannot be armed by Stop until it is explicitly resumed", async t => {
  const f=fixture(t);
  const queue=await f.queue.start({...f.args,startPaused:true});
  assert.equal(queue.status,"paused");
  assert.equal(f.queue.attachSupervisor(queue.id,sourceTurn).attached,false);
  f.finishSource(); await f.queue.tick(queue.id);
  assert.equal(f.sent.length,0);
  const resumedTurn="dddddddd-dddd-dddd-dddd-dddddddddddd";
  f.setHost({active:true,lastTurnId:resumedTurn});
  assert.equal((await f.queue.resume(queue.id)).pendingSourceTurnId,resumedTurn);
  await f.queue.tick(queue.id);
  assert.equal(f.sent.length,0);
});

test("input added to the preparing turn invalidates the pending queue before its first send", async t => {
  const f=fixture(t);
  f.setHost({active:true,lastTurnId:sourceTurn,userMessageCount:1});
  const queue=await f.queue.start(f.args);
  f.setHost({active:false,lastTurnId:sourceTurn,completedTurnId:sourceTurn,userMessageCount:2});
  assert.equal((await f.queue.tick(queue.id)).status,"needs_review");
  assert.equal(f.sent.length,0);
});

test('an explicitly unsent UI draft is saved for review and never automatically retried', async t => {
  let calls=0;
  const f=fixture(t,{dispatch:async()=>{
    calls++;
    throw Object.assign(new Error('Composer did not confirm'),{
      deliveryStage:'before_send',sendAttempted:false,textEntryAttempted:true,uiPhase:'waiting_for_composer',
    });
  }});
  const started=await f.queue.start(f.args);
  f.finishSource();
  const stopped=await f.queue.tick(started.id);
  assert.equal(stopped.status,'needs_review');
  assert.equal(stopped.dispatch.sending,false);
  assert.equal(stopped.dispatch.sendAttempted,false);
  assert.equal(stopped.dispatch.textEntryAttempted,true);
  assert.equal(stopped.dispatch.deliveryStage,'before_send_failed');
  assert.equal(stopped.dispatch.uiPhase,'waiting_for_composer');
  await f.queue.tick(started.id);
  assert.equal(calls,1);
});

test('an attempted send without a prompt receipt is explicitly uncertain and never retried', async t => {
  let calls=0;
  const f=fixture(t,{dispatch:async()=>{
    calls++;
    throw Object.assign(new Error('Host did not confirm the started prompt'),{sendAttempted:true});
  }});
  const started=await f.queue.start(f.args);
  f.finishSource();
  const stopped=await f.queue.tick(started.id);
  assert.equal(stopped.status,'needs_review');
  assert.equal(stopped.dispatch.sending,false);
  assert.equal(stopped.dispatch.sendAttempted,true);
  assert.equal(stopped.dispatch.deliveryStage,'confirmation_uncertain');
  await f.queue.tick(started.id);
  assert.equal(calls,1);
});

test('reconciliation records one exact completed host receipt and never sends another prompt',async t=>{
  let calls=0;
  const turnId="eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
  const f=fixture(t,{dispatch:async()=>{calls++;throw Object.assign(new Error("Confirmation timed out"),{sendAttempted:true});}});
  const args={...f.args,steps:[{title:"Only step",prompt:"Exact result",selection:selection("medium"),expectedResponse:"verified"}]};
  const started=await f.queue.start(args);
  f.finishSource();
  const uncertain=await f.queue.tick(started.id);
  assert.equal(uncertain.status,"needs_review");
  f.setPromptTurns([{turnId,startedAt:new Date(Date.now()+1000).toISOString()}]);
  f.setReceipt({completed:true,interrupted:false,promptMatched:true,userMessageCount:1,
    finalResponse:"verified",model:"gpt-6-luna",reasoning:"medium"});
  const reconciled=await f.queue.reconcile(started.id);
  assert.equal(reconciled.status,"completed");
  assert.equal(reconciled.completedSteps.length,1);
  assert.equal(reconciled.completedSteps[0].messageId,turnId);
  assert.equal(reconciled.lastReconciliation.source,"verified_host_receipt");
  assert.equal(reconciled.dispatch,null);
  assert.equal(f.sent.length,0);
  assert.equal(calls,1);
});

test('reconciliation refuses mismatching receipts and duplicate prompt turns',async t=>{
  const turnId="ffffffff-ffff-ffff-ffff-ffffffffffff";
  const f=fixture(t,{dispatch:async()=>{throw Object.assign(new Error("uncertain"),{sendAttempted:true});}});
  const started=await f.queue.start({...f.args,steps:[{title:"Only step",prompt:"Exact result",selection:selection("medium"),expectedResponse:"verified"}]});
  f.finishSource();
  await f.queue.tick(started.id);
  f.setPromptTurns([{turnId,startedAt:new Date(Date.now()+1000).toISOString()}]);
  f.setReceipt({completed:true,interrupted:false,promptMatched:true,userMessageCount:1,finalResponse:"wrong",model:"gpt-6-luna",reasoning:"medium"});
  await assert.rejects(f.queue.reconcile(started.id),/final response differs/);
  f.setReceipt({completed:true,interrupted:false,promptMatched:true,userMessageCount:1,finalResponse:"verified",model:"gpt-6-luna",reasoning:"medium"});
  f.setPromptTurns([{turnId,startedAt:new Date(Date.now()+1000).toISOString()},{turnId:"aaaaaaaa-0000-0000-0000-000000000000",startedAt:new Date(Date.now()+2000).toISOString()}]);
  await assert.rejects(f.queue.reconcile(started.id),/exact prompt must appear in exactly one/);
  assert.equal(f.queue.getStatus(started.id).status,"needs_review");
});

test('explicit user-approved pairs allow only the stored Sol medium then Luna high plan from Astra low', async t => {
  const f=fixture(t);
  const approved=[{model:'gpt-6-sol',reasoning:'medium'},{model:'gpt-6-luna',reasoning:'high'}];
  const args={...f.args,initialSelection:{model:'gpt-6-astra',reasoning:'low'},authorizedSelections:approved,
    steps:approved.map((selection,i)=>({title:`Step ${i+1}`,prompt:`Reply ${i+1}`,selection,expectedResponse:String(i+1)}))};
  const started=await f.queue.start(args);
  assert.deepEqual(started.authorization.initialSelection,{model:'gpt-6-astra',reasoning:'low'});
  assert.deepEqual(started.authorization.authorizedSelections,approved);
  f.finishSource();await f.queue.tick(started.id);
  f.finish();await f.queue.tick(started.id);
  f.finish();await f.queue.tick(started.id);
  assert.equal(f.queue.getStatus(started.id).status,'completed');
  assert.deepEqual(f.sent.map(x=>x.requested),approved);
  assert.deepEqual(f.sent[0].authorization.authorizedSelections,approved);
});

test('above-initial pairs require explicit authorization, belong to the plan, and keep the model generation', async t => {
  const f=fixture(t);
  const high={model:'gpt-6-luna',reasoning:'high'};
  const args={...f.args,initialSelection:selection('low'),steps:[{prompt:'one',selection:high}]};
  await assert.rejects(f.queue.start(args),/higher/);
  await assert.rejects(f.queue.start({...args,authorizedSelections:[high],allowPlannedIncreases:false}),/allowPlannedIncreases/);
  await assert.rejects(f.queue.start({...args,authorizedSelections:[selection('medium')]}),/stored step/);
  const other={model:'gpt-5.6-luna',reasoning:'high'};
  await assert.rejects(f.queue.start({...args,steps:[{prompt:'one',selection:other}],authorizedSelections:[other]}),/generation/);
});
