function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  serviceGraphTable: required("SERVICE_GRAPH_TABLE"),
  deployEventsTable: required("DEPLOY_EVENTS_TABLE"),
  incidentsTable: required("INCIDENTS_TABLE"),
  approveFunctionUrl: process.env.APPROVE_FUNCTION_URL ?? "",
  protectedFunctionName: process.env.PROTECTED_FUNCTION_NAME ?? "",
  protectedAliasName: process.env.PROTECTED_ALIAS_NAME ?? "live",
};
