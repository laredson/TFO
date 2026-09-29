// Read-only host observer for an already dispatched final handoff. No sending.
import { createNativeFlow } from "./native-flow.mjs";
import { nativeProjectHost } from "./project-host.mjs";
const runId = process.argv[2];
const flow = createNativeFlow({ dataDir: process.env.TFO_DATA_DIR, host: nativeProjectHost });
while (true) {
  const state = await flow.observe(runId);
  if (state.status !== "running") { console.log(JSON.stringify({ runId, status: state.status, error: state.error })); break; }
  if (!state.nodes.some(node => ["queued", "dispatching"].includes(node.status))) break;
  await new Promise(resolve => setTimeout(resolve, 2000));
}
