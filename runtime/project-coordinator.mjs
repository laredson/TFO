// Persistent, fail-closed project DAG scheduler. It stores plans and checkpoints;
// no chat can be dispatched until a host adapter is injected and verified.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { validateSelection } from "./model-policy.mjs";
import { createProjectReservationStore } from "./project-reservations.mjs";

const stamp = () => new Date().toISOString();
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const TERMINAL = new Set(["completed", "cancelled"]);
const waitCell = new Int32Array(new SharedArrayBuffer(4));

function withCoordinatorLock(root, callback, timeoutMs = 5000) {
  const lock = path.join(root, "coordinator.lock"), ownerPath = path.join(lock, "owner.json");
  const deadline = Date.now() + timeoutMs, token = crypto.randomUUID();
  const alive = pid => {
    if (!Number.isInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code === "EPERM"; }
  };
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token, createdAt: stamp() }), { flag: "wx" });
      try { return callback(); }
      finally {
        try {
          const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
          if (owner.pid === process.pid && owner.token === token) fs.rmSync(lock, { recursive: true });
        } catch { /* A damaged lock is left for manual review. */ }
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
        if (owner.pid && !alive(owner.pid)) {
          const again = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
          if (again.pid === owner.pid && again.token === owner.token) fs.rmSync(lock, { recursive: true });
        }
      } catch { /* Incomplete/corrupt locks fail closed. */ }
      Atomics.wait(waitCell, 0, 0, 20);
    }
  }
  throw new Error("Project coordinator state is locked or needs manual recovery; no plan changed");
}

export const unavailableProjectAdapter = Object.freeze({
  verified: false, threadDiscovery: false, turnDispatch: false, turnReceipts: false,
  selectionControl: false, pauseCancel: false, workspaceIsolation: false, gitIsolation: false,
  reason: "No se ha verificado un adaptador del host que dirija y confirme turnos en varios chats del proyecto.",
});

function gitCommonDir(workspace) {
  const dotGit = path.join(workspace, ".git");
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return fs.realpathSync(dotGit);
    const match = fs.readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)\s*$/im);
    if (!match) return null;
    const gitDir = fs.realpathSync(path.resolve(workspace, match[1]));
    const commonFile = path.join(gitDir, "commondir");
    return fs.existsSync(commonFile) ? fs.realpathSync(path.resolve(gitDir, fs.readFileSync(commonFile, "utf8").trim())) : gitDir;
  } catch { return null; }
}

export function validateProjectPlan(args) {
  if (!args || typeof args !== "object" || typeof args.objective !== "string" || args.objective.trim().length < 3) throw new Error("objective must contain at least 3 characters");
  const projectPath = fs.realpathSync(path.resolve(String(args.projectPath || "")));
  if (!fs.statSync(projectPath).isDirectory()) throw new Error("projectPath must be a directory");
  const projectGit = gitCommonDir(projectPath);
  if (!Array.isArray(args.nodes) || !args.nodes.length || args.nodes.length > 40) throw new Error("nodes must contain between 1 and 40 nodes");
  const ids = new Set();
  const nodes = args.nodes.map((node, index) => {
    if (!node || typeof node !== "object" || !ID.test(node.id || "") || ids.has(node.id)) throw new Error(`nodes[${index}] requires a unique valid id`);
    ids.add(node.id);
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(node.threadId || "")) throw new Error(`nodes[${index}] requires a real Codex threadId`);
    const workspace = fs.realpathSync(path.resolve(String(node.workspace || "")));
    if (!fs.statSync(workspace).isDirectory()) throw new Error(`nodes[${index}] workspace must be an existing directory`);
    const relativeWorkspace = path.relative(projectPath, workspace);
    const insideProject = relativeWorkspace === "" || (!relativeWorkspace.startsWith(`..${path.sep}`) && relativeWorkspace !== ".." && !path.isAbsolute(relativeWorkspace));
    const workspaceGit = gitCommonDir(workspace);
    if (!insideProject && (!projectGit || projectGit !== workspaceGit)) throw new Error(`Node ${node.id} workspace is outside the project and does not share its Git repository`);
    const dependencies = node.dependencies ?? [];
    if (!Array.isArray(dependencies) || dependencies.some(id => typeof id !== "string")) throw new Error(`nodes[${index}] dependencies must be an array of node IDs`);
    return { id: node.id, title: String(node.title || node.id).slice(0, 160), threadId: node.threadId, workspace, gitCommonDir: workspaceGit,
      dependencies: [...new Set(dependencies)], selection: validateSelection(node.selection),
      access: node.access === "write" ? "write" : "read", status: "blocked", checkpoint: null };
  });
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const node of nodes) for (const dependency of node.dependencies) {
    if (dependency === node.id || !byId.has(dependency)) throw new Error(`Node ${node.id} has an invalid dependency: ${dependency}`);
  }
  const order = [], visiting = new Set(), visited = new Set();
  const visit = node => {
    if (visiting.has(node.id)) throw new Error(`Dependency cycle includes ${node.id}`);
    if (visited.has(node.id)) return;
    visiting.add(node.id);
    for (const dep of node.dependencies) visit(byId.get(dep));
    visiting.delete(node.id); visited.add(node.id); order.push(node.id);
  };
  nodes.forEach(visit);
  const ancestors = new Map(nodes.map(node => [node.id, new Set()]));
  for (const id of order) {
    const node = byId.get(id);
    for (const dependency of node.dependencies) {
      ancestors.get(id).add(dependency);
      for (const ancestor of ancestors.get(dependency)) ancestors.get(id).add(ancestor);
    }
  }
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    const sameChat = a.threadId === b.threadId;
    if (!sameChat && (a.access !== "write" || b.access !== "write")) continue;
    const sharedCheckout = a.workspace === b.workspace;
    const commonA = gitCommonDir(a.workspace), commonB = gitCommonDir(b.workspace);
    const sharedGit = commonA && commonA === commonB;
    const ordered = ancestors.get(a.id).has(b.id) || ancestors.get(b.id).has(a.id);
    if ((sameChat || sharedCheckout || sharedGit) && !ordered) throw new Error(`Nodes ${a.id} and ${b.id} can overlap in the same chat, checkout or Git common directory; add a dependency or use verified isolation`);
  }
  return { projectPath, objective: args.objective.trim(), nodes, topologicalOrder: order };
}

export function createProjectCoordinator({ dataDir, adapter = unavailableProjectAdapter }) {
  const root = path.join(dataDir, "projects");
  fs.mkdirSync(root, { recursive: true });
  const reservations = createProjectReservationStore({ dataDir, adapter });
  const file = id => {
    if (!/^project_[a-z0-9_]+$/i.test(id || "")) throw new Error("Invalid project run ID");
    return path.join(root, id, "state.json");
  };
  const read = id => JSON.parse(fs.readFileSync(file(id), "utf8"));
  const save = state => {
    fs.mkdirSync(path.dirname(file(state.id)), { recursive: true });
    state.updatedAt = stamp();
    const tmp = `${file(state.id)}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { flag: "wx" });
    fs.renameSync(tmp, file(state.id));
    return state;
  };
  const summary = state => ({ id: state.id, objective: state.objective, projectPath: state.projectPath,
    status: state.status, totalNodes: state.nodes.length, completedNodes: state.nodes.filter(n => n.checkpoint).length,
    nodes: state.nodes, topologicalOrder: state.topologicalOrder, adapter: state.adapter,
    reservation: state.reservation || reservations.get(state.id), error: state.error,
    noDispatchVerified: state.noDispatchVerified, recovery: state.recovery,
    startedAt: state.startedAt, updatedAt: state.updatedAt });
  function prepare(args) {
    return withCoordinatorLock(root, () => {
      const plan = validateProjectPlan(args);
      const id = `project_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
      const state = { ...plan, id, kind: "project_dag", status: "blocked", adapter: { ...adapter },
        error: adapter.verified === true ? "Verified adapter execution is not enabled in this preview." : adapter.reason || unavailableProjectAdapter.reason,
        noDispatchVerified: true, startedAt: stamp(), updatedAt: stamp(), recovery: "No dispatch attempted; all nodes remain blocked." };
      state.reservation = reservations.reserve(id, plan);
      try { save(state); }
      catch (error) {
        try { reservations.release(id, "cancelled_before_dispatch"); } catch { /* Keep an orphaned reservation rather than risk overlap. */ }
        throw error;
      }
      return summary(state);
    });
  }
  function status(id) { return summary(read(id)); }
  function pause(id) {
    return withCoordinatorLock(root, () => {
      const state = read(id);
      if (TERMINAL.has(state.status)) throw new Error(`Project plan is ${state.status}`);
      if (state.status === "needs_review" || state.noDispatchVerified !== true) throw new Error("A plan requiring review cannot be hidden by pausing it");
      if (state.nodes.some(node => ["dispatching", "running", "needs_review"].includes(node.status))) {
        throw new Error("A dispatched or uncertain node cannot be treated as safely paused by this planner");
      }
      state.status = "paused"; state.error = "Paused by user; no node was dispatched.";
      return summary(save(state));
    });
  }
  function resume(id) {
    return withCoordinatorLock(root, () => {
      const state = read(id);
      if (state.status !== "paused") throw new Error("Only a paused project plan can resume");
      if (state.noDispatchVerified !== true) throw new Error("A plan with possible dispatch requires review; it cannot be resumed automatically");
      if (state.nodes.some(node => ["dispatching", "running", "needs_review"].includes(node.status))) {
        throw new Error("A dispatched or uncertain node requires review; it cannot be resumed automatically");
      }
      state.reservation = reservations.get(id) || reservations.reserve(id, state);
      if (state.reservation.status === "needs_review") throw new Error("An uncertain reservation requires review; it cannot be resumed automatically");
      state.status = "blocked";
      state.error = adapter.verified === true ? "Verified adapter execution is not enabled in this preview." : adapter.reason || unavailableProjectAdapter.reason;
      state.recovery = "Rechecked adapter capabilities; no node was dispatched.";
      return summary(save(state));
    });
  }
  function cancel(id) {
    return withCoordinatorLock(root, () => {
      const state = read(id);
      if (state.status === "completed") throw new Error("Cannot cancel a completed project plan");
      const uncertain = state.noDispatchVerified !== true || ["dispatching", "running", "needs_review"].includes(state.status) || state.dispatch?.attempted === true ||
        state.nodes.some(node => ["dispatching", "running", "needs_review"].includes(node.status));
      if (uncertain) {
        state.status = "needs_review";
        state.error = "Cancellation requested while execution may be uncertain; resource reservations are retained for review.";
        state.reservation = reservations.markUncertain(id, state.error);
        return summary(save(state));
      }
      state.status = "cancelled"; state.error = "Cancelled; no node was dispatched.";
      save(state);
      try { state.reservation = reservations.release(id, "cancelled_before_dispatch"); }
      catch (error) { state.error = `Cancelled; reservation remains held for safety: ${error.message}`; }
      return summary(save(state));
    });
  }
  function recover() {
    return withCoordinatorLock(root, () => {
      const changed = [];
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("project_")) continue;
        try {
          const state = read(entry.name);
          if (state.status === "running" || state.status === "dispatching") {
            state.noDispatchVerified = false;
            state.status = "needs_review"; state.error = "Coordinator restarted during execution; inspect the host receipt before resuming.";
            state.recovery = "Persisted plan retained; no node was relaunched.";
            state.reservation = reservations.markUncertain(state.id, state.error); save(state); changed.push(state.id);
          } else if (state.status === "needs_review") {
            state.noDispatchVerified = false;
            state.reservation = reservations.markUncertain(state.id, state.error || "Plan already requires review after restart."); save(state);
          }
        } catch { /* Preserve corrupt state for manual recovery; never delete its leases. */ }
      }
      return changed;
    });
  }
  return { prepare, status, pause, resume, cancel, recover };
}
