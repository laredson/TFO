// Persistent web queue preparation. No model, worker, UI driver or network sender.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { replaceAtomicFile } from "./atomic-file.mjs";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const text = (value, name, max) => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name}: expected non-empty text up to ${max} characters`);
  return value.trim();
};
function normalize(input) {
  if (!UUID.test(input.requestId || "")) throw new Error("requestId must be a UUID retained for retries of the same preparation");
  const url = new URL(input.chatUrl);
  if (url.origin !== "https://chatgpt.com" || url.username || url.password || url.search || url.hash ||
      !/^\/(?:g\/g-p-[a-z0-9-]+\/)?c\/[0-9a-f-]{36}$/i.test(url.pathname) || !UUID.test(url.pathname.split("/").at(-1))) {
    throw new Error("chatUrl must be the actual https://chatgpt.com/.../c/<conversation UUID> URL without query or fragment");
  }
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 20) throw new Error("Provide 1 to 20 steps");
  return { requestId: input.requestId.toLowerCase(), chatUrl: url.href,
    projectLabel: text(input.projectLabel, "projectLabel", 200), objective: text(input.objective, "objective", 2000),
    steps: input.steps.map((step, i) => ({ id: `step-${i + 1}`, title: text(step.title, "title", 200),
      prompt: text(step.prompt, "prompt", 16000), selection: {
        modelLabel: text(step.selection?.modelLabel, "modelLabel", 100), effortLabel: text(step.selection?.effortLabel, "effortLabel", 100),
      } })),
  };
}
export function createWebQueueStore(dataDir) {
  const directory = path.join(path.resolve(dataDir), "web-queues");
  const file = id => {
    if (!/^web_[0-9a-f-]{36}$/.test(id || "") || !UUID.test(id.slice(4))) throw new Error("Invalid web queue ID");
    return path.join(directory, `${id}.json`);
  };
  const read = id => JSON.parse(fs.readFileSync(file(id), "utf8"));
  return {
    prepare(input) {
      const plan = normalize(input);
      const id = `web_${plan.requestId}`;
      const fingerprint = crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex");
      const state = { id, kind: "web_prompt_queue", schemaVersion: 1, ...plan, fingerprint,
        status: "awaiting_host_adapter", revision: 1, targetVerified: false, sendEnabled: false,
        pendingPrompts: plan.steps.length, confirmedSends: 0, checkpoints: [],
        blocker: "No verified normal Chat turn observer or model/effort sender is connected. Preparation never sends a prompt.",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      fs.mkdirSync(directory, { recursive: true });
      try { fs.writeFileSync(file(id), JSON.stringify(state, null, 2), { flag: "wx", encoding: "utf8" }); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        const previous = read(id);
        if (previous.fingerprint !== fingerprint) throw new Error("requestId already belongs to a different plan; nothing was overwritten");
        return previous; // Includes cancelled status; repeated calls cannot re-arm it.
      }
      return state;
    },
    get: read,
    cancel(id) {
      const target = file(id);
      const lock = `${target}.lock`;
      // Do not reclaim an uncertain lock or silently replay a mutation.
      const fd = fs.openSync(lock, "wx");
      try {
        const state = read(id);
        if (state.status === "cancelled") return state;
        state.status = "cancelled"; state.revision++; state.updatedAt = new Date().toISOString();
        const temporary = `${target}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
        replaceAtomicFile(temporary, target);
        return state;
      } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
    },
  };
}
