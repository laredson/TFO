// Recheck durable authorization and the host immediately before every UI mutation.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readHostTurnState } from "./host-selection.mjs";
import { readProjectThread } from "./project-host.mjs";
import { createProjectReservationStore } from "./project-reservations.mjs";
import { createWorkPolicyStore } from "./work-policy.mjs";

const same = (a, b) => a?.model === b?.model && a?.reasoning === b?.reasoning;
export async function verifyUiSendGuard(stateFile, runId, sourceTurnId, expectedOwnerPid = null,
    { readTurn = readHostTurnState, readThread = readProjectThread,
      reservationStore = createProjectReservationStore } = {}) {
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  if (state.id !== runId) throw new Error("Route changed before UI action");
  const policyDataDir = /^flow_/.test(runId) ? path.dirname(path.dirname(stateFile)) : path.dirname(path.dirname(path.dirname(stateFile)));
  createWorkPolicyStore(policyDataDir).assertDispatch(state.workPolicy);
  if (/^flow_[a-z0-9_]+$/.test(runId || "")) {
    const file = path.join(path.dirname(path.dirname(stateFile)), "native-flows", `${runId}.json`);
    if (path.resolve(stateFile) !== path.resolve(file)) throw new Error("Wrong native flow state file");
    const join = state.deferredJoin, node = state.nodes.find(item => item.id === join?.nodeId);
    const main = state.lanes.find(item => item.id === "main");
    if (state.status !== "running" || join?.status !== "dispatching" || join.transport !== "selected_join" ||
        !Number.isInteger(expectedOwnerPid) || join.ownerPid !== expectedOwnerPid ||
        node?.status !== "dispatching" || node.deliveryKind !== "selected_join" ||
        !node.visiblePrompt || !main?.threadId || main.threadId !== state.mainThreadId ||
        join.sourceTurnId !== sourceTurnId || !same(join.sourceSelection, main.selection) ||
        !same(join.requestedSelection, node.selection) || join.marker !== state.mainJoinMarker ||
        typeof join.selectionReason !== "string" || !join.selectionReason) {
      throw new Error("Selected join authorization changed before UI action");
    }
    try { process.kill(expectedOwnerPid, 0); }
    catch (error) { if (error.code !== "EPERM") throw new Error("Selected join owner is no longer running"); }
    if (state.nodes.some(item => item.id !== node.id && (item.status !== "completed" || !item.checkpoint)) ||
        (node.dependsOn || []).some(id => !state.nodes.some(item => item.id === id && item.checkpoint))) {
      throw new Error("Selected join prerequisites are not complete");
    }
    const dataDir = path.dirname(path.dirname(stateFile));
    const reservation = reservationStore({ dataDir }).get(runId);
    if (reservation?.status !== "held" || !reservation.claims?.some(claim =>
        claim.key === `chat:${main.threadId.toLowerCase()}`)) throw new Error("Main chat reservation is not held");
    const thread = await readThread(main.threadId);
    if (thread.workspace !== main.hostWorkspace || thread.active ||
        thread.lastTurnId !== sourceTurnId || thread.completedTurnId !== sourceTurnId ||
        thread.interruptedTurnId === sourceTurnId || thread.userMessageCount !== join.sourceUserMessageCount ||
        !same(thread, join.sourceSelection)) throw new Error("Main chat identity or source turn changed");
    return { threadId: main.threadId, requestedSelection: join.requestedSelection, marker: join.marker };
  }
  if (!/^(chat|queue)_[a-z0-9_]+$/.test(runId || "") || state.status !== "dispatching" ||
      !state.dispatch?.sending || state.dispatch.sourceTurnId !== sourceTurnId) throw new Error("Route changed before UI action");
  const host = await readTurn(state.threadId);
  if (host.active || host.lastTurnId !== sourceTurnId || host.completedTurnId !== sourceTurnId ||
      host.interruptedTurnId === sourceTurnId) throw new Error("Host is not idle on the expected completed turn");
  if (state.pendingSourceUserMessageCount != null && host.userMessageCount !== state.pendingSourceUserMessageCount)
    throw new Error("New user input arrived before UI action");
  return { threadId: state.threadId };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [stateFile, runId, sourceTurnId, owner] = process.argv.slice(2);
  try { await verifyUiSendGuard(stateFile, runId, sourceTurnId, owner === undefined ? null : Number(owner)); }
  catch (error) { process.stderr.write(String(error.message || error)); process.exitCode = 1; }
}
