import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createSettingsStore, UPGRADE_WARNING } from "./settings.mjs";
import { createChatRouter } from "./chat-route.mjs";
import { createPromptQueue } from "./prompt-queue.mjs";
import { decideModel } from "./model-policy.mjs";
import { createProjectFlow } from "./project-flow.mjs";
import { createNativeFlow } from "./native-flow.mjs";
import { nativeProjectHost } from "./project-host.mjs";
import { createWorkPolicyStore } from "./work-policy.mjs";
import { readSmartCatalog } from "./work-entry.mjs";
import { assertAvailable, PRESET_GUIDANCE } from "./smart-policy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export async function createOptionsServer(dataDir, { readCatalog = readSmartCatalog } = {}) {
  const store = createSettingsStore(dataDir);
  const policies = createWorkPolicyStore(dataDir);
  const router = createChatRouter({ dataDir, dispatch: async () => { throw new Error("Options cannot dispatch prompts"); }, deferDispatch: true });
  const queue = createPromptQueue({ dataDir });
  const projectFlow = createProjectFlow({ dataDir, host: nativeProjectHost });
  const nativeFlow = createNativeFlow({ dataDir, host: nativeProjectHost });
  const token = crypto.randomBytes(32).toString("hex");
  const challenges = new Map();
  let origin;
  const assets = { "/": ["options.html", "text/html"], "/options.js": ["options.js", "text/javascript"], "/options.css": ["options.css", "text/css"] };
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (req.headers.host !== new URL(origin).host) return send(403, { error: "Invalid host" });
    if (req.headers.origin && req.headers.origin !== origin) return send(403, { error: "Invalid origin" });
    if (req.method === "GET" && req.url === "/connection") {
      // Static, read-only preview. No token, route state or settings are embedded.
      const html = fs.readFileSync(path.join(here, "ui", "connection.html"), "utf8");
      const hashes = tag => [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g"))]
        .map(match => `'sha256-${crypto.createHash("sha256").update(match[1]).digest("base64")}'`).join(" ");
      res.setHeader("Content-Security-Policy", `default-src 'none'; script-src ${hashes("script")}; style-src ${hashes("style")}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (req.method === "GET" && assets[req.url]) {
      const [file, type] = assets[req.url];
      res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
      return res.end(fs.readFileSync(path.join(here, "ui", file)));
    }
    if (req.headers.authorization !== `Bearer ${token}`) return send(403, { error: "Reopen Options from TFO" });
    try {
      if (req.method === "GET" && req.url === "/api/settings") return send(200, store.read());
      if (req.method === "GET" && req.url === "/api/catalog") return send(200, { models: await readCatalog(), presets: PRESET_GUIDANCE });
      if (req.method === "GET" && req.url === "/api/work-policies") return send(200, policies.list());
      if (req.method === "GET" && req.url === "/api/routes") {
        const dir = path.join(dataDir, "runs");
        const routes = [];
        for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
          if (!entry.isDirectory() || !/^(chat|route|queue)_[a-z0-9_]+$/.test(entry.name)) continue;
          try {
            const state = entry.name.startsWith("queue_") ? queue.recover(entry.name) : JSON.parse(fs.readFileSync(path.join(dir, entry.name, "state.json"), "utf8"));
            let plannedSelection = null;
            if (state.kind === "prompt_queue") plannedSelection = state.steps[state.currentIndex]?.selection || null;
            if (state.status === "pending" && state.execution && state.steps[state.currentIndex]) {
              try { plannedSelection = decideModel({ ...state.execution, assessment: state.steps[state.currentIndex].assessment, settings: store.read() }).selected; } catch { /* The route will stop before dispatch. */ }
            }
            routes.push({ id: state.id, objective: state.objective, status: state.status, completed: state.completedSteps.length,
              total: state.steps.length, execution: state.execution || null, error: state.error, updatedAt: state.updatedAt,
              plannedSelection,
              supervisor: state.kind === "prompt_queue" ? state.supervisor : null,
              currentStep: state.steps[state.currentIndex] || null, pendingPrompt: state.status === "pending" ? state.dispatch?.prompt || state.steps[state.currentIndex]?.visiblePrompt || state.steps[state.currentIndex]?.prompt || null : null,
              remainingPrompts: state.kind === "prompt_queue" ? state.steps.slice(state.currentIndex).map(step => ({ title: step.title, prompt: step.prompt, selection: step.selection })) : null,
              checkpoints: state.completedSteps.map(item => ({ title: item.title, summary: item.summary, success: item.success })),
              lastDecision: state.modelDecisions?.at(-1) || null, budget: state.budget || null,
              time: state.time ? { ...state.time, elapsedMinutes: Math.round((Date.now() - Date.parse(state.startedAt)) / 60000),
                progressPercent: Math.min(100, Math.round((Date.now() - Date.parse(state.startedAt)) / 60000 / state.time.targetMinutes * 100)) } : null });
          } catch { /* A corrupt route is handled by the route tool. */ }
        }
        for (const [folder, singleFile] of [["native-flows", true], ["parallel", false]]) {
          const flowDir = path.join(dataDir, folder);
          for (const entry of fs.existsSync(flowDir) ? fs.readdirSync(flowDir, { withFileTypes: true }) : []) {
            if (singleFile ? !entry.isFile() || !/^flow_[a-z0-9_]+\.json$/.test(entry.name) : !entry.isDirectory() || !/^flow_[a-z0-9_]+$/.test(entry.name)) continue;
            try {
              const state = JSON.parse(fs.readFileSync(singleFile ? path.join(flowDir, entry.name) : path.join(flowDir, entry.name, "state.json"), "utf8"));
              const maxParallelWorkers = state.maxParallelWorkers ?? (singleFile ? 2 : 8);
              routes.push({ id: state.id, kind: state.kind, objective: state.objective, status: state.status,
                completed: state.nodes.filter(node => node.checkpoint && (node.status === "completed" || node.resolution?.status === "resolved")).length, total: state.nodes.length,
                maxParallelWorkers,
                effectiveMaxParallelWorkers: Math.min(maxParallelWorkers, state.capacityBackpressure?.effectiveMaxParallelWorkers ?? 100),
                capacityBackpressure: state.capacityBackpressure ? { retryAt: state.capacityBackpressure.retryAt, code: state.capacityBackpressure.code } : null,
                activeWorkers: state.nodes.filter(node => node.lane !== "main" && ["current", "dispatching", "queued", "running", "provisioning_dispatching", "provisioning"].includes(node.status)).length,
                coordinationMode: state.coordinationMode ?? "deferred_join", error: state.error, updatedAt: state.updatedAt,
                checkpoints: [], execution: null });
            } catch { /* Preserve damaged flow data for its dedicated diagnostic tool. */ }
          }
        }
        return send(200, routes.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).slice(0, 30));
      }
      if (req.method !== "POST" || req.headers.origin !== origin || req.headers["content-type"] !== "application/json") return send(403, { error: "Expected a local JSON request" });
      let body = "";
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 4096) { send(413, { error: "Request too large" }); return; } }
      const args = JSON.parse(body || "{}");
      if (req.url === "/api/work-choice") {
        const next = { ...policies.get(args.workId).configuration, ...args.policy };
        if (next.mode === "custom") assertAvailable({ model: next.customModel, reasoning: next.customEffort }, await readCatalog());
        return send(200, policies.choose(args.workId, args));
      }
      if (req.url === "/api/work-permission") return send(200, policies.grant(args.workId, args.scope));
      if (req.url === "/api/work-revoke") return send(200, policies.revoke(args.grantId));
      if (req.url === "/api/routes/control") {
        if (/^flow_[a-z0-9_]+$/.test(args.runId || "")) {
          if (args.action !== "set_parallelism") return send(400, { error: "Unsupported flow action" });
          const nativePath = path.join(dataDir, "native-flows", `${args.runId}.json`);
          const control = fs.existsSync(nativePath) ? nativeFlow : projectFlow;
          const state = await control.setParallelism(args.runId, args.maxParallelWorkers, true);
          return send(200, { id: state.id, status: state.status, maxParallelWorkers: state.maxParallelWorkers });
        }
        if (!/^(chat|queue)_[a-z0-9_]+$/.test(args.runId || "")) return send(400, { error: "Invalid chat route" });
        const control = args.runId.startsWith("queue_") ? queue : router;
        if (args.action === "pause") return send(200, control.pause(args.runId));
        if (args.action === "cancel") return send(200, control.cancel(args.runId));
        return send(400, { error: "Unsupported route action" });
      }
      if (req.url === "/api/upgrade-confirmation") {
        challenges.clear();
        const challenge = crypto.randomBytes(24).toString("hex");
        challenges.set(challenge, Date.now() + 120000);
        return send(200, { challenge, warning: UPGRADE_WARNING });
      }
      if (req.url === "/api/settings") {
        if (args.patch?.customModel || args.patch?.customEffort || args.patch?.mode === "custom") {
          const next = { ...store.read(), ...args.patch };
          assertAvailable({ model: next.customModel, reasoning: next.customEffort }, await readCatalog());
        }
        if (args.patch?.allowUpgrades === true && !store.read().allowUpgrades) {
          const expires = challenges.get(args.challenge);
          challenges.delete(args.challenge);
          if (!expires || expires < Date.now() || args.confirmation !== UPGRADE_WARNING) return send(409, { error: "Confirm the warning in Options first" });
        }
        return send(200, store.update(args.patch, args.confirmation));
      }
      return send(404, { error: "Not found" });
    } catch (error) { return send(400, { error: String(error.message || error) }); }
  });
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, url: `${origin}/#${token}`, connectionPreviewUrl: `${origin}/connection`, origin, token };
}

export function launchOptions(dataDir) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ["--child", dataDir], { detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Options did not start")); }, 10000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("message", message => {
      clearTimeout(timer); child.disconnect(); child.unref();
      if (message.error) reject(new Error(message.error)); else resolve(message);
    });
  });
}
if (process.argv[2] === "--child") {
  try {
    const panel = await createOptionsServer(process.argv[3]);
    let idle = setTimeout(() => panel.server.close(), 30 * 60 * 1000);
    panel.server.on("request", () => { clearTimeout(idle); idle = setTimeout(() => panel.server.close(), 30 * 60 * 1000); });
    process.send({ url: panel.url, connectionPreviewUrl: panel.connectionPreviewUrl, expiresAfterIdleMinutes: 30 });
  } catch (error) { process.send({ error: String(error.message || error) }); process.exitCode = 1; }
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.env.TFO_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), "TFO", "data"));
  const panel = await launchOptions(dir);
  console.log(process.argv.includes("--connection-preview") ? panel.connectionPreviewUrl : panel.url);
}
