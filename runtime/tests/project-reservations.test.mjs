import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createProjectReservationStore } from "../project-reservations.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const thread = n => `12345678-1234-1234-1234-${String(n).padStart(12, "0")}`;
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-project-reservations-"));
  const workspace = path.join(dataDir, "workspace");
  const otherWorkspace = path.join(dataDir, "other-workspace");
  const commonDir = path.join(dataDir, "git-common");
  for (const dir of [workspace, otherWorkspace, commonDir]) fs.mkdirSync(dir);
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const plan = (id, options = {}) => ({ nodes: [{ id, threadId: options.threadId || thread(Number(id.replace(/\D/g, "")) || 1),
    workspace: options.workspace || workspace, gitCommonDir: options.gitCommonDir ?? null, access: options.access || "write" }] });
  return { dataDir, workspace, otherWorkspace, commonDir, plan };
}

test("reservations serialize shared chats and writable checkouts while allowing shared reads", t => {
  const f = fixture(t), store = createProjectReservationStore({ dataDir: f.dataDir });
  store.reserve("read-a", f.plan("node1", { access: "read" }));
  store.reserve("read-b", f.plan("node2", { access: "read", threadId: thread(2) }));
  assert.throws(() => store.reserve("write-c", f.plan("node3", { access: "write", threadId: thread(3) })), /reserved by another plan/);
  assert.throws(() => store.reserve("same-chat", f.plan("node4", { access: "read", workspace: f.otherWorkspace, threadId: thread(1) })), /reserved by another plan/);
});

test("same Git common directory is not shared for writes without verified isolation", t => {
  const f = fixture(t), store = createProjectReservationStore({ dataDir: f.dataDir });
  store.reserve("git-a", f.plan("node1", { workspace: f.workspace, gitCommonDir: f.commonDir, threadId: thread(1) }));
  assert.throws(() => store.reserve("git-b", f.plan("node2", { workspace: f.otherWorkspace, gitCommonDir: f.commonDir, threadId: thread(2) })), /reserved by another plan/);
});

test("a writable parent also reserves child directories across different flows", t => {
  const f = fixture(t), store = createProjectReservationStore({ dataDir: f.dataDir });
  store.reserve("parent", f.plan("node1"));
  assert.throws(() => store.reserve("child", f.plan("node2", { workspace: path.join(f.workspace, "child") })), /reserved by another plan/);
});

test("verified isolation can share Git metadata only across distinct workspaces", t => {
  const f = fixture(t), adapter = { verified: true, workspaceIsolation: true, gitIsolation: true, isolationProof: "proof-verified-by-host-2026" };
  const store = createProjectReservationStore({ dataDir: f.dataDir, adapter });
  store.reserve("git-a", f.plan("node1", { workspace: f.workspace, gitCommonDir: f.commonDir, threadId: thread(1) }));
  assert.doesNotThrow(() => store.reserve("git-b", f.plan("node2", { workspace: f.otherWorkspace, gitCommonDir: f.commonDir, threadId: thread(2) })));
  assert.throws(() => store.reserve("same-checkout", f.plan("node3", { workspace: f.workspace, gitCommonDir: f.commonDir, threadId: thread(3) })), /reserved by another plan/);
});

test("uncertain leases survive and cannot be released or reused", t => {
  const f = fixture(t), store = createProjectReservationStore({ dataDir: f.dataDir });
  store.reserve("uncertain", f.plan("node1"));
  store.markUncertain("uncertain", "host receipt missing");
  assert.throws(() => store.release("uncertain", "completed_receipt_verified"), /cannot be released automatically/);
  assert.throws(() => store.reserve("uncertain", f.plan("node2")), /cannot be reused/);
});

test("released run IDs cannot be reused to hide an older lease", t => {
  const f = fixture(t), store = createProjectReservationStore({ dataDir: f.dataDir });
  store.reserve("once", f.plan("node1"));
  store.release("once", "cancelled_before_dispatch");
  assert.throws(() => store.reserve("once", f.plan("node2")), /cannot be reused/);
  assert.equal(store.get("once").status, "released");
});

test("held run IDs are idempotent only for their original resource set", t => {
  const f = fixture(t), store = createProjectReservationStore({ dataDir: f.dataDir });
  const original = store.reserve("stable", f.plan("node1"));
  assert.equal(store.reserve("stable", f.plan("node1")).acquiredAt, original.acquiredAt);
  assert.throws(() => store.reserve("stable", f.plan("node2", { workspace: f.otherWorkspace })), /cannot be rebound/);
});

test("concurrent processes acquire one writable checkout reservation", async t => {
  const f = fixture(t), workers = 8;
  const code = `
    import { pathToFileURL } from 'node:url';
    import path from 'node:path';
    const [repo, dataDir, workspace, threadId, runId] = process.argv.slice(1);
    const { createProjectReservationStore } = await import(pathToFileURL(path.join(repo, 'runtime', 'project-reservations.mjs')));
    const store = createProjectReservationStore({ dataDir });
    try { store.reserve(runId, { nodes: [{ id: 'node', threadId, workspace, gitCommonDir: null, access: 'write' }] }); process.stdout.write('ok'); }
    catch (error) { if (!error.message.includes('reserved by another plan')) { process.stderr.write(error.stack); process.exitCode = 2; } else process.stdout.write('conflict'); }
  `;
  const results = await Promise.all(Array.from({ length: workers }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, root, f.dataDir, f.workspace, thread(index + 1), `parallel-${index}`], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", value => stdout += value);
    child.stderr.setEncoding("utf8").on("data", value => stderr += value);
    child.on("error", reject);
    child.on("close", status => status === 0 ? resolve(stdout) : reject(new Error(stderr || `child exited ${status}`)));
  })));
  assert.equal(results.filter(value => value === "ok").length, 1, results.join(","));
  assert.equal(results.filter(value => value === "conflict").length, workers - 1, results.join(","));
});
