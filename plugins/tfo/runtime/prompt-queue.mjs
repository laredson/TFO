// Conventional FIFO supervisor. A model never drives the wait/send/advance loop.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { validateSelection, assertNotHigher, assertQueueSelection } from "./model-policy.mjs";

const stamp = () => new Date().toISOString();
const QUEUE_ID = /^queue_[a-z0-9_]+$/;
const THREAD_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const activeQueueStates = ["pending", "dispatching", "queued"];
export const isAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};
export function lockedFile(lockPath, action) {
  let fd;
  try { fd = fs.openSync(lockPath, "wx"); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = Number(fs.readFileSync(lockPath, "utf8"));
    if (!owner || isAlive(owner)) throw new Error("Prompt queue is busy");
    fs.unlinkSync(lockPath); fd = fs.openSync(lockPath, "wx");
  }
  fs.writeFileSync(fd, String(process.pid));
  try { return action(); } finally { fs.closeSync(fd); fs.unlinkSync(lockPath); }
}
export function reserveChatSlot(runs, threadId, action, projectRunId = null) {
  if (!THREAD_ID.test(threadId || "")) throw new Error("Invalid host thread ID");
  return lockedFile(path.join(runs, `thread-${threadId}.lock`), () => {
    const ledgerFile = path.join(path.dirname(runs), "projects", "resource-reservations.json");
    if (fs.existsSync(ledgerFile)) {
      const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
      if (!Array.isArray(ledger.reservations)) throw new Error("Invalid project resource ledger");
      if (ledger.reservations.some(item => item.runId !== projectRunId && ["held", "needs_review"].includes(item.status) &&
        item.claims.some(claim => claim.kind === "chat" && claim.key === `chat:${threadId.toLowerCase()}`))) {
        throw new Error("This chat is reserved by a project route");
      }
    }
    for (const entry of fs.readdirSync(runs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let other;
      try { other = JSON.parse(fs.readFileSync(path.join(runs, entry.name, "state.json"), "utf8")); } catch { continue; }
      if (other.threadId === threadId && ["pending", "dispatching", "queued", "scheduled", "paused"].includes(other.status)) throw new Error("This chat already has a live or paused route; review it before preparing another queue");
    }
    return action();
  });
}

export function createPromptQueue({ dataDir, readHost, readReceipt, findPromptTurns = async () => [], dispatch, verifyInitial, verifyHook, startSupervisor }) {
  const runs = path.join(dataDir, "runs");
  fs.mkdirSync(runs, { recursive: true });
  const file = id => {
    if (!QUEUE_ID.test(id || "")) throw new Error("Invalid prompt queue ID");
    return path.join(runs, id, "state.json");
  };
  const read = id => JSON.parse(fs.readFileSync(file(id), "utf8"));
  const save = state => {
    const target = file(state.id);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
    state.updatedAt = stamp();
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(temp, target);
  };
  const change = (id, action) => lockedFile(path.join(path.dirname(file(id)), "mutation.lock"), () => {
    const state = read(id);
    action(state);
    save(state);
    return state;
  });
  const view = state => ({ ...state, totalSteps: state.steps.length, currentStep: state.steps[state.currentIndex] || null,
    pendingPrompt: state.status === "pending" ? state.steps[state.currentIndex]?.visiblePrompt || null : null });
  function receiptProblem(step, receipt) {
    if (!receipt?.completed || receipt.interrupted || !receipt.promptMatched || receipt.userMessageCount !== 1 || !receipt.finalResponse ||
        receipt.model !== step.selection.model || receipt.reasoning !== step.selection.reasoning) return "The completed turn, exact prompt, final response or actual selection could not be verified.";
    if (step.expectedResponse !== null && receipt.finalResponse.trim() !== step.expectedResponse) return "The final response differs from the expected response; remaining prompts were retained.";
    return null;
  }
  function recordReceipt(state, step, turnId, receipt) {
    state.completedSteps.push({ id: step.id, title: step.title, success: true, completedAt: stamp(), messageId: turnId,
      requested: step.selection, observed: { model: receipt.model, reasoning: receipt.reasoning },
      verification: step.expectedResponse === null ? "turn_completed" : "expected_response", summary: receipt.finalResponse.slice(0,8192),
      responseSha256: crypto.createHash("sha256").update(receipt.finalResponse).digest("hex") });
    state.currentIndex += 1; state.dispatch = null;
  }

  async function start(args) {
    if (args.surface && args.surface !== "codex") throw new Error("This queue requires a local Codex thread. Normal Chat/ChatGPT Work need their own adapter; use tfo_connection_check first. No queue was armed.");
    if (!THREAD_ID.test(args.threadId || "")) throw new Error("threadId must identify this Codex chat");
    if (!args.startPaused && !startSupervisor && verifyHook) await verifyHook(args.threadId);
    if (!String(args.objective || "").trim()) throw new Error("objective is required");
    if (!args.projectPath) throw new Error("projectPath is required");
    const projectPath = fs.realpathSync(path.resolve(args.projectPath));
    if (!fs.statSync(projectPath).isDirectory()) throw new Error("projectPath must be a directory");
    const initial = validateSelection(args.initialSelection);
    const deliveryMode = args.deliveryMode || "auto";
    if (!["auto", "ui"].includes(deliveryMode)) throw new Error("Unknown delivery mode");
    if (!Array.isArray(args.steps) || !args.steps.length || args.steps.length > 20) throw new Error("A prompt queue requires 1 to 20 steps");
    if (args.authorizedSelections != null && (!Array.isArray(args.authorizedSelections) || args.authorizedSelections.length > 20)) throw new Error("authorizedSelections must list at most 20 exact user-approved selections");
    const authorizedSelections = (args.authorizedSelections || []).map(validateSelection);
    if (authorizedSelections.length && args.allowPlannedIncreases !== true) throw new Error("Explicit selections require allowPlannedIncreases");
    for (const approved of authorizedSelections) {
      if (!args.steps.some(step => step.selection?.model === approved.model && step.selection?.reasoning === approved.reasoning)) throw new Error("Every authorized selection must belong to a stored step");
    }
    if (verifyInitial) await verifyInitial(args.threadId, initial);
    const host = await readHost(args.threadId);
    if (!host.lastTurnId || !host.active) throw new Error("Prepare the queue during the current turn; TFO will wait for it to finish");
    const id = `queue_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
    let previous = initial;
    const steps = args.steps.map((item, index) => {
      const prompt = String(item.prompt || "").trim();
      if (!prompt || prompt.length > 32000) throw new Error("Each prompt must contain 1 to 32000 characters");
      const selection = validateSelection(item.selection);
      assertQueueSelection(selection, initial, authorizedSelections);
      if (args.allowPlannedIncreases !== true) assertNotHigher(selection, previous);
      previous = selection;
      if (item.expectedResponse != null && (typeof item.expectedResponse !== "string" || !item.expectedResponse.trim())) throw new Error("expectedResponse must be non-empty text when supplied");
      return { id: `step-${index + 1}`, title: String(item.title || `Prompt ${index + 1}`), prompt, selection,
        expectedResponse: item.expectedResponse?.trim() ?? null,
        // The wire prompt is persisted before the model returns control. No self-continuation instructions.
        visiblePrompt: `[Enviado por TFO · cola ${id} · paso ${index + 1}/${args.steps.length}]  ${prompt.replace(/[\r\n]+/g, "  ")}` };
    });
    const maxTurnMinutes = args.maxTurnMinutes ?? 60;
    if (!Number.isInteger(maxTurnMinutes) || maxTurnMinutes < 1 || maxTurnMinutes > 1440) throw new Error("maxTurnMinutes must be between 1 and 1440");
    const state = { id, kind: "prompt_queue", surface: "codex", version: "1.0.0-rc.1", objective: args.objective, projectPath,
      threadId: args.threadId, steps, currentIndex: 0, status: args.startPaused === true ? "paused" : "pending",
      resumeStatus: args.startPaused === true ? "pending" : null, pendingSourceTurnId: host.lastTurnId,
      pendingSourceUserMessageCount: host.userMessageCount ?? null,
      hostObservationVersion: host.observationVersion ?? null,
      dispatch: null, completedSteps: [], error: "", startedAt: stamp(), updatedAt: stamp(), waitingSince: stamp(),
      authorization: { initialSelection: initial, authorizedSelections, allowPlannedIncreases: args.allowPlannedIncreases === true, deliveryMode },
      maxTurnMinutes, supervisor: { status: "awaiting_stop", ownerPid: null, lastStopTurnId: null } };
    // There may only be one live dispatcher for this chat, including compatible older routes.
    reserveChatSlot(runs, args.threadId, () => save(state));
    return activate(state);
  }

  async function activate(state) {
    if (state.status !== "pending" || !startSupervisor) return view(state);
    try { await startSupervisor(state); }
    catch (error) { return fail(state.id, `Supervisor startup failed: ${error.message}. No automatic retry.`); }
    return view(read(state.id));
  }

  function fail(id, reason) {
    return view(change(id, state => {
      if (["completed", "cancelled", "paused"].includes(state.status)) return;
      state.status = "needs_review"; state.error = reason;
    }));
  }
  function pause(id) {
    return view(change(id, state => {
      if (!activeQueueStates.includes(state.status)) throw new Error(`Cannot pause a ${state.status} queue`);
      state.resumeStatus = state.status; state.status = "paused";
    }));
  }
  function cancel(id) {
    return view(change(id, state => {
      if (state.status === "completed") throw new Error("Cannot cancel a completed queue");
      state.status = "cancelled";
    }));
  }
  async function resume(id) {
    const current = read(id);
    if (current.status !== "paused") throw new Error("Only paused queues can resume");
    if (isAlive(current.supervisor?.ownerPid)) throw new Error("The paused supervisor is still stopping; resume after it exits");
    if (!startSupervisor && verifyHook) await verifyHook(current.threadId);
    if (current.dispatch?.sending || current.resumeStatus === "dispatching") throw new Error("Delivery was in progress; inspect it before preparing a new queue");
    const host = await readHost(current.threadId);
    // A user-triggered resume is bound to this new turn and cannot send until it finishes.
    if (!host.active || !host.lastTurnId) throw new Error("Resume during a user turn so TFO can wait for its completion");
    let receipt = null;
    if (current.resumeStatus === "queued") {
      receipt = await readReceipt(current.threadId, current.dispatch.messageId, current.steps[current.currentIndex].visiblePrompt);
      const problem = receiptProblem(current.steps[current.currentIndex], receipt);
      if (problem) throw new Error(`The sent prompt is awaiting review: ${problem}`);
    }
    const resumed = change(id, state => {
      if (state.status !== "paused" || state.currentIndex !== current.currentIndex) throw new Error("Queue changed while resuming");
      if (receipt) recordReceipt(state, state.steps[state.currentIndex], state.dispatch.messageId, receipt);
      state.status = state.currentIndex === state.steps.length ? "completed" : "pending";
      state.pendingSourceTurnId = host.lastTurnId; state.waitingSince = stamp();
      state.pendingSourceUserMessageCount = host.userMessageCount ?? null;
      state.hostObservationVersion = host.observationVersion ?? null;
      state.error = ""; state.supervisor = { status: "awaiting_stop", ownerPid: null, lastStopTurnId: null };
    });
    return activate(resumed);
  }
  function recover(id) {
    return view(change(id, state => {
      if (!activeQueueStates.includes(state.status)) return;
      const owner = state.supervisor?.ownerPid;
      if (owner && !isAlive(owner)) {
        state.resumeStatus = state.status;
        state.status = state.dispatch?.sending ? "needs_review" : "paused";
        state.error = "Supervisor stopped. Saved prompts and receipts were preserved; no prompt was resent.";
        state.supervisor.status = "stopped";
      }
    }));
  }
  function attachSupervisor(id, turnId, metadata = {}) {
    let attached = false;
    const state = change(id, state => {
      if (!activeQueueStates.includes(state.status)) return;
      const expected = state.status === "pending" ? state.pendingSourceTurnId : state.dispatch?.messageId;
      if (expected !== turnId) return;
      if (isAlive(state.supervisor?.ownerPid)) return;
      if (state.supervisor?.ownerPid) { // A restart always requires review, even after a valid Stop signal.
        state.resumeStatus = state.status; state.status = state.dispatch?.sending ? "needs_review" : "paused";
        state.error = "Supervisor restarted; saved queue needs review before continuing.";
        return;
      }
      state.supervisor = { status: "watching", ownerPid: process.pid,
        lastStopTurnId: metadata.launchMode === "prestarted" ? null : turnId, sourceTurnId:turnId,
        launchMode:metadata.launchMode || "stop", runtimeRoot:metadata.runtimeRoot || null, startedAt: stamp() };
      attached = true;
    });
    return { attached, state: view(state) };
  }
  function releaseSupervisor(id) {
    return view(change(id, state => {
      if (state.supervisor.ownerPid !== process.pid) return;
      // Keep dead ownership on an unexpected exit so a restart pauses instead of resending.
      state.supervisor.status = "stopped";
      if (!activeQueueStates.includes(state.status)) state.supervisor.ownerPid = null;
    }));
  }

  async function reconcile(id) {
    const state = read(id);
    const step = state.steps[state.currentIndex];
    if (state.status !== "needs_review" || !step || !state.dispatch || state.dispatch.stepId !== step.id ||
        state.dispatch.prompt !== step.visiblePrompt) throw new Error("This queue has no uncertain current send to reconcile");
    if (state.supervisor?.ownerPid && isAlive(state.supervisor.ownerPid)) throw new Error("The queue supervisor is still active; review only after it stops");
    if (state.dispatch.sending !== true && state.dispatch.sendAttempted !== true &&
        !["confirmation_uncertain", "outcome_unknown"].includes(state.dispatch.deliveryStage)) {
      throw new Error("This queue was not stopped after an uncertain send");
    }
    if (!readReceipt || !findPromptTurns) throw new Error("Host receipt inspection is unavailable");
    const matches = await findPromptTurns(state.threadId, step.visiblePrompt);
    if (!Array.isArray(matches) || matches.length !== 1 || !THREAD_ID.test(matches[0]?.turnId || "")) throw new Error("The exact prompt must appear in exactly one host turn before reconciliation");
    const startedAt = Date.parse(matches[0].startedAt || "");
    const attemptedAt = Date.parse(state.dispatch.attemptedAt || "");
    if (!Number.isFinite(startedAt) || !Number.isFinite(attemptedAt) || startedAt < attemptedAt) throw new Error("The matching host turn cannot be tied safely to this send attempt");
    const receipt = await readReceipt(state.threadId, matches[0].turnId, step.visiblePrompt);
    const problem = receiptProblem(step, receipt);
    if (problem) throw new Error(`Host receipt did not pass reconciliation: ${problem}`);
    return view(change(id, latest => {
      if (latest.status !== "needs_review" || latest.dispatch?.attemptId !== state.dispatch.attemptId ||
          latest.steps[latest.currentIndex]?.id !== step.id) throw new Error("The queue changed while its host receipt was being checked");
      recordReceipt(latest, step, matches[0].turnId, receipt);
      latest.lastReconciliation = { attemptId: state.dispatch.attemptId, turnId: matches[0].turnId, reconciledAt: stamp(), source: "verified_host_receipt" };
      latest.pendingSourceTurnId = matches[0].turnId;
      latest.pendingSourceUserMessageCount = receipt.userMessageCount;
      latest.status = latest.currentIndex === latest.steps.length ? "completed" : "paused";
      latest.resumeStatus = null;
      latest.waitingSince = stamp();
      latest.error = "";
      latest.supervisor = { ...latest.supervisor, status: "stopped", ownerPid: null };
    }));
  }

  async function tick(id) {
    let state = read(id);
    if (state.supervisor?.launchMode === "prestarted" && state.supervisor.ownerPid !== process.pid) return view(state);
    if (!["pending", "queued"].includes(state.status)) return view(state);
    const expected = state.status === "pending" ? state.pendingSourceTurnId : state.dispatch.messageId;
    const host = await readHost(state.threadId);
    if ((state.hostObservationVersion ?? null) !== (host.observationVersion ?? null)) return fail(id, "Host observer revision differs from the queue preparer. Reload the queue control; no next prompt was sent.");
    if (host.lastTurnId !== expected) return fail(id, "Another turn intervened. TFO stopped before sending another prompt.");
    if (state.status === "pending" && state.pendingSourceUserMessageCount !== null && host.userMessageCount !== state.pendingSourceUserMessageCount) return fail(id, "New user input arrived after the queue was prepared; no next prompt was sent.");
    if (host.interruptedTurnId === expected) return fail(id, "The expected turn was interrupted; no next prompt was sent.");
    if (host.active || host.completedTurnId !== expected) {
      if (Date.now() - Date.parse(state.waitingSince) > state.maxTurnMinutes * 60000) return fail(id, "The turn did not finish within the queue's wait limit.");
      return view(state);
    }
    if (state.status === "queued") {
      const step = state.steps[state.currentIndex];
      const receipt = await readReceipt(state.threadId, expected, step.visiblePrompt);
      const problem = receiptProblem(step, receipt);
      if (problem) return fail(id, problem);
      state = change(id, latest => {
        if (latest.status !== "queued" || latest.dispatch.messageId !== expected) return;
        recordReceipt(latest, step, expected, receipt);
        latest.pendingSourceTurnId = expected;
        latest.pendingSourceUserMessageCount = receipt.userMessageCount;
        latest.status = latest.currentIndex === latest.steps.length ? "completed" : "pending";
        latest.waitingSince = stamp();
      });
    }
    if (state.status !== "pending") return view(state);
    // Reserve one durable attempt before the external side effect. Duplicate ticks cannot reserve it.
    let reserved = false;
    state = change(id, latest => {
      if (latest.status !== "pending" || latest.pendingSourceTurnId !== expected) return;
      const step = latest.steps[latest.currentIndex];
      latest.dispatch = { stepId: step.id, prompt: step.visiblePrompt, requested: step.selection, sourceTurnId: expected,
        attemptId: crypto.randomUUID(), ownerPid: process.pid, sending: true, attemptedAt: stamp() };
      latest.status = "dispatching"; reserved = true;
    });
    if (!reserved) return view(state);
    const attemptId = state.dispatch.attemptId;
    try {
      const latestHost = await readHost(state.threadId);
      if (latestHost.active || latestHost.lastTurnId !== expected || latestHost.completedTurnId !== expected) {
        const error = new Error("Chat became busy before delivery"); error.deliveryStage = "before_send"; error.sendAttempted = false; throw error;
      }
      const current = read(id);
      if (current.status !== "dispatching" || current.dispatch.attemptId !== attemptId) return view(current);
      const messageId = await dispatch(state.threadId, state.dispatch.prompt, state.dispatch.requested, {
        sourceTurnId: expected, runId: id, dataDir, projectPath: state.projectPath,
        ceiling: state.authorization.initialSelection, allowUpgrades: state.authorization.allowPlannedIncreases,
        authorizedSelections: state.authorization.authorizedSelections || [],
        deliveryMode:state.authorization.deliveryMode || "auto",
      });
      if (!THREAD_ID.test(messageId || "")) {
        const error = new Error("The host did not return a confirmed turn ID"); error.sendAttempted = true; throw error;
      }
      return view(change(id, latest => {
        if (latest.dispatch?.attemptId !== attemptId) throw new Error("Dispatch receipt does not match its reservation");
        latest.dispatch = { ...latest.dispatch, sending: false, messageId, confirmedAt: stamp() };
        if (latest.status === "dispatching") latest.status = "queued";
        if (latest.status === "paused") latest.resumeStatus = "queued";
        latest.waitingSince = stamp();
      }));
    } catch (error) {
      change(id, latest => {
        if (latest.dispatch?.attemptId !== attemptId) return;
        latest.dispatch.sending = false;
        latest.dispatch.deliveryStage = error.deliveryStage === "preflight" ? "preflight_failed"
          : error.deliveryStage === "before_send" ? "before_send_failed"
          : error.sendAttempted === true ? "confirmation_uncertain" : "outcome_unknown";
        latest.dispatch.sendAttempted = error.sendAttempted === true ? true
          : error.deliveryStage === "preflight" || error.deliveryStage === "before_send" ? false : null;
        latest.dispatch.textEntryAttempted = error.textEntryAttempted === true;
        if (error.uiPhase) latest.dispatch.uiPhase = error.uiPhase;
        if (error.preflightObservation) latest.dispatch.preflightObservation = error.preflightObservation;
        latest.dispatch.failedAt = stamp();
      });
      return fail(id, `Delivery was not confirmed: ${String(error.message || error)}. No automatic retry.`);
    }
  }
  function getStatus(id) {
    const state = read(id);
    if (state.status === "pending" && state.supervisor?.status === "awaiting_stop" &&
        Date.now() - Date.parse(state.waitingSince) > state.maxTurnMinutes * 60000) {
      return view(change(id, latest => {
        if (latest.status !== "pending" || latest.supervisor?.status !== "awaiting_stop") return;
        latest.status = "needs_review";
        latest.error = "No supervisor acknowledged Stop within the wait limit. Nothing was sent; no automatic retry.";
      }));
    }
    return view(state);
  }
  return { start, tick, getStatus, pause, cancel, resume, reconcile, fail, recover, attachSupervisor, releaseSupervisor };
}
