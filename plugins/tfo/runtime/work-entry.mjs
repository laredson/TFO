import { openAppServer } from "./app-server-client.mjs";
import { createWorkPolicyStore } from "./work-policy.mjs";
import { SMART_MODELS } from "./smart-policy.mjs";

export async function readSmartCatalog() {
  const app = await openAppServer();
  try { return (await app.request("model/list", { limit: 100 })).data.filter(item => SMART_MODELS.includes(item.model || item.id) && !item.hidden); }
  finally { app.close(); }
}
export async function prepareWorkEntry(dataDir, args, readCatalog = readSmartCatalog) {
  const policies = createWorkPolicyStore(dataDir);
  const work = policies.prepare(args, args.workId ? undefined : await readCatalog());
  const gate = policies.status(work.id);
  if (!gate.allowed) return { pending: { status: "awaiting_policy", workId: work.id, reason: gate.reason,
    configuration: work.configuration, nextAction: "Abre tfo_options para elegir el modo y autorizar este trabajo; después reutiliza workId." } };
  if (args.initialSelection) policies.assertMain(work, args.initialSelection);
  return { args: { ...args, workPolicy: work }, work };
}
