#!/usr/bin/env node
// Private web MCP entry point for Secure MCP Tunnel's stdio transport.
// Deliberately independent of server.mjs: importing it would expose local worker tools.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { connectionCheck, connectionResource } from "./connection-check.mjs";
import { createWebQueueStore } from "./web-queue.mjs";

const VERSION = "1.0.0-rc.3";
const root = path.dirname(fileURLToPath(import.meta.url));
const queueResource = "ui://tfo/web-queue-v1.html";
const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const string = maxLength => ({ type: "string", minLength: 1, maxLength });
const idSchema = object({ runId: { type: "string", pattern: "^web_[0-9a-f-]{36}$" } });
const surfaceSchema = object({ surface: { type: "string", enum: ["chatgpt-chat", "chatgpt-work"] } });
const selectionSchema = object({ modelLabel: string(100), effortLabel: string(100) });
const queueSchema = { type: "object", required: ["id", "status", "sendEnabled", "steps", "confirmedSends"], properties: {
  id: string(40), status: { type: "string", enum: ["awaiting_host_adapter", "cancelled"] }, sendEnabled: { const: false },
  steps: { type: "array", items: object({ id: string(20), title: string(200), prompt: string(16000), selection: selectionSchema }) },
  confirmedSends: { const: 0 },
}, additionalProperties: true };
const descriptor = (name, description, inputSchema, readOnlyHint, resourceUri, outputSchema) => ({
  name, description, inputSchema, outputSchema: outputSchema || { type: "object", additionalProperties: true },
  annotations: { readOnlyHint, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  ...(resourceUri ? { _meta: { ui: { resourceUri }, "openai/outputTemplate": resourceUri } } : {}),
});
export const webTools = [
  descriptor("tfo_health", "Read the private web TFO version and supported capabilities. No prompt is sent.", object({}), true),
  descriptor("tfo_connection_check", "Check the private web MCP connection. The surface is caller-declared; connection does not prove automatic sending.", surfaceSchema, true),
  descriptor("tfo_connection_panel", "Show the connection diagnostic inside the web chat. No sending or model selection.", surfaceSchema, true, connectionResource),
  descriptor("tfo_web_prepare", "Store an authorized sequence of prompts for this web chat. Retain one requestId UUID for retries; supply the real conversation URL and exact requested model/effort labels. This version saves the plan awaiting a host adapter: it never starts execution, sends prompts, chooses models or accesses project files.", object({
    requestId: { type: "string", format: "uuid" }, chatUrl: string(500), projectLabel: string(200), objective: string(2000),
    steps: { type: "array", minItems: 1, maxItems: 20, items: object({ title: string(200), prompt: string(16000), selection: selectionSchema }) },
  }), false, null, queueSchema),
  descriptor("tfo_web_status", "Read saved prompts, requested selections and blocking reason. Never interpret preparation as execution.", idSchema, true, null, queueSchema),
  descriptor("tfo_web_panel", "Display a saved web queue in this chat with its pending prompts, selections and cancel control.", idSchema, true, queueResource, queueSchema),
  descriptor("tfo_web_cancel", "Cancel a prepared web queue while preserving its prompts. Repeating cancellation or preparation cannot reactivate it.", idSchema, false, null, queueSchema),
];
export function createWebHandler(dataDir) {
  const store = createWebQueueStore(dataDir);
  const resources = new Map([[connectionResource, "connection.html"], [queueResource, "web-queue.html"]]);
  return async message => {
    const reply = result => ({ jsonrpc: "2.0", id: message.id, result });
    const error = (code, text) => ({ jsonrpc: "2.0", id: message?.id ?? null, error: { code, message: text } });
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string" || Array.isArray(message)) return error(-32600, "Invalid request");
    if (message.id === undefined) return null;
    const params = message.params || {};
    switch (message.method) {
      case "initialize": return reply({ protocolVersion: ["2025-11-25", "2025-06-18", "2025-03-26"].includes(params.protocolVersion) ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } }, serverInfo: { name: "tfo-web", version: VERSION },
        instructions: "TFO private web preparation. Store authorized plans with tfo_web_prepare and display tfo_web_panel. The conventional supervisor has no verified web turn observer/sender yet: all plans wait for that adapter. Never claim a prompt or worker was launched, never change model through another API, never ask for API keys in chat. This connection has no shell, local Codex writer or project file access." });
      case "ping": return reply({});
      case "tools/list": return reply({ tools: webTools });
      case "resources/list": return reply({ resources: [...resources].map(([uri]) => ({ uri, name: uri, mimeType: "text/html;profile=mcp-app" })) });
      case "resources/templates/list": return reply({ resourceTemplates: [] });
      case "resources/read": {
        if (!resources.has(params.uri)) return error(-32602, "Unknown resource");
        return reply({ contents: [{ uri: params.uri, mimeType: "text/html;profile=mcp-app", text: fs.readFileSync(path.join(root, "ui", resources.get(params.uri)), "utf8"),
          _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } } }] });
      }
      case "tools/call": {
        try {
          const args = params.arguments || {};
          let value;
          if (!webTools.some(tool => tool.name === params.name)) throw new Error("Tool not available on the private web profile");
          switch (params.name) {
            case "tfo_health": value = { ok: true, version: VERSION, profile: "private-web", queuePreparation: true, automaticDelivery: false, dataScope: "isolated-web-queues" }; break;
            case "tfo_connection_check":
            case "tfo_connection_panel":
              if (!["chatgpt-chat", "chatgpt-work"].includes(args.surface)) throw new Error("Use a ChatGPT web surface");
              value = { ...connectionCheck(args.surface), version: VERSION, profile: "private-web", queuePreparation: true }; break;
            case "tfo_web_prepare": value = store.prepare(args); break;
            case "tfo_web_cancel": value = store.cancel(args.runId); break;
            default: value = store.get(args.runId);
          }
          return reply({ structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] });
        } catch (cause) {
          // Avoid leaking server filesystem locations or internal stack traces to web clients.
          const text = cause.code ? `Stored web queue operation failed (${cause.code}). No prompt was sent.` : cause.message;
          return reply({ isError: true, content: [{ type: "text", text }] });
        }
      }
      default: return error(-32601, "Method not found");
    }
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.TFO_WEB_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), "TFO", "web-data");
  const handle = createWebHandler(dataDir);
  // readline calls are serialized; stdout contains only MCP JSON-RPC.
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let response;
    try { response = await handle(JSON.parse(line)); }
    catch { response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON request" } }; }
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  }
}
