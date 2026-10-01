// Codex routing tiers, not a benchmark or price table. 6.1 Sol shares the GPT-6 tier family.
// Efforts follow the Codex host catalog (including ultra), not the public API catalog.
export const DEFAULT_SOL_MODEL = "gpt-6.1-sol";
export const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
export const MODELS = {
  "gpt-6-luna": { family: "6", rank: 0, maxEffort: "max" },
  "gpt-6.1-sol": { family: "6", rank: 1, maxEffort: "ultra" },
  "gpt-6-sol": { family: "6", rank: 1, maxEffort: "ultra", explicitOnly: true, replacement: DEFAULT_SOL_MODEL },
  "gpt-6-astra": { family: "6", rank: 2, maxEffort: "ultra" },
  "gpt-5.6-luna": { family: "5.6", rank: 0, maxEffort: "max" },
  "gpt-5.6-terra": { family: "5.6", rank: 1, maxEffort: "ultra" },
  "gpt-5.6-sol": { family: "5.6", rank: 2, maxEffort: "ultra" },
  "gpt-5.5": { family: "5.5", rank: 0, maxEffort: "xhigh" },
};
export const selectionSchema = {
  type: "object", additionalProperties: false, required: ["model", "reasoning"],
  properties: { model: { type: "string", enum: Object.keys(MODELS), description: "Prefer gpt-6.1-sol for the Sol tier. Use gpt-6-sol only when explicitly requested by the user; preserve exact observed source selections and approved plans." }, reasoning: { type: "string", enum: EFFORTS } },
};
export const assessmentSchema = {
  type: "object", additionalProperties: false, required: ["complexity", "confidence", "reason"],
  properties: {
    complexity: { type: "string", enum: ["routine", "standard", "complex"] },
    confidence: { type: "string", enum: ["high", "low"] },
    reason: { type: "string", minLength: 1 }, recommendation: selectionSchema,
  },
};
export function validateSelection(value) {
  const spec = MODELS[value?.model];
  const effort = EFFORTS.indexOf(value?.reasoning);
  if (!spec || effort < 0 || effort > EFFORTS.indexOf(spec.maxEffort)) throw new Error("Unsupported model or reasoning effort; no fallback will be used");
  return { model: value.model, reasoning: value.reasoning };
}
// Only an automatic choice may use this helper. Validation, receipts and explicit
// selections must keep exact IDs so an old Sol receipt can never satisfy a 6.1 request.
export function preferredSelection(value) {
  const selection = validateSelection(value);
  return { ...selection, model: MODELS[selection.model].replacement || selection.model };
}
export function validateAssessment(value) {
  if (value == null) return null;
  if (!["routine", "standard", "complex"].includes(value.complexity) || !["high", "low"].includes(value.confidence) || !String(value.reason || "").trim()) throw new Error("Assessment requires complexity, confidence and a reason");
  return { complexity: value.complexity, confidence: value.confidence, reason: String(value.reason).trim(),
    ...(value.recommendation ? { recommendation: validateSelection(value.recommendation) } : {}) };
}
function within(candidate, limit) {
  const a = MODELS[candidate.model], b = MODELS[limit.model];
  return a.family === b.family && a.rank <= b.rank && EFFORTS.indexOf(candidate.reasoning) <= EFFORTS.indexOf(limit.reasoning);
}
export function assertNotHigher(candidate, limit) {
  if (!within(validateSelection(candidate), validateSelection(limit))) throw new Error("Requested model/effort is higher than the observed host selection or uses a different generation");
}
export function assertQueueSelection(candidate, initial, explicitlyAuthorized = []) {
  candidate = validateSelection(candidate);
  initial = validateSelection(initial);
  if (MODELS[candidate.model].family !== MODELS[initial.model].family) throw new Error("A queue cannot change model generation");
  if (explicitlyAuthorized.some(item => item.model === candidate.model && item.reasoning === candidate.reasoning)) return;
  assertNotHigher(candidate, initial);
}
export function decideModel({ current, ceiling, assessment, settings }) {
  current = validateSelection(current);
  ceiling = validateSelection(ceiling);
  assessment = validateAssessment(assessment);
  if (!within(current, ceiling)) throw new Error("Current selection exceeds the authorized ceiling");
  const automatic = preferredSelection(current);
  let requested = automatic;
  if (assessment?.recommendation) requested = assessment.recommendation;
  else if (assessment?.confidence === "high" && assessment.complexity === "routine" && MODELS[current.model].family === "6") requested = { model: "gpt-6-luna", reasoning: "low" };
  if (!within(requested, ceiling)) throw new Error("Recommended model/effort exceeds the route ceiling or changes model generation. Review the plan.");
  const raises = !within(requested, current);
  if (raises && settings.allowUpgrades !== true) throw new Error("Model or effort increase blocked. Review the plan or explicitly enable upgrades in Options.");
  if (raises && settings.upgradeCeiling && !within(requested, settings.upgradeCeiling)) throw new Error("Recommended model/effort exceeds the upgrade limit in Options.");
  const explicitCurrent = assessment?.confidence === "high" && assessment.recommendation?.model === current.model;
  let selected = explicitCurrent ? current : automatic;
  if (assessment?.confidence === "high" && (raises || settings.economyEnabled === true)) selected = requested;
  return { previous: current, requested, selected, ceiling, changed: selected.model !== current.model || selected.reasoning !== current.reasoning,
    reason: assessment?.reason || (automatic.model !== current.model ? "Use GPT-6.1 Sol as the default Sol tier; GPT-6 Sol requires an explicit request" : "No confident assessment: keep the current selection"), economyEnabled: settings.economyEnabled === true,
    allowUpgrades: settings.allowUpgrades === true, decidedAt: new Date().toISOString() };
}
