import fs from "node:fs";
import path from "node:path";
import { equivalentUsd, normalizeUsage, PRICES } from "./budget.mjs";

const milliseconds = value => typeof value === "number" ? value : Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const iso = value => milliseconds(value) === null ? null : new Date(milliseconds(value)).toISOString();
export function exportMeasurements(dataDir, runId) {
  if (!/^(flow|queue|chat|route)_[a-z0-9_]+$/.test(runId || "")) throw new Error("Invalid run ID");
  const candidates = runId.startsWith("flow_") ? [path.join(dataDir, "native-flows", `${runId}.json`), path.join(dataDir, "parallel", runId, "state.json")]
    : [path.join(dataDir, "runs", runId, "state.json")];
  const source = candidates.find(file => fs.existsSync(file));
  if (!source) throw new Error("Unknown run");
  const state = JSON.parse(fs.readFileSync(source, "utf8"));
  const seen = new Set();
  const records = state.nodes ? state.nodes.map(node => ({ node, receipt: node.checkpoint || null, lane: node.lane })) :
    state.steps.map(node => ({ node, lane: "main", receipt: state.completedSteps?.find(item => item.id === node.id) || null }));
  const turns = records.map(({ node, receipt, lane }) => {
    const key = `${lane}:${receipt?.turnId || receipt?.messageId || node.id}`;
    const rawUsage = receipt?.usage || receipt?.actualUsage;
    const usage = rawUsage?.inputTokens !== undefined ? rawUsage : normalizeUsage(rawUsage);
    const duplicate = receipt && seen.has(key); if (receipt) seen.add(key);
    const startedAt = iso(receipt?.startedAt), completedAt = iso(receipt?.completedAt);
    const requested = receipt?.requested || node.selection || node.decision?.selected || null, observed = receipt?.observed || null;
    let usd = null; if (usage && observed && !duplicate && PRICES[observed.model]) usd = equivalentUsd(observed, usage);
    return { taskId: node.id, lane, kind: node.taskKind || "work", status: node.status || (receipt ? "completed" : "pending"),
      normalSelection: node.normalSelection || node.decision?.normalSelection || null, requested, observed,
      decisionRevision: node.policyRevision ?? null, preset: node.decision?.preset ?? null,
      verification: receipt?.verification || null, attemptAt: iso(node.attemptedAt), startedAt, completedAt,
      durationMs: startedAt && completedAt ? milliseconds(completedAt) - milliseconds(startedAt) : null,
      duplicateTurn: Boolean(duplicate), usage: duplicate ? null : usage, apiEquivalentUsd: usd,
      quality: null, qualityEvaluatedAt: null, concurrencyWaitMs: null };
  });
  const start = iso(state.createdAt || state.startedAt), finish = ["completed", "delivered_at_time"].includes(state.status) ? iso(state.updatedAt) : null;
  return { schemaVersion: 1, runId, status: state.status, exportedAt: new Date().toISOString(),
    configuration: state.workPolicy ? Object.fromEntries(["usagePolicy", "permissionPolicy", "mode", "smartPreset", "customModel", "customEffort"].map(key => [key, state.workPolicy.configuration[key]])) : null,
    startedAt: start, completedAt: finish, durationMs: start && finish ? milliseconds(finish) - milliseconds(start) : null,
    maxParallelWorkers: state.maxParallelWorkers ?? null, turns,
    knownApiEquivalentUsd: turns.reduce((sum, turn) => sum + (turn.apiEquivalentUsd || 0), 0),
    completeCostCoverage: turns.length > 0 && turns.every(turn => turn.duplicateTurn || turn.apiEquivalentUsd !== null),
    weeklyQuotaDeltaPoints: null, qualityEvaluations: [],
    priceBasis: { date: "2026-09-29", unit: "USD per million tokens; standard short-context API equivalent", rates: PRICES },
    limitations: ["API equivalent is not subscription quota or a billed charge.", "Missing measurements stay null; known cost is a partial sum when coverage is incomplete.",
      "Quality needs a shared rubric and human/functional evaluation; no score is inferred from completion.",
      "Concurrency waiting and weekly quota need separate observations; timestamps alone cannot attribute their cause.",
      "Inline checkpoints can share a single turn; token usage is counted once per lane and turn.",
      "Verification fields describe stored records; live-host acceptance must identify the environment separately."] };
}
