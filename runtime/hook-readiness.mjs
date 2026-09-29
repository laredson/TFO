import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Installation metadata is not evidence that this chat executed the installed hook.
export function verifyHookReceipt(dataDir, threadId, runtimeDir = path.dirname(fileURLToPath(import.meta.url))) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) throw new Error("Invalid chat ID");
  let signal;
  try { signal = JSON.parse(fs.readFileSync(path.join(dataDir, "hook-signals", `${threadId}.json`), "utf8")); }
  catch { throw new Error("No real Stop receipt for this chat. Finish a diagnostic turn before arming TFO."); }
  if (signal.threadId !== threadId || signal.stopHookActive !== false || !path.isAbsolute(signal.runtimeRoot || "")) throw new Error("Invalid Stop receipt");
  for (const name of ["stop-hook.mjs", "queue-supervisor.mjs", "prompt-queue.mjs", "queue-transport.mjs", "ui-bridge.ps1"]) {
    let observed;
    try { observed = fs.readFileSync(path.join(signal.runtimeRoot, name), "utf8"); }
    catch { throw new Error("The last Stop receipt points to a removed installation. Finish a turn with the current plugin before arming TFO."); }
    const expected = fs.readFileSync(path.join(runtimeDir, name), "utf8");
    if (observed.replace(/\r\n/g, "\n") !== expected.replace(/\r\n/g, "\n")) throw new Error("The last Stop receipt belongs to different runtime code. Validate the updated plugin before arming TFO.");
  }
  return signal;
}
