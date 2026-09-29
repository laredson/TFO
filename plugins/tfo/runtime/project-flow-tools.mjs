import { selectionSchema } from "./model-policy.mjs";

export const projectFlowTools = [
  { name: "tfo_parallel_prepare", description: "Plan authorized parallel Codex chats and dependency chains. Returns bootstrap prompts; create each worker once using native Codex create_thread in the same project, then bind and start. Use verified Git worktrees for repository writes. scratch_folders is limited to disposable non-Git child folders and is not a sandbox. TFO is the conventional scheduler after setup. ChatGPT Project execution is not supported yet.", inputSchema: {
    type: "object", additionalProperties: false,
    required: ["surface", "objective", "projectPath", "projectId", "mainThreadId", "initialSelection", "lanes", "nodes"],
    properties: {
      surface: { type: "string", enum: ["codex"] }, objective: { type: "string" }, constraints: { type: "string" },
      projectPath: { type: "string" }, projectId: { type: "string" }, mainThreadId: { type: "string" },
      workspaceMode: { type: "string", enum: ["git_worktrees", "scratch_folders"], description: "Defaults to git_worktrees. scratch_folders is only for disposable non-Git project trees with separate child folders." },
      mainWorkspace: { type: "string", description: "Required in scratch_folders mode: the final main lane's dedicated child folder." },
      currentNodeId: { type: "string", description: "Optional prerequisite-free main node the planning AI performs in THIS turn while workers run. TFO records its final response as that node's result after this turn ends." },
      initialSelection: selectionSchema, mainAccess: { type: "string", enum: ["read", "write"] }, maxTurnMinutes: { type: "integer", minimum: 1, maximum: 240 },
      lanes: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", additionalProperties: false, required: ["id", "access"], properties: {
        id: { type: "string" }, title: { type: "string" }, access: { type: "string", enum: ["read", "write"] },
        workspace: { type: "string", description: "Required in scratch_folders mode: this lane's dedicated child folder." },
      } } },
      nodes: { type: "array", minItems: 2, maxItems: 40, items: { type: "object", additionalProperties: false, required: ["id", "lane", "prompt", "dependencies"], properties: {
        id: { type: "string" }, lane: { type: "string" }, title: { type: "string" }, prompt: { type: "string" },
        dependencies: { type: "array", items: { type: "string" } }, expectedResponse: { type: "string" },
      } } },
    },
  } },
  { name: "tfo_parallel_bind", description: "Bind one native worker chat to a prepared lane. Use the real thread ID and workspace returned by the host, not a queued clientThreadId. TFO verifies rollout identity, bootstrap response, branch and Git worktree registration before scheduling.", inputSchema: {
    type: "object", additionalProperties: false, required: ["runId", "laneId", "threadId", "workspace"],
    properties: Object.fromEntries(["runId", "laneId", "threadId", "workspace"].map(key => [key, { type: "string" }])),
  } },
  ...["start", "status", "pause", "resume", "cancel"].map(action => ({ name: `tfo_parallel_${action}`,
    description: action === "start"
      ? "Start an acknowledged persistent TFO supervisor after all worker chats are bound. Workers run independently, dependent nodes wait for verified final receipts, and main receives joined results after its current turn ends. End this turn when its work is ready; no AI polling or self-message is needed."
      : `${action} a parallel project flow. Pause stops future sends while existing turns finish. Cancel drains active turns and preserves files. Uncertain delivery stops for review and never retries.`,
    inputSchema: { type: "object", additionalProperties: false, required: ["runId"], properties: { runId: { type: "string" } } },
  })),
];
