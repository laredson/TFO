// A queue owns an immutable copy of its executable dependencies, outside plugin cache.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { publishSnapshot } from "./snapshot-publish.mjs";

export const supervisorFiles = ["queue-supervisor.mjs", "prompt-queue.mjs", "model-policy.mjs", "host-selection.mjs", "smart-policy.mjs", "work-policy.mjs", "settings.mjs", "work-budget.mjs", "budget.mjs",
  "queue-transport.mjs", "ui-send-guard.mjs", "ui-bridge.ps1", "project-host.mjs",
  "project-workspace.mjs", "project-reservations.mjs", "selected-join-adapter.mjs", "snapshot-publish.mjs", "atomic-file.mjs"];
export function snapshotSupervisor(dataDir, sourceDir = path.dirname(fileURLToPath(import.meta.url))) {
  const contents = supervisorFiles.map(name => [name, fs.readFileSync(path.join(sourceDir, name))]);
  const digest = crypto.createHash("sha256");
  for (const [name, bytes] of contents) digest.update(name).update("\0").update(bytes);
  const hash = digest.digest("hex");
  const parent = path.join(dataDir, "supervisor-runtimes");
  const root = path.join(parent, hash);
  fs.mkdirSync(parent, {recursive:true});
  if (!fs.existsSync(root)) {
    const temp = fs.mkdtempSync(path.join(parent, "staging-"));
    for (const [name, bytes] of contents) fs.writeFileSync(path.join(temp, name), bytes, {flag:"wx"});
    publishSnapshot(temp, root);
  }
  for (const [name, bytes] of contents) {
    if (!fs.readFileSync(path.join(root, name)).equals(bytes)) throw new Error("Supervisor snapshot integrity check failed");
  }
  return {root, hash};
}

export async function launchSupervisor(dataDir, state, options = {}) {
  const {root, hash} = snapshotSupervisor(dataDir, options.sourceDir);
  const log = fs.openSync(path.join(dataDir, "runs", state.id, "supervisor.log"), "a");
  let child;
  try {
    child = spawn(process.execPath, [path.join(root, "queue-supervisor.mjs"), state.id, state.pendingSourceTurnId, "--prestarted"], {
      detached:true, windowsHide:true, cwd:root, stdio:["ignore", "ignore", log, "ipc"],
      env:{...process.env, TFO_DATA_DIR:dataDir},
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
    const timer = setTimeout(() => finish(new Error("Supervisor did not acknowledge startup")), 8000);
    child.once("error", finish);
    child.once("exit", code => finish(new Error(`Supervisor exited before acknowledgement (${code})`)));
    child.on("message", message => {
      try {
      if (message?.type === "ready" && message.runId === state.id && message.pid === child.pid) {
        const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "runs", state.id, "state.json"), "utf8"));
        if (saved.supervisor?.ownerPid !== child.pid || saved.status !== "pending") return finish(new Error("Queue changed during startup"));
        child.send({type:"activate", runId:state.id}, error => { if (error) finish(error); });
      } else if (message?.type === "watching" && message.runId === state.id) finish();
      else if (message?.type === "failed") finish(new Error(message.error));
      } catch (error) { finish(error); }
    });
  });
  return {pid:child.pid, runtimeRoot:root, runtimeHash:hash};
}
