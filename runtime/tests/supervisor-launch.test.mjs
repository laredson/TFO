import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPromptQueue, isAlive } from "../prompt-queue.mjs";
import { launchSupervisor, snapshotSupervisor, supervisorFiles } from "../supervisor-launch.mjs";
import { readHostTurnState } from "../host-selection.mjs";
import { snapshotProjectSupervisor } from "../project-supervisor.mjs";
import { snapshotNativeCoordinator } from "../native-coordinator-supervisor.mjs";
const thread = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", turn = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const wait = ms => new Promise(r => setTimeout(r,ms));
async function until(check) { for (let i=0;i<100;i++) { if (check()) return; await wait(100); } throw new Error("Timed out"); }

test("real child acknowledges, survives removed plugin files, waits without Stop, and checks three simulated receipts", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"tfo-supervisor-"));
  const previous = process.env.CODEX_HOME;
  const codex = path.join(dir,"host");
  process.env.CODEX_HOME = codex;
  let pid;
  t.after(async () => {
    if (pid && isAlive(pid)) { process.kill(pid); await until(() => !isAlive(pid)); }
    if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    fs.rmSync(dir,{recursive:true,force:true});
  });
  fs.mkdirSync(path.join(codex,"sessions"),{recursive:true});
  const rollout = path.join(codex,"sessions",`${thread}.jsonl`);
  fs.writeFileSync(rollout,JSON.stringify({type:"event_msg",payload:{type:"task_started",turn_id:turn}})+"\n");
  const source = path.join(dir,"plugin-runtime");
  fs.mkdirSync(source);
  for (const name of supervisorFiles) fs.copyFileSync(path.join("runtime",name),path.join(source,name));
  // Only the transport is simulated. The child process, persistent queue, parser and checkpoints are real.
  fs.writeFileSync(path.join(source,"queue-transport.mjs"), `
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
export async function dispatchPrompt(thread,prompt,selection) {
 const file=path.join(process.env.CODEX_HOME,'sessions',thread+'.jsonl'), id=crypto.randomUUID();
 const rows=[{type:'event_msg',payload:{type:'task_started',turn_id:id}},
 {type:'turn_context',payload:{turn_id:id,model:selection.model,effort:selection.reasoning}},
 {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:prompt}]}},
 {type:'response_item',payload:{type:'message',role:'assistant',phase:'final',content:[{type:'output_text',text:'hola'}]}},
 {type:'event_msg',payload:{type:'task_complete',turn_id:id}}];
 fs.appendFileSync(file,rows.map(x=>JSON.stringify(x)).join('\\n')+'\\n'); return id;
}`);
  const dataDir = path.join(dir,"data");
  const queue = createPromptQueue({dataDir,readHost:id=>readHostTurnState(id,codex),
    startSupervisor:state=>launchSupervisor(dataDir,state,{sourceDir:source})});
  const result = await queue.start({threadId:thread,projectPath:dir,objective:"isolated process test",
    initialSelection:{model:"gpt-6-luna",reasoning:"medium"},allowPlannedIncreases:true,
    steps:["medium","low","medium"].map(reasoning=>({prompt:"Only hola",expectedResponse:"hola",selection:{model:"gpt-6-luna",reasoning}}))});
  pid=result.supervisor.ownerPid;
  assert.equal(result.status,"pending"); assert.ok(isAlive(pid));
  assert.equal(result.supervisor.launchMode,"prestarted");
  assert.equal(result.supervisor.lastStopTurnId,null);
  fs.rmSync(source,{recursive:true,force:true});
  await wait(1400);
  assert.equal(queue.getStatus(result.id).dispatch,null,"no send during active source");
  fs.appendFileSync(rollout,JSON.stringify({type:"event_msg",payload:{type:"task_complete",turn_id:turn}})+"\n");
  await until(()=>queue.getStatus(result.id).status === "completed");
  assert.deepEqual(queue.getStatus(result.id).completedSteps.map(s=>s.observed.reasoning),["medium","low","medium"]);
  await until(()=>!isAlive(pid));
});

test("immutable snapshots reject modified contents instead of overwriting them", t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"tfo-snapshot-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const first=snapshotSupervisor(dir);
  assert.equal(snapshotSupervisor(dir).root,first.root);
  fs.appendFileSync(path.join(first.root,"queue-supervisor.mjs"),"\n// changed");
  assert.throws(()=>snapshotSupervisor(dir),/integrity/);
});

test("all atomic snapshot publishers retry transient Windows locks before publishing complete contents", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-snapshot-retry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const originalRename = fs.renameSync;
  for (const snapshot of [snapshotSupervisor, snapshotProjectSupervisor, snapshotNativeCoordinator]) {
    let calls = 0, staging;
    fs.renameSync = (source, destination) => {
      staging = source; calls++;
      assert.equal(fs.existsSync(destination), false, "nothing is published before the atomic rename");
      if (calls <= 2) { const error = new Error("Injected transient Windows snapshot lock"); error.code = calls === 1 ? "EPERM" : "EBUSY"; throw error; }
      return originalRename(source, destination);
    };
    let result;
    try { result = snapshot(dir); } finally { fs.renameSync = originalRename; }
    const published = typeof result === "string" ? result : result.root;
    assert.equal(calls, 3); assert.equal(fs.existsSync(staging), false);
    assert.ok(fs.existsSync(path.join(published, "snapshot-publish.mjs")));
    const repeated = snapshot(dir);
    assert.equal(typeof repeated === "string" ? repeated : repeated.root, published);
  }
});

test("permanent snapshot publication errors keep their original error and stop after bounded retries", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-snapshot-permanent-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const originalRename = fs.renameSync;
  for (const code of ["EPERM", "EACCES", "EIO"]) {
    const data = path.join(dir, code), injected = Object.assign(new Error(`Permanent ${code} snapshot failure`), { code });
    let calls = 0, staging, target;
    fs.renameSync = (source, destination) => { calls++; staging = source; target = destination; throw injected; };
    try { assert.throws(() => snapshotSupervisor(data), error => error === injected); }
    finally { fs.renameSync = originalRename; }
    assert.equal(calls, code === "EIO" ? 1 : 6); assert.equal(fs.existsSync(target), false);
    assert.ok(fs.readFileSync(path.join(staging, "queue-supervisor.mjs")).equals(fs.readFileSync(path.join("runtime", "queue-supervisor.mjs"))));
  }
});

test("a destination which appears during snapshot retry is verified without any overwrite", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-snapshot-race-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const originalRename = fs.renameSync; let calls = 0, target;
  fs.renameSync = (_source, destination) => {
    calls++; target = destination; fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, "queue-supervisor.mjs"), "Existing damaged snapshot");
    throw Object.assign(new Error("Another publisher created the destination"), { code: "EBUSY" });
  };
  try { assert.throws(() => snapshotSupervisor(dir), /integrity/); }
  finally { fs.renameSync = originalRename; }
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(path.join(target, "queue-supervisor.mjs"), "utf8"), "Existing damaged snapshot");
});
