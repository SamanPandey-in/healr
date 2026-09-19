function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  serviceGraphTable: required("SERVICE_GRAPH_TABLE"),
  deployEventsTable: required("DEPLOY_EVENTS_TABLE"),
  incidentsTable: required("INCIDENTS_TABLE"),
  ordersFunctionUrl: process.env.ORDERS_FUNCTION_URL ?? "",
  inventoryFunctionUrl: process.env.INVENTORY_FUNCTION_URL ?? "",
  injectFault: process.env.INJECT_FAULT === "true",
  faultProbability: Number(process.env.FAULT_PROBABILITY ?? "0.3"),
  faultMode: (process.env.FAULT_MODE ?? "error") as "error" | "latency",
  bedrockModelId: process.env.BEDROCK_MODEL_ID ?? "qwen.qwen3-235b-a22b-2507-v1:0",
  approveFunctionUrl: process.env.APPROVE_FUNCTION_URL ?? "",
  inventoryFunctionName: process.env.INVENTORY_FUNCTION_NAME ?? "",
  inventoryAliasName: process.env.INVENTORY_ALIAS_NAME ?? "live",
};