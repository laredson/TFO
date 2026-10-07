import { equivalentUsd, normalizeUsage, roughTokens } from "./budget.mjs";

const normalized = value => value?.inputTokens !== undefined ? value : normalizeUsage(value);
const estimate = (item, selection, contextTokens) => equivalentUsd(selection, {
  inputTokens: contextTokens + roughTokens(item.prompt) + 400,
  outputTokens: item.expectedOutputTokens || 2048,
});
export function assertWorkBudget(work, state, metrics) {
  if (!work) return null;
  const config = work.configuration;
  if (config.maxWeeklyUsedPercent < 100 && !Number.isFinite(metrics?.weeklyUsedPercent)) throw new Error("Weekly limit cannot be checked; usage is unavailable. No new prompt was sent.");
  if (Number.isFinite(metrics?.weeklyUsedPercent) && metrics.weeklyUsedPercent >= config.maxWeeklyUsedPercent) throw new Error("Weekly usage limit reached; no new prompt was sent.");
  if (config.timeMode === "deliver_at_time" && Date.now() - Date.parse(state.createdAt || state.startedAt) >= (config.targetMinutes + config.extraMinutes) * 60000)
    throw new Error("Work time limit reached; pending work is preserved.");
  const items = state.nodes ? state.nodes.filter(node => !(state.coordinationMode === "active_main" && node.lane === "main")) : state.steps;
  const completed = state.nodes ? items.filter(node => node.checkpoint).map(node => ({ ...node.checkpoint, key: `${node.lane}:${node.checkpoint.turnId}` })) : state.completedSteps || [];
  const seen = new Set(); let spent = 0;
  for (const record of completed) {
    const key = record.key || record.messageId || record.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const usage = normalized(record.usage || record.actualUsage);
    if (usage && record.observed) spent += equivalentUsd(record.observed, usage);
  }
  const contextTokens = metrics?.lastResponseUsage?.input_tokens || 0;
  const pending = state.nodes ? items.filter(item => !item.checkpoint && item.status !== "cancelled") : items.slice(state.currentIndex || 0);
  const projected = pending.reduce((sum, item) => sum + estimate(item, item.selection, contextTokens), 0);
  const baseline = items.reduce((sum, item) => sum + estimate(item, item.normalSelection || item.decision?.normalSelection || item.selection, contextTokens), 0);
  const ceiling = Math.min(config.maxEstimatedUsd, config.explicitLimits?.includes("maxCostMultiplier") ? baseline * 1.25 * config.maxCostMultiplier : Infinity);
  if (spent + projected * 1.25 > ceiling) throw new Error("Estimated work exceeds the explicit API-equivalent budget; review tasks or limits before dispatch.");
  return { spentKnownEquivalentUsd: spent, projectedRemainingUsd: projected, ceilingUsd: ceiling, reserveFactor: 1.25,
    kind: "uncalibrated_estimate", missingUsageRecords: completed.filter(record => !normalized(record.usage || record.actualUsage)).length,
    weeklyUsedPercent: metrics?.weeklyUsedPercent ?? null, excludesUnreportedContext: true };
}
