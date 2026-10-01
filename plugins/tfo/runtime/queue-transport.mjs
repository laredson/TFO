import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateSelection, assertNotHigher, assertQueueSelection } from "./model-policy.mjs";
import { readHostSelection, readHostTurnState, hostTurnContainsPrompt } from "./host-selection.mjs";
const execute = promisify(execFile);
const uiScript = fileURLToPath(new URL("./ui-bridge.ps1", import.meta.url));
export function uiBridgeFailure(stderr, code) {
  const clean = stderr.replace(/\u001b\[[0-9;]*m/g, "").trim();
  const line = clean.split(/\r?\n/).findLast(line => line.startsWith("TFO_UI_FAILURE:"));
  let report;
  try { if (line) report = JSON.parse(line.slice("TFO_UI_FAILURE:".length)); } catch {}
  const error = new Error(`Codex interface bridge failed: ${report?.error || clean.slice(-2000) || `exit ${code}`}`);
  if (typeof report?.sendAttempted === "boolean") {
    error.sendAttempted = report.sendAttempted;
    error.textEntryAttempted = report.textEntryAttempted === true;
    error.uiPhase = report.phase;
    if (!report.sendAttempted) error.deliveryStage = "before_send";
  }
  return error;
}
export function runUiBridge(mode, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.TFO_PWSH_COMMAND || "pwsh", ["-NoProfile", "-NonInteractive", "-File", uiScript, "-Mode", mode], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => child.kill(), mode === "send" ? 30000 : 5000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => {
      clearTimeout(timeout);
      if (code !== 0) return reject(uiBridgeFailure(stderr, code));
      try { resolve(JSON.parse(stdout.trim())); } catch { reject(new Error("Codex interface bridge returned an unknown result")); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
export function diagnoseDesktopAccess() { return runUiBridge("diagnose", {}); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function waitForUiReady({probe, guard, wait = delay, now = Date.now}) {
  const deadline = now() + 12000;
  let previous = null, last;
  for (let read = 0; read < 8 && now() <= deadline; read++) {
    await guard();
    last = await probe();
    if (last.status === "ready") {
      const layout = last.layout;
      if (!layout || !["window", "marker", "editor", "selector"].every(key =>
        Array.isArray(layout[key]) && layout[key].length === 4 && layout[key].every(Number.isFinite))) {
        throw new Error("The interface did not provide verifiable layout bounds");
      }
      const current = JSON.stringify([last.selector, layout.window, layout.marker, layout.editor, layout.selector]);
      if (current === previous) return last;
      previous = current;
    } else if (last.status === "awaiting_render") {
      previous = null;
    } else {
      throw new Error("The interface did not confirm readiness");
    }
    await wait(250);
  }
  const error = new Error(`The chat did not show a stable route marker and composer within the read-only wait (${last?.reason || "layout_unstable"})`);
  error.preflightObservation = {status:last?.status,reason:last?.reason || "layout_unstable",markerVisible:last?.markerVisible ?? null};
  throw error;
}
export function turnStartParams(threadId, prompt, selection, cwd) {
  const { model, reasoning } = validateSelection(selection);
  return { threadId, input: [{ type: "text", text: prompt }], model, effort: reasoning, cwd };
}
export function queueArguments(threadId, prompt) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) throw new Error("Invalid host thread ID");
  if (!String(prompt || "").trim()) throw new Error("Prompt is required");
  return ["queue", "--thread", threadId, "--message", prompt];
}
export function selectorMatchesSelection(label, selection) {
  const models = { "gpt-6-luna": "GPT-6 Luna", "gpt-6.1-sol": "GPT-6.1 Sol", "gpt-6-sol": "GPT-6 Sol", "gpt-6-astra": "GPT-6 Astra",
    "gpt-5.6-luna": "GPT-5.6 Luna", "gpt-5.6-terra": "GPT-5.6 Terra", "gpt-5.6-sol": "GPT-5.6 Sol", "gpt-5.5": "GPT-5.5" };
  const efforts = { low: ["Ligero", "Bajo", "Light", "Low"], medium: ["Medio", "Medium"], high: ["Alto", "High"],
    xhigh: ["Muy alto", "Very high", "Extra high"], max: ["Máximo", "Max"], ultra: ["Ultra"] };
  return (efforts[selection.reasoning] || []).some(effort =>
    String(label || "").trim().toLowerCase() === `${models[selection.model]} ${effort}`.toLowerCase());
}
export function createPromptDispatcher({ readTurn = readHostTurnState, readSelection = readHostSelection,
  containsPrompt = hostTurnContainsPrompt, ui = runUiBridge, wait = delay,
  confirmationTimeoutMs = 120000, confirmationPollMs = 500,
  nativeSend = async (threadId, prompt) => {
    const command = process.env.TFO_QUEUE_COMMAND || process.env.TFO_CODEX_COMMAND || "codex";
    const { stdout } = await execute(command, queueArguments(threadId, prompt), { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    const match = String(stdout).match(/Queued message ([0-9a-f-]{36}) for thread /i);
    if (!match) throw new Error(`Codex did not confirm prompt delivery: ${String(stdout).trim().slice(0, 300)}`);
    return match[1];
  },
  guard = async authorization => {
    await execute(process.execPath, [fileURLToPath(new URL("./ui-send-guard.mjs", import.meta.url)),
      path.join(authorization.dataDir, "runs", authorization.runId, "state.json"), authorization.runId, authorization.sourceTurnId],
    { windowsHide: true, timeout: 10000 });
  },
} = {}) {
return async function dispatchPrompt(threadId, prompt, selection, authorization = {}) {
  validateSelection(selection);
  if (authorization.sourceTurnId) {
    const turn = await readTurn(threadId);
    if (turn.active || turn.lastTurnId !== authorization.sourceTurnId || turn.completedTurnId !== authorization.sourceTurnId) {
      throw new Error("The source turn is no longer the latest completed turn; no prompt was sent.");
    }
  }
  const observed = await readSelection(threadId);
  if (authorization.ceiling) assertQueueSelection(selection, authorization.ceiling,
    authorization.allowUpgrades === true ? authorization.authorizedSelections || [] : []);
  if (authorization.allowUpgrades !== true) assertNotHigher(selection, observed);
  if (authorization.sourceTurnId) {
    let uiReady, probe;
    try {
      // The completion record can precede rendering. Wait only by observing; do not
      // focus, scroll or type to make a marker visible, and keep checking the host.
      probe = await waitForUiReady({probe:() => ui("probe", {runId:authorization.runId}),
        guard:() => guard(authorization), wait});
      uiReady = probe.status === "ready";
      if (!uiReady) throw new Error("The interface did not confirm readiness");
      if (selection.model === observed.model && selection.reasoning === observed.reasoning && !selectorMatchesSelection(probe.selector, selection)) {
        throw new Error("The visible composer selection differs from the requested native-queue selection");
      }
    } catch (cause) {
      const error = new Error(`Read-only preflight failed before selecting, typing or sending: ${cause.message}`);
      error.deliveryStage = "preflight";
      if (cause.preflightObservation) error.preflightObservation = cause.preflightObservation;
      throw error;
    }
    if (uiReady) {
      let selectionConfirmedBeforeSend = false;
      if (selection.model === observed.model && selection.reasoning === observed.reasoning && authorization.deliveryMode !== "ui") {
        // Restore the host-owned queue used in 0.5 without starting another writer.
        // Recheck the durable reservation and latest completed source turn before sending.
        await guard(authorization);
        await nativeSend(threadId, prompt);
        selectionConfirmedBeforeSend = true;
      } else {
        const result = await ui("send", { runId: authorization.runId, prompt, model: selection.model, reasoning: selection.reasoning,
          sourceTurnId: authorization.sourceTurnId, nodeCommand: process.execPath,
          stateFile: path.join(authorization.dataDir, "runs", authorization.runId, "state.json") });
        if (result.status !== "attempted") throw new Error("Codex interface delivery is uncertain; inspect the chat before any retry.");
        if (!selectorMatchesSelection(result.selector, selection)) {
          const error = new Error("Codex confirmed the send action, but its selector report did not match the requested model and effort; inspect the turn before any retry.");
          error.sendAttempted = true;
          throw error;
        }
        selectionConfirmedBeforeSend = true;
      }
      // The host can record task_started and the user prompt well before it writes
      // turn_context. Confirm the exact new prompt here; the completed-turn receipt
      // verifies the actual model/effort before a queue step is accepted.
      for (let i = 0; i < Math.ceil(confirmationTimeoutMs / confirmationPollMs); i++) {
        const turn = await readTurn(threadId);
        if (turn.lastTurnId !== authorization.sourceTurnId && turn.lastTurnId) {
          if (turn.interruptedTurnId === turn.lastTurnId) throw new Error("The dispatched turn was interrupted; inspect the chat before any retry.");
          const hasPrompt = await containsPrompt(threadId, turn.lastTurnId, prompt.replace(/[\r\n]+/g, "  "));
          if (hasPrompt) {
            if (turn.selectionTurnId === turn.lastTurnId &&
                (turn.model !== selection.model || turn.reasoning !== selection.reasoning)) {
              throw new Error(`The host started a turn with ${turn.model}/${turn.reasoning}, expected ${selection.model}/${selection.reasoning}; inspect the visible prompt.`);
            }
            // For UI sends the picker was verified immediately before input. The
            // later host receipt remains authoritative and can still stop the queue.
            if (selectionConfirmedBeforeSend || turn.selectionTurnId === turn.lastTurnId) return turn.lastTurnId;
          }
          if (turn.userMessageCount > 0 && !hasPrompt) throw new Error("A different prompt started after dispatch; stop and inspect the chat before any retry.");
        }
        await wait(confirmationPollMs);
      }
      const error = new Error(`Codex did not confirm the new prompt in the host history within ${Math.round(confirmationTimeoutMs / 1000)} seconds; delivery is uncertain.`);
      error.sendAttempted = true;
      throw error;
    }
    throw new Error("The Codex interface did not confirm an idle chat; no prompt was sent.");
  }
  if (selection.model !== observed.model || selection.reasoning !== observed.reasoning) {
    throw new Error("The Codex interface was unavailable and the native queue cannot select another model or effort; no prompt was sent.");
  }
  return nativeSend(threadId, prompt);
};
}
export const dispatchPrompt = createPromptDispatcher();
