const $ = id => document.getElementById(id);
const token = location.hash.slice(1);
let settings, catalog = [], guidance = {};
async function api(endpoint, data) {
  const response = await fetch(`/api/${endpoint}`, { method: data ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, ...(data ? { "Content-Type": "application/json" } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "No se pudieron guardar las opciones");
  return result;
}
function showError(error) { $("status").textContent = error.message; $("status").className = "error"; }
function limits() { return { usagePolicy: $("usage-policy").value, permissionPolicy: $("permission-policy").value,
  mode: $("mode-custom").checked ? "custom" : "intelligent", smartPreset: $("smart-preset").value,
  ...($("mode-custom").checked ? { customModel: $("custom-model").value, customEffort: $("custom-effort").value } : {}),
  maxCostMultiplier: Number($("cost-multiplier").value), maxEstimatedUsd: Number($("max-usd").value), maxWeeklyUsedPercent: Number($("weekly").value), maxParallelWorkers: Number($("parallel-workers").value), targetMinutes: Number($("target").value), extraMinutes: Number($("extra").value), timeMode: $("time-mode").value }; }
const effortNames = { low: "Bajo", medium: "Medio", high: "Alto", xhigh: "Muy alto", max: "Máximo", ultra: "Ultra" };
function options(select, entries, selected) { select.replaceChildren(); for (const [value, label] of entries) { const item = document.createElement("option"); item.value = value; item.textContent = label; select.append(item); } if (entries.some(([value]) => value === selected)) select.value = selected; }
function efforts(selected = settings.customEffort) {
  const model = catalog.find(item => (item.model || item.id) === $("custom-model").value);
  const entries = (model?.supportedReasoningEfforts || []).map(item => { const value = typeof item === "string" ? item : item.reasoningEffort; return [value, effortNames[value] || value]; });
  options($("custom-effort"), entries, selected); $("custom-effort").disabled = !entries.length;
}
function modeView() {
  const custom = $("mode-custom").checked;
  $("custom-fields").hidden = !custom; $("intelligent-fields").hidden = custom;
  $("mode-description").textContent = custom ? "El modelo y la potencia elegidos se mantienen en los nuevos turnos del maestro y sus auxiliares." : guidance[$("smart-preset").value] || "Elige modelo y potencia según cada tarea.";
  $("save-limits").disabled = custom && !catalog.length;
}
function render() {
  for (const [id, value] of Object.entries({ "usage-policy": settings.usagePolicy, "permission-policy": settings.permissionPolicy, "smart-preset": settings.smartPreset, "cost-multiplier": settings.maxCostMultiplier, "max-usd": settings.maxEstimatedUsd, weekly: settings.maxWeeklyUsedPercent, "parallel-workers": settings.maxParallelWorkers, target: settings.targetMinutes, extra: settings.extraMinutes, "time-mode": settings.timeMode })) $(id).value = value;
  $("mode-custom").checked = settings.mode === "custom"; $("mode-intelligent").checked = settings.mode !== "custom";
  options($("custom-model"), catalog.map(item => [item.model || item.id, item.displayName || item.model || item.id]), settings.customModel);
  $("custom-model").disabled = !catalog.length; efforts(); modeView();
}
async function save(patch) { $("save-limits").disabled = true; try { settings = await api("settings", { patch }); $("status").className = ""; $("status").textContent = "Opciones guardadas para trabajos nuevos. Deshabilitar TFO también bloquea próximos envíos de los trabajos existentes."; } catch (error) { showError(error); } finally { render(); } }
$("save-limits").onclick = () => save(Object.fromEntries(Object.entries(limits()).filter(([key, value]) => settings[key] !== value)));
$("mode-custom").onchange = $("mode-intelligent").onchange = $("smart-preset").onchange = modeView;
$("custom-model").onchange = () => efforts();
function appendParallelismControl(item, route) {
  if (!["project_flow", "native_tool_flow"].includes(route.kind)) return;
  const detail = document.createElement("p");
  detail.textContent = `${route.activeWorkers} auxiliares activos · límite ${route.maxParallelWorkers}`;
  if (route.effectiveMaxParallelWorkers < route.maxParallelWorkers) detail.textContent += ` · capacidad temporal ${route.effectiveMaxParallelWorkers}`;
  item.append(detail);
  if (!["provisioning", "launching", "running", "paused"].includes(route.status)) return;
  const label = document.createElement("label");
  label.textContent = "Límite de esta coordinación ";
  const input = document.createElement("input");
  input.type = "number"; input.min = "1"; input.max = "100"; input.step = "1";
  input.value = route.maxParallelWorkers;
  label.append(input);
  const button = document.createElement("button");
  button.textContent = "Aplicar a esta coordinación";
  button.onclick = async () => {
    if (!input.reportValidity()) return;
    button.disabled = true;
    try {
      await api("routes/control", { runId: route.id, action: "set_parallelism", maxParallelWorkers: Number(input.value) });
      await loadRoutes();
      $("status").textContent = "Límite actualizado. Las tareas activas pueden terminar antes de nuevos envíos.";
    } catch (error) { showError(error); button.disabled = false; }
  };
  item.append(label, button);
}
async function loadRoutes() {
  try { const routes = await api("routes"); $("route-list").replaceChildren(); if (!routes.length) $("route-list").textContent = "Todavía no hay rutas guardadas en este motor.";
    for (const route of routes) { const item = document.createElement("article"); item.className = "route"; const heading = document.createElement("h2"); heading.textContent = route.objective; const id = document.createElement("small"); id.textContent = route.id; const state = document.createElement("p"); state.className = "badge"; const labels = { pending: "Prompt preparado; esperando fin de turno", scheduled: "Esperando al turno actual", queued: "Esperando respuesta final", dispatching: "Enviando", running: "En ejecución", provisioning: "Preparando chats auxiliares", launching: "Iniciando coordinación", cancelling: "Cancelando; esperando tareas activas", finishing: "Verificando cierre", completed: "Completada", delivered_at_time: "Entregada por tiempo", paused: "Pausada", cancelled: "Cancelada", needs_review: "Requiere revisión" }; state.textContent = `${labels[route.status] || route.status} · ${route.completed}/${route.total} pasos`; const model = document.createElement("p"); model.textContent = route.plannedSelection ? `Selección prevista: ${route.plannedSelection.model} · ${route.plannedSelection.reasoning}` : route.execution ? `Última selección: ${route.execution.current.model} · ${route.execution.current.reasoning}` : "Ruta anterior sin selección registrada"; const reason = document.createElement("pre"); reason.textContent = route.error || route.lastDecision?.reason || ""; if (route.error) reason.className = "error"; if (route.time) { const progress = document.createElement("progress"); progress.max = 100; progress.value = route.time.progressPercent || 0; item.append(progress); } item.append(id, heading, state, model, reason); if (route.supervisor) { const observer = document.createElement("p"); observer.textContent = route.supervisor.status === "watching" ? "Supervisor iniciado; observando el turno" : "Supervisor: " + route.supervisor.status; item.append(observer); } if (route.currentStep) { const step = document.createElement("p"); step.textContent = `Siguiente paso: ${route.currentStep.title}`; item.append(step); } if (route.pendingPrompt) { const prompt = document.createElement("pre"); prompt.textContent = route.pendingPrompt; item.append(prompt); } if (route.remainingPrompts?.length) { const queue = document.createElement("details"); const title = document.createElement("summary"); title.textContent = `Cola guardada: ${route.remainingPrompts.length} prompts`; queue.append(title); for (const next of route.remainingPrompts) { const line = document.createElement("p"); line.textContent = `${next.title} · ${next.selection.model}/${next.selection.reasoning}: ${next.prompt}`; queue.append(line); } item.append(queue); } if (route.checkpoints?.length) { const history = document.createElement("ul"); for (const checkpoint of route.checkpoints) { const line = document.createElement("li"); line.textContent = `${checkpoint.success ? "✓" : "✗"} ${checkpoint.title}: ${checkpoint.summary}`; history.append(line); } item.append(history); } if (["pending", "queued", "dispatching"].includes(route.status) && /^(chat|queue)_/.test(route.id)) { for (const action of ["pause", "cancel"]) { const button = document.createElement("button"); button.textContent = action === "pause" ? "Pausar" : "Cancelar"; button.onclick = async () => { try { await api("routes/control", { runId: route.id, action }); await loadRoutes(); } catch (error) { showError(error); } }; item.append(button); } } appendParallelismControl(item, route); $("route-list").append(item); }
  } catch (error) { showError(error); }
}
function actionButton(label, action) { const button = document.createElement("button"); button.textContent = label; button.onclick = async () => { button.disabled = true; try { await action(); await loadPermissions(); } catch (error) { showError(error); button.disabled = false; } }; return button; }
async function loadPermissions() {
  try {
    const data = await api("work-policies"); $("work-list").replaceChildren(); $("grant-list").replaceChildren();
    if (!data.works.length) $("work-list").textContent = "No hay trabajos preparados.";
    for (const { work, allowed, reason } of data.works) {
      const item = document.createElement("article"); item.className = "route";
      const title = document.createElement("h3"); title.textContent = work.objective;
      const status = document.createElement("p"); status.textContent = allowed ? "Uso autorizado" : reason;
      const choice = document.createElement("select"); choice.setAttribute("aria-label", "Modo de este trabajo");
      options(choice, [...[...$("smart-preset").options].map(o => [o.value, o.textContent]), ["custom", "Custom"]], work.configuration.mode === "custom" ? "custom" : work.configuration.smartPreset);
      const model = document.createElement("select"), effort = document.createElement("select");
      model.setAttribute("aria-label", "Modelo de este trabajo"); effort.setAttribute("aria-label", "Potencia de este trabajo");
      options(model, catalog.map(entry => [entry.model || entry.id, entry.displayName || entry.model || entry.id]), work.configuration.customModel);
      const updateEfforts = () => { const entry = catalog.find(entry => (entry.model || entry.id) === model.value); options(effort, (entry?.supportedReasoningEfforts || []).map(item => { const value = item.reasoningEffort || item; return [value, effortNames[value] || value]; }), work.configuration.customEffort); };
      model.onchange = updateEfforts; updateEfforts();
      const updateMode = () => { model.hidden = effort.hidden = choice.value !== "custom"; }; choice.onchange = updateMode; updateMode();
      item.append(title, status, choice, model, effort, actionButton("Usar este modo", () => api("work-choice", { workId: work.id, accepted: true, planAccepted: work.invocation === "plan", policy: choice.value === "custom" ? { mode: "custom", customModel: model.value, customEffort: effort.value } : { mode: "intelligent", smartPreset: choice.value } })),
        actionButton("Continuar sin TFO", () => api("work-choice", { workId: work.id, accepted: false })));
      if (work.configuration.permissionPolicy === "ask") {
        const permission = document.createElement("select"); permission.setAttribute("aria-label", "Alcance del permiso");
        options(permission, [["chain", "Esta cadena de chats"], ["project", "Este proyecto"], ["always", "Permitir siempre"]], "chain");
        item.append(permission, actionButton("Permitir", () => api("work-permission", { workId: work.id, scope: permission.value })));
      }
      $("work-list").append(item);
    }
    for (const grant of data.grants.filter(g => !g.revokedAt)) {
      const item = document.createElement("article"); const label = document.createElement("p"); label.textContent = `${grant.scope === "project" ? "Proyecto" : "Cadena de chats"}: ${grant.key}`;
      item.append(label, actionButton("Revocar", () => api("work-revoke", { grantId: grant.id }))); $("grant-list").append(item);
    }
  } catch (error) { showError(error); }
}
for (const name of ["options", "routes", "permissions"]) $(name + "-tab").onclick = () => { for (const other of ["options", "routes", "permissions"]) { $(other).hidden = other !== name; $(other + "-tab").setAttribute("aria-pressed", String(other === name)); } if (name === "routes") void loadRoutes(); if (name === "permissions") void loadPermissions(); };
$("refresh").onclick = loadRoutes; $("refresh-permissions").onclick = loadPermissions;
try {
  settings = await api("settings");
  try { const result = await api("catalog"); catalog = result.models; guidance = result.presets; }
  catch { $("catalog-status").textContent = "No se pudo verificar el catálogo del host. Custom estará disponible cuando vuelva la conexión."; }
  render(); $("status").textContent = "Opciones listas.";
} catch (error) { showError(error); }
