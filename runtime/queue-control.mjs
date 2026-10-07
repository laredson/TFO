// Fresh-process entry for the SAME conventional queue, not another model/writer.
// JSON arrives on stdin. Preparing is always paused; resume is a separate action
// after the user confirms the desktop is available.
import os from "node:os";
import path from "node:path";
import { createPromptQueue } from "./prompt-queue.mjs";
import { launchSupervisor } from "./supervisor-launch.mjs";
import { readHostTurnState, readHostTurnReceipt, findHostTurnsForPrompt, verifyInitialSelection } from "./host-selection.mjs";
import { dispatchPrompt } from "./queue-transport.mjs";
import { prepareWorkEntry } from "./work-entry.mjs";

async function main() {
  const action = process.argv[2];
  if (!["prepare", "resume", "status", "cancel"].includes(action)) throw new Error("Usage: node queue-control.mjs prepare|resume|status|cancel < request.json");
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1_000_000) throw new Error("Queue request is too large");
  }
  const args = JSON.parse(input.replace(/^\uFEFF/, ""));
  const dataDir = path.resolve(process.env.TFO_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), "TFO", "data"));
  const queue = createPromptQueue({ dataDir, readHost: readHostTurnState, readReceipt: readHostTurnReceipt,
    findPromptTurns: findHostTurnsForPrompt, verifyInitial: verifyInitialSelection, dispatch: dispatchPrompt,
    startSupervisor: state => launchSupervisor(dataDir, state) });
  const entry = action === "prepare" ? await prepareWorkEntry(dataDir, args) : null;
  if (entry?.pending) { process.stdout.write(JSON.stringify(entry.pending) + "\n"); return; }
  const state = action === "prepare" ? await queue.start({ ...entry.args, startPaused: true })
    : action === "resume" ? await queue.resume(args.runId)
    : action === "cancel" ? queue.cancel(args.runId) : queue.getStatus(args.runId);
  // Prompts remain in local state; compact output is enough to verify startup.
  process.stdout.write(JSON.stringify({ id: state.id, status: state.status, currentIndex: state.currentIndex,
    totalSteps: state.steps.length, completedSteps: state.completedSteps.length,
    hostObservationVersion: state.hostObservationVersion, pendingSourceUserMessageCount: state.pendingSourceUserMessageCount,
    pendingSourceTurnId: state.pendingSourceTurnId, dispatch: state.dispatch, error: state.error, supervisor: state.supervisor }) + "\n");
  if (state.status === "needs_review") process.exitCode = 1;
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
