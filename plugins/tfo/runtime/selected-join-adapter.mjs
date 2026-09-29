// The only model-changing transport for a deferred main join. It uses the
// guarded visible Codex composer; no App Server writer or native queue fallback.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { validateSelection } from "./model-policy.mjs";
import { readHostTurnState, readHostTurnReceipt, hostTurnContainsPrompt } from "./host-selection.mjs";
import { runUiBridge, waitForUiReady, selectorMatchesSelection } from "./queue-transport.mjs";

const execute = promisify(execFile);
const runtime = path.dirname(fileURLToPath(import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const same = (a, b) => a?.model === b?.model && a?.reasoning === b?.reasoning;
async function capability() {
  if (process.platform !== "win32") throw new Error("Selected joins require the visible Windows Codex Desktop composer");
  for (const file of ["ui-bridge.ps1", "ui-send-guard.mjs"]) fs.accessSync(path.join(runtime, file), fs.constants.R_OK);
  await execute(process.env.TFO_PWSH_COMMAND || "pwsh", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"],
    { windowsHide: true, timeout: 5000 });
  return { selectionSupported: true, guardedTarget: true, readinessChecked: false };
}

export function createSelectedJoinAdapter({ readThread, readTurn = readHostTurnState,
  readReceipt = readHostTurnReceipt, containsPrompt = hostTurnContainsPrompt,
  ui = runUiBridge, checkCapability = capability, guard = async (stateFile, runId, sourceTurnId, ownerPid) => {
    await execute(process.execPath, [path.join(runtime, "ui-send-guard.mjs"), stateFile, runId, sourceTurnId, String(ownerPid)],
      { windowsHide: true, timeout: 10000 });
  }, wait = delay, confirmationPollMs = 500, confirmationTimeoutMs = 120000 } = {}) {
  if (typeof readThread !== "function") throw new Error("Selected join adapter requires an exact native chat reader");
  return {
    async preflight({ threadId, sourceTurnId, sourceSelection, requestedSelection, marker }) {
      validateSelection(sourceSelection); validateSelection(requestedSelection);
      if (!/^[0-9a-f-]{36}$/i.test(threadId || "") || !sourceTurnId ||
          !marker?.startsWith("TFO_MAIN_JOIN flow_")) throw new Error("Selected join identity is incomplete");
      const access = await checkCapability();
      if (access?.selectionSupported !== true || access?.guardedTarget !== true) throw new Error("Guarded selector transport unavailable");
      return { ...access, sourceTurnMayStillBeActive: true };
    },
    async send({ threadId, prompt, sourceTurnId, sourceUserMessageCount, sourceSelection,
      requestedSelection, marker, ownerPid, runId, dataDir }) {
      const stateFile = path.join(dataDir, "native-flows", `${runId}.json`);
      const authorize = () => guard(stateFile, runId, sourceTurnId, ownerPid);
      await authorize();
      const source = await readThread(threadId);
      if (source.active || source.lastTurnId !== sourceTurnId || source.completedTurnId !== sourceTurnId ||
          source.userMessageCount !== sourceUserMessageCount || !same(source, sourceSelection))
        throw new Error("Main source turn changed before selected join; no prompt was sent");
      const sourceReceipt = await readReceipt(threadId, sourceTurnId, "");
      if (!sourceReceipt.completed || sourceReceipt.interrupted || !sourceReceipt.finalResponse?.includes(marker))
        throw new Error("The completed main source turn did not display its unique join marker; no prompt was sent");
      const probe = await waitForUiReady({ probe: () => ui("probe", { runId, threadId, marker }), guard: authorize, wait });
      if (probe.editorEmpty !== true) throw new Error("Main composer is not empty; no prompt was sent");
      await authorize();
      const result = await ui("send", { runId, threadId, marker, prompt,
        model: requestedSelection.model, reasoning: requestedSelection.reasoning,
        sourceTurnId, ownerPid, nodeCommand: process.execPath, stateFile });
      if (result?.status !== "attempted" || !selectorMatchesSelection(result.selector, requestedSelection)) {
        const error = new Error("Selected join send or picker confirmation is uncertain; inspect the chat without retrying");
        error.sendAttempted = true; throw error;
      }
      const visiblePrompt = prompt.replace(/[\r\n]+/g, "  ");
      for (let i = 0; i < Math.ceil(confirmationTimeoutMs / confirmationPollMs); i++) {
        const current = await readTurn(threadId);
        if (current.lastTurnId && current.lastTurnId !== sourceTurnId) {
          if (current.interruptedTurnId === current.lastTurnId) throw new Error("Selected join turn was interrupted");
          if (await containsPrompt(threadId, current.lastTurnId, visiblePrompt)) {
            if (current.selectionTurnId === current.lastTurnId && !same(current, requestedSelection))
              throw new Error("Selected join started with the wrong model/effort");
            return { sendAttempted: true, selectionConfirmed: true, turnId: current.lastTurnId,
              selector: result.selector, transport: "guarded_visible_composer" };
          }
          if (current.userMessageCount > sourceUserMessageCount) throw new Error("A different user prompt started after selected join send");
        }
        await wait(confirmationPollMs);
      }
      const error = new Error("Selected join prompt was not confirmed in host history; delivery is uncertain");
      error.sendAttempted = true; throw error;
    },
  };
}
