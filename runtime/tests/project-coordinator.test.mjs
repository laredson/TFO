import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProjectCoordinator, unavailableProjectAdapter, validateProjectPlan } from "../project-coordinator.mjs";

const thread = n => `12345678-1234-1234-1234-${String(n).padStart(12, "0")}`;
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-project-coordinator-"));
  const projectPath = path.join(dataDir, "project");
  fs.mkdirSync(projectPath);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const args = (nodes = [{ id: "first", threadId: thread(1), workspace: projectPath, dependencies: [], selection: { model: "gpt-6-luna", reasoning: "medium" }, access: "write" }]) => ({
    objective: "Coordinate project work", projectPath, nodes,
  });
  return { dataDir, projectPath, args };
}

test("validates a DAG and rejects duplicate IDs, unknown dependencies and cycles", t => {
  const f = fixture(t), valid = f.args([
    { id: "first", threadId: thread(1), workspace: f.projectPath, dependencies: [], selection: { model: "gpt-6-luna", reasoning: "medium" }, access: "write" },
    { id: "second", threadId: thread(2), workspace: f.projectPath, dependencies: ["first"], selection: { model: "gpt-6-sol", reasoning: "low" }, access: "write" },
  ]);
  assert.deepEqual(validateProjectPlan(valid).topologicalOrder, ["first", "second"]);
  assert.throws(() => validateProjectPlan(f.args([valid.nodes[0], { ...valid.nodes[0] }])), /unique valid id/);
  assert.throws(() => validateProjectPlan(f.args([{ ...valid.nodes[0], dependencies: ["missing"] }])), /invalid dependency/);
  assert.throws(() => validateProjectPlan(f.args([
    { ...valid.nodes[0], dependencies: ["second"] }, { ...valid.nodes[1], dependencies: ["first"] },
  ])), /cycle/);
});

test("rejects unordered nodes sharing a chat, checkout or Git common directory", t => {
  const f = fixture(t), base = f.args().nodes[0];
  const other = path.join(f.projectPath, "other"); fs.mkdirSync(other);
  const node = (id, threadId, workspace, extra = {}) => ({ ...base, id, threadId, workspace, dependencies: [], ...extra });
  assert.throws(() => validateProjectPlan(f.args([node("a", thread(1), f.projectPath), node("b", thread(1), other)])), /overlap/);
  assert.throws(() => validateProjectPlan(f.args([node("a", thread(1), f.projectPath), node("b", thread(2), f.projectPath)])), /overlap/);
  const gitRoot = path.join(f.dataDir, "git"); fs.mkdirSync(gitRoot);
  fs.mkdirSync(path.join(gitRoot, "a")); fs.mkdirSync(path.join(gitRoot, "b"));
  fs.writeFileSync(path.join(gitRoot, ".git"), "gitdir: .git-dir\n");
  fs.mkdirSync(path.join(gitRoot, ".git-dir"));
  // A shared repository is enough for validation to detect common Git metadata.
  fs.writeFileSync(path.join(gitRoot, "a", ".git"), "gitdir: ../.git-dir\n");
  fs.writeFileSync(path.join(gitRoot, "b", ".git"), "gitdir: ../.git-dir\n");
  assert.throws(() => validateProjectPlan({ objective: "Coordinate Git work", projectPath: gitRoot,
    nodes: [node("a", thread(3), path.join(gitRoot, "a")), node("b", thread(4), path.join(gitRoot, "b"))] }), /overlap/);
});

test("preparation remains blocked without a real adapter and never dispatches", t => {
  const f = fixture(t), coordinator = createProjectCoordinator({ dataDir: f.dataDir });
  const plan = coordinator.prepare(f.args());
  assert.equal(plan.status, "blocked");
  assert.equal(plan.nodes[0].status, "blocked");
  assert.equal(plan.adapter.verified, false);
  assert.match(plan.error, /adaptador del host/);
  assert.equal(plan.reservation.status, "held");
  assert.equal(plan.noDispatchVerified, true);
  assert.equal(unavailableProjectAdapter.turnDispatch, false);
});

test("pause and resume retain reservations; safe pre-dispatch cancellation releases them", t => {
  const f = fixture(t), coordinator = createProjectCoordinator({ dataDir: f.dataDir });
  const plan = coordinator.prepare(f.args());
  assert.equal(coordinator.pause(plan.id).status, "paused");
  assert.equal(coordinator.status(plan.id).reservation.status, "held");
  assert.equal(coordinator.resume(plan.id).status, "blocked");
  assert.equal(coordinator.status(plan.id).reservation.status, "held");
  assert.equal(coordinator.cancel(plan.id).status, "cancelled");
  assert.equal(coordinator.status(plan.id).reservation.status, "released");
});

test("restart during a possibly dispatched node requires review and preserves its lease", t => {
  const f = fixture(t), coordinator = createProjectCoordinator({ dataDir: f.dataDir });
  const plan = coordinator.prepare(f.args());
  const statePath = path.join(f.dataDir, "projects", plan.id, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.status = "running";
  state.nodes[0].status = "running";
  state.noDispatchVerified = false;
  fs.writeFileSync(statePath, JSON.stringify(state));
  assert.deepEqual(coordinator.recover(), [plan.id]);
  const recovered = coordinator.status(plan.id);
  assert.equal(recovered.status, "needs_review");
  assert.equal(recovered.nodes[0].status, "running");
  assert.equal(recovered.reservation.status, "needs_review");
  assert.match(recovered.recovery, /no node was relaunched/);
  assert.equal(coordinator.cancel(plan.id).status, "needs_review");
  assert.equal(coordinator.status(plan.id).reservation.status, "needs_review");
  assert.throws(() => coordinator.resume(plan.id), /Only a paused/);
});
