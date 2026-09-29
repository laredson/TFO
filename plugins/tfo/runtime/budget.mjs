import { validateSelection } from "./model-policy.mjs";

// Standard, short-context API-equivalent USD per million tokens (2026-09-29).
// These prices do not describe Codex subscription quota consumption.
export const PRICES = Object.freeze({
  "gpt-6-luna": { input: 0.10, cached: 0.01, cacheWrite: 0.125, output: 0.50 },
  "gpt-6-sol": { input: 2.00, cached: 0.20, cacheWrite: 2.50, output: 10.00 },
  "gpt-6-astra": { input: 10.00, cached: 1.00, cacheWrite: 12.50, output: 50.00 },
});
export const roughTokens = value => Math.ceil(String(value || "").length / 4);
export function equivalentUsd(selection, usage) {
  const model = validateSelection(selection).model;
  const price = PRICES[model];
  if (!price) throw new Error(`No verified price for ${model}; review the budget before dispatch`);
  const cached = Math.max(0, Number(usage.cachedInputTokens || 0));
  const cacheWrite = Math.max(0, Number(usage.cacheWriteInputTokens || 0));
  const input = Math.max(0, Number(usage.inputTokens || 0) - cached - cacheWrite);
  const output = Math.max(0, Number(usage.outputTokens || 0));
  return (input * price.input + cached * price.cached + cacheWrite * price.cacheWrite + output * price.output) / 1_000_000;
}
export function normalizeUsage(value) {
  if (!value || !Number.isFinite(value.input_tokens) || !Number.isFinite(value.output_tokens)) return null;
  return { inputTokens: value.input_tokens, cachedInputTokens: value.cached_input_tokens || 0,
    cacheWriteInputTokens: value.cache_write_input_tokens || 0, outputTokens: value.output_tokens,
    reasoningOutputTokens: value.reasoning_output_tokens || 0, totalTokens: value.total_tokens || value.input_tokens + value.output_tokens };
}
export function estimateRouteBudget({ objective, constraints = "", steps, initialSelection, contextTokens = 0, maxCostMultiplier = 1, maxEstimatedUsd = Infinity, maxWeeklyUsedPercent = null }) {
  if (!Array.isArray(steps) || !steps.length) throw new Error("Steps are needed for a budget estimate");
  const baseInput = Math.max(0, Math.floor(contextTokens));
  const output = steps.reduce((sum, step) => sum + (step.expectedOutputTokens || 2048), 0);
  const baseline = equivalentUsd({ model: "gpt-6-sol", reasoning: "high" }, {
    inputTokens: baseInput + roughTokens(objective + constraints + steps.map(step => step.prompt).join("\n")), outputTokens: output,
  });
  let projected = 0, historyTokens = 0;
  const estimates = steps.map((step, index) => {
    const selection = step.assessment?.confidence === "low" ? initialSelection : step.assessment?.recommendation || initialSelection;
    const input = baseInput + roughTokens(objective + constraints + step.prompt) + 400 + historyTokens;
    const tokens = { inputTokens: input, outputTokens: step.expectedOutputTokens || 2048 };
    historyTokens += roughTokens(step.prompt) + tokens.outputTokens;
    const usd = equivalentUsd(selection, tokens);
    projected += usd;
    return { stepId: step.id, selection, tokens, usd };
  });
  if (!Number.isFinite(maxCostMultiplier) || maxCostMultiplier < 1 || maxCostMultiplier > 20) throw new Error("Invalid cost multiplier");
  const ceiling = Math.min(baseline * maxCostMultiplier, maxEstimatedUsd);
  return { priceBasis: "OpenAI API standard short-context, verified 2026-09-29", baselineUsd: baseline,
    estimateKind: "uncalibrated_heuristic", confidence: "low", latencyEstimate: null,
    assumptions: ["Baseline is one hypothetical Sol turn, not measured savings.",
      "No cache discount; prior planned prompts and outputs are repeated in later turns.",
      "Expected output must include reasoning tokens; effort is not a calibrated multiplier.",
      "Tool calls, hidden context growth, retries and long-context pricing are not predicted.",
      "API-equivalent dollars do not measure Codex subscription quota."],
    projectedUsd: projected, ceilingUsd: ceiling, reserveFactor: 1.25,
    withinBudget: projected * 1.25 <= ceiling,
    maxWeeklyUsedPercent, contextTokens: baseInput, estimates };
}
