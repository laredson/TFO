import { DEFAULT_SOL_MODEL } from "./model-policy.mjs";

export function reviewRequired(configuration) { return configuration?.mode === "intelligent" && ["hq", "max_hq"].includes(configuration.smartPreset); }
export function validateReviewTasks(nodes, lanes) {
  const terminals = nodes.filter(node => !nodes.some(other => other.dependencies.includes(node.id)));
  for (const node of nodes) {
    if (node.taskKind === "review" && (node.lane === "main" || lanes.find(lane => lane.id === node.lane)?.access !== "read"))
      throw new Error("Independent review requires a separate read-only lane");
    if (node.taskKind === "review_close" && (node.lane !== "main" || terminals.length !== 1 || terminals[0].id !== node.id ||
        node.dependencies.length !== 1 || nodes.find(other => other.id === node.dependencies[0])?.taskKind !== "review"))
      throw new Error("Review closure must be the sole final main task, directly after its independent review");
  }
}

export function addIndependentReview(args, policy) {
  if (!reviewRequired(policy.configuration)) return args;
  if ((args.coordinationMode || "active_main") !== "active_main") throw new Error("HQ/MaxHQ require active native coordination for an independent review");
  const final = args.nodes.find(node => !args.nodes.some(other => other.dependencies.includes(node.id)));
  if (!final || final.lane !== "main") throw new Error("Review requires one integrated final main task");
  const ids = new Set([...args.lanes, ...args.nodes].map(item => item.id));
  let suffix = 0; while ([`tfo_review_${suffix}`, `tfo_close_${suffix}`].some(id => ids.has(id))) suffix++;
  const reviewId = `tfo_review_${suffix}`, closeId = `tfo_close_${suffix}`;
  if (args.workspaceMode === "scratch_folders" && !args.reviewWorkspace) throw new Error("HQ/MaxHQ scratch mode requires an existing separate reviewWorkspace");
  return { ...args, lanes: [...args.lanes, { id: reviewId, title: "Revisión independiente", access: "read",
      ...(args.workspaceMode === "scratch_folders" ? { workspace: args.reviewWorkspace } : {}) }],
    nodes: [...args.nodes, { id: reviewId, lane: reviewId, dependencies: [final.id], title: "Revisar el resultado integrado", taskKind: "review",
      selection: { model: DEFAULT_SOL_MODEL, reasoning: "medium" },
      selectionReason: "Revisión independiente de calidad del resultado integrado.",
      prompt: "Revisa el entregable integrado y sus evidencias en el workspace del principal indicado en los prerrequisitos; tu propio worktree no contiene necesariamente la integración. Solo lectura. Comprueba requisitos, fallos y validación. Devuelve el JSON habitual y findings: [] si no quedan defectos, o findings con objetos {id,description,evidence}. No marques problemas como corregidos sin evidencia. No edites archivos." },
      { id: closeId, lane: "main", dependencies: [reviewId], title: "Cerrar tras revisión independiente", taskKind: "review_close",
        selection: args.initialSelection,
        normalSelection: policy.configuration.smartPreset === "hq" ? { ...args.initialSelection, model: args.initialSelection.model === "gpt-6-astra" ? DEFAULT_SOL_MODEL : "gpt-6-luna" } : args.initialSelection,
        selectionReason: "Integrar la revisión y verificar el cierre en el turno principal activo.",
        prompt: "Examina la revisión independiente. Corrige sus hallazgos mediante tareas dirigidas y solicita una nueva revisión. Finaliza solo con una revisión limpia posterior a los cambios." }] };
}
export function assertReviewComplete(state) {
  if (!state.workPolicy?.reviewRequired) return;
  validateReviewTasks(state.nodes, state.lanes);
  const reviews = state.nodes.filter(node => node.taskKind === "review" && node.checkpoint && node.status === "completed");
  const final = state.nodes.find(node => !state.nodes.some(other => other.dependencies.includes(node.id)));
  const latest = reviews.find(node => final?.taskKind === "review_close" && final.dependencies.includes(node.id));
  if (!latest || !Array.isArray(latest.checkpoint.report?.findings) || latest.checkpoint.report.findings.length)
    throw new Error("An independent review with no outstanding findings is required before completion");
  const covered = new Set();
  const visit = id => { if (covered.has(id)) return; covered.add(id); for (const dependency of state.nodes.find(node => node.id === id)?.dependencies || []) visit(dependency); };
  visit(latest.id);
  if (state.nodes.some(node => node.taskKind !== "review_close" && !covered.has(node.id)))
    throw new Error("Independent review must cover every implementation and correction task");
}
