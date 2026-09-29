import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeProjectHost } from "../project-host.mjs";

const thread = "22222222-2222-2222-2222-222222222222", source = "11111111-1111-1111-1111-111111111111";
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfo-project-host-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "sessions"));
  const prompt = "Preparación exacta con acentos. TFO_READY flow_example a", turn = "bootstrap-turn";
  const delegation = { type: "response_item", payload: { type: "function_call_output", name: options.name || "create_thread", namespace: options.namespace || "codex_app",
    output: `<codex_delegation>\n  <source_thread_id>${options.source || source}</source_thread_id>\n  <input>${prompt}</input>\n</codex_delegation>`,
    internal_chat_message_metadata_passthrough: { turn_id: options.wrongTurn ? "wrong" : turn } } };
  const records = [{ type: "event_msg", payload: { type: "task_started", turn_id: turn } },
    { type: "turn_context", payload: { turn_id: turn, model: "gpt-6-sol", effort: "medium" } }, delegation,
    ...(options.duplicate ? [delegation] : []),
    ...(options.extraUser ? [{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Intervention" }] } }] : []),
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "TFO_READY flow_example a" }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: turn } }];
  fs.writeFileSync(path.join(dir, "sessions", `rollout-${thread}.jsonl`), records.map(record => JSON.stringify(record)).join("\n"));
  return () => nativeProjectHost.bootstrap(thread, prompt, source, dir);
}
test("host-authored create_thread bootstrap proves exact input, source, turn and final response", async t => {
  const receipt = await fixture(t)();
  assert.equal(receipt.bootstrapVerified, true); assert.equal(receipt.completed, true);
  assert.equal(receipt.userMessageCount, 0); assert.equal(receipt.promptMatched, false, "do not fabricate a normal user message");
  assert.equal(receipt.finalResponse, "TFO_READY flow_example a");
});
test("explicitly reused chat accepts the native send_message_to_thread bootstrap", async t => {
  assert.equal((await fixture(t, { name: "send_message_to_thread" })()).bootstrapVerified, true);
});
for (const [name, options] of [["foreign source", { source: thread }], ["wrong namespace", { namespace: "untrusted" }], ["unrelated tool", { name: "shell" }], ["wrong turn", { wrongTurn: true }]]) {
  test(`bootstrap rejects ${name}`, async t => assert.equal(await fixture(t, options)(), null));
}
test("bootstrap rejects duplicates and intervening user input", async t => {
  await assert.rejects(fixture(t, { duplicate: true })(), /Duplicate/);
  assert.equal((await fixture(t, { extraUser: true })()).bootstrapVerified, false);
});
