import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readHostSelection, readHostTurnReceipt, readHostTurnState, findHostTurnsForPrompt } from "../host-selection.mjs";
const id = "12345678-1234-1234-1234-123456789abc";
test("weekly usage selects the seven-day window and never labels a five-hour window weekly", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-weekly-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); fs.mkdirSync(path.join(dir, "sessions"));
  const file = path.join(dir, "sessions", `rollout-${id}.jsonl`);
  const record = rate_limits => JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits } }) + "\n";
  fs.writeFileSync(file, record({ primary: { used_percent: 45, window_minutes: 300 } }));
  assert.equal((await readHostTurnState(id, dir)).weeklyUsedPercent, null);
  fs.appendFileSync(file, record({ primary: { used_percent: 45, window_minutes: 300 }, secondary: { used_percent: 21, window_minutes: 10080 } }));
  assert.equal((await readHostTurnState(id, dir)).weeklyUsedPercent, 21);
});
test("host probe reads only matching turn metadata and rejects missing or unknown model information", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-host-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(readHostSelection(id, dir), /Cannot verify/);
  const sessions = path.join(dir, "sessions", "2026", "09", "25");
  fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, `rollout-test-${id}.jsonl`);
  const row = (model, effort) => JSON.stringify({ type: "turn_context", payload: { model, effort } });
  fs.writeFileSync(file, [row("gpt-6-astra", "xhigh"), row("gpt-6-luna", "low"), "partial"].join("\n"));
  assert.deepEqual(await readHostSelection(id, dir), { model: "gpt-6-luna", reasoning: "low" });
  fs.writeFileSync(file, row("unsupported", "low"));
  await assert.rejects(readHostSelection(id, dir), /Unsupported/);
  await assert.rejects(readHostSelection("../bad", dir), /Invalid/);
});

test("a turn receipt requires the exact user prompt, its own final answer and matching completion", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-receipt-"));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  fs.mkdirSync(path.join(dir,"sessions"));
  const turn="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const file=path.join(dir,"sessions",`rollout-${id}.jsonl`);
  const rows=[
    {type:"event_msg",payload:{type:"task_started",turn_id:turn}},
    {type:"turn_context",payload:{turn_id:turn,model:"gpt-6-luna",effort:"medium"}},
    {type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"TFO prompt"}]}},
    {type:"response_item",payload:{type:"message",role:"assistant",phase:"commentary",content:[{type:"output_text",text:"still working"}]}},
  ];
  const write=()=>fs.writeFileSync(file,rows.map(x=>JSON.stringify(x)).join("\n"));
  write();
  let receipt=await readHostTurnReceipt(id,turn,"TFO prompt",dir);
  assert.equal(receipt.completed,false);
  assert.equal(receipt.finalResponse,null);
  rows.push({type:"response_item",payload:{type:"message",role:"assistant",phase:"final_answer",content:[{type:"output_text",text:"hola"}]}});
  write();
  assert.equal((await readHostTurnReceipt(id,turn,"TFO prompt",dir)).completed,false);
  rows.push({type:"event_msg",payload:{type:"task_complete",turn_id:turn}});
  write();
  receipt=await readHostTurnReceipt(id,turn,"TFO prompt",dir);
  assert.equal(receipt.completed,true); assert.equal(receipt.promptMatched,true); assert.equal(receipt.finalResponse,"hola");
  assert.equal(receipt.model,"gpt-6-luna"); assert.equal(receipt.userMessageCount,1);
  assert.equal((await readHostTurnReceipt(id,turn,"other",dir)).promptMatched,false);
  const other="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  rows.push({type:"event_msg",payload:{type:"task_started",turn_id:other}},
    {type:"response_item",payload:{type:"message",role:"assistant",phase:"final_answer",content:[{type:"output_text",text:"unrelated"}]}},
    {type:"event_msg",payload:{type:"turn_aborted",turn_id:other}});
  write();
  assert.equal((await readHostTurnReceipt(id,turn,"TFO prompt",dir)).finalResponse,"hola");
  assert.equal((await readHostTurnState(id,dir)).interruptedTurnId,other);
});

test("injected environment metadata is not counted as a second user prompt", async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"tfo-context-receipt-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,"sessions"));
  const turn="cccccccc-cccc-cccc-cccc-cccccccccccc";
  const file=path.join(dir,"sessions",`rollout-${id}.jsonl`);
  const rows=[
    {type:"event_msg",payload:{type:"task_started",turn_id:turn}},
    {type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"<environment_context>\n<cwd>C:\\Project</cwd>\n</environment_context>"}]}},
    {type:"turn_context",payload:{turn_id:turn,model:"gpt-6-luna",effort:"high"}},
    {type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"TFO prompt"}]}},
    {type:"response_item",payload:{type:"message",role:"assistant",phase:"final_answer",content:[{type:"output_text",text:"luna"}]}},
    {type:"event_msg",payload:{type:"task_complete",turn_id:turn}},
  ];
  fs.writeFileSync(file,rows.map(x=>JSON.stringify(x)).join("\n"));
  const receipt=await readHostTurnReceipt(id,turn,"TFO prompt",dir);
  assert.equal(receipt.completed,true);
  assert.equal(receipt.promptMatched,true);
  assert.equal(receipt.userMessageCount,1);
  assert.equal((await readHostTurnState(id,dir)).userMessageCount,1);
  rows.splice(3,0,{type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"Another user message"}]}});
  fs.writeFileSync(file,rows.map(x=>JSON.stringify(x)).join("\n"));
  assert.equal((await readHostTurnReceipt(id,turn,"TFO prompt",dir)).userMessageCount,2);
});

test("host prompt lookup returns only exact matching turns with their start time",async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"tfo-find-prompt-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,"sessions"));
  const one="dddddddd-dddd-dddd-dddd-dddddddddddd",two="eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
  const file=path.join(dir,"sessions",`rollout-${id}.jsonl`);
  const rows=[
    {type:"event_msg",timestamp:"2026-09-28T04:00:00.000Z",payload:{type:"task_started",turn_id:one}},
    {type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"exact marker"}]}},
    {type:"event_msg",timestamp:"2026-09-28T04:01:00.000Z",payload:{type:"task_started",turn_id:two}},
    {type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"different marker"}]}}
  ];
  fs.writeFileSync(file,rows.map(x=>JSON.stringify(x)).join("\n"));
  assert.deepEqual(await findHostTurnsForPrompt(id,"exact marker",dir),[{turnId:one,startedAt:"2026-09-28T04:00:00.000Z"}]);
  assert.deepEqual(await findHostTurnsForPrompt(id,"exact",dir),[]);
});
