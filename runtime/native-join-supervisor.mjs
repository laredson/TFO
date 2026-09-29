// Only the final main handoff uses this independent supervisor. Worker model
// changes still require the native host tools; this does not claim otherwise.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createNativeFlow } from "./native-flow.mjs";
import { nativeProjectHost } from "./project-host.mjs";

export function checkNativeQueueAccess() {
  const codexDir = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const command = process.env.TFO_QUEUE_COMMAND || process.env.TFO_CODEX_COMMAND || "codex";
  const help = execFileSync(command, ["queue", "--help"], { encoding: "utf8", windowsHide: true, timeout: 10000, stdio: "pipe" });
  if (!help.includes("--thread") || !help.includes("--message")) throw new Error("Native queue interface unavailable");
  // Verify access without changing the host database or submitting a message.
  const databases = fs.readdirSync(codexDir).filter(name => /^state_\d+\.sqlite(?:-wal|-shm)?$/.test(name));
  if (!databases.some(name => name.endsWith(".sqlite"))) throw new Error("No local host state database");
  for (const name of databases) { const fd = fs.openSync(path.join(codexDir, name), "r+"); fs.closeSync(fd); }
  const probe = path.join(codexDir, `.tfo-write-probe-${crypto.randomUUID()}`);
  fs.writeFileSync(probe, "TFO permission probe", { flag: "wx" }); fs.unlinkSync(probe);
  return { checkedAt: new Date().toISOString(), queueInterface: true, stateAccess: true, messageSent: false };
}

const files = ["native-join-supervisor.mjs", "native-flow.mjs", "project-host.mjs", "host-selection.mjs", "project-flow.mjs",
  "project-workspace.mjs", "project-reservations.mjs", "model-policy.mjs", "prompt-queue.mjs", "budget.mjs",
  "selected-join-adapter.mjs", "queue-transport.mjs", "ui-send-guard.mjs", "ui-bridge.ps1"];
export function snapshotNativeJoin(dataDir) {
  const source = path.dirname(fileURLToPath(import.meta.url));
  const contents = files.map(file => [file, fs.readFileSync(path.join(source, file))]);
  const hash = crypto.createHash("sha256");
  for (const [name, bytes] of contents) hash.update(name).update("\0").update(bytes);
  const runtime = path.join(dataDir, "native-join-runtimes", hash.digest("hex"));
  fs.mkdirSync(runtime, { recursive: true });
  for (const [name, bytes] of contents) {
    const target = path.join(runtime, name);
    if (fs.existsSync(target)) { if (!fs.readFileSync(target).equals(bytes)) throw new Error("Join snapshot integrity failure"); }
    else fs.writeFileSync(target, bytes, { flag: "wx" });
  }
  return runtime;
}
export async function launchNativeJoin(dataDir, runId) {
  if (!/^flow_[a-z0-9_]+$/.test(runId)) throw new Error("Invalid flow ID");
  const runtime = snapshotNativeJoin(dataDir);
  const log = fs.openSync(path.join(dataDir, "native-flows", `${runId}.join.log`), "a");
  let child;
  try {
    child = spawn(process.execPath, [path.join(runtime, "native-join-supervisor.mjs"), "--watch", runId], {
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
      else { child.disconnect(); child.unref(); resolve(info); }
    };
    const timer = setTimeout(() => finish(new Error("Join supervisor startup timed out")), 15000);
    child.once("error", finish);
    child.once("exit", code => finish(new Error(`Join supervisor exited before acknowledgement (${code})`)));
    child.on("message", message => {
      if (message.runId !== runId || message.pid !== child.pid) return;
      if (message.type === "watching") finish(null, message);
      if (message.type === "failed") finish(new Error(message.error));
    });
  });
}

async function watch(runId) {
  const flow = createNativeFlow({ dataDir: process.env.TFO_DATA_DIR, host: nativeProjectHost });
  try {
    const pending = flow.status(runId);
    const preflight = pending.deferredJoin?.transport === "selected_join"
      ? await nativeProjectHost.selectedJoin?.preflight?.({ threadId: pending.mainThreadId,
          sourceTurnId: pending.deferredJoin.sourceTurnId,
          sourceSelection: pending.deferredJoin.sourceSelection,
          requestedSelection: pending.deferredJoin.requestedSelection,
          marker: pending.deferredJoin.marker })
      : checkNativeQueueAccess();
    if (pending.deferredJoin?.transport === "selected_join" &&
        (preflight?.selectionSupported !== true || preflight?.guardedTarget !== true))
      throw new Error("Selected main join transport unavailable in supervisor; no prompt was sent");
    flow.claimJoin(runId);
    let state = await flow.tickJoin(runId);
    if (state.status !== "running") throw new Error(state.error || "Join is no longer running");
    process.send({ type: "watching", runId, pid: process.pid, preflight });
    while (state.status === "running") {
      await new Promise(resolve => setTimeout(resolve, 1000));
      state = await flow.tickJoin(runId);
    }
  } catch (error) {
    flow.fail(runId, error.message);
    if (process.connected) process.send({ type: "failed", runId, pid: process.pid, error: error.message });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--watch") await watch(process.argv[3]);
