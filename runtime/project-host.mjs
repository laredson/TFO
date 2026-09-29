// Host-native chat creation is performed once by the planning AI using the
// Codex app tools. This conventional adapter observes and queues existing chats.
// It never starts/resumes a thread with a second App Server writer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findRollout, readHostTurnState, readHostTurnReceipt, findHostTurnsForPrompt } from "./host-selection.mjs";
import { canonicalPath } from "./project-workspace.mjs";
import { createSelectedJoinAdapter } from "./selected-join-adapter.mjs";

const execute = promisify(execFile);
export async function readProjectThread(threadId) {
  let metadata;
  const lines = readline.createInterface({ input: fs.createReadStream(findRollout(threadId)), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let entry; try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type === "session_meta") { metadata = entry.payload; break; }
    }
  } finally { lines.close(); }
  if (metadata?.id !== threadId || !metadata.cwd) throw new Error("Cannot verify chat identity and workspace from the host");
  return { ...await readHostTurnState(threadId), threadId, workspace: canonicalPath(metadata.cwd) };
}

export const nativeProjectHost = {
  read: readProjectThread,
  find: findHostTurnsForPrompt,
  receipt: readHostTurnReceipt,
  async bootstrap(threadId, prompt, sourceThreadId, codexDir) {
    const lines = readline.createInterface({ input: fs.createReadStream(findRollout(threadId, codexDir)), crlfDelay: Infinity });
    const matches = [], messages = new Map();
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
  },
  async send(threadId, prompt) {
    const command = process.env.TFO_QUEUE_COMMAND || process.env.TFO_CODEX_COMMAND || "codex";
    const { stdout } = await execute(command, ["queue", "--thread", threadId, "--message", prompt],
      { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
        env: { ...process.env, CODEX_HOME: process.env.CODEX_HOME || path.join(os.homedir(), ".codex") } });
    const match = stdout.match(/Queued message ([0-9a-f-]{36}) for thread ([0-9a-f-]{36})/i);
    if (!match || match[2].toLowerCase() !== threadId.toLowerCase()) throw new Error("Native queue did not confirm the target chat; inspect history before any retry");
    return { queueMessageId: match[1] };
  },
};
nativeProjectHost.selectedJoin = createSelectedJoinAdapter({ readThread: readProjectThread });
