import test from "node:test";
import assert from "node:assert/strict";
import { createPromptDispatcher, uiBridgeFailure, waitForUiReady } from "../queue-transport.mjs";
const source = "11111111-1111-1111-1111-111111111111";
const target = "22222222-2222-2222-2222-222222222222";
const layout = {window:[0,0,1200,900],marker:[400,600,200,30],editor:[300,700,800,100],selector:[800,850,150,30]};
const current = { model: "gpt-6-luna", reasoning: "medium" };
test("bridge errors distinguish an unsent draft from an attempted or unknown send", () => {
  const report = {phase:"waiting_for_composer",textEntryAttempted:true,sendAttempted:false,error:"Composer did not confirm"};
  const before = uiBridgeFailure(`TFO_UI_FAILURE:${JSON.stringify(report)}\n`,1);
  assert.equal(before.deliveryStage,"before_send");
  assert.equal(before.sendAttempted,false);
  assert.equal(before.textEntryAttempted,true);
  assert.equal(before.uiPhase,"waiting_for_composer");
  const attempted = uiBridgeFailure(`TFO_UI_FAILURE:${JSON.stringify({...report,sendAttempted:true,phase:"invoking_send"})}`,1);
  assert.equal(attempted.sendAttempted,true);
  assert.equal(attempted.deliveryStage,undefined);
  const unknown = uiBridgeFailure('terminated without a report',null);
  assert.equal(unknown.sendAttempted,undefined);
  assert.equal(unknown.deliveryStage,undefined);
});
function fixture(overrides = {}) {
  const calls = [];
  let sent = false;
  const deps = {
    readTurn: async () => sent ? { active: true, lastTurnId: target, selectionTurnId: target, userMessageCount: 1, model: current.model, reasoning: current.reasoning }
      : { active: false, lastTurnId: source, completedTurnId: source },
    readSelection: async () => current, containsPrompt: async () => true, wait: async () => {},
    guard: async () => { calls.push("guard"); },
    ui: async mode => { calls.push(mode); if (mode === "send") sent = true; return { status: mode === "probe" ? "ready" : "attempted", selector: "GPT-6 Luna Medio", layout }; },
    nativeSend: async () => { calls.push("native"); sent = true; return "33333333-3333-3333-3333-333333333333"; },
    ...overrides,
  };
  return { calls, dispatch: createPromptDispatcher(deps), auth: { sourceTurnId: source, runId: "queue_test", dataDir: "unused", ceiling: current } };
}
test("deferred identical selection uses the native host queue once and confirms the actual turn ID", async () => {
  const f = fixture();
  assert.equal(await f.dispatch(target, "hola", current, f.auth), target);
  assert.deepEqual(f.calls, ["guard", "probe", "guard", "probe", "guard", "native"]);
});
test("deferred selection change uses the guarded UI and never falls back to native", async () => {
  const f = fixture({ readSelection: async () => ({model:"gpt-6-sol",reasoning:"medium"}) });
  assert.equal(await f.dispatch(target, "hola", current, f.auth), target);
  assert.deepEqual(f.calls, ["guard", "probe", "guard", "probe", "send"]);
});
test("explicit UI validation uses the full picker path even when selection is unchanged", async () => {
  const f = fixture();
  assert.equal(await f.dispatch(target, "hola", current, {...f.auth,deliveryMode:"ui"}), target);
  assert.deepEqual(f.calls,["guard","probe","guard","probe","send"]);
});
test("UI dispatch accepts the exact started prompt before Codex writes turn_context", async () => {
  let sent = false, reads = 0;
  const f = fixture({
    readTurn: async () => {
      reads++;
      if (!sent) return {active:false,lastTurnId:source,completedTurnId:source};
      return {active:true,lastTurnId:target,userMessageCount:1,selectionTurnId:null,model:null,reasoning:null};
    },
    ui: async mode => {
      if (mode === "send") sent = true;
      return {status:mode === "probe" ? "ready" : "attempted",selector:"GPT-6 Luna Medio",layout};
    },
  });
  assert.equal(await f.dispatch(target,"hola",current,{...f.auth,deliveryMode:"ui"}),target);
  assert.equal(reads,2);
});
test("UI dispatch keeps an attempted send uncertain and never retries if no matching host prompt appears", async () => {
  let reads = 0;
  const f = fixture({
    readTurn: async () => { reads++; return {active:false,lastTurnId:source,completedTurnId:source}; },
    confirmationTimeoutMs: 2,
    confirmationPollMs: 1,
  });
  await assert.rejects(f.dispatch(target,"hola",current,{...f.auth,deliveryMode:"ui"}), error => error.sendAttempted === true && /delivery is uncertain/.test(error.message));
  assert.equal(f.calls.filter(call => call === "send").length,1);
  assert.equal(reads,3); // source guard plus two bounded confirmation reads
});
test("a failed UI preflight sends nothing on either path", async () => {
  const f = fixture({ui:async () => {throw new Error("marker unavailable");}});
  await assert.rejects(f.dispatch(target, "hola", current, f.auth), error => error.deliveryStage === "preflight");
  assert.deepEqual(f.calls, ["guard"]);
});
test("an active source turn and a changed reservation block native dispatch", async () => {
  const busy = fixture({readTurn:async()=>({active:true,lastTurnId:source,completedTurnId:source})});
  await assert.rejects(busy.dispatch(target,"hola",current,busy.auth), /source turn/);
  assert.deepEqual(busy.calls, []);
  let checked = 0;
  const stale = fixture({guard:async()=>{if(++checked===2)throw new Error("route paused");}});
  await assert.rejects(stale.dispatch(target,"hola",current,stale.auth), /route paused/);
  assert.deepEqual(stale.calls, ["probe"]);
});
test("a composer selection different from rollout metadata blocks the native queue before sending", async () => {
  const f = fixture({ui:async()=>({status:"ready",selector:"GPT-6 Sol Medio",layout})});
  await assert.rejects(f.dispatch(target,"hola",current,f.auth), error => error.deliveryStage === "preflight" && /composer selection/.test(error.message));
  assert.deepEqual(f.calls,["guard","guard"]);
});
test("an ambiguous native result or mismatching turn never retries another transport", async () => {
  let attempts = 0;
  const ambiguous = fixture({nativeSend:async()=>{attempts++;throw new Error("unconfirmed");}});
  await assert.rejects(ambiguous.dispatch(target,"hola",current,ambiguous.auth), /unconfirmed/);
  assert.equal(attempts, 1);
  assert.ok(!ambiguous.calls.includes("send"));
  const mismatch = fixture({containsPrompt:async()=>false});
  await assert.rejects(mismatch.dispatch(target,"hola",current,mismatch.auth), /different prompt/);
  assert.equal(mismatch.calls.filter(x=>x==="native").length,1);
});


test('read-only preflight waits for rendering and two stable layouts without actions', async () => {
  const frames=[{status:'awaiting_render',reason:'route_marker_not_visible'},
    {status:'ready',selector:'GPT-6 Luna Medio',layout:{...layout,marker:[400,500,200,30]}},
    {status:'ready',selector:'GPT-6 Luna Medio',layout},
    {status:'ready',selector:'GPT-6 Luna Medio',layout}];
  let reads=0,guards=0;
  const result=await waitForUiReady({probe:async()=>frames[reads++],guard:async()=>{guards++;},wait:async()=>{}});
  assert.equal(result.status,'ready'); assert.equal(reads,4); assert.equal(guards,4);
});

test('hidden marker, unstable layout, changed host, and absent bounds never become ready', async () => {
  for(const make of [()=>({status:'awaiting_render',reason:'route_marker_not_visible',markerVisible:false}),
    i=>({status:'ready',selector:'GPT-6 Luna Medio',layout:{...layout,marker:[400,i,200,30]}})]) {
    let reads=0;
    await assert.rejects(waitForUiReady({probe:async()=>make(++reads),guard:async()=>{},wait:async()=>{}}),/read-only wait/);
    assert.equal(reads,8);
  }
  let reads=0;
  await assert.rejects(waitForUiReady({probe:async()=>{reads++;return {status:'awaiting_render'};},guard:async()=>{if(reads)throw new Error('New user input');},wait:async()=>{}}),/New user input/);
  assert.equal(reads,1);
  await assert.rejects(waitForUiReady({probe:async()=>({status:'ready'}),guard:async()=>{},wait:async()=>{}}),/layout bounds/);
});

test('dispatch enforces exact authorized pairs above the initial ceiling', async () => {
  const f=fixture();
  const auth={...f.auth,ceiling:{model:'gpt-6-luna',reasoning:'low'},allowUpgrades:true,authorizedSelections:[current]};
  assert.equal(await f.dispatch(target,'hola',current,auth),target);
  const blocked=fixture();
  await assert.rejects(blocked.dispatch(target,'hola',current,{...auth,authorizedSelections:[{...current,reasoning:'high'}]}),/higher/);
  assert.deepEqual(blocked.calls,[]);
  await assert.rejects(blocked.dispatch(target,'hola',current,{...auth,allowUpgrades:false}),/higher/);
});
