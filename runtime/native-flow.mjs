// Supervised Codex-tool driver. This module schedules and verifies; the calling
// host executes the returned native tool call. It has no independent writer.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { validateFlow, nodePrompt, resolveMaxParallelWorkers, validateParallelWorkers } from "./project-flow.mjs";
import { validateSelection, assertQueueSelection } from "./model-policy.mjs";
import { canonicalPath, containsPath, inspectWorkspace, verifyWorkspace } from "./project-workspace.mjs";
import { lockedFile, reserveChatSlot, isAlive } from "./prompt-queue.mjs";
import { createProjectReservationStore } from "./project-reservations.mjs";
import { normalizeUsage, equivalentUsd } from "./budget.mjs";
import { replaceAtomicFile } from "./atomic-file.mjs";
import { createWorkPolicyStore } from "./work-policy.mjs";
import { assertWorkBudget } from "./work-budget.mjs";
import { addIndependentReview, assertReviewComplete, reviewRequired, validateReviewTasks } from "./review-policy.mjs";

const active = node => ["dispatching", "queued", "provisioning_dispatching", "provisioning"].includes(node.status);
const same = (a, b) => a?.model === b?.model && a?.reasoning === b?.reasoning;
const activeMain = state => state.coordinationMode === "active_main";
const terminal = state => ["completed", "cancelled"].includes(state.status);
const uncertain = node => ["dispatching", "provisioning_dispatching"].includes(node.status);
const eventPageSize = 20;
export function createNativeFlow({ dataDir, host, now = Date.now }) {
  const policies = createWorkPolicyStore(dataDir);
  const root = path.join(dataDir, "native-flows"), runs = path.join(dataDir, "runs");
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(runs, { recursive: true });
  const reservations = createProjectReservationStore({ dataDir });
  const watcherToken = crypto.randomUUID();
  const file = id => {
    if (!/^flow_[a-z0-9_]+$/.test(id)) throw new Error("Invalid flow ID");
    return path.join(root, `${id}.json`);
  };
  const readRaw = id => {
    const state = JSON.parse(fs.readFileSync(file(id), "utf8"));
    // These are the historical defaults, independent of today's user settings.
    state.coordinationMode ??= "deferred_join";
    state.maxParallelWorkers ??= 2;
    state.revision ??= 0; state.events ??= []; state.eventSequence ??= 0;
    return state;
  };
  const read = id => {
    const state = readRaw(id);
    if (!state.pendingRevision) return state;
    const lockPath = `${file(id)}.lock`;
    if (fs.existsSync(lockPath)) {
      try { if (isAlive(Number(fs.readFileSync(lockPath, "utf8")))) return state; } catch { return state; }
    }
    try { return lockedFile(lockPath, () => restorePendingRevision(readRaw(id))); }
    catch (error) { state.error = `Revision commit is paused: ${error.message}`; state.pendingRevision.error = String(error.message); return state; }
  };
  const save = state => {
    const target = file(state.id), temp = `${target}.${crypto.randomUUID()}.tmp`;
    state.updatedAt = new Date(now()).toISOString();
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), { flag: "wx" });
    replaceAtomicFile(temp, target);
    return state;
  };
  const mutate = (id, change) => {
    read(id); // Finish a persisted no-send revision intent before allowing any new mutation.
    return lockedFile(`${file(id)}.lock`, () => { const s = readRaw(id); if (s.pendingRevision) throw new Error("A paused revision commit must be repaired before any new mutation"); change(s); return save(s); });
  };
  const event = (state, type, nodeId = null, detail = null) => {
    state.eventSequence = (state.eventSequence || 0) + 1;
    state.events ||= [];
    state.events.push({ cursor: state.eventSequence, type, nodeId, at: new Date(now()).toISOString(), ...(detail ? { detail } : {}) });
    if (state.events.length > 1000) state.events.splice(0, state.events.length - 1000);
  };
  const dependenciesReady = (state, node) => node.dependencies.every(dep => {
    const previous = state.nodes.find(item => item.id === dep);
    return previous?.checkpoint && (previous.status === "completed" || previous.resolution?.status === "resolved" ||
      (previous.status === "blocked" && previous.resolution?.withNodeId === node.id));
  });
  const resolveOutcomes = state => {
    let changed;
    do {
      changed = false;
      for (const blocked of state.nodes.filter(node => node.status === "blocked" && node.resolution?.status === "pending")) {
        const remedy = state.nodes.find(node => node.id === blocked.resolution.withNodeId);
        if (remedy?.checkpoint && (remedy.status === "completed" || remedy.resolution?.status === "resolved")) {
          blocked.resolution.status = "resolved"; blocked.resolution.completedTurnId = remedy.checkpoint.turnId;
          event(state, "blocked_resolved", blocked.id); changed = true;
        }
      }
    } while (changed);
  };
  const reserve = state => {
    const plan = { nodes: [...state.lanes.filter(lane => lane.workspace).map(lane => ({ ...lane, threadId: `pending-${state.id}-${lane.id}`, gitCommonDir: lane.isolation?.gitCommonDir })),
      ...state.lanes.filter(lane => lane.threadId && lane.workspace).map(lane => ({ ...lane, gitCommonDir: lane.isolation?.gitCommonDir }))] };
    return (reservations.get(state.id) ? reservations.extend : reservations.reserve)(state.id, plan);
  };
  const verify = (plan, workspace, others, access, cache) => {
    if (plan.workspaceMode !== "scratch_folders") {
      if (!cache) return verifyWorkspace(plan.projectPath, workspace, others, access);
      const inspect = value => { const key = canonicalPath(value); if (!cache.has(key)) cache.set(key, inspectWorkspace(key)); return cache.get(key); };
      const project = inspect(plan.projectPath), info = inspect(workspace);
      if (!containsPath(project.workspace, info.workspace) && (!project.gitCommonDir || project.gitCommonDir !== info.gitCommonDir)) throw new Error("Workspace is outside the authorized project/repository");
      if (access === "write" && (!info.registered || info.workspace !== info.top || !info.branch || info.gitCommonDir !== project.gitCommonDir)) throw new Error("Writing requires the root of a registered Git worktree on a named branch of this repository");
      for (const otherLane of others.filter(lane => lane.workspace)) {
        if (access !== "write" && otherLane.access !== "write") continue;
        const other = inspect(otherLane.workspace);
        if (other.top === info.top || (other.gitCommonDir === info.gitCommonDir && other.branch === info.branch)) throw new Error("Parallel chats require different verified Git worktrees and branches");
      }
      return info;
    }
    const inspect = value => { if (!cache) return inspectWorkspace(value); const key = canonicalPath(value); if (!cache.has(key)) cache.set(key, inspectWorkspace(key)); return cache.get(key); };
    const rootInfo = inspect(plan.projectPath), info = inspect(workspace);
    for (let parent = info.workspace; ; parent = path.dirname(parent)) {
      if (fs.existsSync(path.join(parent, ".git"))) throw new Error("Scratch directories cannot belong to Git, even when Git inspection fails");
      if (parent === path.dirname(parent)) break;
    }
    if (rootInfo.gitCommonDir || info.gitCommonDir || info.workspace === rootInfo.workspace || !containsPath(rootInfo.workspace, info.workspace))
      throw new Error("Scratch mode requires distinct child directories outside Git");
    for (const lane of others) if (containsPath(lane.workspace, info.workspace) || containsPath(info.workspace, lane.workspace))
      throw new Error("Scratch workspaces must not overlap");
    return info;
  };
  async function prepare(args) {
    const workPolicy = args.workPolicy ? policies.get(args.workPolicy.id) : null;
    if (workPolicy) {
      policies.assertDispatch(workPolicy); policies.assertMain(workPolicy, args.initialSelection);
      args = addIndependentReview(args, workPolicy);
    }
    const coordinationMode = args.coordinationMode || "active_main";
    if (!["active_main", "deferred_join"].includes(coordinationMode)) throw new Error("Unknown coordination mode");
    if (coordinationMode === "deferred_join" && args.currentNodeId !== undefined) throw new Error("Native flows require separate task turns");
    const plan = validateFlow({ ...args, coordinationMode }), main = await host.read(plan.mainThreadId);
    if (!same(main, plan.initialSelection) || !main.lastTurnId) throw new Error("Main selection must match the actual host");
    const maxParallelWorkers = resolveMaxParallelWorkers(args.maxParallelWorkers, dataDir);
    const authorizedSelections = (args.authorizedSelections || []).map(validateSelection);
    const workspaceMode = args.workspaceMode || "git_worktrees";
    if (coordinationMode === "deferred_join" && workspaceMode !== "scratch_folders") throw new Error("The deferred native driver supports scratch_folders only");
    const state = { ...plan, id: `flow_${now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`, kind: "native_tool_flow",
      status: "running", driver: "supervised_native_tools", unattended: false, coordinationMode, workspaceMode, maxParallelWorkers,
      revision: 0, events: [], eventSequence: 0, authorizedSelections, createdAt: new Date(now()).toISOString(), error: null,
      ...(workPolicy ? { workPolicy: { id: workPolicy.id, revision: workPolicy.revision,
        configuration: workPolicy.configuration, reviewRequired: workPolicy.configuration.mode === "intelligent" && ["hq", "max_hq"].includes(workPolicy.configuration.smartPreset) } } : {}) };
    state.mainJoinMarker = `TFO_MAIN_JOIN ${state.id} ${state.mainThreadId}`;
    state.lanes = [{ id: "main", title: "Principal", access: args.mainAccess === "read" ? "read" : "write", threadId: plan.mainThreadId,
      workspace: canonicalPath(args.mainWorkspace || args.projectPath), hostWorkspace: main.workspace,
      selection: plan.initialSelection, baselineTurnId: main.lastTurnId }, ...plan.lanes.map(lane => ({ ...lane,
      workspace: args.lanes.find(item => item.id === lane.id).workspace ? canonicalPath(args.lanes.find(item => item.id === lane.id).workspace) : null }))];
    const isolationCache = new Map();
    for (const lane of state.lanes.filter(lane => lane.workspace)) lane.isolation = verify(state, lane.workspace, state.lanes.filter(other => other !== lane && other.workspace), lane.access, isolationCache);
    state.nodes = plan.nodes.map(node => {
      const input = args.nodes.find(item => item.id === node.id);
      const decision = workPolicy ? policies.decision(workPolicy, input) : null;
      const selection = decision?.selected || validateSelection(input.selection);
      if (!workPolicy) assertQueueSelection(selection, plan.initialSelection, authorizedSelections);
      const selectionReason = input.selectionReason;
      if (selectionReason !== undefined && (typeof selectionReason !== "string" || selectionReason.trim().length > 1000)) throw new Error("Invalid selection reason");
      return { ...node, selection, selectionReason: selectionReason?.trim() || decision?.reason || null,
        ...(decision ? { decision, normalSelection: decision.normalSelection, policyRevision: workPolicy.revision, taskKind: input.taskKind || "work" } : {}) };
    });
    if (workPolicy) validateReviewTasks(state.nodes, state.lanes);
    if (workPolicy) state.workBudget = assertWorkBudget(workPolicy, state, main);
    if (activeMain(state)) {
      if (!main.active) throw new Error("Active coordination must start in an active main turn");
      if (state.nodes.some(node => node.lane === "main" && !same(node.selection, plan.initialSelection))) throw new Error("Inline main tasks must use the actual current turn selection; model changes require a new turn");
      state.coordinator = { threadId: main.threadId || plan.mainThreadId, turnId: main.lastTurnId,
        userMessageCount: main.userMessageCount ?? null, selection: plan.initialSelection,
        selectionReason: String(args.coordinatorSelectionReason || "Mantener la selección autorizada del principal para coordinar, revisar e integrar el trabajo"),
        phase: "active", claimedAt: now(), supervisor: null, recovery: { attempts: [], limit: 3 } };
    }
    for (const pair of authorizedSelections) if (!state.nodes.some(node => same(node.selection, pair))) throw new Error("Unused selection authorization");
    event(state, "prepared");
    return reserveChatSlot(runs, state.mainThreadId, () => { reserve(state); if (workPolicy) policies.bind(workPolicy.id, state.id); return save(state); }, state.id);
  }
  function fail(id, reason) {
    reservations.markUncertain(id, reason);
    return mutate(id, state => { state.status = "needs_review"; state.error = String(reason); event(state, "needs_review", null, String(reason).slice(0, 300)); });
  }
  async function observationLock(id) {
    const target = `${file(id)}.observe.lock`, token = crypto.randomUUID(), deadline = Date.now() + 60000;
    while (true) {
      try {
        const fd = fs.openSync(target, "wx");
        try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(fd); }
        return () => { try { const owner = JSON.parse(fs.readFileSync(target, "utf8")); if (owner.pid === process.pid && owner.token === token) fs.unlinkSync(target); } catch { /* Never steal a damaged live lock. */ } };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const owner = JSON.parse(fs.readFileSync(target, "utf8"));
          if (owner.pid && !isAlive(owner.pid)) {
            const latest = JSON.parse(fs.readFileSync(target, "utf8"));
            if (latest.pid === owner.pid && latest.token === owner.token) fs.unlinkSync(target);
          }
        } catch { /* Another observer may be between creation and writing its owner. */ }
        if (Date.now() >= deadline) { const busy = new Error("Host unavailable temporarily: flow observation is busy"); busy.code = "HOST_UNAVAILABLE"; throw busy; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  }
  async function observe(id) {
    const unlock = await observationLock(id);
    try { return await observeUnlocked(id); } finally { unlock(); }
  }
  async function observeUnlocked(id) {
    const before = read(id);
    if (before.status !== "running" && !(activeMain(before) && ["paused", "cancelling"].includes(before.status))) return before;
    try {
      for (const node of before.nodes.filter(active)) {
        const lane = before.lanes.find(lane => lane.id === node.lane);
        const provisioning = ["provisioning_dispatching", "provisioning"].includes(node.status);
        const attempt = provisioning ? node.provision : node;
        if (!lane.threadId) {
          if (now() - attempt.attemptedAt > 120000) throw new Error(`Missing creation acknowledgement for ${node.id}; do not recreate`);
          continue;
        }
        if (activeMain(before)) {
          const lifecycle = await host.read(lane.threadId);
          if (lifecycle.active) {
            if (now() - attempt.attemptedAt > before.maxTurnMinutes * 60000) throw new Error(`Receipt timed out for ${node.id}`);
            continue; // Incremental lifecycle metadata is sufficient while this turn still runs.
          }
        }
        let receipt;
        if (["native_queue", "selected_join"].includes(node.deliveryKind)) {
          const expectedPrompt = node.deliveryKind === "selected_join" ? node.visiblePrompt.replace(/[\r\n]+/g, "  ") : node.visiblePrompt;
          const matches = await host.find(lane.threadId, expectedPrompt);
          if (matches.length > 1) throw new Error(`Duplicate queued delivery for ${node.id}`);
          if (node.deliveryKind === "selected_join" && matches.length && node.delivery?.turnId &&
              matches[0].turnId !== node.delivery.turnId) throw new Error("Selected join receipt belongs to another turn");
          receipt = matches.length ? await host.receipt(lane.threadId, matches[0].turnId, expectedPrompt) : null;
          if (!matches.length && now() - node.attemptedAt > 120000) throw new Error(`Queued delivery receipt missing for ${node.id}; never resend`);
        } else receipt = await host.bootstrap(lane.threadId, attempt.visiblePrompt, before.mainThreadId);
        if (!receipt?.completed) {
          if (receipt?.interrupted) throw new Error(`Interrupted ${node.id}`);
          if (now() - attempt.attemptedAt > before.maxTurnMinutes * 60000) throw new Error(`Receipt timed out for ${node.id}`);
          continue;
        }
        mutate(id, state => { const target = state.nodes.find(item => item.id === node.id); if (active(target)) (provisioning ? target.provision : target).resultObserved = receipt; });
        const verified = ["native_queue", "selected_join"].includes(node.deliveryKind) ? receipt.promptMatched && receipt.userMessageCount === 1 : receipt.bootstrapVerified;
        if (!verified || receipt.interrupted || !same(receipt, node.selection)) throw new Error(`Unverified prompt or model/effort for ${node.id}`);
        const latest = await host.read(lane.threadId);
        if (latest.lastTurnId !== receipt.turnId || latest.active) throw new Error(`Another turn intervened in ${lane.id}`);
        if (provisioning) {
          if (receipt.finalResponse?.trim() !== `TFO_WORKTREE_READY ${before.id} ${node.id}`) throw new Error("Worktree bootstrap did not acknowledge its read-only boundary");
          verify(before, lane.workspace, before.lanes.filter(other => other.id !== lane.id && other.workspace), lane.access);
          mutate(id, state => { const target = state.nodes.find(item => item.id === node.id); if (!active(target)) return;
            target.provision.status = "completed"; target.provision.checkpoint = { ...receipt, verification: "native_worktree_bootstrap_receipt" };
            target.status = state.status === "cancelling" ? "cancelled" : "pending";
            Object.assign(state.lanes.find(item => item.id === lane.id), { baselineTurnId: receipt.turnId, selection: node.selection });
            event(state, "worktree_verified", node.id); });
          continue;
        }
        let report;
        if (node.lane !== "main") {
          report = JSON.parse(receipt.finalResponse.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
          if ((!activeMain(before) && report.status !== "completed") || !["completed", "blocked"].includes(report.status) || typeof report.summary !== "string" || !report.summary.trim()) throw new Error(`Blocked or malformed worker result for ${node.id}`);
          if (node.taskKind === "review" && !Array.isArray(report.findings)) throw new Error("Independent review must report an explicit findings array");
        }
        if (!receipt.finalResponse) throw new Error(`No final response for ${node.id}`);
        const workspace = inspectWorkspace(lane.workspace);
        if (workspace.workspace !== lane.workspace || workspace.branch !== lane.isolation.branch || workspace.gitCommonDir !== lane.isolation.gitCommonDir) throw new Error("Workspace identity changed");
        const usage = normalizeUsage(receipt.usage);
        mutate(id, state => {
          const target = state.nodes.find(item => item.id === node.id);
          if (!active(target)) return;
          target.status = report?.status === "blocked" ? "blocked" : "completed";
          target.checkpoint = { turnId: receipt.turnId, response: receipt.finalResponse, report: report || null,
            requested: node.selection, selectionReason: node.selectionReason, decision: node.decision || null, observed: { model: receipt.model, reasoning: receipt.reasoning },
            startedAt: receipt.startedAt, completedAt: receipt.completedAt, usage,
            apiEquivalentUsd: usage ? equivalentUsd(node.selection, usage) : null,
            verification: node.deliveryKind === "native_queue" ? "native_queue_host_receipt" :
              node.deliveryKind === "selected_join" ? "selected_join_host_receipt" : "native_host_receipt", head: workspace.head };
          Object.assign(state.lanes.find(item => item.id === lane.id), { baselineTurnId: receipt.turnId, selection: node.selection });
          if (target.status === "completed") resolveOutcomes(state);
          event(state, target.status, node.id);
        });
      }
      const state = read(id);
      if (activeMain(state)) return await observeInline(id, state);
      if (state.nodes.every(node => node.checkpoint)) {
        reservations.release(id, "completed_receipt_verified"); return mutate(id, state => {
          state.status = "completed";
          if (state.deferredJoin?.status === "queued") state.deferredJoin.status = "completed";
        });
      }
      return state;
    } catch (error) {
      if (activeMain(before) && /prompt queue is busy|resource ledger is locked/i.test(error.message)) return { ...read(id), observerError: String(error.message) };
      if (activeMain(before) && (['ENOENT', 'EACCES', 'HOST_UNAVAILABLE'].includes(error.code) || /temporar|host unavailable|cannot verify this thread in local codex history/i.test(error.message)))
        return mutate(id, state => { state.observerError = String(error.message); });
      return fail(id, error.message);
    }
  }
  async function claim(id, nodeId) {
    const before = await observe(id), node = before.nodes.find(node => node.id === nodeId);
    const work = policies.assertDispatch(before.workPolicy);
    if (work) policies.assertMain(work, before.coordinator?.selection || before.initialSelection);
    if (work) assertWorkBudget(work, before, await host.read(before.mainThreadId));
    if (work && node?.policyRevision !== work.revision) throw new Error("Work mode changed; revise unattempted tasks before dispatch");
    if (before.status !== "running" || !node || node.status !== "pending") throw new Error("Node is not available; never retry an attempted dispatch");
    if (activeMain(before)) {
      await assertCoordinator(before);
      if (node.lane === "main") throw new Error("Execute main tasks inline and record a checkpoint; never send a self-message");
      if (before.capacityBackpressure && now() < before.capacityBackpressure.retryAt) throw new Error("Host capacity backpressure is cooling down; wait for the persisted retry time");
    }
    if (node.lane === "main" && before.deferredJoin) throw new Error("The persistent join owns the main dispatch");
    const lane = before.lanes.find(lane => lane.id === node.lane);
    if (lane.threadId) {
      const current = await host.read(lane.threadId);
      if (current.active && lane.id === "main") throw new Error("Cannot switch the active main turn with a self-message; defer integration until a supported idle-host handoff exists");
      if (current.active || current.lastTurnId !== lane.baselineTurnId || !same(current, lane.selection)) throw new Error("Chat preflight changed");
    }
    let action;
    mutate(id, state => {
      const target = state.nodes.find(node => node.id === nodeId);
      policies.assertDispatch(state.workPolicy);
      if (activeMain(state) && (state.coordinator.turnId !== before.coordinator.turnId || state.revision !== before.revision || state.inlineFinish)) throw new Error("Coordinator or plan changed before claiming; read status again");
      const actualLane = state.lanes.find(item => item.id === target?.lane);
      if (actualLane?.baselineTurnId !== lane.baselineTurnId || actualLane?.threadId !== lane.threadId) throw new Error("Worker lane changed before claim");
      if (state.status !== "running" || target.status !== "pending" || !dependenciesReady(state, target)) throw new Error("Dependencies are incomplete");
      if (state.nodes.some(other => other.lane === target.lane && active(other))) throw new Error("Chat already active");
      const effectiveCap = Math.min(state.maxParallelWorkers, state.capacityBackpressure?.effectiveMaxParallelWorkers ?? state.maxParallelWorkers);
      if (target.lane !== "main" && state.nodes.filter(other => other.lane !== "main" && active(other)).length >= effectiveCap) throw new Error("Parallel worker limit reached");
      if (activeMain(state) && state.capacityBackpressure && now() < state.capacityBackpressure.retryAt) throw new Error("Host capacity backpressure is cooling down");
      const provisioning = activeMain(state) && state.workspaceMode === "git_worktrees" && !lane.threadId;
      const prompt = provisioning ? [`TFO_WORKTREE_BOOTSTRAP ${state.id} ${target.id}`, "Esta llamada prepara únicamente el aislamiento del chat.",
        "No edites archivos, cambies de rama ni ejecutes trabajo de la tarea. Espera a que el principal verifique y confirme el worktree real con una nueva instrucción.",
        `Responde exactamente: TFO_WORKTREE_READY ${state.id} ${target.id}`].join("\n\n") : nodePrompt(state, target);
      if (prompt.length > 100000) throw new Error("Dependency results exceed prompt limit");
      action = lane.threadId
        ? { tool: "send_message_to_thread", args: { threadId: lane.threadId, prompt, model: target.selection.model, thinking: target.selection.reasoning } }
        : { tool: "create_thread", args: { title: lane.title, prompt, model: target.selection.model, thinking: target.selection.reasoning,
          target: { type: "project", projectId: state.projectId, environment: { type: provisioning ? "worktree" : "local" } } } };
      if (provisioning) { target.provision = { status: "dispatching", attemptId: crypto.randomUUID(), attemptedAt: now(), visiblePrompt: prompt, action }; target.status = "provisioning_dispatching"; }
      else { target.attemptId = crypto.randomUUID(); target.visiblePrompt = prompt; target.status = "dispatching"; target.attemptedAt = now(); target.action = action; }
      event(state, provisioning ? "worktree_claimed" : "claimed", nodeId);
    });
    return action;
  }
  async function acknowledge(id, nodeId, threadId, workspace) {
    const before = read(id), node = before.nodes.find(node => node.id === nodeId), lane = before.lanes.find(lane => lane.id === node?.lane);
    if (!node || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) throw new Error("Invalid dispatch acknowledgement");
    const alreadyAccepted = node.status === "queued" || (["completed", "blocked"].includes(node.status) && node.checkpoint?.verification === "native_host_receipt");
    if (!["dispatching", "provisioning_dispatching"].includes(node.status) && !alreadyAccepted) throw new Error("Invalid dispatch acknowledgement");
    if (lane.threadId && lane.threadId !== threadId) throw new Error("Wrong target thread");
    const actual = await host.read(threadId);
    if (workspace && canonicalPath(workspace) !== actual.workspace) throw new Error("Returned workspace does not match the native host cwd");
    let isolation;
    if (before.workspaceMode === "git_worktrees") {
      if (!workspace || canonicalPath(workspace) !== actual.workspace) throw new Error("A real returned workspace matching the native host cwd is required");
      if (lane.workspace && lane.workspace !== actual.workspace) throw new Error("Host worktree differs from the planned workspace");
      isolation = verify(before, actual.workspace, before.lanes.filter(other => other.id !== lane.id && other.workspace), lane.access);
    } else if (!containsPath(actual.workspace, lane.workspace)) throw new Error("Host cwd does not contain the assigned scratch directory");
    if (alreadyAccepted) {
      if (actual.workspace !== lane.hostWorkspace) throw new Error("Already accepted host workspace changed");
      if (lane.threadId !== threadId || node.action?.args?.threadId !== threadId && node.action?.tool !== "create_thread") throw new Error("Wrong already accepted target thread");
      return before; // A fast verified worker may complete before its tool acknowledgement returns.
    }
    return reserveChatSlot(runs, threadId, () => mutate(id, state => {
      const target = state.nodes.find(node => node.id === nodeId);
      if (target.status === "queued" || (["completed", "blocked"].includes(target.status) && target.checkpoint?.verification === "native_host_receipt")) {
        if (state.lanes.find(item => item.id === lane.id).threadId !== threadId) throw new Error("Wrong already accepted target thread");
        return;
      }
      if (!["dispatching", "provisioning_dispatching"].includes(target.status)) throw new Error("Dispatch already acknowledged");
      Object.assign(state.lanes.find(item => item.id === lane.id), { threadId, hostWorkspace: actual.workspace, ...(isolation ? { workspace: actual.workspace, isolation } : {}) });
      reserve(state); target.status = target.status === "provisioning_dispatching" ? "provisioning" : "queued";
      event(state, "acknowledged", nodeId);
    }), id);
  }
  async function armJoin(id) {
    const before = await observe(id), mainLane = before.lanes.find(lane => lane.id === "main");
    policies.assertDispatch(before.workPolicy);
    if (activeMain(before)) throw new Error("Active main flows integrate inline; deferred join is a separate coordination mode");
    const mainNodes = before.nodes.filter(node => node.lane === "main");
    if (before.status !== "running" || before.deferredJoin || mainNodes.length !== 1 || mainNodes[0].status !== "pending") throw new Error("One pending final main node is required; never rearm");
    if (before.nodes.some(node => node.lane !== "main" && !["queued", "completed"].includes(node.status))) throw new Error("Dispatch all worker tasks before arming the final join");
    const source = await host.read(mainLane.threadId);
    if (source.lastTurnId !== mainLane.baselineTurnId || !same(source, mainLane.selection) || source.workspace !== mainLane.hostWorkspace) throw new Error("Main source turn changed before arming");
    const selected = !same(mainNodes[0].selection, mainLane.selection);
    if (selected) {
      if (!mainNodes[0].selectionReason) throw new Error("A changed main selection requires the AI's selection reason");
      if (typeof host.selectedJoin?.preflight !== "function" || typeof host.selectedJoin?.send !== "function")
        throw new Error("Selected main join transport is unavailable; the native queue cannot change model/effort. No join was armed or sent.");
      const access = await host.selectedJoin.preflight({ threadId: mainLane.threadId, sourceTurnId: mainLane.baselineTurnId,
        sourceSelection: mainLane.selection, requestedSelection: mainNodes[0].selection,
        marker: before.mainJoinMarker });
      if (access?.selectionSupported !== true || access?.guardedTarget !== true)
        throw new Error("Selected main join transport did not prove selection and target guards; no join was armed or sent");
    }
    return mutate(id, state => {
      if (state.deferredJoin || state.status !== "running") throw new Error("Join already armed or flow changed");
      state.deferredJoin = { status: "armed", sourceTurnId: source.lastTurnId, sourceUserMessageCount: source.userMessageCount,
        sourceSelection: mainLane.selection, requestedSelection: mainNodes[0].selection,
        selectionReason: mainNodes[0].selectionReason, marker: before.mainJoinMarker,
        transport: selected ? "selected_join" : "native_queue",
        nodeId: mainNodes[0].id, armedAt: now(), ownerPid: null, waitReason: "worker_results_and_main_completion" };
    });
  }
  function claimJoin(id) {
    return mutate(id, state => {
      if (state.status !== "running" || state.deferredJoin?.status !== "armed" || state.deferredJoin.ownerPid) throw new Error("Join already has an owner or is not armed");
      Object.assign(state.deferredJoin, { status: "watching", ownerPid: process.pid });
    });
  }
  async function tickJoin(id) {
    let state = read(id);
    if (state.status !== "running") return state;
    if (state.deferredJoin?.ownerPid !== process.pid) throw new Error("Only the acknowledged join supervisor may dispatch");
    try {
      state = await observe(id);
      if (state.status !== "running") return state;
      const join = state.deferredJoin, node = state.nodes.find(node => node.id === join.nodeId);
      if (node.status !== "pending") return state; // Persisted intent is never retried.
      if (now() - join.armedAt > state.maxTurnMinutes * 60000) throw new Error("Deferred join exceeded its wait limit");
      const lane = state.lanes.find(lane => lane.id === "main"), current = await host.read(lane.threadId);
      if (current.lastTurnId !== join.sourceTurnId || current.interruptedTurnId === join.sourceTurnId || current.userMessageCount !== join.sourceUserMessageCount) throw new Error("Main was interrupted or received another user prompt; inspect before continuing");
      if (!same(current, lane.selection) || current.workspace !== lane.hostWorkspace) throw new Error("Main selection or workspace changed");
      if (!node.dependencies.every(dep => state.nodes.find(n => n.id === dep).checkpoint) || current.active) return state;
      if (current.completedTurnId !== join.sourceTurnId) throw new Error("Main source completion is not verified");
      for (const item of state.lanes) {
        const latest = await host.read(item.threadId);
        if (latest.active || latest.lastTurnId !== item.baselineTurnId || !same(latest, item.selection) || latest.workspace !== item.hostWorkspace) throw new Error(`Chat changed before join: ${item.id}`);
        verify(state, item.workspace, state.lanes.filter(other => other.id !== item.id), item.access);
      }
      const prompt = nodePrompt(state, node);
      if (prompt.length > 100000) throw new Error("Join reports exceed the prompt limit");
      mutate(id, s => {
        const target = s.nodes.find(n => n.id === node.id);
        const work = policies.assertDispatch(s.workPolicy);
        assertWorkBudget(work, s, current);
        if (work && node.policyRevision !== work.revision) throw new Error("Work mode changed; review the pending join before dispatch");
        if (s.status !== "running" || target.status !== "pending") throw new Error("Join dispatch changed");
        Object.assign(target, { visiblePrompt: prompt, status: "dispatching", deliveryKind: join.transport, attemptedAt: now() });
        s.deferredJoin.status = "dispatching";
      });
      const delivery = join.transport === "selected_join"
        ? await host.selectedJoin.send({ threadId: lane.threadId, prompt, sourceTurnId: join.sourceTurnId,
          sourceUserMessageCount: join.sourceUserMessageCount, sourceSelection: join.sourceSelection,
          requestedSelection: join.requestedSelection, selectionReason: join.selectionReason,
          marker: join.marker, ownerPid: join.ownerPid, runId: id, dataDir })
        : await host.send(lane.threadId, prompt);
      if (join.transport === "selected_join" && (delivery?.sendAttempted !== true || delivery?.selectionConfirmed !== true))
        throw new Error("Selected join delivery did not confirm the requested picker and send attempt; inspect the chat without retrying");
      return mutate(id, s => {
        Object.assign(s.nodes.find(n => n.id === node.id), { status: "queued", delivery });
        s.deferredJoin.status = "queued";
      });
    } catch (error) { return fail(id, error.message); }
  }
  async function assertCoordinator(state, requestedTurnId) {
    if (!activeMain(state) || !state.coordinator) throw new Error("An active main coordinator is required");
    const owner = state.coordinator, current = await host.read(state.mainThreadId);
    if (requestedTurnId && requestedTurnId !== owner.turnId) throw new Error("Stale coordinator owner turn");
    if (!current.active || current.lastTurnId !== owner.turnId || !same(current, owner.selection) ||
        current.workspace !== state.lanes.find(lane => lane.id === "main").hostWorkspace ||
        (owner.userMessageCount !== null && current.userMessageCount !== owner.userMessageCount)) throw new Error("The active coordinator owner changed; review or recover before mutation");
    return current;
  }
  function nodeSummary(state, node) {
    return { id: node.id, lane: node.lane, title: node.title, status: node.status, selection: node.selection,
      resultRef: node.checkpoint ? { runId: state.id, nodeId: node.id } : null,
      ...(node.checkpoint?.report?.summary ? { summary: node.checkpoint.report.summary.slice(0, 300) } : {}) };
  }
  function compact(id) {
    const state = typeof id === "string" ? status(id) : id;
    const runningWorkers = state.nodes.filter(node => node.lane !== "main" && active(node)).length;
    const effectiveCap = Math.min(state.maxParallelWorkers, state.capacityBackpressure?.effectiveMaxParallelWorkers ?? state.maxParallelWorkers);
    return { runId: state.id, status: state.status, coordinationMode: state.coordinationMode || "deferred_join",
      revision: state.revision || 0, cursor: state.eventSequence || 0, error: state.error,
      observerError: state.observerError || null, maxParallelWorkers: state.maxParallelWorkers,
      workPolicy: state.workPolicy || null,
      reviewNodeIds: state.nodes.filter(node => node.taskKind === "review").map(node => node.id),
      capacityBackpressure: state.capacityBackpressure || null,
      pendingRevision: state.pendingRevision ? { id: state.pendingRevision.id, fromRevision: state.pendingRevision.fromRevision,
        toRevision: state.pendingRevision.toRevision, preparedAt: state.pendingRevision.preparedAt, error: state.pendingRevision.error || null } : null,
      mainThreadId: state.mainThreadId, mainJoinMarker: state.mainJoinMarker,
      mainCompleteMarker: state.inlineFinish?.marker || null,
      coordinator: state.coordinator ? { threadId: state.coordinator.threadId, turnId: state.coordinator.turnId,
        phase: state.coordinator.phase, observerPid: state.coordinator.observerPid || null,
        recoveryAttempts: state.coordinator.recovery.attempts.length,
        recoveryAccess: state.coordinator.recoveryAccess || null,
        nextRecoveryAt: state.coordinator.recovery.attempts.at(-1)?.status === "scheduled" ? state.coordinator.recovery.attempts.at(-1).dueAt : null } : null,
      counts: state.nodes.reduce((counts, node) => { counts[node.status] = (counts[node.status] || 0) + 1; return counts; }, {}),
      readyNodeIds: state.status === "running" ? state.nodes.filter(node => node.status === "pending" && dependenciesReady(state, node) &&
        (node.lane === "main" || ((!state.capacityBackpressure || now() >= state.capacityBackpressure.retryAt) && runningWorkers < effectiveCap))).map(node => node.id).slice(0, eventPageSize) : [],
      blockedNodeIds: state.nodes.filter(node => node.status === "blocked" && node.resolution?.status !== "resolved").map(node => node.id).slice(0, eventPageSize),
      activeNodeIds: state.nodes.filter(active).map(node => node.id).slice(0, eventPageSize) };
  }
  async function observeInline(id, supplied) {
    let state = supplied || read(id);
    if (state.status === "cancelling" && !state.nodes.some(active)) {
      const recovery = state.coordinator.recovery.attempts.at(-1);
      if (recovery && ["dispatching", "queued", "claimed"].includes(recovery.status)) {
        const matches = await host.find(state.mainThreadId, recovery.prompt);
        if (matches.length > 1) return fail(id, "Duplicate coordinator recovery receipt during cancellation");
        if (!matches.length) {
          if (now() - recovery.attemptedAt > 120000) return fail(id, "Uncertain coordinator recovery still prevents cancellation release");
          return state;
        }
        const receipt = await host.receipt(state.mainThreadId, matches[0].turnId, recovery.prompt);
        if (receipt.interrupted) return fail(id, "Interrupted coordinator recovery receipt prevents automatic cancellation release");
        if (!receipt.completed) return state;
        if (!receipt.promptMatched || receipt.userMessageCount !== 1 || !same(receipt, recovery.selection)) return fail(id, "Recovery cancellation receipt is unverified");
        state = mutate(id, s => { const last = s.coordinator.recovery.attempts.at(-1); last.status = "drained"; last.turnId = receipt.turnId; event(s, "recovery_drained"); });
      }
      // Every attempted worker has a verified terminal receipt; pending work was never sent.
      reservations.release(id, "completed_receipt_verified");
      return mutate(id, s => { s.status = "cancelled"; s.coordinator.phase = "cancelled"; event(s, "cancelled"); });
    }
    if (!state.inlineFinish || !["running", "paused", "finishing"].includes(state.status)) return state;
    const current = await host.read(state.mainThreadId), finish = state.inlineFinish;
    if (current.active) return state;
    if (current.lastTurnId !== finish.turnId) return fail(id, "Another main turn intervened before inline completion was verified");
    if (current.abortedTurnId === finish.turnId || (current.interruptedTurnId === finish.turnId && current.failedTurnId !== finish.turnId))
      return mutate(id, s => { s.status = "paused"; s.error = "Inline main turn was stopped; explicit recovery is required"; event(s, "paused"); });
    if (current.failedTurnId === finish.turnId) return state; // The recovery owner handles verified host failures.
    if (current.completedTurnId !== finish.turnId) return state;
    const receipt = await host.receipt(state.mainThreadId, finish.turnId, "");
    if (!receipt.completed || receipt.interrupted || !same(receipt, finish.selection) ||
        !receipt.finalResponse?.includes(finish.marker) ||
        (finish.userMessageCount !== null && receipt.userMessageCount !== finish.userMessageCount))
      return fail(id, "Inline main completion lacks its exact final marker, selection or source receipt");
    let finalized = false;
    state = mutate(id, s => {
      if (!["running", "paused", "finishing"].includes(s.status) || s.inlineFinish?.turnId !== finish.turnId || s.inlineFinish?.marker !== finish.marker) return;
      const final = s.nodes.find(node => node.id === finish.nodeId);
      if (!final || !dependenciesReady(s, final) || s.nodes.some(node => node.id !== final.id && !(node.checkpoint && (node.status === "completed" || node.resolution?.status === "resolved")))) throw new Error("Inline finish prerequisites changed before final receipt acceptance");
      for (const node of s.nodes.filter(node => node.lane === "main")) {
        node.status = "completed";
        if (node.checkpoint?.turnId && node.checkpoint.turnId !== receipt.turnId) {
          // Earlier inline declarations are retained exactly; this is the run's finalization proof, not their source receipt.
          node.finalizationReceipt = { turnId: receipt.turnId, observed: finish.selection, verification: "active_main_final_host_receipt" };
          continue;
        }
        node.checkpoint = { ...node.checkpoint, turnId: receipt.turnId, response: receipt.finalResponse,
          requested: finish.selection, observed: { model: receipt.model, reasoning: receipt.reasoning },
          startedAt: receipt.startedAt, completedAt: receipt.completedAt, usage: normalizeUsage(receipt.usage),
          verification: "active_main_final_host_receipt" };
      }
      s.status = "completed"; s.coordinator.phase = "completed"; s.inlineFinish.status = "completed";
      finalized = true;
      event(s, "completed", finish.nodeId);
    });
    if (finalized) reservations.release(id, "completed_receipt_verified");
    return state;
  }
  async function checkpoint(id, args = {}) {
    const before = await observe(id); await assertCoordinator(before, args.ownerTurnId);
    policies.assertDispatch(before.workPolicy);
    if (before.status !== "running") throw new Error("Checkpoints require a running coordinator");
    if (typeof args.summary !== "string" || !args.summary.trim()) throw new Error("A factual main checkpoint summary is required");
    return mutate(id, state => {
      if (state.status !== "running" || state.inlineFinish || state.coordinator.turnId !== before.coordinator.turnId || state.revision !== before.revision) throw new Error("Coordinator or plan changed before checkpoint");
      const node = state.nodes.find(item => item.id === args.nodeId);
      if (!node || node.lane !== "main" || node.status !== "pending" || !dependenciesReady(state, node) || !same(node.selection, state.coordinator.selection)) throw new Error("Main checkpoint is not ready or its selection differs from the active turn");
      node.status = "completed"; node.inlineDeclared = true;
      node.checkpoint = { turnId: state.coordinator.turnId, response: args.summary,
        report: { status: "completed", summary: args.summary, files: args.files || [], tests: args.tests || [], risks: args.risks || [], evidence: args.evidence || null },
        requested: node.selection, observed: state.coordinator.selection, verification: "inline_declaration_awaiting_final_receipt" };
      resolveOutcomes(state);
      event(state, "main_checkpoint", node.id);
    });
  }
  async function finish(id, args = {}) {
    const before = await observe(id), current = await assertCoordinator(before, args.ownerTurnId);
    if (before.workPolicy) before.workPolicy.reviewRequired = reviewRequired(policies.get(before.workPolicy.id).configuration);
    assertReviewComplete(before);
    if (before.status !== "running" || before.inlineFinish) throw new Error("Inline finish is already armed or coordinator is not running");
    const final = args.nodeId ? before.nodes.find(node => node.id === args.nodeId) : before.nodes.find(node => !before.nodes.some(other => other.dependencies.includes(node.id)));
    if (!final || final.lane !== "main" || !same(final.selection, before.coordinator.selection) || !dependenciesReady(before, final) || before.nodes.some(node =>
      node.id !== final.id && !(node.checkpoint && (node.status === "completed" || node.resolution?.status === "resolved")))) throw new Error("All prerequisites and blocked outcomes must be resolved before inline finish");
    return mutate(id, state => {
      if (state.status !== "running" || state.inlineFinish || state.coordinator.turnId !== before.coordinator.turnId || state.revision !== before.revision) throw new Error("Coordinator or plan changed before inline finish");
      const latestFinal = state.nodes.find(node => node.id === final.id);
      if (!latestFinal || !dependenciesReady(state, latestFinal) || state.nodes.some(node => node.id !== latestFinal.id && !(node.checkpoint && (node.status === "completed" || node.resolution?.status === "resolved")))) throw new Error("Finish prerequisites changed before arming");
      const marker = `TFO_MAIN_COMPLETE ${id} ${state.coordinator.turnId}`;
      state.inlineFinish = { nodeId: final.id, turnId: state.coordinator.turnId, selection: state.coordinator.selection,
        userMessageCount: current.userMessageCount ?? null, summary: args.summary || null, marker, status: "armed", armedAt: now() };
      state.mainCompleteMarker = marker; state.coordinator.phase = "waiting_final";
      event(state, "main_finish_armed", final.id);
    });
  }
  function planArgs(state, lanes, nodes) {
    return { surface: state.surface, objective: state.objective, constraints: state.constraints, projectPath: state.projectPath,
      projectId: state.projectId, mainThreadId: state.mainThreadId, initialSelection: state.initialSelection,
      workspaceMode: state.workspaceMode, mainWorkspace: state.lanes.find(lane => lane.id === "main").workspace,
      mainAccess: state.lanes.find(lane => lane.id === "main").access, maxTurnMinutes: state.maxTurnMinutes,
      coordinationMode: state.coordinationMode, lanes: lanes.filter(lane => lane.id !== "main"), nodes };
  }
  function applyPendingRevision(state) {
    const intent = state.pendingRevision;
    state.lanes = intent.lanes; state.nodes = intent.nodes; state.topologicalOrder = intent.topologicalOrder;
    if (intent.maxParallelWorkers > state.maxParallelWorkers && intent.explicitUserIncrease && state.capacityBackpressure) state.capacityBackpressure.effectiveMaxParallelWorkers = intent.maxParallelWorkers;
    else if (state.capacityBackpressure) state.capacityBackpressure.effectiveMaxParallelWorkers = Math.min(intent.maxParallelWorkers, state.capacityBackpressure.effectiveMaxParallelWorkers);
    state.maxParallelWorkers = intent.maxParallelWorkers; state.revision = intent.toRevision;
    if (intent.workPolicy) state.workPolicy = intent.workPolicy;
    state.status = intent.resumeStatus; state.error = null; delete state.pendingRevision;
    event(state, "plan_revised", null, `revision ${state.revision}`);
    return state;
  }
  function restorePendingRevision(state) {
    const intent = state.pendingRevision;
    if (!intent) return state;
    if (intent.fromRevision !== state.revision || intent.toRevision !== state.revision + 1 ||
        intent.coordinatorTurnId !== state.coordinator?.turnId || state.status !== "paused") throw new Error("Revision intent does not match its preserved source plan");
    validateFlow(planArgs(state, intent.lanes, intent.nodes));
    const cache = new Map();
    for (const lane of intent.lanes.filter(lane => lane.workspace)) {
      const actual = verify(state, lane.workspace, intent.lanes.filter(other => other.id !== lane.id && other.workspace), lane.access, cache);
      if (lane.isolation && (actual.branch !== lane.isolation.branch || actual.gitCommonDir !== lane.isolation.gitCommonDir)) throw new Error("Workspace changed during a paused revision commit");
    }
    // Idempotent resource acquisition is safe: this never executes a host action.
    reserve({ ...state, lanes: intent.lanes, nodes: intent.nodes });
    return save(applyPendingRevision(state));
  }
  async function revise(id, args = {}) {
    const before = read(id); await assertCoordinator(before, args.ownerTurnId);
    if (!Number.isInteger(args.expectedRevision) || args.expectedRevision !== before.revision) throw new Error("Plan revision changed; read status before replanning");
    if (before.status !== "running" || before.inlineFinish) throw new Error("Only an unfinished running active plan can be revised");
    return mutate(id, state => {
      if (state.revision !== args.expectedRevision || state.status !== "running" || state.inlineFinish || state.coordinator.turnId !== before.coordinator.turnId) throw new Error("Plan revision or coordinator changed; no amendment applied");
      const nodes = structuredClone(state.nodes), lanes = structuredClone(state.lanes);
      const work = state.workPolicy ? policies.get(state.workPolicy.id) : null;
      if (work) policies.assertMain(work, state.coordinator.selection);
      for (const addition of args.addLanes || []) {
        if (lanes.some(lane => lane.id === addition.id)) throw new Error("Worker lane already exists");
        lanes.push({ ...addition, threadId: null, baselineTurnId: null, workspace: addition.workspace ? canonicalPath(addition.workspace) : null });
      }
      for (const replacement of args.replaceNodes || []) {
        const index = nodes.findIndex(node => node.id === replacement.id);
        if (index < 0 || nodes[index].status !== "pending" || nodes[index].attemptedAt || nodes[index].provision) throw new Error("Only unattempted pending nodes may be replaced");
        nodes[index] = { ...nodes[index], ...replacement, status: "pending", checkpoint: null };
      }
      for (const addition of args.addNodes || []) {
        if (nodes.some(node => node.id === addition.id)) throw new Error("Node already exists");
        nodes.push({ ...addition, status: "pending", checkpoint: null });
      }
      const plan = validateFlow(planArgs(state, lanes, nodes));
      for (const node of nodes) {
        if (node.status === "pending" && !node.attemptedAt && !node.provision) {
          const normalized = plan.nodes.find(item => item.id === node.id);
          Object.assign(node, { title: normalized.title, prompt: normalized.prompt, dependencies: normalized.dependencies });
        }
        if (state.workPolicy && node.status === "pending" && !node.attemptedAt && !node.provision) {
          const work = policies.get(state.workPolicy.id);
          const decision = policies.decision(work, node);
          Object.assign(node, { decision, normalSelection: decision.normalSelection, selection: decision.selected, policyRevision: work.revision });
        } else node.selection = validateSelection(node.selection);
        if (!state.workPolicy) assertQueueSelection(node.selection, state.initialSelection, state.authorizedSelections);
        if (node.lane === "main" && node.status === "pending" && !same(node.selection, state.coordinator.selection)) throw new Error("Pending inline main tasks must match the current turn selection");
      }
      for (const resolution of args.resolveBlocked || []) {
        const blocked = nodes.find(node => node.id === resolution.nodeId), remediation = nodes.find(node => node.id === resolution.withNodeId);
        if (!blocked?.checkpoint || blocked.status !== "blocked" || blocked.resolution || !remediation || remediation.status !== "pending" || remediation.id === blocked.id || !remediation.dependencies.includes(blocked.id)) throw new Error("A blocked outcome needs an unattempted explicit remediation dependent on its preserved receipt");
        blocked.resolution = { withNodeId: remediation.id, status: "pending", declaredAt: now() };
      }
      if (work) validateReviewTasks(nodes, lanes);
      let maxParallelWorkers = state.maxParallelWorkers;
      if (args.maxParallelWorkers !== undefined) {
        const cap = validateParallelWorkers(args.maxParallelWorkers);
        if (cap > state.maxParallelWorkers && args.explicitUserIncrease !== true) throw new Error("Increasing concurrency requires an explicit user request");
        maxParallelWorkers = cap;
      }
      const isolationCache = new Map();
      for (const lane of lanes.filter(lane => lane.workspace && !lane.isolation)) lane.isolation = verify(state, lane.workspace, lanes.filter(other => other.id !== lane.id && other.workspace), lane.access, isolationCache);
      state.pendingRevision = { id: crypto.randomUUID(), fromRevision: state.revision, toRevision: state.revision + 1,
        coordinatorTurnId: state.coordinator.turnId, resumeStatus: state.status, preparedAt: new Date(now()).toISOString(),
        lanes, nodes, topologicalOrder: plan.topologicalOrder, maxParallelWorkers, explicitUserIncrease: args.explicitUserIncrease === true };
      if (work) state.pendingRevision.workPolicy = { id: work.id, revision: work.revision, configuration: work.configuration, reviewRequired: reviewRequired(work.configuration) };
      state.status = "paused"; state.error = "Revision commit pending; new dispatches are paused";
      save(state); // The authorized candidate is durable before extending the separate resource ledger.
      reserve({ ...state, lanes, nodes });
      applyPendingRevision(state); // mutate() persists the final commit; a failed save retains the paused intent.
    });
  }
  async function setParallelism(id, value, explicitUserIncrease = false) {
    const cap = validateParallelWorkers(value), before = readRaw(id);
    if (!activeMain(before) || !["running", "paused"].includes(before.status) || before.inlineFinish || before.pendingRevision) throw new Error("Only an unfinished running or paused active flow can change parallelism");
    if (cap > before.maxParallelWorkers && explicitUserIncrease !== true) throw new Error("Increasing concurrency requires an explicit user request");
    // Authenticated human configuration is independent of an AI owner being active.
    // It neither observes nor dispatches work, and never commits a pending task revision.
    return lockedFile(`${file(id)}.lock`, () => {
      const state = readRaw(id);
      if (!activeMain(state) || !["running", "paused"].includes(state.status) || state.inlineFinish || state.pendingRevision ||
          state.revision !== before.revision || state.maxParallelWorkers !== before.maxParallelWorkers) throw new Error("Plan revision or worker cap changed; no configuration applied");
      const previous = state.maxParallelWorkers;
      state.maxParallelWorkers = cap;
      if (state.capacityBackpressure) state.capacityBackpressure.effectiveMaxParallelWorkers = Math.min(cap,
        explicitUserIncrease === true && cap > previous ? cap : state.capacityBackpressure.effectiveMaxParallelWorkers);
      state.parallelismChanges ||= [];
      state.parallelismChanges.push({ previous, maxParallelWorkers: cap, explicitUserIncrease: explicitUserIncrease === true, changedAt: new Date(now()).toISOString() });
      state.revision++;
      event(state, "parallelism_changed", null, `${previous} to ${cap}; revision ${state.revision}`);
      return save(state);
    });
  }
  async function deferDispatch(id, nodeId, hostEvidence) {
    if (!hostEvidence || hostEvidence.code !== "HOST_CAPACITY" || hostEvidence.deliveryAttempted !== false ||
        Object.keys(hostEvidence).some(key => !["code", "deliveryAttempted", "retryAfterMs"].includes(key)) ||
        (hostEvidence.retryAfterMs !== undefined && (!Number.isInteger(hostEvidence.retryAfterMs) || hostEvidence.retryAfterMs < 0 || hostEvidence.retryAfterMs > 60000))) throw new Error("Capacity backpressure requires structured HOST_CAPACITY evidence with deliveryAttempted:false");
    const before = read(id); await assertCoordinator(before);
    const node = before.nodes.find(item => item.id === nodeId), lane = before.lanes.find(item => item.id === node?.lane);
    if (before.status !== "running" || !node || !uncertain(node) || node.resultObserved || node.provision?.resultObserved) throw new Error("Only a proven unsent dispatch can release its slot");
    const attempt = node.status === "provisioning_dispatching" ? node.provision : node;
    if (lane.threadId) {
      const current = await host.read(lane.threadId);
      if (current.active || current.lastTurnId !== lane.baselineTurnId || !same(current, lane.selection)) throw new Error("Worker activity prevents a no-send capacity deferral");
      if (await host.bootstrap(lane.threadId, attempt.visiblePrompt, before.mainThreadId)) throw new Error("A real native receipt prevents a no-send capacity deferral");
    }
    return mutate(id, state => {
      const target = state.nodes.find(item => item.id === nodeId), actualLane = state.lanes.find(item => item.id === target?.lane);
      if (state.status !== "running" || state.coordinator.turnId !== before.coordinator.turnId || state.revision !== before.revision ||
          target?.status !== node.status || (target.status === "provisioning_dispatching" ? target.provision.attemptId : target.attemptId) !== attempt.attemptId || target.resultObserved || target.provision?.resultObserved || actualLane.threadId !== lane.threadId ||
          actualLane.baselineTurnId !== lane.baselineTurnId || state.nodes.some(other => other.id !== nodeId && other.lane === target.lane && active(other))) throw new Error("Dispatch changed before its proven no-send deferral");
      target.dispatchAttempts ||= [];
      target.dispatchAttempts.push({ id: attempt.attemptId || crypto.randomUUID(), attemptedAt: attempt.attemptedAt, action: attempt.action, visiblePrompt: attempt.visiblePrompt,
        promptSha256: crypto.createHash("sha256").update(attempt.visiblePrompt).digest("hex"),
        kind: node.status === "provisioning_dispatching" ? "worktree_bootstrap" : "task", status: "proven_not_sent",
        hostEvidence: { code: "HOST_CAPACITY", deliveryAttempted: false, ...(hostEvidence.retryAfterMs !== undefined ? { retryAfterMs: hostEvidence.retryAfterMs } : {}) }, deferredAt: now() });
      target.attemptedAt ??= attempt.attemptedAt; // A deferral never makes an attempted task editable again.
      if (target.provision && target.status === "provisioning_dispatching") target.provision.status = "proven_not_sent";
      target.status = "pending";
      const workers = state.nodes.filter(other => other.lane !== "main" && active(other)).length;
      state.capacityBackpressure = { code: "HOST_CAPACITY", retryAt: now() + (hostEvidence.retryAfterMs ?? 2000),
        effectiveMaxParallelWorkers: Math.max(1, Math.min(state.maxParallelWorkers, workers, state.capacityBackpressure?.effectiveMaxParallelWorkers ?? 100)) };
      event(state, "capacity_deferred", nodeId);
    });
  }
  async function results(id, args = {}) {
    const state = read(id);
    if (args.nodeId) {
      const node = state.nodes.find(node => node.id === args.nodeId);
      if (!node) throw new Error("Unknown result node");
      return { runId: id, node: nodeSummary(state, node), checkpoint: node.checkpoint, provision: node.provision || null,
        resultObserved: node.resultObserved || null, resolution: node.resolution || null };
    }
    const page = args.page ?? 0;
    if (!Number.isInteger(page) || page < 0) throw new Error("Result page must be a nonnegative integer");
    const offset = page * eventPageSize;
    return { runId: id, page, total: state.nodes.length, nextPage: offset + eventPageSize < state.nodes.length ? page + 1 : null,
      nodes: state.nodes.slice(offset, offset + eventPageSize).map(node => nodeSummary(state, node)) };
  }
  async function wait(id, { afterCursor = 0, timeoutMs = 60000 } = {}) {
    if (!Number.isInteger(afterCursor) || afterCursor < 0 || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000) throw new Error("Invalid event cursor or wait timeout (maximum 60 seconds)");
    const deadline = Date.now() + timeoutMs;
    while (true) {
      let state = await observe(id);
      if (state.status === "running" && state.capacityBackpressure && now() >= state.capacityBackpressure.retryAt && !state.capacityBackpressure.notifiedAt) {
        state = mutate(id, s => { if (s.capacityBackpressure && now() >= s.capacityBackpressure.retryAt && !s.capacityBackpressure.notifiedAt) { s.capacityBackpressure.notifiedAt = now(); event(s, "capacity_retry_ready"); } });
      }
      const changes = (state.events || []).filter(item => item.cursor > afterCursor).slice(0, eventPageSize);
      if (changes.length || state.status !== "running" || Date.now() >= deadline) return { ...compact(state),
        cursor: changes.at(-1)?.cursor ?? afterCursor, nextCursor: changes.at(-1)?.cursor ?? afterCursor, latestCursor: state.eventSequence || 0,
        cursorExpired: (state.events?.[0]?.cursor || 1) > afterCursor + 1, events: changes,
        hasMore: (state.events || []).some(item => item.cursor > (changes.at(-1)?.cursor ?? afterCursor)) };
      await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(1, deadline - Date.now()))));
    }
  }
  function pause(id) {
    return mutate(id, state => {
      if (!activeMain(state) || terminal(state) || state.status === "needs_review" || state.status === "cancelling") throw new Error("This coordinator cannot be paused");
      state.status = "paused"; event(state, "paused");
    });
  }
  async function resume(id) {
    const before = await observe(id);
    if (before.status !== "paused") throw new Error("Only a paused coordinator can resume");
    await assertCoordinator(before);
    return mutate(id, state => { if (state.status !== "paused") throw new Error("Coordinator changed before resume"); state.status = "running"; state.error = null; event(state, "resumed"); });
  }
  async function cancel(id) {
    const cancelState = s => {
      if (!activeMain(s) || terminal(s) || s.status === "needs_review") throw new Error("Uncertain execution must be reconciled before cancellation");
      if (s.pendingRevision) {
        s.revisionHistory ||= []; s.revisionHistory.push({ ...s.pendingRevision, status: "cancelled_before_commit", cancelledAt: now() });
        delete s.pendingRevision; s.error = null;
      }
      s.status = "cancelling"; s.coordinator.phase = "cancelling";
      for (const node of s.nodes.filter(node => node.status === "pending")) node.status = "cancelled";
      const scheduled = s.coordinator.recovery.attempts.at(-1);
      if (scheduled?.status === "scheduled") scheduled.status = "cancelled";
      event(s, "cancellation_requested");
    };
    // A failed revision acquisition must remain cancellable without completing the candidate first.
    if (readRaw(id).pendingRevision) lockedFile(`${file(id)}.lock`, () => { const state = readRaw(id); cancelState(state); return save(state); });
    else mutate(id, cancelState);
    return observe(id);
  }
  async function reconcile(id) {
    const before = read(id);
    if (!activeMain(before) || before.status !== "needs_review") throw new Error("Reconciliation requires an active-main review state");
    // Read-only with respect to host delivery. Only exact completed receipts repair an uncertain attempt.
    const repaired = [], turnIds = [];
    for (const node of before.nodes.filter(uncertain)) {
      const lane = before.lanes.find(lane => lane.id === node.lane);
      if (!lane.threadId) throw new Error("A missing real creation acknowledgement cannot be guessed or recreated");
      const attempt = node.status === "provisioning_dispatching" ? node.provision : node;
      const receipt = await host.bootstrap(lane.threadId, attempt.visiblePrompt, before.mainThreadId);
      if (!receipt?.completed || !receipt.bootstrapVerified || receipt.interrupted || !same(receipt, node.selection)) throw new Error("The exact completed native receipt is still uncertain; nothing was resent");
      if (node.status === "provisioning_dispatching") {
        if (receipt.finalResponse?.trim() !== `TFO_WORKTREE_READY ${id} ${node.id}`) throw new Error("Worktree read-only bootstrap receipt does not match");
      } else {
        let report; try { report = JSON.parse(receipt.finalResponse.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new Error("A malformed worker result cannot be reconciled"); }
        if (!['completed', 'blocked'].includes(report.status) || typeof report.summary !== 'string' || !report.summary.trim()) throw new Error("Worker result cannot be reconciled");
      }
      const latest = await host.read(lane.threadId);
      if (latest.lastTurnId !== receipt.turnId || latest.active) throw new Error("Another worker turn intervened before reconciliation");
      verify(before, lane.workspace, before.lanes.filter(other => other.id !== lane.id && other.workspace), lane.access);
      repaired.push(node.id); turnIds.push(receipt.turnId);
    }
    const recoveryAttempt = before.coordinator.recovery.attempts.at(-1);
    let recoveredReceipt = null;
    if (recoveryAttempt && ["dispatching", "queued"].includes(recoveryAttempt.status)) {
      const matches = await host.find(before.mainThreadId, recoveryAttempt.prompt);
      if (matches.length !== 1) throw new Error("The uncertain recovery needs one exact actual completed receipt; never resend");
      const receipt = await host.receipt(before.mainThreadId, matches[0].turnId, recoveryAttempt.prompt);
      if (!receipt.completed || receipt.interrupted || !receipt.promptMatched || receipt.userMessageCount !== 1 || !same(receipt, recoveryAttempt.selection)) throw new Error("Recovery selection or completed receipt is unverified");
      const latest = await host.read(before.mainThreadId);
      if (latest.active || latest.lastTurnId !== receipt.turnId || latest.workspace !== before.lanes.find(lane => lane.id === "main").hostWorkspace) throw new Error("Main changed before recovery reconciliation");
      recoveredReceipt = receipt; turnIds.push(receipt.turnId);
    }
    if (!turnIds.length) throw new Error("No uncertain native action can be reconciled automatically");
    reservations.reconcile(id, { verification: "completed_receipts_verified", turnIds });
    mutate(id, state => { state.status = "paused"; state.error = null; for (const node of state.nodes.filter(node => repaired.includes(node.id))) node.status = node.provision && node.status === "provisioning_dispatching" ? "provisioning" : "queued"; event(state, "reconciled"); });
    if (recoveredReceipt) mutate(id, state => { const last = state.coordinator.recovery.attempts.at(-1); last.status = "claimed"; last.turnId = recoveredReceipt.turnId;
      state.coordinator.turnId = recoveredReceipt.turnId; state.coordinator.userMessageCount = 1; state.coordinator.phase = "paused"; });
    return observe(id);
  }
  function claimCoordinator(id) {
    return mutate(id, state => {
      if (!activeMain(state) || terminal(state)) throw new Error("Only a live active-main flow has a coordinator observer");
      const owner = state.coordinator.supervisor;
      if (owner && isAlive(owner.pid)) throw new Error("Coordinator already has a live observer owner");
      state.coordinator.supervisor = { pid: process.pid, token: watcherToken, claimedAt: now() };
      state.coordinator.observerPid = process.pid; event(state, "observer_claimed");
    });
  }
  async function recognizeRecovery(id, state, current) {
    const attempt = state.coordinator.recovery.attempts.at(-1);
    if (!attempt || !["dispatching", "queued"].includes(attempt.status)) return null;
    const matches = await host.find(state.mainThreadId, attempt.prompt);
    if (matches.length > 1) return fail(id, "Duplicate coordinator recovery delivery; never resend");
    if (!matches.length) {
      if (now() - attempt.attemptedAt > 120000) return fail(id, "Coordinator recovery delivery is uncertain; never resend");
      return state;
    }
    const receipt = await host.receipt(state.mainThreadId, matches[0].turnId, attempt.prompt);
    if (!receipt.promptMatched || receipt.userMessageCount !== 1 || !same(receipt, attempt.selection)) {
      if (!receipt.model && now() - attempt.attemptedAt <= 120000) return state;
      return fail(id, "Coordinator recovery prompt or actual selection was not verified");
    }
    if (current.lastTurnId !== receipt.turnId || current.workspace !== state.lanes.find(lane => lane.id === "main").hostWorkspace) return fail(id, "Another main turn intervened during coordinator recovery");
    return mutate(id, s => {
      const last = s.coordinator.recovery.attempts.at(-1);
      if (last.id !== attempt.id || !["dispatching", "queued"].includes(last.status)) return;
      last.status = "claimed"; last.turnId = receipt.turnId; last.verifiedAt = now();
      s.coordinator.previousTurnId = s.coordinator.turnId; s.coordinator.turnId = receipt.turnId;
      s.coordinator.userMessageCount = current.userMessageCount ?? 1; s.coordinator.phase = "active";
      if (s.inlineFinish) { s.inlineFinishHistory ||= []; s.inlineFinishHistory.push(s.inlineFinish); delete s.inlineFinish; delete s.mainCompleteMarker; }
      Object.assign(s.lanes.find(lane => lane.id === "main"), { baselineTurnId: receipt.turnId, selection: attempt.selection });
      event(s, "coordinator_recovered");
    });
  }
  async function recover(id) {
    let state = read(id);
    if (!activeMain(state) || terminal(state) || state.status === "needs_review" || state.status === "cancelling") throw new Error("Coordinator cannot recover an uncertain or terminal flow");
    const current = await host.read(state.mainThreadId);
    const recognized = await recognizeRecovery(id, state, current);
    if (recognized) state = recognized;
    if (current.active && current.lastTurnId === state.coordinator.turnId) { await assertCoordinator(state); return state; }
    if (!current.active || current.lastTurnId === state.coordinator.turnId || state.coordinator.recovery.attempts.some(attempt => ["dispatching", "queued"].includes(attempt.status))) throw new Error("Recovery must claim a verified active main turn, never resend a recovery prompt");
    assertQueueSelection(current, state.initialSelection, state.authorizedSelections);
    if (current.workspace !== state.lanes.find(lane => lane.id === "main").hostWorkspace || state.nodes.some(uncertain)) throw new Error("Workspace changed or a worker action is uncertain");
    return mutate(id, s => {
      s.coordinator.previousTurnId = s.coordinator.turnId; s.coordinator.turnId = current.lastTurnId;
      s.coordinator.selection = { model: current.model, reasoning: current.reasoning }; s.coordinator.userMessageCount = current.userMessageCount ?? null;
      s.coordinator.phase = "active"; s.status = "paused"; s.error = "Recovered owner; inspect preserved state and explicitly resume";
      if (s.inlineFinish) { s.inlineFinishHistory ||= []; s.inlineFinishHistory.push(s.inlineFinish); delete s.inlineFinish; }
      event(s, "owner_claimed");
    });
  }
  async function tickCoordinator(id) {
    let state = read(id);
    if (!activeMain(state) || terminal(state) || state.status === "needs_review") return state;
    const owner = state.coordinator.supervisor;
    if (owner?.pid !== process.pid || owner.token !== watcherToken) throw new Error("Only the acknowledged coordinator observer may tick");
    try {
      state = await observe(id);
      if (terminal(state) || state.status === "needs_review" || state.status === "cancelling") return state;
      let current = await host.read(state.mainThreadId);
      const recognized = await recognizeRecovery(id, state, current);
      if (recognized) { state = recognized; if (state.status === "needs_review") return state; }
      if (current.lastTurnId !== state.coordinator.turnId) return mutate(id, s => { s.status = "paused"; s.error = "Main owner turn changed; explicit recovery is required"; event(s, "owner_intervened"); });
      if (!same(current, state.coordinator.selection) || current.workspace !== state.lanes.find(lane => lane.id === "main").hostWorkspace ||
          (state.coordinator.userMessageCount !== null && current.userMessageCount !== state.coordinator.userMessageCount))
        return mutate(id, s => { s.status = "paused"; s.error = "Main selection, workspace or user input changed"; event(s, "owner_intervened"); });
      if (state.status !== "running" || current.active) return state; // A legitimate wait never triggers recovery.
      try { policies.assertDispatch(state.workPolicy); }
      catch (error) { return mutate(id, s => { s.status = "paused"; s.error = error.message; event(s, "policy_paused"); }); }
      if (current.abortedTurnId === current.lastTurnId || (current.interruptedTurnId === current.lastTurnId && current.failedTurnId !== current.lastTurnId))
        return mutate(id, s => { s.status = "paused"; s.error = "Main turn was stopped; automatic recovery is ambiguous"; event(s, "paused"); });
      const failed = current.failedTurnId === current.lastTurnId;
      const premature = current.completedTurnId === current.lastTurnId && !state.inlineFinish;
      if (!failed && !premature) return state;
      if (state.nodes.some(uncertain)) return state; // No recovery while a native send acknowledgement is uncertain.
      let attempt = state.coordinator.recovery.attempts.at(-1);
      if (attempt && ["dispatching", "queued"].includes(attempt.status)) return state;
      if (!attempt || attempt.sourceTurnId !== current.lastTurnId || attempt.status === "claimed") {
        if (state.coordinator.recovery.attempts.length >= 3) return mutate(id, s => { s.status = "paused"; s.error = "Three coordinator recoveries were used; user review is required"; event(s, "recovery_exhausted"); });
        state = mutate(id, s => {
          const number = s.coordinator.recovery.attempts.length;
          const attemptId = crypto.randomUUID();
          const prompt = [`TFO_MAIN_RECOVERY ${id} ${attemptId}`, `Recupera el flujo ${id} en este mismo chat.`,
            "Lee tfo_native_status y tfo_native_recover antes de continuar. Conserva todos los resultados y los intentos ya registrados; no repitas envíos inciertos.",
            "Mantén el principal activo, espera con cursores y usa TFO para revisar el plan, continuar trabajadores y finalizar la integración en este turno."].join("\n\n");
          s.coordinator.recovery.attempts.push({ id: attemptId, sourceTurnId: current.lastTurnId, status: "scheduled", number: number + 1,
            dueAt: now() + [60000, 180000, 600000][number], reason: failed ? "verified_host_failure" : "premature_main_completion",
            selection: s.coordinator.selection, selectionReason: s.coordinator.selectionReason, prompt });
          event(s, "recovery_scheduled");
        });
        attempt = state.coordinator.recovery.attempts.at(-1);
      }
      if (attempt.status !== "scheduled" || now() < attempt.dueAt) return state;
      if (host.preflightRecovery) {
        let report;
        try { report = await host.preflightRecovery(state.mainThreadId); }
        catch (error) { report = { available: false, reason: `Recovery queue preflight failed: ${error.message}` }; }
        const available = report?.available === true;
        const reason = report?.reason == null ? (available ? null : "Host did not confirm recovery queue availability") : String(report.reason).slice(0, 1000);
        state = read(id);
        const latest = state.coordinator.recovery.attempts.at(-1);
        if (state.status !== "running" || state.coordinator.turnId !== attempt.sourceTurnId || latest?.id !== attempt.id || latest.status !== "scheduled") return state;
        const previous = state.coordinator.recoveryAccess;
        if (previous?.attemptId !== attempt.id || previous.available !== available || previous.reason !== reason) {
          state = mutate(id, s => {
            const last = s.coordinator.recovery.attempts.at(-1);
            if (s.status !== "running" || s.coordinator.turnId !== attempt.sourceTurnId || last?.id !== attempt.id || last.status !== "scheduled") return;
            s.coordinator.recoveryAccess = { attemptId: attempt.id, available, reason, changedAt: now() };
            event(s, "recovery_access_changed");
          });
        }
        if (!available || state.status !== "running" || state.coordinator.recovery.attempts.at(-1)?.id !== attempt.id ||
            state.coordinator.recovery.attempts.at(-1)?.status !== "scheduled") return state;
      }
      // Re-read immediately before persisting intent; only an idle exact source can be queued.
      current = await host.read(state.mainThreadId);
      if (current.active || current.lastTurnId !== attempt.sourceTurnId || !same(current, attempt.selection) ||
          current.workspace !== state.lanes.find(lane => lane.id === "main").hostWorkspace ||
          (state.coordinator.userMessageCount !== null && current.userMessageCount !== state.coordinator.userMessageCount)) return state;
      mutate(id, s => {
        const last = s.coordinator.recovery.attempts.at(-1);
        const work = policies.assertDispatch(s.workPolicy);
        if (work) policies.assertMain(work, attempt.selection);
        assertWorkBudget(work, s, current);
        if (s.status !== "running" || s.coordinator.turnId !== attempt.sourceTurnId || last.id !== attempt.id || last.status !== "scheduled" ||
            s.nodes.some(uncertain)) throw new Error("Recovery changed before dispatch");
        last.status = "dispatching"; last.attemptedAt = now(); event(s, "recovery_attempted");
      });
      let delivery;
      try { delivery = await host.send(state.mainThreadId, attempt.prompt); }
      catch (error) { return fail(id, `Coordinator recovery send is uncertain: ${error.message}; never resend`); }
      return mutate(id, s => { const last = s.coordinator.recovery.attempts.at(-1); if (last.id === attempt.id) { last.status = "queued"; last.delivery = delivery; event(s, "recovery_queued"); } });
    } catch (error) {
      // Host observation outages never prove a dead main turn and cannot authorize a wake-up.
      return mutate(id, s => { s.observerError = String(error.message); });
    }
  }
  function status(id) {
    const state = read(id);
    if (!activeMain(state) && state.status === "running" && state.deferredJoin?.ownerPid && !isAlive(state.deferredJoin.ownerPid)) return fail(id, "Join supervisor stopped; never resend without reviewing receipts");
    return state;
  }
  return { prepare, claim, acknowledge, observe, status, compact, fail, armJoin, claimJoin, tickJoin,
    revise, checkpoint, finish, wait, results, pause, resume, cancel, reconcile, recover, setParallelism, deferDispatch, claimCoordinator, tickCoordinator };
}
