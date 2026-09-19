import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { getRecentTraceIds, getFullTraces } from "../../shared/aws/xrayQuery";
import { deriveEdgesFromTrace } from "./traceParser";
import { upsertEdge } from "./graphRepository";
import { IncidentResponseState } from "../incidents/types";
import { GraphEdge } from "../types";

patchAwsSdkForTracing();

export async function handler(state: IncidentResponseState): Promise<IncidentResponseState> {
  const traceIds = await getRecentTraceIds(15);
  const traces = await getFullTraces(traceIds);

  const edges = traces.flatMap(deriveEdgesFromTrace);
  const latestByPair = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}`;
    const existing = latestByPair.get(key);
    if (!existing || edge.lastSeenAt > existing.lastSeenAt) latestByPair.set(key, edge);
  }
  await Promise.all([...latestByPair.values()].map(upsertEdge));

  return state;
}
