// Supervised Codex-tool driver. This module schedules and verifies; the calling
// host executes the returned native tool call. It has no independent writer.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { validateFlow, nodePrompt } from "./project-flow.mjs";
import { validateSelection, assertQueueSelection } from "./model-policy.mjs";
import { canonicalPath, containsPath, inspectWorkspace, verifyWorkspace } from "./project-workspace.mjs";
import { lockedFile, reserveChatSlot, isAlive } from "./prompt-queue.mjs";
import { createProjectReservationStore } from "./project-reservations.mjs";
import { normalizeUsage, equivalentUsd } from "./budget.mjs";

const active = node => ["dispatching", "queued"].includes(node.status);
const same = (a, b) => a?.model === b?.model && a?.reasoning === b?.reasoning;
export function createNativeFlow({ dataDir, host, now = Date.now }) {
  const root = path.join(dataDir, "native-flows"), runs = path.join(dataDir, "runs");
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(runs, { recursive: true });
  const reservations = createProjectReservationStore({ dataDir });
  const file = id => {
    if (!/^flow_[a-z0-9_]+$/.test(id)) throw new Error("Invalid flow ID");
    return path.join(root, `${id}.json`);
  };
  const read = id => JSON.parse(fs.readFileSync(file(id), "utf8"));
  const save = state => {
    const target = file(state.id), temp = `${target}.${crypto.randomUUID()}.tmp`;
    state.updatedAt = new Date(now()).toISOString();
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), { flag: "wx" }); fs.renameSync(temp, target); return state;
  };
  const mutate = (id, change) => lockedFile(`${file(id)}.lock`, () => { const s = read(id); change(s); return save(s); });
  const reserve = state => {
    const plan = { nodes: [...state.lanes.map(lane => ({ ...lane, threadId: `pending-${state.id}-${lane.id}`, gitCommonDir: lane.isolation?.gitCommonDir })),
      ...state.lanes.filter(lane => lane.threadId).map(lane => ({ ...lane, gitCommonDir: lane.isolation?.gitCommonDir }))] };
    return (reservations.get(state.id) ? reservations.extend : reservations.reserve)(state.id, plan);
  };
  const verify = (plan, workspace, others, access) => {
    if (plan.workspaceMode !== "scratch_folders") return verifyWorkspace(plan.projectPath, workspace, others, access);
    const rootInfo = inspectWorkspace(plan.projectPath), info = inspectWorkspace(workspace);
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
    if (args.currentNodeId !== undefined) throw new Error("Native flows require separate task turns");
    const plan = validateFlow(args), main = await host.read(plan.mainThreadId);
    if (!same(main, plan.initialSelection) || !main.lastTurnId) throw new Error("Main selection must match the actual host");
    const maxParallelWorkers = args.maxParallelWorkers ?? 2;
    if (!Number.isInteger(maxParallelWorkers) || maxParallelWorkers < 1 || maxParallelWorkers > 8) throw new Error("maxParallelWorkers must be 1-8");
    const authorizedSelections = (args.authorizedSelections || []).map(validateSelection);
    const workspaceMode = args.workspaceMode || "git_worktrees";
    if (workspaceMode !== "scratch_folders") throw new Error("This supervised native driver currently supports scratch_folders only; use the parallel adapter for Git worktrees");
    const state = { ...plan, id: `flow_${now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`, kind: "native_tool_flow",
      status: "running", driver: "supervised_native_tools", unattended: false, workspaceMode, maxParallelWorkers,
      authorizedSelections, createdAt: new Date(now()).toISOString(), error: null };
    state.mainJoinMarker = `TFO_MAIN_JOIN ${state.id} ${state.mainThreadId}`;
    state.lanes = [{ id: "main", title: "Principal", access: "write", threadId: plan.mainThreadId,
      workspace: canonicalPath(args.mainWorkspace || args.projectPath), hostWorkspace: main.workspace,
      selection: plan.initialSelection, baselineTurnId: main.lastTurnId }, ...plan.lanes.map(lane => ({ ...lane,
      workspace: canonicalPath(args.lanes.find(item => item.id === lane.id).workspace) }))];
    for (const lane of state.lanes) lane.isolation = verify(state, lane.workspace, state.lanes.filter(other => other !== lane), lane.access);
    state.nodes = plan.nodes.map(node => {
      const selection = validateSelection(args.nodes.find(item => item.id === node.id).selection);
      assertQueueSelection(selection, plan.initialSelection, authorizedSelections);
      const selectionReason = args.nodes.find(item => item.id === node.id).selectionReason;
      if (selectionReason !== undefined && (typeof selectionReason !== "string" || selectionReason.trim().length > 1000)) throw new Error("Invalid selection reason");
      return { ...node, selection, selectionReason: selectionReason?.trim() || null };
    });
    for (const pair of authorizedSelections) if (!state.nodes.some(node => same(node.selection, pair))) throw new Error("Unused selection authorization");
    return reserveChatSlot(runs, state.mainThreadId, () => { reserve(state); return save(state); }, state.id);
  }
  function fail(id, reason) {
    reservations.markUncertain(id, reason);
    return mutate(id, state => { state.status = "needs_review"; state.error = String(reason); });
  }
  async function observe(id) {
    const before = read(id);
    if (before.status !== "running") return before;
    try {
      for (const node of before.nodes.filter(active)) {
        const lane = before.lanes.find(lane => lane.id === node.lane);
        if (!lane.threadId) {
          if (now() - node.attemptedAt > 120000) throw new Error(`Missing creation acknowledgement for ${node.id}; do not recreate`);
          continue;
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
        } else receipt = await host.bootstrap(lane.threadId, node.visiblePrompt, before.mainThreadId);
        if (!receipt?.completed) {
          if (receipt?.interrupted) throw new Error(`Interrupted ${node.id}`);
          if (now() - node.attemptedAt > before.maxTurnMinutes * 60000) throw new Error(`Receipt timed out for ${node.id}`);
          continue;
        }
        mutate(id, state => { state.nodes.find(item => item.id === node.id).resultObserved = receipt; });
        const verified = ["native_queue", "selected_join"].includes(node.deliveryKind) ? receipt.promptMatched && receipt.userMessageCount === 1 : receipt.bootstrapVerified;
        if (!verified || receipt.interrupted || !same(receipt, node.selection)) throw new Error(`Unverified prompt or model/effort for ${node.id}`);
        const latest = await host.read(lane.threadId);
        if (latest.lastTurnId !== receipt.turnId || latest.active) throw new Error(`Another turn intervened in ${lane.id}`);
        let report;
        if (node.lane !== "main") {
          report = JSON.parse(receipt.finalResponse.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
          if (report.status !== "completed" || !report.summary) throw new Error(`Blocked or malformed worker result for ${node.id}`);
        }
        if (!receipt.finalResponse) throw new Error(`No final response for ${node.id}`);
        const workspace = inspectWorkspace(lane.workspace);
        if (workspace.workspace !== lane.workspace || workspace.branch !== lane.isolation.branch || workspace.gitCommonDir !== lane.isolation.gitCommonDir) throw new Error("Workspace identity changed");
        const usage = normalizeUsage(receipt.usage);
        mutate(id, state => {
          const target = state.nodes.find(item => item.id === node.id);
          target.status = "completed";
          target.checkpoint = { turnId: receipt.turnId, response: receipt.finalResponse, report: report || null,
            requested: node.selection, selectionReason: node.selectionReason, observed: { model: receipt.model, reasoning: receipt.reasoning },
            startedAt: receipt.startedAt, completedAt: receipt.completedAt, usage,
            apiEquivalentUsd: usage ? equivalentUsd(node.selection, usage) : null,
            verification: node.deliveryKind === "native_queue" ? "native_queue_host_receipt" :
              node.deliveryKind === "selected_join" ? "selected_join_host_receipt" : "native_host_receipt", head: workspace.head };
          Object.assign(state.lanes.find(item => item.id === lane.id), { baselineTurnId: receipt.turnId, selection: node.selection });
        });
      }
      const state = read(id);
      if (state.nodes.every(node => node.checkpoint)) {
        reservations.release(id, "completed_receipt_verified"); return mutate(id, state => {
          state.status = "completed";
          if (state.deferredJoin?.status === "queued") state.deferredJoin.status = "completed";
        });
      }
      return state;
    } catch (error) { return fail(id, error.message); }
  }
  async function claim(id, nodeId) {
    const before = await observe(id), node = before.nodes.find(node => node.id === nodeId);
    if (before.status !== "running" || !node || node.status !== "pending") throw new Error("Node is not available; never retry an attempted dispatch");
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
      if (state.status !== "running" || target.status !== "pending" || !target.dependencies.every(dep => state.nodes.find(node => node.id === dep).checkpoint)) throw new Error("Dependencies are incomplete");
      if (state.nodes.some(other => other.lane === target.lane && active(other))) throw new Error("Chat already active");
      if (target.lane !== "main" && state.nodes.filter(other => other.lane !== "main" && active(other)).length >= state.maxParallelWorkers) throw new Error("Parallel worker limit reached");
      const prompt = nodePrompt(state, target);
      if (prompt.length > 100000) throw new Error("Dependency results exceed prompt limit");
      action = lane.threadId
        ? { tool: "send_message_to_thread", args: { threadId: lane.threadId, prompt, model: target.selection.model, thinking: target.selection.reasoning } }
        : { tool: "create_thread", args: { title: lane.title, prompt, model: target.selection.model, thinking: target.selection.reasoning,
          target: { type: "project", projectId: state.projectId, environment: { type: "local" } } } };
      target.visiblePrompt = prompt; target.status = "dispatching"; target.attemptedAt = now(); target.action = action;
    });
    return action;
  }
  async function acknowledge(id, nodeId, threadId) {
    const before = read(id), node = before.nodes.find(node => node.id === nodeId), lane = before.lanes.find(lane => lane.id === node?.lane);
    if (!node || node.status !== "dispatching" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) throw new Error("Invalid dispatch acknowledgement");
    if (lane.threadId && lane.threadId !== threadId) throw new Error("Wrong target thread");
    const actual = await host.read(threadId);
    if (!containsPath(actual.workspace, lane.workspace)) throw new Error("Host cwd does not contain the assigned scratch directory");
    return reserveChatSlot(runs, threadId, () => mutate(id, state => {
      const target = state.nodes.find(node => node.id === nodeId);
      if (target.status !== "dispatching") throw new Error("Dispatch already acknowledged");
      Object.assign(state.lanes.find(item => item.id === lane.id), { threadId, hostWorkspace: actual.workspace });
      reserve(state); target.status = "queued";
    }), id);
  }
  async function armJoin(id) {
    const before = await observe(id), mainLane = before.lanes.find(lane => lane.id === "main");
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
  function status(id) {
    const state = read(id);
    if (state.status === "running" && state.deferredJoin?.ownerPid && !isAlive(state.deferredJoin.ownerPid)) return fail(id, "Join supervisor stopped; never resend without reviewing receipts");
    return state;
  }
  return { prepare, claim, acknowledge, observe, status, fail, armJoin, claimJoin, tickJoin };
}
