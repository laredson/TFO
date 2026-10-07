import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = relative => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
test("local and portable identities agree without a root manifest", () => {
  const local = read("plugins/tfo/.codex-plugin/plugin.json");
  const portable = read("plugins/tfo/plugin.portable.json");
  assert.equal(local.name, "tfo");
  assert.equal(local.version.split("+")[0], "1.0.0-rc.3");
  assert.equal(portable.name, local.name);
  assert.equal(portable.version, local.version);
  assert.deepEqual(portable.extensions["com.openai"].interface.defaultPrompt, local.interface.defaultPrompt);
  assert.deepEqual(local.interface.defaultPrompt, [
    "Organiza este proyecto en tareas paralelas con TFO y reúne los resultados en este chat.",
    "Coordina dos cadenas de tareas dependientes y luego integra el proyecto.",
    "Abre las opciones de modos y permisos de TFO."
  ]);
  assert.equal(fs.existsSync(path.join(root, "plugins/tfo/plugin.json")), false);
  assert.ok(read("plugins/tfo/hooks/hooks.json").hooks.Stop.length > 0);
});
test("MCP, skill and catalogue use only the new package identity", () => {
  const local = read("plugins/tfo/.codex-plugin/plugin.json");
  assert.equal(local.mcpServers, "./.mcp.json");
  assert.deepEqual(Object.keys(read("plugins/tfo/.mcp.json").mcpServers), ["tfo"]);
  assert.deepEqual(Object.keys(read("plugins/tfo/mcp.json").mcpServers), ["tfo"]);
  const skill = fs.readFileSync(path.join(root, "plugins/tfo/skills/tfo/SKILL.md"), "utf8");
  assert.match(skill, /^---\r?\nname: tfo\r?\n/);
  assert.match(skill, /tfo_budgeted_chat_start/);
  const catalogue = read(".agents/plugins/marketplace.json");
  assert.equal(catalogue.name, "tfo-local");
  assert.equal(catalogue.plugins[0].source.path, "./plugins/tfo");
  assert.equal(catalogue.plugins[0].name, "tfo");
});
