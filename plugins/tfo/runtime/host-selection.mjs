// Codex Desktop 0.155 local rollout adapter. Unknown/migrated formats fail closed.
// Read only the identified thread's model metadata; never export conversation text.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { validateSelection } from "./model-policy.mjs";
// Persisted with a queue so a hot-installed observer cannot silently reinterpret
// the preparing process's user-message count.
export const HOST_OBSERVATION_VERSION = 1;
export function findRollout(threadId, codexDir = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) throw new Error("Invalid host thread ID");
  const matches = [];
  function search(dir, depth) {
    if (depth > 4 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const location = path.join(dir, entry.name);
      if (entry.isDirectory()) search(location, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) matches.push(location);
    }
  }
  search(path.join(codexDir, "sessions"), 0);
  if (matches.length !== 1) throw new Error("Cannot verify this thread in local Codex history. Review host compatibility.");
  return matches[0];
}
export async function readHostSelection(threadId, codexDir) {
  let selection;
  const lines = readline.createInterface({ input: fs.createReadStream(findRollout(threadId, codexDir)), crlfDelay: Infinity });
  for await (const line of lines) {
    // Avoid parsing large tool outputs unrelated to model selection.
    if (!line.includes('"turn_context"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "turn_context") selection = { model: entry.payload?.model, reasoning: entry.payload?.effort };
  }
  if (!selection) throw new Error("No host model metadata found. No prompt was sent.");
  return validateSelection(selection);
}
function messageText(payload) {
  return payload?.content?.filter(item => item.type === "input_text").map(item => item.text).join("\n") || "";
}
function isInjectedEnvironmentContext(text) {
  return /^\s*<environment_context>[\s\S]*<\/environment_context>\s*$/.test(text);
}
// Reads only lifecycle and usage metadata, never the conversation text.
export async function readHostTurnState(threadId, codexDir) {
  let started = null, completed = null, lastTurnId = null, model = null, reasoning = null, selectionTurnId = null;
  let interruptedTurnId = null;
  let userMessageCount = 0;
  let usage = null, lastResponseUsage = null, weeklyUsedPercent = null;
  const lines = readline.createInterface({ input: fs.createReadStream(findRollout(threadId, codexDir)), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"task_started"') && !line.includes('"task_complete"') && !line.includes('"turn_aborted"') && !line.includes('"task_failed"') && !line.includes('"turn_context"') && !line.includes('"token_usage_record"') && !line.includes('"token_count"') && !(line.includes('"response_item"') && line.includes('"role"') && line.includes('"user"'))) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "event_msg" && entry.payload?.type === "task_started") { started = entry.payload.turn_id; lastTurnId = started; userMessageCount = 0; }
    if (entry.type === "response_item" && entry.payload?.type === "message" && entry.payload.role === "user" &&
        !isInjectedEnvironmentContext(messageText(entry.payload))) userMessageCount += 1;
    if (entry.type === "event_msg" && entry.payload?.type === "task_complete") completed = entry.payload.turn_id;
    if (entry.type === "event_msg" && ["turn_aborted", "task_failed"].includes(entry.payload?.type)) interruptedTurnId = entry.payload.turn_id || started;
    if (entry.type === "turn_context") { model = entry.payload?.model; reasoning = entry.payload?.effort; selectionTurnId = entry.payload?.turn_id || null; }
    if (entry.type === "token_usage_record") { usage = entry.payload?.turn_token_usage || null; lastResponseUsage = entry.payload?.usage || lastResponseUsage; }
    if (entry.type === "event_msg" && entry.payload?.type === "token_count") {
      lastResponseUsage = entry.payload.info?.last_token_usage || lastResponseUsage;
      weeklyUsedPercent = entry.payload.rate_limits?.primary?.used_percent ?? weeklyUsedPercent;
    }
  }
  return { observationVersion: HOST_OBSERVATION_VERSION, active: Boolean(started && started !== completed), lastTurnId, completedTurnId: completed, interruptedTurnId, userMessageCount, model, reasoning, selectionTurnId, usage, lastResponseUsage, weeklyUsedPercent };
}
// Local receipt for one known turn. Never treats commentary or mere delivery as completion.
export async function readHostTurnReceipt(threadId, turnId, prompt, codexDir) {
  const receipt = { turnId, completed: false, interrupted: false, promptMatched: false, userMessageCount: 0,
    model: null, reasoning: null, finalResponse: null };
  let current = null;
  const lines = readline.createInterface({ input: fs.createReadStream(findRollout(threadId, codexDir)), crlfDelay: Infinity });
  for await (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const payload = entry.payload;
    if (entry.type === "event_msg" && payload?.type === "task_started") {
      current = payload.turn_id;
      if (current === turnId) receipt.startedAt = entry.timestamp || null;
    }
    if (current !== turnId) continue;
    if (entry.type === "event_msg" && payload?.type === "task_complete" && payload.turn_id === turnId) {
      receipt.completed = true; receipt.completedAt = entry.timestamp || null;
    }
    if (entry.type === "token_usage_record" && payload?.turn_token_usage) receipt.usage = payload.turn_token_usage;
    if (entry.type === "event_msg" && ["turn_aborted", "task_failed"].includes(payload?.type)) receipt.interrupted = true;
    if (entry.type === "turn_context" && payload.turn_id === turnId) { receipt.model = payload.model; receipt.reasoning = payload.effort; }
    if (entry.type !== "response_item" || payload?.type !== "message") continue;
    if (payload.role === "user") {
      const text = messageText(payload);
      if (!isInjectedEnvironmentContext(text)) receipt.userMessageCount += 1;
      if (text?.trim() === prompt.trim()) receipt.promptMatched = true;
    }
    if (payload.role === "assistant" && ["final", "final_answer"].includes(payload.phase)) {
      receipt.finalResponse = payload.content?.filter(c => c.type === "output_text").map(c => c.text).join("\n") || null;
    }
  }
  return receipt;
}
export async function hostTurnContainsPrompt(threadId, turnId, prompt, codexDir) {
  let inTurn = false;
  const lines = readline.createInterface({ input: fs.createReadStream(findRollout(threadId, codexDir)), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"task_started"') && !line.includes('"response_item"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "event_msg" && entry.payload?.type === "task_started") inTurn = entry.payload.turn_id === turnId;
    if (inTurn && entry.type === "response_item" && entry.payload?.type === "message" && entry.payload?.role === "user") {
      const content = entry.payload.content?.filter(item => item.type === "input_text").map(item => item.text).join("\n");
      if (content?.trim() === prompt.trim()) return true;
    }
  }
  return false;
}
// Locate completed or active turns containing one unique, exact visible prompt.
// The caller still verifies the entire turn receipt before using a match.
export async function findHostTurnsForPrompt(threadId, prompt, codexDir) {
  const matches = new Map();
  let currentTurnId = null, currentStartedAt = null;
  const lines = readline.createInterface({ input: fs.createReadStream(findRollout(threadId, codexDir)), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"task_started"') && !line.includes('"response_item"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "event_msg" && entry.payload?.type === "task_started") {
      currentTurnId = entry.payload.turn_id;
      currentStartedAt = entry.timestamp || null;
    }
    if (currentTurnId && entry.type === "response_item" && entry.payload?.type === "message" && entry.payload?.role === "user" &&
        messageText(entry.payload).trim() === String(prompt).trim()) {
      matches.set(currentTurnId, { turnId: currentTurnId, startedAt: currentStartedAt });
    }
  }
  return [...matches.values()];
}
export async function verifyInitialSelection(threadId, initial) {
  const observed = await readHostSelection(threadId);
  if (observed.model !== initial.model || observed.reasoning !== initial.reasoning) throw new Error(`Initial selection does not match the host: ${observed.model} / ${observed.reasoning}`);
}
