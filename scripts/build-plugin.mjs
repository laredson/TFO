// Canonical code is runtime/. Never edit the generated plugin/runtime copy.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = path.join(repo, "plugins", "tfo");
const files = ["server.mjs", "chat-route.mjs", "chat-control.mjs", "prompt-queue.mjs", "project-coordinator.mjs", "project-reservations.mjs", "queue-supervisor.mjs", "dispatch-worker.mjs", "stop-hook.mjs", "ui-bridge.ps1", "ui-send-guard.mjs", "model-policy.mjs", "host-selection.mjs", "queue-transport.mjs", "app-server-client.mjs", "budget.mjs", "settings.mjs", "options-server.mjs", "step-result.schema.json", "start.cmd", "ui/options.html", "ui/options.css", "ui/options.js"];
files.push("connection-check.mjs", "ui/connection.html");
files.push("hook-readiness.mjs");
files.push("supervisor-launch.mjs");
files.push("queue-control.mjs");
files.push("web-server.mjs", "web-queue.mjs", "ui/web-queue.html");
files.push("project-flow.mjs", "project-host.mjs", "project-workspace.mjs", "project-supervisor.mjs", "project-flow-tools.mjs");
files.push("native-flow.mjs", "native-flow-control.mjs", "native-flow-tools.mjs", "native-flow-watch.mjs");
files.push("native-join-supervisor.mjs", "native-join-control.mjs");
files.push("selected-join-adapter.mjs");
files.push("native-coordinator-supervisor.mjs");
files.push("snapshot-publish.mjs");
files.push("atomic-file.mjs");
const hashes = {};
files.push("smart-policy.mjs", "work-policy.mjs", "work-entry.mjs", "review-policy.mjs", "native-settings.mjs", "work-budget.mjs", "measurements.mjs");
for (const relative of files) {
  const contents = fs.readFileSync(path.join(repo, "runtime", relative), "utf8").replace(/\r\n/g, "\n");
  const target = path.join(plugin, "runtime", relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  hashes[relative] = crypto.createHash("sha256").update(contents).digest("hex");
}
const overlay = JSON.parse(fs.readFileSync(path.join(plugin, ".codex-plugin", "plugin.json"), "utf8"));
const packageHashes = {};
for (const relative of ["scripts/configure-web-tunnel.ps1", "scripts/import-legacy.mjs",
  "README.md", "INSTALL.md", "MIGRATION_NOTES.md", "LICENSE.md",
  ...fs.readdirSync(path.join(repo, "docs")).filter(name => name.endsWith(".md") && name !== "RC_VALIDATION.md").map(name => "docs/" + name)]) {
  const source = path.join(repo, relative);
  const contents = fs.readFileSync(source, "utf8").replace(/\r\n/g, "\n");
  const target = path.join(plugin, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  packageHashes[relative] = crypto.createHash("sha256").update(contents).digest("hex");
}
const portable = { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: overlay.name, version: overlay.version,
  description: overlay.description, author: overlay.author, extensions: { "com.openai": { interface: overlay.interface, hooks: "./hooks/hooks.json", onboardingSkill: "./skills/setup/SKILL.md" } } };
// Current Codex skips plugin hooks when root plugin.json selects AgentPlugin format.
// Keep portable metadata as an export only; local installation uses .codex-plugin/.
if (fs.existsSync(path.join(plugin, "plugin.json"))) throw new Error("Root plugin.json disables local hooks on this host. Remove the generated root manifest before bundling.");
fs.writeFileSync(path.join(plugin, "plugin.portable.json"), JSON.stringify(portable, null, 2) + "\n");
fs.writeFileSync(path.join(plugin, "bundle.json"), JSON.stringify({ version: overlay.version, source: "../../runtime", sha256: hashes, packageSha256: packageHashes }, null, 2) + "\n");
console.log(`Bundled ${files.length} runtime files in TFO ${overlay.version}`);
