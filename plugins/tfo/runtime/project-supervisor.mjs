import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createProjectFlow } from "./project-flow.mjs";
import { nativeProjectHost } from "./project-host.mjs";

const dependencies = ["project-supervisor.mjs", "project-flow.mjs", "project-host.mjs", "project-workspace.mjs",
  "project-reservations.mjs", "prompt-queue.mjs", "host-selection.mjs", "model-policy.mjs",
  "selected-join-adapter.mjs", "queue-transport.mjs", "ui-send-guard.mjs", "ui-bridge.ps1"];
export function snapshotProjectSupervisor(dataDir) {
  const source = path.dirname(fileURLToPath(import.meta.url));
  const contents = dependencies.map(file => [file, fs.readFileSync(path.join(source, file))]);
  const digest = crypto.createHash("sha256");
  for (const [file, bytes] of contents) digest.update(file).update("\0").update(bytes);
  const runtime = path.join(dataDir, "project-runtimes", digest.digest("hex"));
  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  if (!fs.existsSync(runtime)) {
    const staging = fs.mkdtempSync(path.join(path.dirname(runtime), "staging-"));
    for (const [file, bytes] of contents) fs.writeFileSync(path.join(staging, file), bytes, { flag: "wx" });
    try { fs.renameSync(staging, runtime); } catch (error) { if (!fs.existsSync(runtime)) throw error; }
  }
  for (const [file, bytes] of contents) if (!fs.readFileSync(path.join(runtime, file)).equals(bytes)) throw new Error("Project supervisor snapshot integrity failed");
  return runtime;
}
export async function launchProjectSupervisor(dataDir, runId) {
  if (!/^flow_[a-z0-9_]+$/.test(runId)) throw new Error("Invalid project flow ID");
  const runtime = snapshotProjectSupervisor(dataDir);
  const log = fs.openSync(path.join(dataDir, "parallel", runId, "supervisor.log"), "a");
  let child;
  try {
    child = spawn(process.execPath, [path.join(runtime, "project-supervisor.mjs"), "--watch", runId], {
      detached: true, windowsHide: true, cwd: runtime, stdio: ["ignore", "ignore", log, "ipc"],
      env: { ...process.env, TFO_DATA_DIR: dataDir },
    });
  } finally { fs.closeSync(log); }
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); }
      else { child.disconnect(); child.unref(); resolve(); }
    };
    const timer = setTimeout(() => finish(new Error("Project supervisor did not acknowledge startup")), 8000);
    child.once("error", finish);
    child.once("exit", code => finish(new Error(`Project supervisor exited before acknowledgement (${code})`)));
    child.on("message", message => {
      if (message.runId !== runId || message.pid !== child.pid) return;
      if (message.type === "ready") child.send({ type: "activate", runId }, error => { if (error) finish(error); });
      if (message.type === "watching") finish();
      if (message.type === "failed") finish(new Error(message.error));
    });
  });
}

async function watch(runId) {
  const flow = createProjectFlow({ dataDir: process.env.TFO_DATA_DIR, host: nativeProjectHost });
  try {
    flow.claim(runId);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Project startup was not activated")), 8000);
      process.on("message", message => { if (message.type === "activate" && message.runId === runId) { clearTimeout(timer); resolve(); } });
      process.send({ type: "ready", runId, pid: process.pid });
    });
    process.send({ type: "watching", runId, pid: process.pid });
    while (true) {
      const state = await flow.tick(runId);
      if (!["running", "paused", "cancelling"].includes(state.status)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    flow.review(runId, error.message);
    if (process.connected) process.send({ type: "failed", runId, pid: process.pid, error: error.message });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--watch") await watch(process.argv[3]);
