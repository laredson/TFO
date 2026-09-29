import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { estimateRouteBudget } from "../budget.mjs";
import { createChatRouter } from "../chat-route.mjs";
import { createSettingsStore } from "../settings.mjs";

const luna = { model: "gpt-6-luna", reasoning: "medium" };
const sol = { model: "gpt-6-sol", reasoning: "medium" };
const steps = Array.from({ length: 3 }, (_, index) => ({ id: `step-${index + 1}`, title: `Paso ${index + 1}`, prompt: "Verifica una línea del archivo.", assessment: { complexity: "routine", confidence: "high", reason: "Edición sencilla", recommendation: luna }, expectedOutputTokens: 300 }));

test("division accounts for repeated context and rejects a split above the cost ceiling", () => {
  const estimate = estimateRouteBudget({ objective: "Editar una nota", steps, initialSelection: sol, contextTokens: 80000, maxCostMultiplier: 1 });
  assert.equal(estimate.estimates.length, 3);
  assert.ok(estimate.estimates.every(item => item.tokens.inputTokens >= 80000));
  assert.ok(estimate.projectedUsd < estimate.baselineUsd);
  const expensive = estimateRouteBudget({ objective: "Editar una nota", steps: steps.map(step => ({ ...step, assessment: null })), initialSelection: sol, contextTokens: 80000, maxCostMultiplier: 1 });
  assert.equal(expensive.withinBudget, false);
});

test("weekly limit stops a budgeted chat before dispatch and leaves legacy route compatibility", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-budget-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  createSettingsStore(dir).update({ maxWeeklyUsedPercent: 8 });
  let count = 0;
  const router = createChatRouter({ dataDir: dir, dispatch: async () => { count++; return "turn-1"; }, readMetrics: async () => ({ weeklyUsedPercent: 9, lastResponseUsage: { input_tokens: 80000 } }) });
  const args = { objective: "Editar una nota", projectPath: dir, threadId: "12345678-1234-1234-1234-123456789abc", initialSelection: sol, steps };
  await assert.rejects(router.start({ ...args, enforceBudget: true }), /Weekly usage limit/);
  assert.equal(count, 0);
  assert.equal((await router.start(args)).status, "queued");
});

test("estimates carry growing history and do not treat uncertain recommendations as savings", () => {
  const uncertain = steps.map(step => ({ ...step, assessment: { ...step.assessment, confidence: "low" } }));
  const budget = estimateRouteBudget({ objective: "Test", steps: uncertain, initialSelection: sol });
  assert.equal(budget.estimates[0].selection.model, sol.model);
  assert.ok(budget.estimates[2].tokens.inputTokens >= budget.estimates[0].tokens.inputTokens + 600);
  assert.equal(budget.confidence, "low"); assert.equal(budget.latencyEstimate, null);
});
