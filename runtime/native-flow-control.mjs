import fs from "node:fs";
import { createNativeFlow } from "./native-flow.mjs";
import { nativeProjectHost } from "./project-host.mjs";
import { launchNativeCoordinator } from "./native-coordinator-supervisor.mjs";
import { prepareWorkEntry } from "./work-entry.mjs";
const flow = createNativeFlow({ dataDir: process.env.TFO_DATA_DIR, host: nativeProjectHost });
const args = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const op = process.argv[2];
let result;
if (op === "prepare") {
  const entry = await prepareWorkEntry(process.env.TFO_DATA_DIR, args);
  if (entry.pending) { process.stdout.write(JSON.stringify(entry.pending)); process.exit(0); }
  result = await flow.prepare(entry.args);
  if (result.coordinationMode === "active_main") {
    const supervisor = await launchNativeCoordinator(process.env.TFO_DATA_DIR, result.id);
    result = { ...flow.compact(result.id), supervisor };
  }
}
else if (op === "claim") result = await flow.claim(args.runId, args.nodeId);
else if (op === "acknowledge") result = await flow.acknowledge(args.runId, args.nodeId, args.threadId, args.workspace);
else if (op === "defer_dispatch") result = await flow.deferDispatch(args.runId, args.nodeId, args.hostEvidence);
else if (["status", "observe"].includes(op)) result = await flow[op](args.runId);
else if (op === "fail") result = flow.fail(args.runId, args.reason);
else if (["wait", "results", "revise", "checkpoint", "finish"].includes(op)) result = await flow[op](args.runId, args);
else if (["pause", "resume", "cancel", "reconcile", "recover"].includes(op)) {
  result = await flow[op](args.runId);
  if (op === "resume") await launchNativeCoordinator(process.env.TFO_DATA_DIR, args.runId);
}
else throw new Error("Unsupported native flow operation");
if (!["prepare", "claim", "wait", "results", "finish"].includes(op) && result?.coordinationMode === "active_main") result = flow.compact(args.runId);
process.stdout.write(JSON.stringify(result));
