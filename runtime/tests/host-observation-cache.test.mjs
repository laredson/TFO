import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readHostTurnState, readHostTurnReceipt, findHostTurnsForPrompt, hostTurnContainsPrompt } from "../host-selection.mjs";
import { readProjectThread, nativeProjectHost } from "../project-host.mjs";

const thread = "33333333-3333-3333-3333-333333333333", source = "44444444-4444-4444-4444-444444444444";
const row = entry => `${JSON.stringify(entry)}\n`;
const started = (turn, timestamp) => ({ type: "event_msg", timestamp, payload: { type: "task_started", turn_id: turn } });
const terminal = (type, turn, detail = {}) => ({ type: "event_msg", timestamp: "2026-10-01T10:01:00.000Z", payload: { type, turn_id: turn, ...detail } });
const context = turn => ({ type: "turn_context", payload: { turn_id: turn, model: "gpt-6-luna", effort: "low" } });
const message = (text, role = "user", phase) => ({ type: "response_item", payload: { type: "message", role, phase,
  content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
function fixture(t, records = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-observation-cache-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sessions = path.join(directory, "sessions"); fs.mkdirSync(sessions);
  const file = path.join(sessions, `rollout-${thread}.jsonl`);
  const metadata = { type: "session_meta", payload: { id: thread, cwd: directory } };
  fs.writeFileSync(file, [metadata, ...records].map(row).join(""));
  return { directory, file, metadata, append: (...entries) => fs.appendFileSync(file, entries.map(row).join("")),
    state: () => readHostTurnState(thread, directory), project: () => readProjectThread(thread, directory) };
}

test("unchanged lifecycle observations reuse identity and read only the appended tail", async t => {
  const f = fixture(t, [started("one", "2026-10-01T10:00:00.000Z"), context("one"), message("authorized")]);
  // A large unrelated tool output must not be reparsed at every observation.
  f.append({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(200000) } });
  assert.equal((await f.project()).active, true);
  let bytes = 0, searches = 0;
  const originalRead = fs.readSync, originalDirectory = fs.readdirSync;
  t.mock.method(fs, "readSync", (...args) => { const read = originalRead(...args); bytes += read; return read; });
  t.mock.method(fs, "readdirSync", (...args) => { searches++; return originalDirectory(...args); });
  for (let index = 0; index < 8; index++) assert.equal((await f.project()).userMessageCount, 1);
  assert.ok(bytes <= 4096, "warm checks read at most 512 identity/tail bytes each"); assert.equal(searches, 0);
  bytes = 0;
  f.append(terminal("task_complete", "one"));
  const observed = await f.project();
  assert.equal(observed.active, false); assert.equal(observed.lifecycleStatus, "completed");
  assert.ok(bytes < 2048, `read ${bytes} bytes instead of the historical tool output`);
  assert.equal(searches, 0); assert.equal(observed.lastActivityAt, "2026-10-01T10:01:00.000Z");
  observed.userMessageCount = 999;
  assert.equal((await f.state()).userMessageCount, 1, "returned snapshots cannot corrupt the cache");
});

test("partial UTF-8 records and records without LF apply exactly once", async t => {
  const f = fixture(t, [started("one"), context("one")]);
  const bytes = Buffer.from(row(message("prompt con ñ"))), split = bytes.indexOf(Buffer.from("ñ")) + 1;
  fs.appendFileSync(f.file, bytes.subarray(0, split));
  assert.equal((await f.state()).userMessageCount, 0);
  fs.appendFileSync(f.file, bytes.subarray(split, bytes.length - 1));
  assert.equal((await f.state()).userMessageCount, 1);
  assert.equal((await f.state()).userMessageCount, 1);
  fs.appendFileSync(f.file, "\n");
  f.append(message("<environment_context>metadata</environment_context>"), message("intervention"));
  assert.equal((await f.state()).userMessageCount, 2);
});

test("verified failures and ambiguous aborts are terminal, with distinct host evidence", async t => {
  const f = fixture(t, [started("one"), context("one"), terminal("task_failed", "one", { error: { message: "transport lost" } })]);
  let observed = await f.state();
  assert.equal(observed.active, false); assert.equal(observed.lifecycleStatus, "failed");
  assert.equal(observed.failedTurnId, "one"); assert.equal(observed.failureReason, "transport lost");
  assert.equal(observed.interruptionKind, "task_failed"); assert.equal(observed.interruptedTurnId, "one");
  const failedReceipt = await readHostTurnReceipt(thread, "one", "authorized", f.directory);
  assert.equal(failedReceipt.failed, true); assert.equal(failedReceipt.aborted, false); assert.equal(failedReceipt.interrupted, true);
  f.append(started("two"), context("two"), terminal("turn_aborted", "two"));
  observed = await f.state();
  assert.equal(observed.active, false); assert.equal(observed.lifecycleStatus, "aborted");
  assert.equal(observed.abortedTurnId, "two"); assert.equal(observed.failedTurnId, "one");
  assert.equal(observed.interruptionKind, "turn_aborted"); assert.equal(observed.failureReason, null);
  const abortedReceipt = await readHostTurnReceipt(thread, "two", "authorized", f.directory);
  assert.equal(abortedReceipt.aborted, true); assert.equal(abortedReceipt.failed, false); assert.equal(abortedReceipt.interrupted, true);
  f.append(started("three"), context("three"), terminal("task_failed", "one"));
  observed = await f.state();
  assert.equal(observed.active, true, "a historical terminal event does not terminate a newer active turn");
  assert.equal(observed.lifecycleStatus, "active"); assert.equal(observed.interruptionKind, null);
});

test("replacement and truncation invalidate workspace identity, lifecycle and exact receipts", async t => {
  const f = fixture(t, [started("one"), context("one"), message("old prompt"), message("old result", "assistant", "final_answer"), terminal("task_complete", "one")]);
  assert.equal((await readHostTurnReceipt(thread, "one", "old prompt", f.directory)).finalResponse, "old result");
  const replacement = `${f.file}.replacement`;
  fs.writeFileSync(replacement, [f.metadata, started("two"), context("two"), message("new prompt")].map(row).join(""));
  fs.rmSync(f.file); fs.renameSync(replacement, f.file);
  assert.equal((await f.project()).lastTurnId, "two");
  assert.equal((await readHostTurnReceipt(thread, "one", "old prompt", f.directory)).finalResponse, null);
  fs.writeFileSync(f.file, row(f.metadata));
  assert.equal((await f.state()).lastTurnId, null); assert.equal((await f.state()).active, false);
  const foreign = { type: "session_meta", payload: { id: source, cwd: f.directory } };
  fs.writeFileSync(f.file, row(foreign));
  await assert.rejects(f.project(), /identity/);
});

test("completed receipt and exact prompt scans are reused until the rollout changes", async t => {
  const f = fixture(t, [started("one"), context("one"), message("exact"), message("done", "assistant", "final_answer"), terminal("task_complete", "one")]);
  await readHostTurnReceipt(thread, "one", "exact", f.directory);
  await findHostTurnsForPrompt(thread, "exact", f.directory);
  await hostTurnContainsPrompt(thread, "one", "exact", f.directory);
  let scans = 0; const original = fs.createReadStream;
  t.mock.method(fs, "createReadStream", (...args) => { scans++; return original(...args); });
  for (let index = 0; index < 4; index++) {
    assert.equal((await readHostTurnReceipt(thread, "one", "exact", f.directory)).promptMatched, true);
    assert.equal((await findHostTurnsForPrompt(thread, "exact", f.directory)).length, 1);
    assert.equal(await hostTurnContainsPrompt(thread, "one", "exact", f.directory), true);
  }
  assert.equal(scans, 0);
  f.append(started("two"), context("two"), message("exact"), terminal("task_complete", "two"));
  assert.equal((await findHostTurnsForPrompt(thread, "exact", f.directory)).length, 2);
  assert.equal(scans, 1, "new delivery requires a fresh exact scan for duplicates");
});

test("a second rollout candidate invalidates the cached unique path", async t => {
  const f = fixture(t, [started("one"), context("one")]);
  await f.project();
  const duplicate = path.join(path.dirname(f.file), `duplicate-${thread}.jsonl`);
  fs.copyFileSync(f.file, duplicate);
  // Force a directory revision even on filesystems with coarse timestamps.
  const changed = new Date(Date.now() + 2000); fs.utimesSync(path.dirname(f.file), changed, changed);
  await assert.rejects(f.project(), /Cannot verify/);
});

test("exact receipt cache stays bounded under diagnostic bursts without losing full results", async t => {
  const report = "full report ".repeat(16000);
  const f = fixture(t, [started("one"), context("one"), message("exact"), message(report, "assistant", "final_answer"), terminal("task_complete", "one")]);
  await readHostTurnReceipt(thread, "one", "exact", f.directory);
  let scans = 0; const original = fs.createReadStream;
  t.mock.method(fs, "createReadStream", (...args) => { scans++; return original(...args); });
  for (let index = 0; index < 35; index++) {
    const receipt = await readHostTurnReceipt(thread, "one", `diagnostic ${index}`, f.directory);
    assert.equal(receipt.finalResponse, report); assert.equal(receipt.promptMatched, false);
  }
  const before = scans;
  assert.equal((await readHostTurnReceipt(thread, "one", "diagnostic 34", f.directory)).finalResponse, report);
  assert.equal(scans, before, "the most recent bounded result remains cached");
  const exact = await readHostTurnReceipt(thread, "one", "exact", f.directory);
  assert.equal(scans, before + 1, "older large entries are evicted and verified again on demand");
  assert.equal(exact.promptMatched, true); assert.equal(exact.finalResponse, report);
});

test("concurrent verification of one receipt does not multiply its retained cache budget", async t => {
  const report = "full report ".repeat(16000);
  const f = fixture(t, [started("one"), context("one"), message("exact"), message(report, "assistant", "final_answer"), terminal("task_complete", "one")]);
  const receipts = await Promise.all(Array.from({ length: 35 }, () => readHostTurnReceipt(thread, "one", "exact", f.directory)));
  assert.ok(receipts.every(receipt => receipt.promptMatched && receipt.finalResponse === report));
  for (let index = 0; index < 3; index++) await readHostTurnReceipt(thread, "one", `diagnostic ${index}`, f.directory);
  let scans = 0; const original = fs.createReadStream;
  t.mock.method(fs, "createReadStream", (...args) => { scans++; return original(...args); });
  assert.equal((await readHostTurnReceipt(thread, "one", "exact", f.directory)).finalResponse, report);
  assert.equal(scans, 0, "concurrent reads retain one entry and allow subsequent small results alongside it");
});

test("bootstrap cache still proves source identity and invalidates on extra delivery or input", async t => {
  const delegation = { type: "response_item", payload: { type: "function_call_output", namespace: "codex_app", name: "create_thread",
    output: `<codex_delegation>\n<source_thread_id>${source}</source_thread_id>\n<input>exact</input>\n</codex_delegation>`,
    internal_chat_message_metadata_passthrough: { turn_id: "one" } } };
  const f = fixture(t, [started("one"), context("one"), delegation, message("done", "assistant", "final_answer"), terminal("task_complete", "one")]);
  const receipt = () => nativeProjectHost.bootstrap(thread, "exact", source, f.directory);
  assert.equal((await receipt()).bootstrapVerified, true);
  let scans = 0; const original = fs.createReadStream;
  t.mock.method(fs, "createReadStream", (...args) => { scans++; return original(...args); });
  assert.equal((await receipt()).bootstrapVerified, true); assert.equal(scans, 0);
  assert.equal(await nativeProjectHost.bootstrap(thread, "exact", thread, f.directory), null);
  f.append(message("intervention"));
  assert.equal((await receipt()).bootstrapVerified, false);
  f.append(delegation);
  await assert.rejects(receipt(), /Duplicate/);
});
