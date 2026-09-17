import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { getRecentTraceIds, getFullTraces } from "../../shared/aws/xrayQuery";
import { deriveEdgesFromTrace } from "./traceParser";
import { upsertEdge } from "./graphRepository";
import { IncidentResponseState } from "../incidents/types";
import { GraphEdge } from "@shi/shared-types";

patchAwsSdkForTracing();

export async function handler(state: IncidentResponseState): Promise<IncidentResponseState> {
  const traceIds = await getRecentTraceIds(15);
  const traces = await getFullTraces(traceIds);

  const edges = traces.flatMap(deriveEdgesFromTrace);
  // De-dupe by from→to, keep the most recent lastSeenAt per pair.
  const latestByPair = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}`;
    const existing = latestByPair.get(key);
    if (!existing || edge.lastSeenAt > existing.lastSeenAt) latestByPair.set(key, edge);
  }
  await Promise.all([...latestByPair.values()].map(upsertEdge));

  // Fallback: if no traces matched (e.g. trace propagation not yet
  // reflecting in X-Ray's index — there's ingestion lag of up to a few
  // minutes), don't wipe the graph. Just pass the state through — the
  // Day 1-seeded static edges are still there for LocalizeRootCause to use.
  return state;
}