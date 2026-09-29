// Product identity is explicit: a ChatGPT conversation ID is not a Codex rollout ID.
export const surfaces = ["codex", "chatgpt-chat", "chatgpt-work"];
export const connectionResource = "ui://tfo/connection-v1.html";
export function connectionCheck(surface) {
  if (!surfaces.includes(surface)) throw new Error("Choose codex, chatgpt-chat or chatgpt-work explicitly");
  const codex = surface === "codex";
  return {
    surface, surfaceSource: "caller_declared", mcpConnected: true,
    diagnosticOnly: true, sendEnabled: false, sendEnabledScope: "this_diagnostic_only",
    dispatchReadiness: "not_evaluated",
    nativeQueue: codex ? "historically_verified_same_selection" : "not_applicable",
    automaticDelivery: codex ? "historically_verified_same_chat" : "adapter_missing",
    modelAndEffortSwitch: codex ? "historically_verified_same_chat" : "unverified",
    parallelProjects: codex ? { tools: "tfo_parallel_*", provisioning: "native_codex_app_tools",
      scheduling: "persistent_conventional_supervisor", transport: "native_queue_same_selection",
      liveEvidence: "three_scratch_folder_worker_chains_completed", branchIsolation: "unverified",
      mainJoin: "independent_deferred_return_verified_after_worker_and_source_turn_completion",
      mainSelectionChange: "guarded_visible_composer_connected_live_unverified" } : { status: "adapter_missing" },
    perTaskSelection: codex ? { tools: "tfo_native_*", driver: "supervised_native_tools", unattended: false,
      workspaceMode: "scratch_folders", liveEvidence: "nine_supervised_turns_with_requested_luna_sol_and_low_medium_selections",
      activeMainSwitch: "unsupported_self_injection_observed_and_blocked", statistics: "functional_pilot_not_calibrated_benchmark" } : { status: "adapter_missing" },
    turnObserver: codex ? "local_codex_rollout" : "adapter_missing",
    stopHook: codex ? "requires_host_trust" : "not_assumed",
    uiBridge: "must_be_checked_in_rendered_panel",
    blockers: codex
      ? ["Readiness is checked per flow, never inferred from this diagnostic.", "Worker model changes required an active native-tool caller; only the deferred main return with inherited selection was independently supervised.", "Changed final main selection has a guarded visible-composer adapter but still needs a live Desktop receipt; its source final response must display the returned unique mainJoinMarker.", "Web delivery, Git branch isolation, and a fully unattended model-switching chain remain unverified."]
      : ["Normal Chat/ChatGPT Work delivery and turn observation are not implemented by this local runtime.", "A reachable MCP tool and a rendered widget do not prove autonomous delivery or model selection."],
    nextGate: codex ? "Verify the target project, native chat provisioning and actual turn receipts" : "Confirm this tool is callable in the target chat, then inspect the MCP Apps bridge without sending",
  };
}
