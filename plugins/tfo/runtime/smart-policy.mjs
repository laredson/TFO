import { DEFAULT_SOL_MODEL, EFFORTS, MODELS, validateSelection } from "./model-policy.mjs";

export const SMART_MODELS = ["gpt-6-luna", DEFAULT_SOL_MODEL, "gpt-6-astra"];
export const SMART_PRESETS = ["normal", "saving", "fast", "max_speed", "quality", "hq", "maximum", "max_hq"];
export const USAGE_POLICIES = ["automatic", "plan_or_ask", "ask_once"];
export const PERMISSION_POLICIES = ["allow", "ask", "disabled"];
export const PRESET_GUIDANCE = Object.freeze({
  normal: "Equilibra calidad, tiempo y coste total según cada tarea; sin cuotas por modelo.",
  saving: "Minimiza el coste total esperado, incluidas correcciones y contexto. Sol puede resultar más económico que Luna.",
  fast: "Reduce la duración total con mejoras proporcionadas al sobrecoste, incluyendo coordinación e integración.",
  max_speed: "Da mayor prioridad a la velocidad que Rápido; evita grandes sobrecostes por mejoras mínimas. Sin umbrales rígidos.",
  quality: "Eleva Luna a Sol y Sol a Astra, conservando la potencia. Astra conserva su potencia.",
  hq: "Calidad más revisión independiente del entregable integrado y corrección de hallazgos.",
  maximum: "Busca mejoras perceptibles de calidad y velocidad. Puede conservar Luna alto; no impone un mínimo de potencia.",
  max_hq: "Máximo más revisión independiente del entregable integrado y corrección de hallazgos.",
});
export const POLICY_KEYS = ["usagePolicy", "permissionPolicy", "mode", "smartPreset", "customModel", "customEffort"];
export function validateSmartOptions(value) {
  if (!USAGE_POLICIES.includes(value.usagePolicy) || !PERMISSION_POLICIES.includes(value.permissionPolicy) ||
      !["intelligent", "custom"].includes(value.mode) || !SMART_PRESETS.includes(value.smartPreset) || !SMART_MODELS.includes(value.customModel))
    throw new Error("Invalid smart mode, usage or permission options");
  validateSelection({ model: value.customModel, reasoning: value.customEffort });
  return value;
}
export function assertAvailable(selection, catalog) {
  validateSelection(selection);
  if (!SMART_MODELS.includes(selection.model)) throw new Error("New smart/custom work supports Luna 6, Sol 6.1 and Astra 6 only");
  if (catalog) {
    const entry = catalog.find(item => (item.model || item.id) === selection.model && !item.hidden);
    const efforts = entry?.supportedReasoningEfforts?.map(item => typeof item === "string" ? item : item.reasoningEffort);
    if (!entry || !efforts?.includes(selection.reasoning)) throw new Error("Requested model/effort is unavailable in this host; no fallback");
  }
  return selection;
}
export function decideTask({ configuration, normalSelection, recommendation, reason, catalog, ceiling }) {
  validateSmartOptions(configuration);
  const normal = assertAvailable(validateSelection(normalSelection), catalog);
  let selected;
  const preset = configuration.smartPreset;
  if (configuration.mode === "custom") selected = { model: configuration.customModel, reasoning: configuration.customEffort };
  else if (["quality", "hq"].includes(preset)) selected = { model: SMART_MODELS[Math.min(2, SMART_MODELS.indexOf(normal.model) + 1)], reasoning: normal.reasoning };
  else selected = recommendation ? validateSelection(recommendation) : normal;
  assertAvailable(selected, catalog);
  if (ceiling) validateSelection(ceiling);
  if (ceiling && (MODELS[selected.model].family !== MODELS[ceiling.model].family || MODELS[selected.model].rank > MODELS[ceiling.model].rank || EFFORTS.indexOf(selected.reasoning) > EFFORTS.indexOf(ceiling.reasoning)))
    throw new Error("Task selection exceeds the explicit work ceiling");
  if (typeof reason !== "string" || !reason.trim()) throw new Error("Every task needs a model/effort decision reason");
  return { policyVersion: 1, mode: configuration.mode, preset: configuration.mode === "intelligent" ? preset : null,
    normalSelection: normal, requested: selected, selected, reason: reason.trim(),
    reviewRequired: configuration.mode === "intelligent" && ["hq", "max_hq"].includes(preset),
    guidance: configuration.mode === "custom" ? "Modelo y potencia fijados por el usuario." : PRESET_GUIDANCE[preset],
    estimateOnly: true, decidedAt: new Date().toISOString() };
}

export const workPolicyProperties = {
  workId: { type: "string", description: "ID returned by tfo_work_prepare; reuses the work's choices and scoped permission." },
  policy: { type: "object", additionalProperties: false, properties: {
    usagePolicy: { type: "string", enum: USAGE_POLICIES }, permissionPolicy: { type: "string", enum: PERMISSION_POLICIES },
    mode: { type: "string", enum: ["intelligent", "custom"] }, smartPreset: { type: "string", enum: SMART_PRESETS },
    customModel: { type: "string", enum: SMART_MODELS }, customEffort: { type: "string", enum: EFFORTS },
  } },
  invocation: { type: "string", enum: ["prompt", "plan"], default: "prompt" },
  planAccepted: { type: "boolean", description: "True only after the human accepted execution of this plan." },
  usageAccepted: { type: "boolean", description: "True only when the human already chose to use TFO for this work." },
};
