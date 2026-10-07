// Durable observation and bounded recovery. Normal task decisions and worker
// dispatch remain with the active principal; this never opens another writer.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createNativeFlow } from "./native-flow.mjs";
import { nativeProjectHost } from "./project-host.mjs";
import { isAlive } from "./prompt-queue.mjs";
import { publishSnapshot } from "./snapshot-publish.mjs";

const source = path.dirname(fileURLToPath(import.meta.url));
const valid = id => /^flow_[a-z0-9_]+$/.test(id);
const observable = new Set(["running", "paused", "cancelling", "finishing"]);

export function snapshotNativeCoordinator(dataDir) {
  const files = fs.readdirSync(source).filter(name => name.endsWith(".mjs") || name === "ui-bridge.ps1").sort();
  const contents = files.map(name => [name, fs.readFileSync(path.join(source, name))]);
  const digest = crypto.createHash("sha256");
  for (const [name, bytes] of contents) digest.update(name).update("\0").update(bytes);
  const root = path.join(dataDir, "native-coordinator-runtimes");
  const runtime = path.join(root, digest.digest("hex"));
  fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(runtime)) {
    const staging = fs.mkdtempSync(path.join(root, "staging-"));
    for (const [name, bytes] of contents) fs.writeFileSync(path.join(staging, name), bytes, { flag: "wx" });
    publishSnapshot(staging, runtime);
  }
  for (const [name, bytes] of contents) if (!fs.readFileSync(path.join(runtime, name)).equals(bytes)) throw new Error("Coordinator snapshot integrity failure");
  return runtime;
}

export async function launchNativeCoordinator(dataDir, runId) {
  if (!valid(runId)) throw new Error("Invalid flow ID");
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, "native-flows", `${runId}.json`), "utf8"));
  if (state.coordinationMode !== "active_main" || !observable.has(state.status)) return { runId, launchMode: "not_required" };
  const ownerPid = state.coordinator?.observerPid;
  if (ownerPid && isAlive(ownerPid)) return { runId, pid: ownerPid, launchMode: "already_running" };
  const runtime = snapshotNativeCoordinator(dataDir);
  const log = fs.openSync(path.join(dataDir, "native-flows", `${runId}.coordinator.log`), "a");
  let child;
  try {
    child = spawn(process.execPath, [path.join(runtime, "native-coordinator-supervisor.mjs"), "--watch", runId], {
      detached: true, windowsHide: true, cwd: runtime, stdio: ["ignore", "ignore", log, "ipc"],
      env: { ...process.env, TFO_DATA_DIR: dataDir },
    });
  } finally { fs.closeSync(log); }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, info) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); }
      else { child.disconnect(); child.unref(); resolve({ ...info, launchMode: "prestarted" }); }
    };
    const timer = setTimeout(() => finish(new Error("Coordinator supervisor startup timed out")), 15000);
    child.once("error", finish);
    child.once("exit", code => finish(new Error(`Coordinator exited before acknowledgement (${code})`)));
    child.on("message", message => {
      if (message.runId !== runId || message.pid !== child.pid) return;
      if (message.type === "watching") finish(null, message);
      if (message.type === "failed") finish(new Error(message.error));
    });
  });
}

export async function restoreNativeCoordinators(dataDir, launch = launchNativeCoordinator) {
  const root = path.join(dataDir, "native-flows");
  if (!fs.existsSync(root)) return [];
  const restored = [];
  for (const name of fs.readdirSync(root).filter(name => /^flow_[a-z0-9_]+\.json$/.test(name))) {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
      if (state.coordinationMode === "active_main" && observable.has(state.status)) restored.push(await launch(dataDir, state.id));
    } catch (error) { process.stderr.write(`TFO coordinator restore: ${name}: ${error.message}\n`); }
  }
  return restored;
}

async function watch(runId) {
  const flow = createNativeFlow({ dataDir: process.env.TFO_DATA_DIR, host: nativeProjectHost });
  try {
    flow.claimCoordinator(runId);
    process.send?.({ type: "watching", runId, pid: process.pid });
    while (observable.has(flow.status(runId).status)) {
      try { await flow.tickCoordinator(runId); }
      catch (error) {
        // A missing Desktop/history is an observation outage, not permission
        // to send a recovery prompt or to discard saved worker receipts.
        process.stderr.write(`TFO observation unavailable: ${error.message}\n`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    if (process.connected) process.send({ type: "failed", runId, pid: process.pid, error: error.message });
    else process.stderr.write(`TFO coordinator stopped: ${error.message}\n`);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--watch") await watch(process.argv[3]);
