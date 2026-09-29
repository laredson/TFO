// Cross-process, persistent resource reservations for project DAG plans.
// A held reservation never expires by time. Uncertain execution is sticky and
// must be reconciled manually; this module never frees it automatically.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const stamp = () => new Date().toISOString();
const ACTIVE = new Set(["held", "needs_review"]);
const waitCell = new Int32Array(new SharedArrayBuffer(4));

function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

function sleep(ms) { Atomics.wait(waitCell, 0, 0, ms); }

function lockLedger(lockDir, timeoutMs = 5000) {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const token = crypto.randomUUID();
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, token, createdAt: stamp() }), { flag: "wx" });
      return () => {
        try {
          const owner = JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
          if (owner.token === token && owner.pid === process.pid) fs.rmSync(lockDir, { recursive: true });
        } catch { /* A damaged lock is left for manual review; never steal it. */ }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // Reclaim only a complete lock whose owner process is demonstrably gone.
      // An incomplete lock may belong to a process between mkdir and owner write;
      // timing out is safer than risking two writers.
      try {
        const ownerPath = path.join(lockDir, "owner.json");
        const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
        if (owner.pid && !alive(owner.pid)) {
          const again = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
          if (again.token === owner.token && again.pid === owner.pid) fs.rmSync(lockDir, { recursive: true });
        }
      } catch { /* Missing/corrupt ownership is a fail-closed lock. */ }
      sleep(20);
    }
  }
  throw new Error("Project resource ledger is locked or needs manual recovery; no reservation changed");
}

function stablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function planClaims(plan) {
  const claims = new Map();
  const add = (kind, value, mode, workspace = null) => {
    if (!value) return;
    const key = `${kind}:${value}`;
    const prior = claims.get(key);
    const mergedMode = prior?.mode === "write" || mode === "write" ? "write" : "read";
    claims.set(key, { key, kind, mode: mergedMode, workspace: workspace || prior?.workspace || null });
  };
  for (const node of plan.nodes) {
    const workspace = stablePath(node.workspace);
    const mode = node.access === "write" ? "write" : "read";
    // A conversation can have only one active project route, even for read-only nodes.
    add("chat", String(node.threadId).toLowerCase(), "write", workspace);
    add("workspace", workspace, mode, workspace);
    add("git", node.gitCommonDir ? stablePath(node.gitCommonDir) : null, mode, workspace);
  }
  return [...claims.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function verifiedIsolation(adapter) {
  if (adapter?.verified !== true || adapter.workspaceIsolation !== true || adapter.gitIsolation !== true) return null;
  const proof = typeof adapter.isolationProof === "string" ? adapter.isolationProof.trim() : "";
  return proof.length >= 16 ? proof : null;
}

function canShare(existing, incoming, existingProof, incomingProof) {
  if (existing.kind === "workspace" && incoming.kind === "workspace" && (existing.mode === "write" || incoming.mode === "write")) {
    const within = (parent, child) => { const relative = path.relative(parent, child); return !relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)); };
    if (within(existing.workspace, incoming.workspace) || within(incoming.workspace, existing.workspace)) return false;
  }
  if (existing.key !== incoming.key) return true;
  if (existing.kind === "chat") return false;
  if (existing.mode === "read" && incoming.mode === "read") return true;
  if (existing.kind === "workspace") return false;
  // A shared Git common directory can overlap only when the verified adapter
  // attests to the same isolation contract and the actual workspaces differ.
  return Boolean(existingProof && incomingProof && existingProof === incomingProof &&
    existing.workspace && incoming.workspace && existing.workspace !== incoming.workspace);
}

function readLedger(file) {
  if (!fs.existsSync(file)) return { version: 1, reservations: [] };
  const ledger = JSON.parse(fs.readFileSync(file, "utf8"));
  if (ledger.version !== 1 || !Array.isArray(ledger.reservations)) throw new Error("Project resource ledger is invalid; no reservation changed");
  return ledger;
}

function writeLedger(file, ledger) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(ledger, null, 2), { flag: "wx" });
  try { fs.renameSync(temporary, file); }
  catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
}

export function createProjectReservationStore({ dataDir, adapter = {} }) {
  const root = path.join(dataDir, "projects");
  fs.mkdirSync(root, { recursive: true });
  const ledgerFile = path.join(root, "resource-reservations.json");
  const lockDir = path.join(root, "resource-reservations.lock");
  const proof = verifiedIsolation(adapter);

  function mutate(action) {
    const unlock = lockLedger(lockDir);
    try {
      const ledger = readLedger(ledgerFile);
      const result = action(ledger);
      writeLedger(ledgerFile, ledger);
      return result;
    } finally { unlock(); }
  }

  function get(runId) {
    const ledger = readLedger(ledgerFile);
    return ledger.reservations.find(item => item.runId === runId) || null;
  }

  function reserve(runId, plan, extend = false) {
    const claims = planClaims(plan);
    if (!claims.length) throw new Error("Project plan has no reservable resources");
    return mutate(ledger => {
      const same = ledger.reservations.find(item => item.runId === runId);
      if (same) {
        if (same.status === "needs_review") throw new Error("An uncertain project reservation cannot be reused");
        if (same.status === "held") {
          if (!extend && (JSON.stringify(same.claims) !== JSON.stringify(claims) || same.isolationProof !== proof)) {
            throw new Error("An active project run ID cannot be rebound to different resources");
          }
          if (!extend) return same;
          if (!runId.startsWith("flow_") || same.isolationProof !== proof || same.claims.some(old =>
            !claims.some(next => next.key === old.key && !(old.mode === "write" && next.mode !== "write") &&
              (old.kind === "git" || old.workspace === next.workspace)))) {
            throw new Error("Provisioning may only add resources without dropping or reassigning existing claims");
          }
        } else {
          throw new Error("A released project reservation cannot be reused; create a new project run ID");
        }
      }
      const conflicts = [];
      for (const held of ledger.reservations) {
        if (!ACTIVE.has(held.status) || held.runId === runId) continue;
        for (const claim of claims) for (const existing of held.claims) {
          if (!canShare(existing, claim, held.isolationProof, proof)) conflicts.push({ runId: held.runId, resource: claim.key });
        }
      }
      if (conflicts.length) {
        const unique = [...new Map(conflicts.map(item => [`${item.runId}:${item.resource}`, item])).values()];
        throw new Error(`Project resources are reserved by another plan: ${unique.map(item => `${item.resource} (${item.runId})`).join(", ")}`);
      }
      const reservation = { runId, status: "held", claims, isolationProof: proof, acquiredAt: stamp(), updatedAt: stamp(), reason: "Reserved before a project plan can be dispatched." };
      if (same && extend) Object.assign(same, reservation, { acquiredAt: same.acquiredAt });
      else ledger.reservations.push(reservation);
      return reservation;
    });
  }

  function markUncertain(runId, reason) {
    return mutate(ledger => {
      const item = ledger.reservations.find(entry => entry.runId === runId);
      if (!item) return null;
      item.status = "needs_review"; item.reason = String(reason || "Execution outcome is uncertain; reservation retained.").slice(0, 500); item.updatedAt = stamp();
      return item;
    });
  }

  function release(runId, outcome) {
    if (!new Set(["cancelled_before_dispatch", "completed_receipt_verified"]).has(outcome)) {
      throw new Error("A project reservation requires verified no-dispatch cancellation or a completed host receipt before release");
    }
    return mutate(ledger => {
      const item = ledger.reservations.find(entry => entry.runId === runId);
      if (!item) return null;
      if (item.status === "needs_review") throw new Error("An uncertain project reservation cannot be released automatically");
      item.status = "released"; item.reason = outcome; item.updatedAt = stamp(); item.releasedAt = stamp();
      return item;
    });
  }

  return { reserve: (id, plan) => reserve(id, plan), extend: (id, plan) => reserve(id, plan, true), get, markUncertain, release };
}
