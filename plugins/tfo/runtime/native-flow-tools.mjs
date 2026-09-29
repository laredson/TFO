import { projectFlowTools } from "./project-flow-tools.mjs";
import { selectionSchema } from "./model-policy.mjs";
const prepare = structuredClone(projectFlowTools[0].inputSchema);
prepare.required.push("workspaceMode", "mainWorkspace");
Object.assign(prepare.properties, {
  workspaceMode: { type: "string", enum: ["scratch_folders"] }, mainWorkspace: { type: "string" },
  maxParallelWorkers: { type: "integer", minimum: 1, maximum: 8, default: 2 },
  authorizedSelections: { type: "array", items: selectionSchema, description: "Only exact user-authorized model/effort pairs above the initial ceiling; must occur in the plan." },
});
prepare.properties.lanes.items.required.push("workspace");
prepare.properties.lanes.items.properties.workspace = { type: "string" };
prepare.properties.nodes.items.required.push("selection");
prepare.properties.nodes.items.properties.selection = selectionSchema;
prepare.properties.nodes.items.properties.selectionReason = { type: "string", description: "AI assessment for the requested model/effort; required when the final main selection differs from its source turn." };
delete prepare.properties.currentNodeId;
export const nativeFlowTools = [
  { name: "tfo_native_prepare", description: "Prepare a supervised flow dispatched through native Codex tools, with per-task models, exact receipts and a configurable worker limit. Requires explicitly authorized distinct scratch directories outside Git. Worker selection changes require a live host-tool caller. A changed final main selection uses the guarded visible Codex composer; include the returned mainJoinMarker in the source main turn's final response so TFO can verify the displayed target. Native queue preserves only the source selection. Claim actions, execute exactly the returned native call once, acknowledge, then observe receipts. Do not substitute for a verified Git worktree flow.", inputSchema: prepare },
  ...["claim", "acknowledge", "observe", "status", "fail"].map(action => ({
    name: `tfo_native_${action}`, description: `Native-tool flow ${action}. Claim persists intent before ONE native tool call; never claim or resend an attempted action. Acknowledge only a real host thread ID. Observe verifies completed native delegation receipts, actual model/effort and worker report before dependencies advance. Failure retains reservations for review.`,
    inputSchema: { type: "object", additionalProperties: false,
      required: ["runId", ...(["claim", "acknowledge"].includes(action) ? ["nodeId"] : []), ...(action === "acknowledge" ? ["threadId"] : []), ...(action === "fail" ? ["reason"] : [])],
      properties: Object.fromEntries(["runId", "nodeId", "threadId", "reason"].map(key => [key, { type: "string" }])) },
  })),
];
