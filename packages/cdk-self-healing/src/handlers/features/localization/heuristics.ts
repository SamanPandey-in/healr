import { GraphEdge, ServiceName } from "../types";

export function findUpstreamAncestors(
  target: ServiceName,
  edges: GraphEdge[]
): Map<ServiceName, number> {
  const reverseAdjacency = new Map<ServiceName, ServiceName[]>();
  for (const edge of edges) {
    if (!reverseAdjacency.has(edge.to)) reverseAdjacency.set(edge.to, []);
    reverseAdjacency.get(edge.to)!.push(edge.from);
  }

  const distances = new Map<ServiceName, number>([[target, 0]]);
  const queue: ServiceName[] = [target];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const callers = reverseAdjacency.get(current) ?? [];
    for (const caller of callers) {
      if (distances.has(caller)) continue;
      distances.set(caller, distances.get(current)! + 1);
      queue.push(caller);
    }
  }
  return distances;
}

export function temporalScore(secondsBeforeAnomaly: number | null): number {
  if (secondsBeforeAnomaly === null) return 0.05;
  if (secondsBeforeAnomaly < 0) return 0;
  return 1 / (1 + secondsBeforeAnomaly / 300);
}

export function structuralPrior(distance: number): number {
  return 1 / (1 + distance);
}

export function combinedScore(secondsBeforeAnomaly: number | null, distance: number): number {
  const TEMPORAL_WEIGHT = 0.8;
  const STRUCTURAL_WEIGHT = 0.2;
  return (
    TEMPORAL_WEIGHT * temporalScore(secondsBeforeAnomaly) +
    STRUCTURAL_WEIGHT * structuralPrior(distance)
  );
}
