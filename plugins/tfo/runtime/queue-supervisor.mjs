// Started and acknowledged while the source turn is active; waits for actual completion.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPromptQueue, activeQueueStates } from "./prompt-queue.mjs";
import { readHostTurnState, readHostTurnReceipt, findHostTurnsForPrompt, verifyInitialSelection, HOST_OBSERVATION_VERSION } from "./host-selection.mjs";
import { dispatchPrompt } from "./queue-transport.mjs";

const [runId, stopTurnId, mode] = process.argv.slice(2);
if (!/^queue_[a-z0-9_]+$/.test(runId || "") || !/^[0-9a-f-]{36}$/i.test(stopTurnId || "")) process.exit(2);
const dataDir = path.resolve(process.env.TFO_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), "TFO", "data"));
const queue = createPromptQueue({ dataDir, readHost: readHostTurnState, readReceipt: readHostTurnReceipt,
  findPromptTurns: findHostTurnsForPrompt, dispatch: dispatchPrompt, verifyInitial: verifyInitialSelection });
let ownsQueue = false;
try {
  const attached = queue.attachSupervisor(runId, stopTurnId, {launchMode:mode === "--prestarted" ? "prestarted" : "stop",
    runtimeRoot:path.dirname(fileURLToPath(import.meta.url))});
  if (!attached.attached) throw new Error("Supervisor ownership was not granted");
  ownsQueue = true;
  if (attached.state.hostObservationVersion !== HOST_OBSERVATION_VERSION) {
    throw new Error("Host observer revision differs from the queue preparer. Reload the queue control before starting a new queue");
  }
  if (mode === "--prestarted") {
    // No polling or dispatch until the launcher confirms the durable ownership receipt.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Launcher did not activate the supervisor")), 8000);
      process.once("disconnect", () => { clearTimeout(timer); reject(new Error("Launcher disconnected before activation")); });
      process.on("message", message => {
        if (message?.type !== "activate" || message.runId !== runId) return;
        clearTimeout(timer);
        process.send({type:"watching",runId,pid:process.pid}, error => error ? reject(error) : resolve());
      });
      if (!process.send) { clearTimeout(timer); return reject(new Error("Missing startup channel")); }
      process.send({type:"ready",runId,pid:process.pid});
    });
  }
  while (activeQueueStates.includes(queue.getStatus(runId).status)) {
    const state = await queue.tick(runId);
    if (!activeQueueStates.includes(state.status)) break;
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
} catch (error) {
  if (process.connected) process.send({type:"failed",error:String(error.message || error)});
  if (ownsQueue) queue.fail(runId, `Supervisor stopped: ${String(error.message || error)}`);
  process.exitCode = 1;
} finally { if (ownsQueue) queue.releaseSupervisor(runId); }
