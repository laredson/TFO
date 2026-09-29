import { spawn } from "node:child_process";
import readline from "node:readline";

// A short-lived local Codex App Server connection. It uses the account already
// signed in on this machine; no API key or separate billing is introduced.
export async function openAppServer({ command = process.env.TFO_CODEX_COMMAND || "codex", timeoutMs = 20000 } = {}) {
  const child = spawn(command, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  const listeners = new Set();
  let serial = 0, stderr = "", closed = false;
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-1000); });
  const failAll = error => {
    closed = true;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  };
  child.once("error", failAll);
  child.once("exit", code => failAll(new Error(`Codex App Server exited (${code}): ${stderr.trim()}`)));
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id != null && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error(`${item.method}: ${message.error.message || JSON.stringify(message.error)}`));
      else item.resolve(message.result);
    } else if (message.method) for (const listener of listeners) listener(message);
  });
  const write = message => {
    if (closed || !child.stdin.writable) throw new Error("Codex App Server connection closed");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const request = (method, params, requestTimeoutMs = timeoutMs) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, requestTimeoutMs);
    pending.set(id, { resolve, reject, timer, method });
    try { write({ method, id, ...(params === undefined ? {} : { params }) }); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
  const close = () => { closed = true; lines.close(); child.stdin.end(); child.kill(); };
  try {
    await request("initialize", { clientInfo: { name: "tfo_orchestrator", title: "TFO", version: "1.0.0-rc.1" } });
    write({ method: "initialized", params: {} });
    return { request, close, onNotification: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  } catch (error) { close(); throw error; }
}
