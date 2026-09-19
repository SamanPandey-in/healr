import { Trace } from "@aws-sdk/client-xray";
import { GraphEdge, ServiceName } from "../types";

function toServiceName(segmentName: string): ServiceName | null {
  if (segmentName.includes("Inventory")) return "inventory";
  if (segmentName.includes("Orders")) return "orders";
  if (segmentName.includes("Gateway")) return "gateway";
  return null;
}

interface ParsedSegment {
  service: ServiceName;
  endTime: number;
  subsegmentNames: string[];
}

function parseSegmentDocument(doc: string): ParsedSegment | null {
  const parsed = JSON.parse(doc);
  const service = toServiceName(parsed.name ?? "");
  if (!service) return null;
  const subsegmentNames: string[] = (parsed.subsegments ?? []).map((s: { name: string }) => s.name);
  return { service, endTime: parsed.end_time, subsegmentNames };
}

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
