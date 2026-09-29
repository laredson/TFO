import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { validateSelection, validateAssessment, decideModel } from "./model-policy.mjs";
import { createSettingsStore } from "./settings.mjs";
import { estimateRouteBudget, equivalentUsd, normalizeUsage } from "./budget.mjs";
import { reserveChatSlot } from "./prompt-queue.mjs";

const timestamp = () => new Date().toISOString();
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_ID = /^chat_[a-z0-9_]+$/;

export function createChatRouter({ dataDir, dispatch, verifyInitial, readObserved, readMetrics, getSettings = createSettingsStore(dataDir).read, deferDispatch = false }) {
  const runsDir = path.join(dataDir, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const fileFor = id => path.join(runsDir, id, "state.json");
  const alive = pid => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
  };
  const locked = (id, action) => {
    if (typeof id !== "string" || !RUN_ID.test(id)) throw new Error("Invalid chat route ID");
    const lock = path.join(runsDir, id, "mutation.lock");
    let fd;
    try { fd = fs.openSync(lock, "wx"); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      let pid;
      try { pid = Number(fs.readFileSync(lock, "utf8")); } catch { /* Another operator owns it. */ }
      if (!pid || alive(pid)) throw new Error("Route is busy; inspect status before retrying");
      fs.unlinkSync(lock);
      fd = fs.openSync(lock, "wx");
    }
    fs.writeFileSync(fd, String(process.pid));
    try { return action(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  };
  const read = id => {
    if (typeof id !== "string" || !RUN_ID.test(id)) throw new Error("Invalid chat route ID");
    try { return JSON.parse(fs.readFileSync(fileFor(id), "utf8")); }
    catch (error) {
      if (error?.code === "ENOENT") throw new Error(`Unknown chat route: ${id}`);
      throw error;
    }
  };
  const save = state => {
    const dir = path.dirname(fileFor(state.id));
    fs.mkdirSync(dir, { recursive: true });
    state.updatedAt = timestamp();
    const temp = path.join(dir, `state.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`);
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(temp, fileFor(state.id));
  };
  const view = state => ({
    id: state.id, kind: state.kind, objective: state.objective,
    projectPath: state.projectPath, threadId: state.threadId,
    status: state.status, currentIndex: state.currentIndex, pendingSourceTurnId: state.pendingSourceTurnId || null,
    totalSteps: state.steps.length, currentStep: state.steps[state.currentIndex] || null,
    completedSteps: state.completedSteps, dispatch: state.dispatch,
    execution: state.execution || null, modelDecisions: state.modelDecisions || [], budget: state.budget || null,
    time: state.time || null,
    error: state.error, startedAt: state.startedAt, updatedAt: state.updatedAt,
  });
  const promptFor = state => {
    const step = state.steps[state.currentIndex];
    const done = state.completedSteps.map(item => `${item.title}: ${item.summary}`).join("\n");
    return [
      `[Enviado por TFO · ruta ${state.id} · paso ${state.currentIndex + 1}/${state.steps.length}]`,
      `Continuemos con TFO. Paso ${state.currentIndex + 1} de ${state.steps.length}: ${step.title}.`,
      `Objetivo general: ${state.objective}`,
      `Carpeta autorizada: ${state.projectPath}`,
      `Antes de trabajar, consulta tfo_chat_status con runId=${state.id}. Si está pausada, cancelada o requiere revisión, detente.`,
      state.execution ? `Modelo solicitado para este paso: ${state.execution.current.model}, esfuerzo ${state.execution.current.reasoning}. TFO aplica el límite en cada envío; no autorices subidas por tu cuenta.` : "",
      state.constraints ? `Condiciones acordadas: ${state.constraints}` : "",
      done ? `Ya completado:\n${done}` : "",
      `Tarea de este paso:\n${step.prompt}`,
      `Usa las herramientas TFO de esta instalación para consultar y completar la ruta.`,
      `Antes de terminar, consulta de nuevo el estado de la ruta ${state.id}. Al terminar, registra el resultado del paso ${step.id} con success=true y un resumen claro; si falla, registra success=false y explica por qué. Puedes incluir nextAssessment para valorar el siguiente paso (complexity, confidence, reason y recommendation con model y reasoning). Considera también los pasos posteriores: sin permiso de subida, una reducción no se revierte. TFO enviará el siguiente prompt después de guardar el resultado; una pausa, cancelación o fallo impide continuar.`,
    ].filter(Boolean).join("\n\n");
  };
  const dispatchCurrent = async (id, sourceTurnId = null) => {
    let reserved = false;
    let metrics = null;
    try { if (readMetrics) metrics = await readMetrics(read(id).threadId); } catch { /* Unknown usage cannot be treated as zero. */ }
    const state = locked(id, () => {
      const latest = read(id);
      if (latest.status !== "dispatching" || latest.dispatch?.sending) return latest;
      try {
        if (!latest.execution) throw new Error("This older route has no explicit model ceiling. Review it before starting another step.");
        const step = latest.steps[latest.currentIndex];
        const options = getSettings();
        if (latest.time) {
          const elapsed = (Date.now() - Date.parse(latest.startedAt)) / 60000;
          latest.time = { ...latest.time, elapsedMinutes: Math.round(elapsed), progressPercent: Math.min(100, Math.round(elapsed / latest.time.targetMinutes * 100)) };
          if (latest.time.mode === "deliver_at_time" && elapsed >= latest.time.targetMinutes + latest.time.extraMinutes) {
            latest.status = "delivered_at_time"; latest.error = "Time target and allowed margin reached; remaining steps are saved for review.";
            save(latest); return latest;
          }
        }
        const decision = decideModel({ ...latest.execution, assessment: step.assessment, settings: options });
        if (latest.budget) {
          if (!metrics || !Number.isFinite(metrics.weeklyUsedPercent)) throw new Error("Weekly usage is unavailable; review the route before another dispatch.");
          if (metrics.weeklyUsedPercent >= options.maxWeeklyUsedPercent) throw new Error("Weekly usage limit reached; no further prompt was sent.");
          const remaining = latest.steps.slice(latest.currentIndex).map((item, index) => ({ ...item,
            assessment: index === 0 ? { recommendation: decision.selected } : item.assessment?.recommendation ? item.assessment : { recommendation: decision.selected } }));
          const estimate = estimateRouteBudget({ objective: latest.objective, constraints: latest.constraints, steps: remaining,
            initialSelection: decision.selected, contextTokens: metrics.lastResponseUsage?.input_tokens || latest.budget.contextTokens || 0,
            maxCostMultiplier: options.maxCostMultiplier, maxEstimatedUsd: options.maxEstimatedUsd, maxWeeklyUsedPercent: options.maxWeeklyUsedPercent });
          const spent = latest.completedSteps.reduce((total, item) => total + (item.equivalentUsd || 0), 0);
          if (spent + estimate.projectedUsd * estimate.reserveFactor > latest.budget.ceilingUsd) throw new Error("Estimated remaining cost exceeds the route budget; review the split or limits.");
          latest.budget = { ...latest.budget, spentEquivalentUsd: spent, remainingEstimateUsd: estimate.projectedUsd, weeklyUsedPercent: metrics.weeklyUsedPercent };
        }
        latest.execution.current = decision.selected;
        latest.modelDecisions.push({ stepId: step.id, ...decision });
        latest.dispatch = { stepId: step.id, sending: true, ownerPid: process.pid, requested: decision.selected, prompt: promptFor(latest),
          sourceTurnId, attemptedAt: timestamp() };
        reserved = true;
      } catch (error) { latest.status = "needs_review"; latest.error = String(error.message || error); }
      save(latest);
      return latest;
    });
    if (!reserved) return view(state);
    const attempt = state.dispatch.attemptedAt;
    try {
      const delivery = await dispatch(state.threadId, state.dispatch.prompt, state.execution.current, {
        ceiling: state.execution.ceiling, allowUpgrades: state.modelDecisions.at(-1).allowUpgrades,
        runId: state.id, dataDir, projectPath: state.projectPath,
        sourceTurnId,
      });
      return locked(id, () => {
        const latest = read(id);
        if (latest.dispatch?.attemptedAt !== attempt) throw new Error("Dispatch state changed; review delivery");
        if (delivery?.scheduled) {
          latest.dispatch = { ...latest.dispatch, sending: false, scheduled: true, ownerPid: delivery.ownerPid, sourceTurnId: delivery.sourceTurnId };
          if (latest.status === "dispatching") latest.status = "scheduled";
        } else {
          latest.dispatch = { ...latest.dispatch, sending: false, messageId: delivery, queuedAt: timestamp() };
          if (latest.status === "dispatching") latest.status = "queued";
        }
        save(latest);
        return view(latest);
      });
    } catch (error) {
      return locked(id, () => {
        const latest = read(id);
        if (latest.status !== "cancelled") latest.status = "needs_review";
        latest.error = `Could not confirm prompt delivery: ${String(error?.message || error)}`;
        save(latest);
        return view(latest);
      });
    }
  };
  async function dispatchPending(id, sourceTurnId) {
    const state = locked(id, () => {
      const latest = read(id);
      if (latest.status !== "pending") throw new Error(`Cannot dispatch a route in ${latest.status} state`);
      if (!sourceTurnId || latest.pendingSourceTurnId !== sourceTurnId) throw new Error("Completed source turn does not match this pending prompt");
      latest.status = "dispatching";
      latest.pendingSourceTurnId = null;
      save(latest);
      return latest;
    });
    return dispatchCurrent(state.id, sourceTurnId);
  }
  function failPending(id, sourceTurnId, reason) {
    return locked(id, () => {
      const latest = read(id);
      if (latest.status !== "pending" || latest.pendingSourceTurnId !== sourceTurnId) return view(latest);
      latest.status = "needs_review";
      latest.error = String(reason || "Pending prompt requires review");
      save(latest);
      return view(latest);
    });
  }
  function validateSteps(steps) {
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20) throw new Error("A chat route requires 1 to 20 steps");
    return steps.map((step, index) => {
      const title = String(step?.title || "").trim();
      const prompt = String(step?.prompt || "").trim();
      if (!title || !prompt) throw new Error(`steps[${index}] requires title and prompt`);
      if (step.expectedOutputTokens != null && (!Number.isInteger(step.expectedOutputTokens) || step.expectedOutputTokens < 1 || step.expectedOutputTokens > 100000)) throw new Error(`steps[${index}].expectedOutputTokens is invalid`);
      return { id: `step-${index + 1}`, title, prompt, assessment: validateAssessment(step.assessment), expectedOutputTokens: step.expectedOutputTokens || 2048 };
    });
  }
  async function start(args) {
    const objective = String(args?.objective || "").trim();
    if (objective.length < 3) throw new Error("objective must contain at least 3 characters");
    if (!THREAD_ID.test(args?.threadId || "")) throw new Error("threadId must be a Codex task UUID");
    if (typeof args?.projectPath !== "string" || !args.projectPath.trim()) throw new Error("projectPath is required");
    const projectPath = fs.realpathSync(path.resolve(String(args?.projectPath || "")));
    if (!fs.statSync(projectPath).isDirectory()) throw new Error("projectPath must be a directory");
    const steps = validateSteps(args.steps);
    const initial = validateSelection(args.initialSelection);
    if (verifyInitial) await verifyInitial(args.threadId, initial);
    const options = getSettings();
    let budget = null;
    if (args.enforceBudget) {
      const metrics = readMetrics ? await readMetrics(args.threadId) : null;
      if (!metrics || !Number.isFinite(metrics.weeklyUsedPercent)) throw new Error("Weekly usage is unavailable; budgeted route cannot start.");
      if (metrics.weeklyUsedPercent >= options.maxWeeklyUsedPercent) throw new Error("Weekly usage limit reached; route not started.");
      budget = estimateRouteBudget({ objective, constraints: String(args.constraints || ""), steps, initialSelection: initial,
        contextTokens: metrics.lastResponseUsage?.input_tokens || 0, maxCostMultiplier: options.maxCostMultiplier,
        maxEstimatedUsd: options.maxEstimatedUsd, maxWeeklyUsedPercent: options.maxWeeklyUsedPercent });
      if (!budget.withinBudget) throw new Error("Planned split exceeds the configured cost limit; shorten or lower its steps.");
    }
    const sourceTurn = deferDispatch ? await readMetrics?.(args.threadId) : null;
    if (deferDispatch && !sourceTurn?.lastTurnId) throw new Error("Cannot identify the current host turn; no route was started.");
    const state = {
      id: `chat_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`,
      kind: "chat", version: "1.0.0-rc.1", objective, projectPath, budget,
      time: args.enforceBudget ? { mode: options.timeMode, targetMinutes: options.targetMinutes, extraMinutes: options.extraMinutes,
        elapsedMinutes: 0, progressPercent: 0, approximate: true } : null,
      execution: { current: initial, ceiling: initial }, modelDecisions: [],
      threadId: args.threadId, constraints: String(args.constraints || "").trim(), steps,
      currentIndex: 0, completedSteps: [], dispatch: null, status: deferDispatch ? "pending" : "dispatching",
      pendingSourceTurnId: deferDispatch ? sourceTurn.lastTurnId : null,
      error: "", startedAt: timestamp(), updatedAt: timestamp(),
    };
    reserveChatSlot(runsDir, args.threadId, () => save(state));
    return deferDispatch ? view(state) : dispatchCurrent(state.id);
  }
  async function complete(args) {
    let observed = null, observationError = "", turnMetrics = null;
    if (readObserved) {
      try { observed = await readObserved(read(args?.runId).threadId); }
      catch (error) { observationError = String(error.message || error); }
    }
    if (readMetrics) {
      try { turnMetrics = await readMetrics(read(args?.runId).threadId); }
      catch (error) { observationError ||= String(error.message || error); }
    }
    const state = locked(args?.runId, () => {
    const state = read(args?.runId);
    const step = state.steps[state.currentIndex];
    if (!step || step.id !== args?.stepId) throw new Error("Step is not current or was already completed");
    if (!["queued", "paused"].includes(state.status)) throw new Error(`Cannot complete a route in ${state.status} state`);
    if (!state.dispatch?.messageId || state.dispatch.stepId !== step.id || state.dispatch.sending) throw new Error("Current prompt was not confirmed as queued");
    let summary = String(args?.summary || "").trim();
    if (!summary) throw new Error("summary is required");
    let success = args?.success === true;
    const requested = state.dispatch.requested;
    if (readObserved && requested && (observationError || observed?.model !== requested.model || observed?.reasoning !== requested.reasoning)) {
      success = false;
      summary += ` [Host model verification failed: ${observationError || `requested ${requested.model}/${requested.reasoning}, observed ${observed?.model}/${observed?.reasoning}`}. Chain stopped.]`;
    }
    const nextAssessment = validateAssessment(args?.nextAssessment);
    if (turnMetrics && turnMetrics.lastTurnId !== state.dispatch.messageId) { success = false; summary += " [Host turn ID differs from the dispatched prompt. Chain stopped.]"; }
    const actualUsage = normalizeUsage(turnMetrics?.usage);
    state.completedSteps.push({ id: step.id, title: step.title, success, summary, completedAt: timestamp(), messageId: state.dispatch.messageId,
      requested: state.dispatch.requested || null, observed, prompt: state.dispatch.prompt || null, actualUsage,
      equivalentUsd: actualUsage && state.dispatch.requested ? equivalentUsd(state.dispatch.requested, actualUsage) : null,
      weeklyUsedPercent: turnMetrics?.weeklyUsedPercent ?? null });
    state.currentIndex += 1;
    if (nextAssessment && state.steps[state.currentIndex]) state.steps[state.currentIndex].assessment = nextAssessment;
    state.dispatch = null;
    if (!success) {
      state.status = "needs_review";
      state.error = summary;
    } else if (state.currentIndex === state.steps.length) {
      state.status = "completed";
    } else if (state.status === "paused") {
      state.status = "paused";
    } else {
      state.status = deferDispatch ? "pending" : "dispatching";
      state.pendingSourceTurnId = deferDispatch ? turnMetrics?.lastTurnId || null : null;
      if (deferDispatch && !state.pendingSourceTurnId) {
        state.status = "needs_review";
        state.error = "Cannot identify the completed host turn for the next prompt.";
      }
    }
    save(state); // The checkpoint exists before the next prompt is queued.
    return state;
    });
    return state.status === "dispatching" ? dispatchCurrent(state.id) : view(state);
  }
  function pause(id) {
    return locked(id, () => {
    const state = read(id);
    if (["completed", "cancelled", "needs_review"].includes(state.status)) throw new Error(`Cannot pause a ${state.status} route`);
    state.status = "paused"; save(state); return view(state);
    });
  }
  function cancel(id) {
    return locked(id, () => {
    const state = read(id);
    if (["completed", "delivered_at_time"].includes(state.status)) throw new Error("Cannot cancel a completed route");
    state.status = "cancelled"; save(state); return view(state);
    });
  }
  async function resume(id) {
    const resumeTurn = deferDispatch ? await readMetrics?.(read(id).threadId) : null;
    const state = locked(id, () => {
    const state = read(id);
    if (state.status !== "paused") throw new Error("Only paused routes can resume");
    if (state.dispatch?.sending) throw new Error("Delivery is still pending or uncertain. Inspect the conversation; do not resend.");
    state.status = state.dispatch?.scheduled ? "scheduled" : state.dispatch?.stepId === state.steps[state.currentIndex]?.id ? "queued" : deferDispatch ? "pending" : "dispatching";
    if (state.status === "pending") {
      if (!resumeTurn?.lastTurnId) throw new Error("Cannot identify the current turn for a safe resume");
      state.pendingSourceTurnId = resumeTurn.lastTurnId;
    }
    save(state);
    return state;
    });
    return state.status === "dispatching" ? dispatchCurrent(id) : view(state);
  }
  function recover() {
    for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
      let state;
      try { state = read(entry.name); } catch { continue; }
      if (!["dispatching", "scheduled"].includes(state.status) && !(state.status === "paused" && (state.dispatch?.sending || state.dispatch?.scheduled))) continue;
      if (alive(state.dispatch?.ownerPid)) continue;
      try { locked(state.id, () => {
        const latest = read(state.id);
        if (!["dispatching", "scheduled", "paused"].includes(latest.status) || alive(latest.dispatch?.ownerPid)) return;
        latest.status = "needs_review";
        latest.error = "TFO restarted during prompt dispatch. Inspect the conversation before retrying; delivery is uncertain.";
        save(latest);
      }); } catch { /* A live process is mutating this route. */ }
    }
  }
  recover();
  return { start, complete, dispatchPending, failPending, getStatus: id => view(read(id)), pause, cancel, resume };
}
