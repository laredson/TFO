import { createSettingsStore } from "./settings.mjs";
import { readSmartCatalog } from "./work-entry.mjs";
import { assertAvailable } from "./smart-policy.mjs";

export const settingsCapability = { readTool: "tfo_settings_read", updateTool: "tfo_settings_update" };
const labels = {
  usagePolicy: { automatic: "Automático", plan_or_ask: "Añadir al plan + preguntar fuera del plan", ask_once: "Siempre preguntar una vez por trabajo" },
  permissionPolicy: { allow: "Permitir siempre", ask: "Preguntar", disabled: "Deshabilitar" },
  mode: { intelligent: "Inteligente", custom: "Custom" },
  smartPreset: { normal: "Normal", saving: "Ahorro", fast: "Rápido", max_speed: "MaxSpeed", quality: "Calidad", hq: "HQ", maximum: "Máximo", max_hq: "MaxHQ" },
  customModel: { "gpt-6-luna": "Luna 6", "gpt-6.1-sol": "Sol 6.1", "gpt-6-astra": "Astra 6" },
  customEffort: { low: "Bajo", medium: "Medio", high: "Alto", xhigh: "Muy alto", max: "Máximo", ultra: "Ultra" },
};
const titles = { usagePolicy: "Uso", permissionPolicy: "Permiso", mode: "Modo", smartPreset: "Prioridad inteligente", customModel: "Modelo Custom", customEffort: "Potencia Custom" };
const valuesFor = settings => Object.fromEntries([...Object.keys(labels).map(key => [key, labels[key][settings[key]]]), ["maxParallelWorkers", settings.maxParallelWorkers]]);
export const nativeSettingsTools = [
  { name: settingsCapability.readTool, description: "Read TFO native settings without changing them.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object", required: ["schema", "values"], properties: { schema: { type: "object" }, values: { type: "object" }, layout: { type: "array", items: { type: "object" } } } } },
  { name: settingsCapability.updateTool, description: "Save settings explicitly changed by the human in plugin settings or explicitly requested in conversation. Does not grant additional host permissions.",
    inputSchema: { type: "object", additionalProperties: false, required: ["set"], properties: { set: { type: "object", additionalProperties: false, minProperties: 1,
      properties: { ...Object.fromEntries(Object.entries(labels).map(([key, values]) => [key, { type: "string", enum: Object.values(values) }])), maxParallelWorkers: { type: "integer", minimum: 1, maximum: 100 } } } } },
    outputSchema: { type: "object", required: ["values"], properties: { values: { type: "object" } } } },
];
export async function readNativeSettings(dataDir, readCatalog = readSmartCatalog) {
  const settings = createSettingsStore(dataDir).read();
  let catalog; try { catalog = await readCatalog(); } catch { catalog = null; }
  const properties = Object.fromEntries(Object.entries(labels).map(([key, values]) => [key, { type: "string", title: titles[key], enum: Object.values(values) }]));
  properties.customModel.enum = catalog ? catalog.map(item => labels.customModel[item.model || item.id]).filter(Boolean) : [labels.customModel[settings.customModel]];
  const model = catalog?.find(item => (item.model || item.id) === settings.customModel);
  properties.customEffort.enum = model ? model.supportedReasoningEfforts.map(item => labels.customEffort[item.reasoningEffort || item]).filter(Boolean) : [labels.customEffort[settings.customEffort]];
  for (const key of ["customModel", "customEffort"]) if (!properties[key].enum.includes(labels[key][settings[key]])) properties[key].enum.push(labels[key][settings[key]]);
  properties.customModel.description = "Custom fija el modelo. Las selecciones se validan con el catálogo actual al guardar.";
  properties.smartPreset.description = "HQ añade revisión a Calidad; MaxHQ añade revisión a Máximo. Los modelos se eligen por tarea.";
  properties.maxParallelWorkers = { type: "integer", title: "Auxiliares simultáneos", minimum: 1, maximum: 100 };
  return { schema: { type: "object", properties }, values: valuesFor(settings), layout: [
    { kind: "group", title: "Uso y permisos", items: ["usagePolicy", "permissionPolicy"].map(property => ({ kind: "property", property })) },
    { kind: "group", title: "Modo de trabajo", items: ["mode", "smartPreset", "customModel", "customEffort", "maxParallelWorkers"].map(property => ({ kind: "property", property })) },
  ] };
}
export async function updateNativeSettings(dataDir, set, readCatalog = readSmartCatalog) {
  if (!set || typeof set !== "object" || !Object.keys(set).length) throw new Error("Settings update requires changed values");
  const patch = {};
  for (const [key, value] of Object.entries(set)) {
    if (key === "maxParallelWorkers") { patch[key] = value; continue; }
    const entry = Object.entries(labels[key] || {}).find(([, label]) => label === value);
    if (!entry) throw new Error(`Invalid setting: ${key}`);
    patch[key] = entry[0];
  }
  const store = createSettingsStore(dataDir), next = { ...store.read(), ...patch };
  if (patch.customModel || patch.customEffort || patch.mode === "custom") assertAvailable({ model: next.customModel, reasoning: next.customEffort }, await readCatalog());
  return { values: valuesFor(store.update(patch)) };
}
