import { GraphEdge, ServiceName } from "@shi/shared-types";

// BFS backward along CALLS edges from `target` to find every service that
// is actually on a call path INTO it, tagged with hop distance. This is the
// "restricted to nodes actually on a call path to D" part of the heuristic —
// it deliberately does NOT rank every service in the system, only ancestors.
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
  return distances; // includes target itself at distance 0
}

// Temporal-precedence score: a deploy that lands closer in time BEFORE the
// anomaly is a stronger causal candidate than one from days ago. A deploy
// AFTER the anomaly onset can't be the cause — score it 0, don't just rank
// it low, so it never accidentally outranks a real candidate with no deploy
// data at all.
export function temporalScore(secondsBeforeAnomaly: number | null): number {
  if (secondsBeforeAnomaly === null) return 0.05; // small non-zero floor: a
  // service with no deploy record is still a valid candidate by topology
  // alone, just a weak one — don't let it drop to exactly 0 and tie with
  // "deploy happened after the anomaly" candidates.
  if (secondsBeforeAnomaly < 0) return 0;
  // Decays from 1.0 (deploy landed right before the anomaly) toward 0 as
  // the gap grows. Half-life ≈ 5 minutes (300s) — tune after seeing real
  // demo timings; this is the one constant worth eyeballing against your
  // actual fault-injection-to-alarm latency.
  return 1 / (1 + secondsBeforeAnomaly / 300);
}

// Structural prior: being closer to the anomaly (fewer hops) is itself
// weak evidence, since most cascades originate near where they're observed
// more often than not. This is deliberately a SMALL weight relative to
// temporalScore, so a well-timed deploy three hops away can still outrank
// the node at distance=0 with no recent deploy — matches the roadmap's "not
// just the loudest symptom" framing.
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