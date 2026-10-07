import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { snapshotNativeCoordinator, restoreNativeCoordinators, launchNativeCoordinator } from "../native-coordinator-supervisor.mjs";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-coordinator-"));
  fs.mkdirSync(path.join(dataDir, "native-flows"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const save = (id, value) => fs.writeFileSync(path.join(dataDir, "native-flows", `${id}.json`), JSON.stringify({ id, ...value }));
  return { dataDir, save };
}
test("coordinator snapshots are immutable and include all runtime imports", async t => {
  const f = fixture(t), runtime = snapshotNativeCoordinator(f.dataDir);
  assert.equal(snapshotNativeCoordinator(f.dataDir), runtime);
  for (const file of ["native-flow.mjs", "settings.mjs", "native-coordinator-supervisor.mjs", "project-host.mjs"]) assert.ok(fs.existsSync(path.join(runtime, file)));
  fs.appendFileSync(path.join(runtime, "native-flow.mjs"), "\n// damaged snapshot");
  assert.throws(() => snapshotNativeCoordinator(f.dataDir), /integrity/);
});
test("restoration only observes active-mode nonterminal flows", async t => {
  const f = fixture(t), called = [];
  f.save("flow_active", { coordinationMode: "active_main", status: "running" });
  f.save("flow_paused", { coordinationMode: "active_main", status: "paused" });
  f.save("flow_legacy", { status: "running" });
  f.save("flow_review", { coordinationMode: "active_main", status: "needs_review" });
  f.save("flow_done", { coordinationMode: "active_main", status: "completed" });
  await restoreNativeCoordinators(f.dataDir, async (_, id) => { called.push(id); return { runId: id }; });
  assert.deepEqual(called.sort(), ["flow_active", "flow_paused"]);
});
test("a live acknowledged observer is reused instead of launching a second process", async t => {
  const f = fixture(t);
  f.save("flow_owned", { coordinationMode: "active_main", status: "running", coordinator: { observerPid: process.pid } });
  const result = await launchNativeCoordinator(f.dataDir, "flow_owned");
  assert.equal(result.launchMode, "already_running");
  assert.equal(result.pid, process.pid);
});
