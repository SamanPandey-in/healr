import { Trace } from "@aws-sdk/client-xray";
import { GraphEdge, ServiceName } from "@shi/shared-types";

// Map a segment's function-name substring to our ServiceName enum.
// Order matters: check "Inventory"/"Orders" before falling through.
function toServiceName(segmentName: string): ServiceName | null {
  if (segmentName.includes("Inventory")) return "inventory";
  if (segmentName.includes("Orders")) return "orders";
  if (segmentName.includes("Gateway")) return "gateway";
  return null;
}

interface ParsedSegment {
  service: ServiceName;
  endTime: number; // epoch seconds, from the segment's own `end_time` field
  subsegmentNames: string[]; // e.g. ["call-orders"]
}

function parseSegmentDocument(doc: string): ParsedSegment | null {
  const parsed = JSON.parse(doc);
  const service = toServiceName(parsed.name ?? "");
  if (!service) return null;
  const subsegmentNames: string[] = (parsed.subsegments ?? []).map((s: { name: string }) => s.name);
  return { service, endTime: parsed.end_time, subsegmentNames };
}

// A trace's `call-orders` / `call-inventory` subsegment names tell us the
// CALLER made an outbound call — we don't need to resolve them to the callee's
// own segment; the topology is static enough (3 services, fixed call shape)
// that "gateway segment has a call-orders subsegment" already means the edge
// gateway→orders exists. This sidesteps correlating subsegment IDs to the
// downstream segment, which BatchGetTraces makes possible but fiddly.
export function deriveEdgesFromTrace(trace: Trace): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const segment of trace.Segments ?? []) {
    if (!segment.Document) continue;
    const parsed = parseSegmentDocument(segment.Document);
    if (!parsed) continue;
    const lastSeenAt = new Date(parsed.endTime * 1000).toISOString();
    for (const subName of parsed.subsegmentNames) {
      if (subName === "call-orders" && parsed.service === "gateway") {
        edges.push({ from: "gateway", to: "orders", lastSeenAt });
      }
      if (subName === "call-inventory" && parsed.service === "orders") {
        edges.push({ from: "orders", to: "inventory", lastSeenAt });
      }
    }
  }
  return edges;
}