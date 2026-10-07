import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyHookReceipt } from "../hook-readiness.mjs";

test("hook readiness rejects absent, removed or changed runtime and accepts matching receipt", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-receipt-"));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  assert.throws(() => verifyHookReceipt(dir,id), /No real Stop/);
  fs.mkdirSync(path.join(dir,"hook-signals"));
  const runtimeRoot = path.join(dir,"runtime");
  fs.writeFileSync(path.join(dir,"hook-signals",`${id}.json`),JSON.stringify({threadId:id,stopHookActive:false,runtimeRoot}));
  assert.throws(() => verifyHookReceipt(dir,id), /removed installation/);
  fs.mkdirSync(runtimeRoot);
  for (const name of ["stop-hook.mjs","queue-supervisor.mjs","prompt-queue.mjs","queue-transport.mjs","ui-bridge.ps1","atomic-file.mjs"]) fs.copyFileSync(path.join("runtime",name),path.join(runtimeRoot,name));
  assert.equal(verifyHookReceipt(dir,id).runtimeRoot,runtimeRoot);
  fs.appendFileSync(path.join(runtimeRoot,"stop-hook.mjs"),"\n// changed");
  assert.throws(() => verifyHookReceipt(dir,id), /different runtime/);
});
