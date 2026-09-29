// A Codex Stop hook only signals the local supervisor. It never sends a prompt.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const dataDir = path.resolve(process.env.TFO_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), "TFO", "data"));
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 65536) process.exit(1);
}
const event = JSON.parse(input || "{}");
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
if (event.hook_event_name === "Stop" && uuid.test(event.session_id || "") && uuid.test(event.turn_id || "")) {
  // Minimal evidence that the host actually invoked the installed hook. No transcript.
  const signals = path.join(dataDir, "hook-signals");
  fs.mkdirSync(signals, { recursive: true });
  const signalFile = path.join(signals, `${event.session_id}.json`);
  const temporary = `${signalFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ threadId: event.session_id, turnId: event.turn_id,
    receivedAt: new Date().toISOString(), stopHookActive: event.stop_hook_active === true,
    runtimeRoot: path.dirname(fileURLToPath(import.meta.url)) }));
  fs.renameSync(temporary, signalFile);
}
if (event.hook_event_name === "Stop" && !event.stop_hook_active && event.session_id && event.turn_id) {
  const runsDir = path.join(dataDir, "runs");
  for (const entry of fs.existsSync(runsDir) ? fs.readdirSync(runsDir, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || !/^(chat|queue)_[a-z0-9_]+$/.test(entry.name)) continue;
    let state;
    try { state = JSON.parse(fs.readFileSync(path.join(runsDir, entry.name, "state.json"), "utf8")); } catch { continue; }
    if (state.threadId !== event.session_id) continue;
    // New queues already acknowledged their observer before the tool returned.
    // Stop cannot restart a dead observer or become a second dispatcher.
    if (state.kind === "prompt_queue" && state.supervisor?.launchMode === "prestarted") continue;
    const pendingMatch = state.status === "pending" && state.pendingSourceTurnId === event.turn_id;
    const completedMatch = state.kind === "prompt_queue" && state.status === "queued" && state.dispatch?.messageId === event.turn_id;
    if (!pendingMatch && !completedMatch) continue;
    const worker = state.kind === "prompt_queue" ? "./queue-supervisor.mjs" : "./dispatch-worker.mjs";
    const child = spawn(process.execPath, [fileURLToPath(new URL(worker, import.meta.url)), entry.name, event.turn_id], {
      detached: true, windowsHide: true, stdio: "ignore", env: process.env,
    });
    child.once("error", () => { /* A pending route remains visible for review. */ });
    child.unref();
  }
}
process.stdout.write("{}\n");
