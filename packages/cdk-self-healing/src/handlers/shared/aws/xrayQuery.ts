import { XRayClient, GetTraceSummariesCommand, BatchGetTracesCommand, Trace } from "@aws-sdk/client-xray";

const xray = new XRayClient({});

export async function getRecentTraceIds(windowMinutes = 15): Promise<string[]> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - windowMinutes * 60_000);
  const res = await xray.send(
    new GetTraceSummariesCommand({
      StartTime: startTime,
      EndTime: endTime,
      FilterExpression: 'service("GatewayFunction")',
    })
  );
  return (res.TraceSummaries ?? []).map((t) => t.Id!).filter(Boolean);
}

export async function getFullTraces(traceIds: string[]): Promise<Trace[]> {
  if (traceIds.length === 0) return [];
  const res = await xray.send(new BatchGetTracesCommand({ TraceIds: traceIds }));
  return res.Traces ?? [];
}
