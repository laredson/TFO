#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createChatRouter } from "./chat-route.mjs";
import { createPromptQueue } from "./prompt-queue.mjs";
import { launchSupervisor } from "./supervisor-launch.mjs";
import { DEFAULT_SOL_MODEL, MODELS as MODEL_REGISTRY, EFFORTS as VALID_EFFORTS, validateSelection, decideModel, selectionSchema, assessmentSchema } from "./model-policy.mjs";
import { createSettingsStore } from "./settings.mjs";
import { dispatchPrompt, diagnoseDesktopAccess } from "./queue-transport.mjs";
import { launchOptions } from "./options-server.mjs";
import { verifyInitialSelection, readHostSelection, readHostTurnState, readHostTurnReceipt, findHostTurnsForPrompt } from "./host-selection.mjs";
import { openAppServer } from "./app-server-client.mjs";
import { estimateRouteBudget } from "./budget.mjs";
import { connectionCheck, connectionResource, surfaces } from "./connection-check.mjs";
import { createProjectCoordinator } from "./project-coordinator.mjs";
import { createProjectFlow } from "./project-flow.mjs";
import { nativeProjectHost } from "./project-host.mjs";
import { launchProjectSupervisor } from "./project-supervisor.mjs";
import { projectFlowTools } from "./project-flow-tools.mjs";
import { createNativeFlow } from "./native-flow.mjs";
import { nativeFlowTools } from "./native-flow-tools.mjs";

const VERSION = "1.0.0-rc.2";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.TFO_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), "TFO", "data"));
const RUNS_DIR = path.join(DATA_DIR, "runs");
const RESULT_SCHEMA = path.join(ROOT, "step-result.schema.json");
const MODELS = new Set(Object.keys(MODEL_REGISTRY));
const EFFORTS = new Set(VALID_EFFORTS);
const activeProcesses = new Map();
const activeLoops = new Map();
const settings = createSettingsStore(DATA_DIR);

fs.mkdirSync(RUNS_DIR, { recursive: true });

const chatRouter = createChatRouter({
  dataDir: DATA_DIR,
  dispatch: dispatchPrompt,
  verifyInitial: verifyInitialSelection,
  readObserved: readHostSelection,
  readMetrics: readHostTurnState,
  deferDispatch: true,
});
const promptQueue = createPromptQueue({ dataDir: DATA_DIR, readHost: readHostTurnState,
  readReceipt: readHostTurnReceipt, findPromptTurns: findHostTurnsForPrompt, dispatch: dispatchPrompt, verifyInitial: verifyInitialSelection,
  startSupervisor: state => launchSupervisor(DATA_DIR, state) });
const projectCoordinator = createProjectCoordinator({ dataDir: DATA_DIR });
const projectFlow = createProjectFlow({ dataDir: DATA_DIR, host: nativeProjectHost, launch: id => launchProjectSupervisor(DATA_DIR, id) });
const nativeFlow = createNativeFlow({ dataDir: DATA_DIR, host: nativeProjectHost });
projectCoordinator.recover();

function now() { return new Date().toISOString(); }
function runDirectory(id) { return path.join(RUNS_DIR, id); }
function stateFile(id) { return path.join(runDirectory(id), "state.json"); }
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function saveState(state) {
  const dir = runDirectory(state.id);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = path.join(dir, `state.${process.pid}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(temporary, stateFile(state.id));
}
function loadState(id) {
  if (!/^[a-z0-9_-]{8,80}$/i.test(id)) return null;
  return readJson(stateFile(id));
}
function publicState(state) {
  return {
    id: state.id,
    objective: state.objective,
    projectPath: state.projectPath,
    status: state.status,
    currentIndex: state.currentIndex,
    totalSteps: state.steps.length,
    completedSteps: state.completedSteps,
    currentStep: state.steps[state.currentIndex] || null,
    lastResult: state.lastResult,
    error: state.error,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    execution: state.execution || null, modelDecisions: state.modelDecisions || [],
  };
}
function normalizeStep(step, index) {
  if (!step || typeof step !== "object") throw new Error(`steps[${index}] must be an object`);
  const model = step.model || "gpt-6-luna";
  const reasoning = step.reasoning || (model === "gpt-6-luna" ? "high" : "medium");
  if (!MODELS.has(model)) throw new Error(`Unsupported model in steps[${index}]: ${model}`);
  if (!EFFORTS.has(reasoning)) throw new Error(`Unsupported reasoning effort in steps[${index}]: ${reasoning}`);
  validateSelection({ model, reasoning });
  const title = String(step.title || "").trim();
  const instruction = String(step.instruction || "").trim();
  if (!title || !instruction) throw new Error(`steps[${index}] requires title and instruction`);
  return {
    id: String(step.id || `step-${index + 1}`).replace(/[^a-z0-9._-]/gi, "-").slice(0, 80),
    title,
    instruction,
    model,
    reasoning,
  };
}
function codexCommand() { return process.env.TFO_CODEX_COMMAND || "codex"; }
function workerPrompt(state, step) {
  const checkpoints = state.completedSteps.map(item => `- ${item.id}: ${item.summary}`).join("\n") || "- none";
  return [
    "TFO WORKER STEP",
    `GLOBAL OBJECTIVE:\n${state.objective}`,
    `AUTHORIZED CONSTRAINTS:\n${state.constraints || "No extra constraints."}`,
    `COMPLETED CHECKPOINTS:\n${checkpoints}`,
    `CURRENT STEP (${step.id}: ${step.title}):\n${step.instruction}`,
    "EXECUTION RULES:",
    "1. Work only inside the supplied project directory and stay within this step's scope.",
    "2. Inspect existing work first and preserve valid changes.",
    "3. Do not push, publish, release, alter credentials, delete the project, or broaden permissions.",
    "4. Run relevant validation when feasible and report exact results.",
    "5. If a consequential decision is required or the step cannot safely continue, set needs_ai=true.",
    "6. Return only the JSON object required by the output schema.",
  ].join("\n\n");
}
function executeStep(state, step, index) {
  const directory = runDirectory(state.id);
  const logs = path.join(directory, "logs");
  fs.mkdirSync(logs, { recursive: true });
  const prefix = `${String(index + 1).padStart(3, "0")}-${step.id}`;
  const resultPath = path.join(logs, `${prefix}.result.json`);
  const stdoutPath = path.join(logs, `${prefix}.events.jsonl`);
  const stderrPath = path.join(logs, `${prefix}.stderr.log`);
  const promptPath = path.join(logs, `${prefix}.prompt.txt`);
  const prompt = workerPrompt(state, step);
  fs.writeFileSync(promptPath, prompt, "utf8");
  const args = [
    "exec", "--cd", state.projectPath,
    "--sandbox", "workspace-write", "--ask-for-approval", "never", "--json",
    "--model", step.model, "-c", `model_reasoning_effort=\"${step.reasoning}\"`,
    "--output-schema", RESULT_SCHEMA, "--output-last-message", resultPath, prompt,
  ];
  return new Promise(resolve => {
    const child = spawn(codexCommand(), args, { cwd: state.projectPath, windowsHide: true, env: { ...process.env } });
    activeProcesses.set(state.id, child);
    const stdout = fs.createWriteStream(stdoutPath, { flags: "a" });
    const stderr = fs.createWriteStream(stderrPath, { flags: "a" });
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    child.once("error", error => {
      stdout.end(); stderr.end(); activeProcesses.delete(state.id);
      resolve({ exitCode: -1, error: String(error), result: null });
    });
    child.once("close", code => {
      stdout.end(); stderr.end(); activeProcesses.delete(state.id);
      resolve({ exitCode: code ?? -1, error: "", result: readJson(resultPath) });
    });
  });
}
async function runLoop(id) {
  if (activeLoops.has(id)) return activeLoops.get(id);
  const task = (async () => {
    try {
      while (true) {
        let state = loadState(id);
        if (!state || state.status !== "running") break;
        if (state.currentIndex >= state.steps.length) {
          state.status = "completed"; state.updatedAt = now(); saveState(state); break;
        }
        const plannedStep = state.steps[state.currentIndex];
        if (!state.execution) throw new Error("Older route has no model ceiling. Review it before continuing.");
        const decision = decideModel({ ...state.execution, settings: settings.read(), assessment: {
          complexity: "standard", confidence: "high", reason: "Model requested in the approved worker step", recommendation: { model: plannedStep.model, reasoning: plannedStep.reasoning },
        } });
        state.execution.current = decision.selected;
        state.modelDecisions.push({ stepId: plannedStep.id, ...decision });
        state.ownerPid = process.pid;
        const step = { ...plannedStep, ...decision.selected };
        state.updatedAt = now(); saveState(state);
        const outcome = await executeStep(state, step, state.currentIndex);
        state = loadState(id);
        if (!state || state.status !== "running") break;
        state.lastResult = outcome.result || { success: false, needs_ai: true, summary: "Worker did not return a valid result", details: outcome.error || `exit code ${outcome.exitCode}` };
        if (outcome.exitCode !== 0 || !outcome.result?.success || outcome.result?.needs_ai) {
          state.status = "needs_ai";
          state.error = outcome.error || (outcome.exitCode !== 0 ? `Worker exited with code ${outcome.exitCode}` : "Worker requested a planning decision");
          state.updatedAt = now(); saveState(state); break;
        }
        state.completedSteps.push({
          id: step.id, title: step.title, summary: outcome.result.summary || "Completed",
          files_changed: outcome.result.files_changed || [], validation: outcome.result.validation || [], completedAt: now(),
        });
        state.currentIndex += 1;
        state.error = ""; state.updatedAt = now(); saveState(state);
      }
    } catch (error) {
      const state = loadState(id);
      if (state) { state.status = "needs_ai"; state.error = String(error?.stack || error); state.updatedAt = now(); saveState(state); }
    } finally { activeLoops.delete(id); }
  })();
  activeLoops.set(id, task);
  return task;
}
function startRoute(args) {
  if (typeof args.objective !== "string" || args.objective.trim().length < 3) throw new Error("objective must contain at least 3 characters");
  if (typeof args.projectPath !== "string" || !args.projectPath.trim()) throw new Error("projectPath is required");
  const projectPath = fs.realpathSync(path.resolve(args.projectPath));
  if (!fs.statSync(projectPath).isDirectory()) throw new Error("projectPath must be a directory");
  if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 20) throw new Error("steps must contain between 1 and 20 steps");
  const id = `route_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  const steps = args.steps.map(normalizeStep);
  const initial = validateSelection(steps[0]);
  const state = {
    id, version: VERSION, objective: args.objective.trim(), projectPath,
    constraints: String(args.constraints || ""), steps,
    execution: { current: initial, ceiling: initial }, modelDecisions: [],
    currentIndex: 0, completedSteps: [], lastResult: null, error: "",
    status: "running", startedAt: now(), updatedAt: now(),
    ownerPid: process.pid,
  };
  saveState(state);
  void runLoop(id);
  return state;
}
function setRunState(id, nextStatus) {
  const state = loadState(id);
  if (!state) throw new Error(`Unknown run: ${id}`);
  if (state.status === "completed" || state.status === "cancelled") throw new Error(`Run ${id} is ${state.status}`);
  state.status = nextStatus; state.updatedAt = now(); saveState(state);
  if (nextStatus === "paused" || nextStatus === "cancelled") activeProcesses.get(id)?.kill();
  if (nextStatus === "running") void runLoop(id);
  return state;
}
function recoverInterruptedRuns() {
  for (const entry of fs.readdirSync(RUNS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = stateFile(entry.name);
    const state = readJson(file);
    if (state?.status === "running") {
      if (Number.isInteger(state.ownerPid)) {
        try { process.kill(state.ownerPid, 0); continue; } catch (error) { if (error.code === "EPERM") continue; }
      }
      state.status = "paused";
      state.error = "Supervisor restarted. Resume this run after reviewing its checkpoint.";
      state.updatedAt = now();
      saveState(state);
    }
  }
}

const tools = [
  ...projectFlowTools,
  ...nativeFlowTools,
  { name: "tfo_health", description: "Read TFO runtime readiness, version, and data directory.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  ...["check", "panel"].map(action => ({ name: `tfo_connection_${action}`,
    description: action === "check" ? "Read TFO capabilities for the explicitly declared product: Codex local, normal ChatGPT Chat, or ChatGPT Work. Never sends. Use this first in normal Chat; tool availability is not proof of automatic delivery."
      : "Show a read-only TFO connection panel inside the chat through MCP Apps. Detects UI bridge availability without sending, selecting a model or arming a queue.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    ...(action === "panel" ? { _meta: { ui: { resourceUri: connectionResource } } } : {}),
    inputSchema: { type: "object", required: ["surface"], additionalProperties: false, properties: { surface: { type: "string", enum: surfaces } } },
  })),
  { name: "tfo_ui_diagnostic", description: "Read whether this installed TFO process can see the Codex Desktop window, model selector, editor and busy state. Never types, changes a selector or sends a prompt.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "tfo_queue_start", description: "Store 1-20 user-authorized prompts in this same chat without sending now. The tool starts an acknowledged conventional supervisor before returning. It waits for this turn to finish, then sends one prompt, waits for its final response and verifies its real selection before advancing. An immutable runtime snapshot survives plugin updates; Stop is auxiliary. No AI checkpoint call or self-message is needed. State the queue ID in the final answer, then end the turn. Set allowPlannedIncreases only for an explicit user-approved selection sequence; it stays within the initial ceiling unless authorizedSelections lists the exact selections explicitly requested by the user. Exceptions apply only to those stored steps and never change global settings.", inputSchema: {
    type: "object", additionalProperties: false, required: ["threadId", "projectPath", "objective", "initialSelection", "steps"],
    properties: { surface: { type: "string", enum: surfaces, default: "codex", description: "Only codex can currently arm this queue. Normal Chat uses connection diagnostics first." }, threadId: { type: "string" }, projectPath: { type: "string" }, objective: { type: "string" }, initialSelection: selectionSchema,
      authorizedSelections: { type: "array", maxItems: 20, items: selectionSchema, description: "Exact model/effort pairs explicitly requested by the user for these steps; permits only these pairs above the initial effort/model. Requires allowPlannedIncreases. Do not infer this authorization." },
      allowPlannedIncreases: { type: "boolean", default: false }, maxTurnMinutes: { type: "integer", minimum: 1, maximum: 1440 },
      deliveryMode: { type: "string", enum: ["auto", "ui"], default: "auto", description: "Use ui only to validate the full picker/composer path even with an unchanged selection. It preserves all guards and never falls back after failure." },
      startPaused: { type: "boolean", default: false, description: "Persist the complete queue for review without arming its Stop hook. Resume explicitly after host readiness is verified." },
      steps: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", additionalProperties: false,
        required: ["prompt", "selection"], properties: { title: { type: "string" }, prompt: { type: "string" }, selection: selectionSchema,
          expectedResponse: { type: "string", description: "Optional exact final response required before advancing, e.g. hola. Without it, the receipt confirms turn completion only, not the task's correctness." } } } } } } },
  ...["status", "pause", "cancel", "resume", "reconcile"].map(action => ({ name: `tfo_queue_${action}`,
    description: action === "reconcile"
      ? "Reconcile an uncertain send only when its exact visible prompt appears in one completed host turn and the real model, effort and expected final response all match. This records the checkpoint without sending anything; any remaining queue is paused."
      : `${action} the stored conventional prompt queue. A pause or cancellation prevents later sends; ambiguous delivery never retries automatically.`,
    inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } }, additionalProperties: false } })),
  { name: "tfo_project_prepare", description: "Persist a validated DAG for chats in one project. This preview has no verified multi-chat host adapter, so the plan is returned blocked and no prompt, chat or worker is started. Never claim parallel execution from a stored plan.", inputSchema: {
    type: "object", additionalProperties: false, required: ["objective", "projectPath", "nodes"], properties: {
      objective: { type: "string", minLength: 3 }, projectPath: { type: "string" },
      nodes: { type: "array", minItems: 1, maxItems: 40, items: { type: "object", additionalProperties: false,
        required: ["id", "threadId", "workspace", "selection"], properties: {
          id: { type: "string" }, title: { type: "string" }, threadId: { type: "string" }, workspace: { type: "string" },
          dependencies: { type: "array", items: { type: "string" } }, selection: selectionSchema,
          access: { type: "string", enum: ["read", "write"], default: "read" },
        } } },
    },
  } },
  ...["status", "pause", "resume", "cancel"].map(action => ({ name: `tfo_project_${action}`,
    description: `${action} or inspect a stored project DAG. This does not enable the unavailable host adapter or dispatch prompts.`,
    inputSchema: { type: "object", required: ["runId"], additionalProperties: false, properties: { runId: { type: "string" } } } })),
  { name: "tfo_project_recover", description: "Mark project plans interrupted during a coordinator restart as needs_review; never resends a node.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "tfo_start", description: "Start a route only after the user has reviewed and approved its objective, steps, models, reasoning, and project scope. Each step runs as a bounded Codex CLI worker in workspace-write mode and writes a persistent checkpoint.", inputSchema: {
    type: "object", additionalProperties: false,
    required: ["objective", "projectPath", "steps"],
    properties: {
      objective: { type: "string", minLength: 3 }, projectPath: { type: "string", minLength: 1 }, constraints: { type: "string" },
      steps: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", additionalProperties: false, required: ["title", "instruction"], properties: {
        id: { type: "string" }, title: { type: "string", minLength: 1 }, instruction: { type: "string", minLength: 1 },
        model: { type: "string", enum: [...MODELS] }, reasoning: { type: "string", enum: [...EFFORTS] },
      } } },
    },
  } },
  { name: "tfo_get_status", description: "Read a route status, current step, completed checkpoints, and last worker result.", inputSchema: { type: "object", required: ["runId"], additionalProperties: false, properties: { runId: { type: "string" } } } },
  { name: "tfo_pause", description: "Pause the route and stop its active worker. Already-written project changes remain.", inputSchema: { type: "object", required: ["runId"], additionalProperties: false, properties: { runId: { type: "string" } } } },
  { name: "tfo_resume", description: "Resume a paused route from its last persisted checkpoint.", inputSchema: { type: "object", required: ["runId"], additionalProperties: false, properties: { runId: { type: "string" } } } },
  { name: "tfo_cancel", description: "Cancel a route and stop its worker. This does not revert project changes already written.", inputSchema: { type: "object", required: ["runId"], additionalProperties: false, properties: { runId: { type: "string" } } } },
  { name: "tfo_chat_start", description: "Prepare an authorized route of 1-20 visible prompts in this Codex chat. TFO saves the first prompt and waits for this turn to end before dispatch. Supply the actual current model/effort; model changes remain blocked until a verified transport exists.", inputSchema: {
    type: "object", additionalProperties: false, required: ["objective", "projectPath", "threadId", "steps", "initialSelection"],
    properties: { objective: { type: "string", minLength: 3 }, projectPath: { type: "string" }, threadId: { type: "string" }, constraints: { type: "string" },
      initialSelection: selectionSchema,
      steps: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", additionalProperties: false, required: ["title", "prompt"], properties: { title: { type: "string" }, prompt: { type: "string" }, assessment: assessmentSchema } } },
    },
  } },
  { name: "tfo_catalog", description: "Read the host's live model and reasoning catalog and observed model for this chat.", inputSchema: { type: "object", additionalProperties: false, required: ["threadId"], properties: { threadId: { type: "string" } } } },
  { name: "tfo_preview", description: "Estimate the API-equivalent route cost and repeated context before starting; weekly Codex quota is reported separately.", inputSchema: {
    type: "object", additionalProperties: false, required: ["threadId", "objective", "steps", "initialSelection"],
    properties: { threadId: { type: "string" }, objective: { type: "string" }, constraints: { type: "string" }, initialSelection: selectionSchema,
      steps: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", additionalProperties: false, required: ["title", "prompt"], properties: {
        title: { type: "string" }, prompt: { type: "string" }, assessment: assessmentSchema, expectedOutputTokens: { type: "integer", minimum: 1, maximum: 100000 },
      } } },
    },
  } },
  { name: "tfo_budgeted_chat_start", description: "Save a budgeted route of visible prompts in this chat. A conventional local supervisor waits until the current turn finishes before dispatch; unsupported model changes stop before sending.", inputSchema: {
    type: "object", additionalProperties: false, required: ["objective", "projectPath", "threadId", "steps", "initialSelection"],
    properties: { objective: { type: "string", minLength: 3 }, projectPath: { type: "string" }, threadId: { type: "string" }, constraints: { type: "string" },
      initialSelection: selectionSchema,
      steps: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", additionalProperties: false, required: ["title", "prompt"], properties: {
        title: { type: "string" }, prompt: { type: "string" }, assessment: assessmentSchema, expectedOutputTokens: { type: "integer", minimum: 1, maximum: 100000 },
      } } },
    },
  } },
  { name: "tfo_chat_status", description: "Read chat route status, queued prompt, and completed checkpoints.", inputSchema: { type: "object", required: ["runId"], additionalProperties: false, properties: { runId: { type: "string" } } } },
  { name: "tfo_chat_complete", description: "Record this step and save the next prompt as pending. End your response so TFO can dispatch after the turn completes. A failure or uncertain delivery stops the chain.", inputSchema: { type: "object", required: ["runId", "stepId", "success", "summary"], additionalProperties: false, properties: { runId: { type: "string" }, stepId: { type: "string" }, success: { type: "boolean" }, summary: { type: "string" }, nextAssessment: assessmentSchema } } },
  { name: "tfo_chat_pause", description: "Pause a chat route. An already queued prompt may still arrive, but must not start a later step.", inputSchema: { type: "object", required: ["runId"], additionalProperties: false, properties: { runId: { type: "string" } } } },
  { name: "tfo_chat_resume", description: "Resume a paused chat route without duplicating an already queued prompt.", inputSchema: { type: "object", required: ["runId"], additionalProperties: false, properties: { runId: { type: "string" } } } },
  { name: "tfo_chat_cancel", description: "Cancel a chat route. No further step is queued; an already queued prompt cannot be recalled.", inputSchema: { type: "object", required: ["runId"], additionalProperties: false, properties: { runId: { type: "string" } } } },
  { name: "tfo_settings", description: "Read economy settings and supported model levels. Changes are made by the user in Options; upgrades are disabled by default.", inputSchema: { type: "object", additionalProperties: false, properties: {} } },
  { name: "tfo_options", description: "Open the local Options menu for savings and upgrade permissions. Returns a private local URL to show in a browser panel. Do not confirm the upgrade warning on the user's behalf.", inputSchema: { type: "object", additionalProperties: false, properties: {} } },
];

function toolResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}
async function callTool(name, args = {}) {
  switch (name) {
    case "tfo_native_prepare": return nativeFlow.prepare(args);
    case "tfo_native_claim": return nativeFlow.claim(args.runId, args.nodeId);
    case "tfo_native_acknowledge": return nativeFlow.acknowledge(args.runId, args.nodeId, args.threadId);
    case "tfo_native_observe": return nativeFlow.observe(args.runId);
    case "tfo_native_status": return nativeFlow.status(args.runId);
    case "tfo_native_fail": return nativeFlow.fail(args.runId, args.reason);
    case "tfo_connection_check":
    case "tfo_connection_panel": return connectionCheck(args.surface);
    case "tfo_health": return { ok: true, name: "TFO", version: VERSION, dataDir: DATA_DIR, workerCommand: codexCommand(), features: ["surface-connection-diagnostics", "mcp-apps-diagnostic-panel", "stored-prompt-queue", "acknowledged-supervisor", "immutable-runtime-snapshot", "automatic-turn-receipts", "pending-after-turn", "uncertain-send-reconciliation", "desktop-access-diagnostic", "host-model-catalog", "budget", "time-options", "persistent-project-dag", "project-plan-recovery", "native-chat-provisioning", "parallel-dependency-supervisor", "joined-main-handoffs", "verified-git-worktrees", "bundled-bootstrap"], limitation: "tfo_parallel_* coordinates local Codex chats provisioned with native app tools, preserves selection, and verifies receipts/worktrees. The old tfo_project_* planner remains storage-only. ChatGPT Project creation and automatic delivery still require a separate adapter. Worker reports do not replace integration tests; uncertain sends never retry." };
    case "tfo_ui_diagnostic": return diagnoseDesktopAccess();
    case "tfo_queue_start": return promptQueue.start(args);
    case "tfo_queue_status": return promptQueue.recover(args.runId);
    case "tfo_queue_reconcile": return promptQueue.reconcile(args.runId);
    case "tfo_project_prepare": return projectCoordinator.prepare(args);
    case "tfo_parallel_prepare": return projectFlow.prepare(args);
    case "tfo_parallel_bind": return projectFlow.bind(args);
    case "tfo_parallel_start": return projectFlow.start(args.runId);
    case "tfo_parallel_status": return projectFlow.status(args.runId);
    case "tfo_parallel_pause": return projectFlow.pause(args.runId);
    case "tfo_parallel_resume": return projectFlow.resume(args.runId);
    case "tfo_parallel_cancel": return projectFlow.cancel(args.runId);
    case "tfo_project_status": return projectCoordinator.status(args.runId);
    case "tfo_project_pause": return projectCoordinator.pause(args.runId);
    case "tfo_project_resume": return projectCoordinator.resume(args.runId);
    case "tfo_project_cancel": return projectCoordinator.cancel(args.runId);
    case "tfo_project_recover": return { recovered: projectCoordinator.recover() };
    case "tfo_queue_pause": return promptQueue.pause(args.runId);
    case "tfo_queue_cancel": return promptQueue.cancel(args.runId);
    case "tfo_queue_resume": return promptQueue.resume(args.runId);
    case "tfo_settings": return { ...settings.read(), defaultSolModel: DEFAULT_SOL_MODEL, models: MODEL_REGISTRY, efforts: VALID_EFFORTS };
    case "tfo_options": return launchOptions(DATA_DIR);
    case "tfo_start": return publicState(startRoute(args));
    case "tfo_get_status": {
      const state = loadState(args.runId);
      if (!state) throw new Error(`Unknown run: ${args.runId}`);
      return publicState(state);
    }
    case "tfo_pause": return publicState(setRunState(args.runId, "paused"));
    case "tfo_resume": {
      const state = loadState(args.runId);
      if (!state || state.status !== "paused") throw new Error(`Run ${args.runId} is not paused`);
      return publicState(setRunState(args.runId, "running"));
    }
    case "tfo_cancel": return publicState(setRunState(args.runId, "cancelled"));
    case "tfo_chat_start": return chatRouter.start(args);
    case "tfo_budgeted_chat_start": return chatRouter.start({ ...args, enforceBudget: true });
    case "tfo_catalog": {
      const app = await openAppServer();
      try { return { catalog: (await app.request("model/list", { limit: 100 })).data, observed: await readHostSelection(args.threadId) }; }
      finally { app.close(); }
    }
    case "tfo_preview": {
      const options = settings.read();
      const host = await readHostTurnState(args.threadId);
      return { estimate: estimateRouteBudget({ ...args, steps: args.steps.map((item, index) => ({ ...item, id: `step-${index + 1}` })),
        contextTokens: host.lastResponseUsage?.input_tokens || 0, maxCostMultiplier: options.maxCostMultiplier,
        maxEstimatedUsd: options.maxEstimatedUsd, maxWeeklyUsedPercent: options.maxWeeklyUsedPercent }),
        weeklyUsedPercentObserved: host.weeklyUsedPercent, time: { mode: options.timeMode, targetMinutes: options.targetMinutes, extraMinutes: options.extraMinutes } };
    }
    case "tfo_chat_status": return chatRouter.getStatus(args.runId);
    case "tfo_chat_complete": return chatRouter.complete(args);
    case "tfo_chat_pause": return chatRouter.pause(args.runId);
    case "tfo_chat_resume": return chatRouter.resume(args.runId);
    case "tfo_chat_cancel": return chatRouter.cancel(args.runId);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

const SUPPORTED_PROTOCOLS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
let negotiatedProtocol = "2025-06-18";
function response(id, result) { return { jsonrpc: "2.0", id, result }; }
function errorResponse(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }
async function handle(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return message?.id === undefined ? null : errorResponse(message.id, -32600, "Invalid JSON-RPC request");
  }
  const id = message.id;
  const params = message.params || {};
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled" || id === undefined) return null;
  try {
    switch (message.method) {
      case "initialize": {
        const requested = params.protocolVersion;
        negotiatedProtocol = SUPPORTED_PROTOCOLS.has(requested) ? requested : "2025-06-18";
        return response(id, { protocolVersion: negotiatedProtocol, capabilities: { tools: { listChanged: false }, resources: { listChanged: false } }, serverInfo: { name: "tfo", version: VERSION }, instructions: "TFO stores authorized prompt queues. First check tfo_connection_check for the actual product. Normal Chat support is diagnostic only; never reinterpret a ChatGPT conversation as a Codex thread or claim automatic delivery. Inspect project scope and approval before tfo_start." });
      }
      case "ping": return response(id, {});
      case "tools/list": return response(id, { tools });
      case "resources/list": return response(id, { resources: [{ uri: connectionResource, name: "TFO connection", mimeType: "text/html;profile=mcp-app" }] });
      case "resources/read": {
        if (params.uri !== connectionResource) return errorResponse(id, -32602, "Unknown resource");
        return response(id, { contents: [{ uri: connectionResource, mimeType: "text/html;profile=mcp-app",
          text: fs.readFileSync(path.join(ROOT, "ui", "connection.html"), "utf8"), _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } } }] });
      }
      case "tools/call": {
        try { return response(id, toolResult(await callTool(params.name, params.arguments))); }
        catch (error) { return response(id, { content: [{ type: "text", text: String(error?.message || error) }], isError: true }); }
      }
      default: return errorResponse(id, -32601, `Method not found: ${message.method}`);
    }
  } catch (error) { return errorResponse(id, -32603, String(error?.message || error)); }
}

recoverInterruptedRuns();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
input.on("line", async line => {
  let request;
  try { request = JSON.parse(line); }
  catch { process.stderr.write("TFO ignored invalid JSON input\n"); return; }
  const result = await handle(request);
  if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
});
input.on("close", () => {
  for (const child of activeProcesses.values()) child.kill();
  process.exit(0);
});
