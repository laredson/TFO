import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("Stop hook ignores unrelated turns and emits valid non-blocking JSON", t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-stop-hook-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const runDir = path.join(dataDir, "runs", "chat_example_1234");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify({ threadId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    pendingSourceTurnId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", status: "pending" }));
  const result = spawnSync(process.execPath, [path.resolve("runtime/stop-hook.mjs")], {
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      turn_id: "dddddddd-dddd-dddd-dddd-dddddddddddd" }), encoding: "utf8", windowsHide: true,
    env: { ...process.env, TFO_DATA_DIR: dataDir },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8")).status, "pending");
  const signal = JSON.parse(fs.readFileSync(path.join(dataDir, "hook-signals", "cccccccc-cccc-cccc-cccc-cccccccccccc.json"), "utf8"));
  assert.equal(signal.turnId, "dddddddd-dddd-dddd-dddd-dddddddddddd");
  assert.equal(signal.stopHookActive, false);
  assert.equal(signal.last_assistant_message, undefined);
});

test("the packaged hook resolves PLUGIN_ROOT without relying on shell variable syntax", t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-hook-command-"));
  t.after(() => fs.rmSync(dataDir, {recursive:true, force:true}));
  const pluginRoot=path.resolve("plugins/tfo");
  const config=JSON.parse(fs.readFileSync(path.join(pluginRoot,"hooks/hooks.json"),"utf8"));
  const result=spawnSync(config.hooks.Stop[0].hooks[0].command,{
    shell:true, windowsHide:true, encoding:"utf8", input:JSON.stringify({hook_event_name:"Stop",session_id:"unrelated",turn_id:"unrelated"}),
    env:{...process.env,PLUGIN_ROOT:pluginRoot,TFO_DATA_DIR:dataDir},
  });
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{});
});
