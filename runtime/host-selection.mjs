// Codex Desktop 0.155 local rollout adapter. Unknown/migrated formats fail closed.
// Read only the identified thread's model metadata; never export conversation text.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { createHash } from "node:crypto";
import { validateSelection } from "./model-policy.mjs";
// Persisted with a queue so a hot-installed observer cannot silently reinterpret
// the preparing process's user-message count.
export const HOST_OBSERVATION_VERSION = 1;
const observations = new Map();
const maximumCachedThreads = 128;
const maximumCachedScans = 32;
const maximumCachedScanBytes = 2 * 1024 * 1024;
const defaultCodexDir = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const clone = value => structuredClone(value);
const promptKey = prompt => createHash("sha256").update(String(prompt)).digest("hex");
function observationKey(threadId, codexDir) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) throw new Error("Invalid host thread ID");
  return `${path.resolve(codexDir || defaultCodexDir())}\0${threadId}`;
}
function fileStamp(stat) {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
function fileIdentity(stat) { return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`; }
function initialTurnState() {
  return { observationVersion: HOST_OBSERVATION_VERSION, active: false, lifecycleStatus: "idle",
    lastTurnId: null, completedTurnId: null, interruptedTurnId: null, failedTurnId: null, abortedTurnId: null,
    interruptionKind: null, failureReason: null, terminalAt: null, startedAt: null, lastActivityAt: null,
    userMessageCount: 0, model: null, reasoning: null, selectionTurnId: null,
    usage: null, lastResponseUsage: null, weeklyUsedPercent: null };
}
function failureReason(payload) {
  const reason = [payload?.error?.message, payload?.message, payload?.reason, payload?.error]
    .find(value => typeof value === "string" && value.trim());
  return reason ? reason.slice(0, 2000) : null;
}
function recordMetadata(record, line) {
  const timestamp = line.match(/"timestamp"\s*:\s*"([^"\r\n]+)"/)?.[1];
  if (timestamp && Number.isFinite(Date.parse(timestamp))) record.state.lastActivityAt = timestamp;
  if (!line.includes('"session_meta"') && !line.includes('"task_started"') && !line.includes('"task_complete"') &&
      !line.includes('"turn_aborted"') && !line.includes('"task_failed"') && !line.includes('"turn_context"') &&
      !line.includes('"token_usage_record"') && !line.includes('"token_count"') &&
      !(line.includes('"response_item"') && line.includes('"role"') && line.includes('"user"'))) return;
  let entry; try { entry = JSON.parse(line); } catch { return; }
  const state = record.state, payload = entry.payload;
  if (entry.type === "session_meta" && !record.metadata) record.metadata = { id: payload?.id, cwd: payload?.cwd };
  if (entry.type === "event_msg" && payload?.type === "task_started") {
    state.lastTurnId = payload.turn_id || null; state.userMessageCount = 0;
    state.lifecycleStatus = state.lastTurnId ? "active" : "idle"; state.active = Boolean(state.lastTurnId);
    state.startedAt = entry.timestamp || null; state.failureReason = null; state.interruptionKind = null; state.terminalAt = null;
  }
  if (entry.type === "response_item" && payload?.type === "message" && payload.role === "user" &&
      !isInjectedEnvironmentContext(messageText(payload))) state.userMessageCount += 1;
  if (entry.type === "event_msg" && payload?.type === "task_complete") {
    state.completedTurnId = payload.turn_id || null;
    if (state.lastTurnId && payload.turn_id === state.lastTurnId) {
      state.active = false; state.lifecycleStatus = "completed"; state.terminalAt = entry.timestamp || null;
    }
  }
  if (entry.type === "event_msg" && ["turn_aborted", "task_failed"].includes(payload?.type)) {
    const turnId = payload.turn_id || state.lastTurnId;
    state.interruptedTurnId = turnId;
    if (payload.type === "task_failed") state.failedTurnId = turnId;
    else state.abortedTurnId = turnId;
    if (turnId && turnId === state.lastTurnId) {
      state.active = false; state.lifecycleStatus = payload.type === "task_failed" ? "failed" : "aborted";
      state.interruptionKind = payload.type; state.failureReason = failureReason(payload); state.terminalAt = entry.timestamp || null;
    }
  }
  if (entry.type === "turn_context") {
    state.model = payload?.model; state.reasoning = payload?.effort; state.selectionTurnId = payload?.turn_id || null;
  }
  if (entry.type === "token_usage_record") {
    state.usage = payload?.turn_token_usage || null; state.lastResponseUsage = payload?.usage || state.lastResponseUsage;
  }
  if (entry.type === "event_msg" && payload?.type === "token_count") {
    state.lastResponseUsage = payload.info?.last_token_usage || state.lastResponseUsage;
    const weekly = [payload.rate_limits?.primary, payload.rate_limits?.secondary].find(window =>
      (window?.window_minutes ?? window?.window_duration_mins) === 10080);
    state.weeklyUsedPercent = weekly?.used_percent ?? state.weeklyUsedPercent;
  }
}
function resetObservation(record, stat) {
  Object.assign(record, { identity: fileIdentity(stat), stamp: null, offset: 0, pending: Buffer.alloc(0),
    pendingApplied: false, anchor: Buffer.alloc(0), prefix: Buffer.alloc(0), state: initialTurnState(), metadata: null, scans: new Map(), scanBytes: 0 });
}
function readBytes(descriptor, position, length) {
  const buffer = Buffer.alloc(length);
  const count = fs.readSync(descriptor, buffer, 0, length, position);
  return buffer.subarray(0, count);
}
// Only new bytes are read while a known rollout is appended. Replacement,
// truncation, or an overwritten tail discards both metadata and exact scans.
function observeRollout(threadId, codexDir) {
  const key = observationKey(threadId, codexDir);
  let record = observations.get(key);
  if (!record || !fs.existsSync(record.location)) {
    record = { location: findRollout(threadId, codexDir) };
    observations.delete(key); observations.set(key, record);
    if (observations.size > maximumCachedThreads) observations.delete(observations.keys().next().value);
  } else {
    observations.delete(key); observations.set(key, record);
  }
  const directoryStamp = fileStamp(fs.statSync(path.dirname(record.location), { bigint: true }));
  if (record.directoryStamp && record.directoryStamp !== directoryStamp) {
    // A move or a second candidate in the known rollout directory must still
    // pass the original unique-path check before any cached observation is used.
    record.location = findRollout(threadId, codexDir);
  }
  record.directoryStamp = directoryStamp;
  const descriptor = fs.openSync(record.location, "r");
  try {
    // Snapshot the opened descriptor. Ordinary host appends between open and
    // fstat are observed here instead of being mistaken for an intervention.
    const stat = fs.fstatSync(descriptor, { bigint: true }), stamp = fileStamp(stat), size = Number(stat.size);
    // Windows can coalesce timestamps for quick writes of the same size.
    // Verify bounded identity/tail bytes instead of trusting stat alone.
    if (record.stamp === stamp &&
        readBytes(descriptor, size - record.anchor.length, record.anchor.length).equals(record.anchor) &&
        (!record.prefix.length || readBytes(descriptor, 0, record.prefix.length).equals(record.prefix))) return record;
    let reset = !record.state || record.identity !== fileIdentity(stat) || size <= record.offset;
    if (!reset && record.anchor.length) {
      reset = !readBytes(descriptor, record.offset - record.anchor.length, record.anchor.length).equals(record.anchor);
    }
    if (!reset && record.pendingApplied && size > record.offset) {
      const next = readBytes(descriptor, record.offset, 1)[0];
      if (next !== 10 && next !== 13) reset = true;
    }
    if (reset) resetObservation(record, stat);
    const priorActivity = record.state.lastActivityAt;
    record.scans.clear(); record.scanBytes = 0;
    let parts = record.pending.length ? [record.pending] : [];
    while (record.offset < size) {
      const chunk = readBytes(descriptor, record.offset, Math.min(65536, size - record.offset));
      if (!chunk.length) throw new Error("Host history was truncated while observing it");
      record.offset += chunk.length;
      let beginning = 0, ending;
      while ((ending = chunk.indexOf(10, beginning)) >= 0) {
        if (!record.pendingApplied) {
          const line = parts.length ? Buffer.concat([...parts, chunk.subarray(beginning, ending)]) : chunk.subarray(beginning, ending);
          recordMetadata(record, line.toString("utf8"));
        }
        parts = []; record.pendingApplied = false; beginning = ending + 1;
      }
      if (beginning < chunk.length) parts.push(chunk.subarray(beginning));
    }
    record.pending = parts.length ? Buffer.concat(parts) : Buffer.alloc(0);
    // Fixtures and a host flush can end in a complete JSON record without LF.
    // Apply it once and retain the bytes until its newline arrives.
    if (record.pending.length && !record.pendingApplied) {
      const tail = record.pending.toString("utf8");
      try { JSON.parse(tail); recordMetadata(record, tail); record.pendingApplied = true; } catch { /* await the remaining bytes */ }
    }
    record.anchor = readBytes(descriptor, Math.max(0, size - 256), Math.min(size, 256));
    record.prefix = size > 256 ? readBytes(descriptor, 0, Math.min(size - 256, 256)) : Buffer.alloc(0);
    if (record.metadata?.id && record.metadata.id !== threadId) throw new Error("Cannot verify chat identity from the host rollout");
    if (!record.state.lastActivityAt || record.state.lastActivityAt === priorActivity) record.state.lastActivityAt = new Date(Number(stat.mtimeMs)).toISOString();
    record.stamp = stamp;
    return record;
  } catch (error) {
    observations.delete(key); throw error;
  } finally { fs.closeSync(descriptor); }
}
async function cachedScan(threadId, codexDir, key, scan) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const record = observeRollout(threadId, codexDir), stamp = record.stamp;
    if (record.scans.has(key)) {
      const cached = record.scans.get(key);
      record.scans.delete(key); record.scans.set(key, cached);
      return clone(cached.value);
    }
    const result = await scan(record.location, record.offset);
    if (fileStamp(fs.statSync(record.location, { bigint: true })) !== stamp) continue;
    const bytes = Buffer.byteLength(JSON.stringify(result) || "null", "utf8");
    // Exact reports remain available on demand. Their caching must not grow
    // with every diagnostic prompt or retain an oversized final indefinitely.
    if (bytes <= maximumCachedScanBytes) {
      const previous = record.scans.get(key);
      if (previous) { record.scanBytes -= previous.bytes; record.scans.delete(key); }
      while (record.scans.size >= maximumCachedScans || record.scanBytes + bytes > maximumCachedScanBytes) {
        const oldest = record.scans.keys().next().value;
        record.scanBytes -= record.scans.get(oldest).bytes; record.scans.delete(oldest);
      }
      record.scans.set(key, { value: clone(result), bytes }); record.scanBytes += bytes;
    }
    return result;
  }
  throw new Error("Host history changed while verifying the exact receipt; inspect before continuing");
}
function rolloutLines(location, size) {
  return readline.createInterface({ input: fs.createReadStream(location, size ? { end: size - 1 } : {}), crlfDelay: Infinity });
}
export async function readHostSessionMetadata(threadId, codexDir) {
  const metadata = observeRollout(threadId, codexDir).metadata;
  if (metadata?.id !== threadId || !metadata.cwd) throw new Error("Cannot verify chat identity and workspace from the host");
  return clone(metadata);
}
export async function readHostThreadObservation(threadId, codexDir) {
  const record = observeRollout(threadId, codexDir), metadata = record.metadata;
  if (metadata?.id !== threadId || !metadata.cwd) throw new Error("Cannot verify chat identity and workspace from the host");
  return { state: clone(record.state), metadata: clone(metadata) };
}
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
  const state = observeRollout(threadId, codexDir).state;
  if (!state.model) throw new Error("No host model metadata found. No prompt was sent.");
  return validateSelection({ model: state.model, reasoning: state.reasoning });
}
function messageText(payload) {
  return payload?.content?.filter(item => item.type === "input_text").map(item => item.text).join("\n") || "";
}
function isInjectedEnvironmentContext(text) {
  return /^\s*<environment_context>[\s\S]*<\/environment_context>\s*$/.test(text);
}
// Reads only lifecycle and usage metadata, never the conversation text.
export async function readHostTurnState(threadId, codexDir) {
  return clone(observeRollout(threadId, codexDir).state);
}
// Local receipt for one known turn. Never treats commentary or mere delivery as completion.
export async function readHostTurnReceipt(threadId, turnId, prompt, codexDir) {
  return cachedScan(threadId, codexDir, `receipt:${turnId}:${promptKey(prompt)}`, async (location, size) => {
  const receipt = { turnId, completed: false, interrupted: false, promptMatched: false, userMessageCount: 0,
    failed: false, aborted: false, interruptionKind: null, failureReason: null,
    model: null, reasoning: null, finalResponse: null };
  let current = null;
  const lines = rolloutLines(location, size);
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
    if (entry.type === "event_msg" && ["turn_aborted", "task_failed"].includes(payload?.type) &&
        (!payload.turn_id || payload.turn_id === turnId)) {
      receipt.interrupted = true; receipt.failed = payload.type === "task_failed"; receipt.aborted = payload.type === "turn_aborted";
      receipt.interruptionKind = payload.type; receipt.failureReason = failureReason(payload); receipt.terminalAt = entry.timestamp || null;
    }
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
  });
}
export async function hostTurnContainsPrompt(threadId, turnId, prompt, codexDir) {
  return cachedScan(threadId, codexDir, `contains:${turnId}:${promptKey(prompt)}`, async (location, size) => {
  let inTurn = false;
  const lines = rolloutLines(location, size);
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
  });
}
// Locate completed or active turns containing one unique, exact visible prompt.
// The caller still verifies the entire turn receipt before using a match.
export async function findHostTurnsForPrompt(threadId, prompt, codexDir) {
  return cachedScan(threadId, codexDir, `find:${promptKey(prompt)}`, async (location, size) => {
  const matches = new Map();
  let currentTurnId = null, currentStartedAt = null;
  const lines = rolloutLines(location, size);
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
  });
}
// Native delegation is a host-authored delivery, not a normal user prompt.
// Its source identity, exact input, turn passthrough and duplicate checks are
// retained even when a terminal receipt is read repeatedly by a watcher.
export async function readHostBootstrapReceipt(threadId, prompt, sourceThreadId, codexDir) {
  return cachedScan(threadId, codexDir, `bootstrap:${sourceThreadId}:${promptKey(prompt)}`, async (location, size) => {
    const lines = rolloutLines(location, size), matches = [], messages = new Map();
    let turnId = null;
    for await (const line of lines) {
      let entry; try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type === "event_msg" && entry.payload?.type === "task_started") turnId = entry.payload.turn_id;
      const item = entry.payload;
      if (entry.type !== "response_item" || item?.type !== "function_call_output" || item.namespace !== "codex_app" ||
          !["create_thread", "send_message_to_thread"].includes(item.name)) continue;
      const match = String(item.output).match(/^<codex_delegation>\s*<source_thread_id>([0-9a-f-]{36})<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>$/i);
      if (!match || !turnId || item.internal_chat_message_metadata_passthrough?.turn_id !== turnId) continue;
      messages.set(turnId, (messages.get(turnId) || 0) + 1);
      if (match[1] === sourceThreadId && match[2] === prompt) matches.push(turnId);
    }
    if (matches.length > 1) throw new Error("Duplicate native bootstrap delivery");
    if (!matches.length) return null;
    const receipt = await readHostTurnReceipt(threadId, matches[0], prompt, codexDir);
    return { ...receipt, bootstrapVerified: messages.get(matches[0]) === 1 && receipt.userMessageCount === 0 };
  });
}
export async function verifyInitialSelection(threadId, initial) {
  const observed = await readHostSelection(threadId);
  if (observed.model !== initial.model || observed.reasoning !== initial.reasoning) throw new Error(`Initial selection does not match the host: ${observed.model} / ${observed.reasoning}`);
}
