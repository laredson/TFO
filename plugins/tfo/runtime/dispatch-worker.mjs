// Runs outside the model turn and only after Codex reports the source turn complete.
import os from "node:os";
import path from "node:path";
import { createChatRouter } from "./chat-route.mjs";
import { dispatchPrompt } from "./queue-transport.mjs";
import { readHostSelection, readHostTurnState, verifyInitialSelection } from "./host-selection.mjs";

const [runId, sourceTurnId] = process.argv.slice(2);
const dataDir = path.resolve(process.env.TFO_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), "TFO", "data"));
const router = createChatRouter({ dataDir, dispatch: dispatchPrompt, verifyInitial: verifyInitialSelection,
  readObserved: readHostSelection, readMetrics: readHostTurnState, deferDispatch: true });
if (!/^chat_[a-z0-9_]+$/.test(runId || "") || !/^[0-9a-f-]{36}$/i.test(sourceTurnId || "")) process.exit(2);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const route = router.getStatus(runId);
  if (route.status !== "pending" || route.pendingSourceTurnId !== sourceTurnId) process.exit(0);
  let confirmed = false;
  for (let i = 0; i < 100; i++) {
    const state = await readHostTurnState(route.threadId);
    if (state.completedTurnId === sourceTurnId && !state.active && state.lastTurnId === sourceTurnId) {
      await delay(300);
      const again = await readHostTurnState(route.threadId);
      if (again.completedTurnId === sourceTurnId && !again.active && again.lastTurnId === sourceTurnId) { confirmed = true; break; }
    }
    await delay(300);
  }
  if (!confirmed) {
    router.failPending(runId, sourceTurnId, "The source turn did not become idle within 30 seconds; no prompt was sent.");
    process.exit(0);
  }
  await router.dispatchPending(runId, sourceTurnId);
} catch (error) {
  try { router.failPending(runId, sourceTurnId, `Dispatch worker failed: ${String(error?.message || error)}`); } catch { /* Preserve the original error in local diagnostics. */ }
  process.exitCode = 1;
}
