#!/usr/bin/env node
// Local operator client for the same MCP tools exposed to Codex Desktop.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const runtime = path.dirname(fileURLToPath(import.meta.url));
const [operation, ...values] = process.argv.slice(2);
let name, args;

if (operation === "start-demo") {
  const [threadId, projectPath, model, reasoning] = values;
  if (!threadId || !projectPath || !model || !reasoning) throw new Error("Usage: chat-control.mjs start-demo <threadId> <disposable-project-path> <current-model> <current-effort>");
  fs.mkdirSync(projectPath, { recursive: true });
  name = "tfo_chat_start";
  args = {
    threadId, projectPath, initialSelection: { model, reasoning },
    objective: "Comprobar dos prompts visibles y consecutivos de TFO en esta tarea",
    constraints: "Trabaja únicamente en la carpeta desechable indicada; registra el resultado de cada paso antes de seguir.",
    steps: [
      { title: "Crear la nota de prueba", prompt: "En la carpeta desechable del proyecto, crea `nota-tfo.txt` con una línea que diga `Paso 1 completado`. Comprueba que el archivo existe y explica brevemente el resultado." },
      { title: "Completar la nota de prueba", prompt: "Lee `nota-tfo.txt` y agrega una segunda línea que diga `Paso 2 completado`. Comprueba que ambas líneas están presentes y explica brevemente el resultado." },
    ],
  };
} else if (operation === "call") {
  name = values[0]; args = JSON.parse(fs.readFileSync(values[1], "utf8"));
} else if (["health", "settings", "options"].includes(operation)) {
  name = `tfo_${operation}`; args = {};
} else if (operation === "status") {
  name = "tfo_chat_status"; args = { runId: values[0] };
} else if (operation === "complete") {
  name = "tfo_chat_complete";
  args = { runId: values[0], stepId: values[1], success: values[2] === "true", summary: values.slice(3).join(" ") };
} else if (["pause", "resume", "cancel"].includes(operation)) {
  name = `tfo_chat_${operation}`; args = { runId: values[0] };
} else {
  throw new Error("Usage: chat-control.mjs <start-demo|status|complete|pause|resume|cancel> ...");
}

const child = spawn(process.execPath, [path.join(runtime, "server.mjs")], {
  stdio: ["pipe", "pipe", "inherit"], env: process.env, windowsHide: true,
});
const lines = readline.createInterface({ input: child.stdout });
const response = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("TFO MCP response timed out")), 40000);
  lines.once("line", line => { clearTimeout(timer); resolve(JSON.parse(line)); });
  child.once("error", error => { clearTimeout(timer); reject(error); });
  child.once("exit", code => { if (code && !lines.closed) reject(new Error(`TFO exited with code ${code}`)); });
});
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })}\n`);
try {
  const result = await response;
  process.stdout.write(`${JSON.stringify(result.result?.structuredContent || result.result, null, 2)}\n`);
  if (result.result?.isError || result.error) process.exitCode = 1;
} finally {
  child.stdin.end();
  lines.close();
}
