import fs from "node:fs";
import { createNativeFlow } from "./native-flow.mjs";
import { nativeProjectHost } from "./project-host.mjs";
import { checkNativeQueueAccess, launchNativeJoin } from "./native-join-supervisor.mjs";

const action = process.argv[2], dataDir = process.env.TFO_DATA_DIR;
if (action === "preflight") {
  console.log(JSON.stringify(checkNativeQueueAccess()));
} else if (action === "arm") {
  const { runId } = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  const flow = createNativeFlow({ dataDir, host: nativeProjectHost });
  const state = flow.status(runId), main = state.lanes.find(lane => lane.id === "main"), join = state.nodes.find(node => node.lane === "main");
  if (join.selection.model === main.selection.model && join.selection.reasoning === main.selection.reasoning)
    checkNativeQueueAccess(); // Failure leaves the flow unarmed and sends nothing.
  await flow.armJoin(runId);
  try {
    const supervisor = await launchNativeJoin(dataDir, runId);
    console.log(JSON.stringify({ runId, status: flow.status(runId).status, supervisor }));
  } catch (error) {
    flow.fail(runId, error.message); throw error;
  }
} else throw new Error("Use native-join-control.mjs preflight|arm [input.json]");
