// Host-native chat creation is performed once by the planning AI using the
// Codex app tools. This conventional adapter observes and queues existing chats.
// It never starts/resumes a thread with a second App Server writer.
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readHostThreadObservation, readHostTurnReceipt, findHostTurnsForPrompt, readHostBootstrapReceipt } from "./host-selection.mjs";
import { canonicalPath } from "./project-workspace.mjs";
import { createSelectedJoinAdapter } from "./selected-join-adapter.mjs";

const execute = promisify(execFile);
export const isHostCapacityRejection = error => error?.code === "HOST_CAPACITY" && error.deliveryAttempted === false;

// A trusted read-only host probe may reject before the queue process is started.
// Command errors and free-form stdout never establish that delivery did not occur.
export function createProjectQueueSender({ executeQueue = execute, preflightCapacity } = {}) {
  return async (threadId, prompt) => {
    if (preflightCapacity) {
      const capacity = await preflightCapacity({ threadId });
      if (capacity?.available === false) {
        const error = new Error("Host capacity is unavailable; no queue process was started");
        Object.assign(error, { code: "HOST_CAPACITY", deliveryAttempted: false,
          retryAfterMs: Number.isInteger(capacity.retryAfterMs) && capacity.retryAfterMs >= 0 ? Math.min(capacity.retryAfterMs, 60000) : 2000,
          capacityProof: { source: "host_preflight", threadId, available: false } });
        throw error;
      }
    }
    const command = process.env.TFO_QUEUE_COMMAND || process.env.TFO_CODEX_COMMAND || "codex";
    let stdout;
    try {
      ({ stdout } = await executeQueue(command, ["queue", "--thread", threadId, "--message", prompt],
        { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
          env: { ...process.env, CODEX_HOME: process.env.CODEX_HOME || path.join(os.homedir(), ".codex") } }));
    } catch (error) {
      // Starting the queue command crossed the delivery boundary, even if it
      // claims capacity trouble. The caller must reconcile actual receipts.
      error.deliveryAttempted = true;
      throw error;
    }
    const match = stdout.match(/Queued message ([0-9a-f-]{36}) for thread ([0-9a-f-]{36})/i);
    if (!match || match[2].toLowerCase() !== threadId.toLowerCase()) {
      const error = new Error("Native queue did not confirm the target chat; inspect history before any retry");
      error.deliveryAttempted = true; throw error;
    }
    return { queueMessageId: match[1] };
  };
}
export async function readProjectThread(threadId, codexDir) {
  const { state, metadata } = await readHostThreadObservation(threadId, codexDir);
  return { ...state, threadId, workspace: canonicalPath(metadata.cwd) };
}

export async function preflightNativeRecoveryAccess(check) {
  try {
    // Reuse the supported queue's existing permission check. It sends no
    // message and opens no second App Server writer or SQLite connection.
    const inspect = check || (await import("./native-join-supervisor.mjs")).checkNativeQueueAccess;
    const evidence = await inspect();
    if (evidence?.queueInterface !== true || evidence.stateAccess !== true || evidence.messageSent !== false) throw new Error("Native queue access check did not prove readiness without sending");
    return { ...evidence, available: true };
  } catch (error) {
    return { available: false, reason: String(error.message), messageSent: false };
  }
}

export const nativeProjectHost = {
  read: readProjectThread,
  find: findHostTurnsForPrompt,
  receipt: readHostTurnReceipt,
  bootstrap: readHostBootstrapReceipt,
  send: createProjectQueueSender(),
  preflightRecovery: preflightNativeRecoveryAccess,
};
nativeProjectHost.selectedJoin = createSelectedJoinAdapter({ readThread: readProjectThread });
