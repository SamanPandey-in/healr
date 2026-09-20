import type { ExecutionView, IncidentBundle, IncidentMeta } from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE!;

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function failWith(res: Response): Promise<never> {
  const text = await res.text();
  let message = text;
  try {
    message = JSON.parse(text).error ?? text;
  } catch {}
  throw new ApiError(res.status, message || `HTTP ${res.status}`);
}

export async function armDemo() {
  const res = await fetch(`${API_BASE}/demo/arm`, { method: "POST" });
  if (!res.ok) await failWith(res);
  return res.json() as Promise<{ armed: boolean; version: string }>;
}

export async function triggerOrder(orderId: string) {
  return fetch(`${API_BASE}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, sku: "SKU-123", quantity: 2 }),
  });
}

export async function listIncidents(): Promise<IncidentMeta[]> {
  const res = await fetch(`${API_BASE}/incidents`, { cache: "no-store" });
  if (!res.ok) await failWith(res);
  const data = await res.json();
  const arr = Array.isArray(data) ? data : Array.isArray((data as { items?: unknown })?.items) ? (data as { items: unknown[] }).items : [];
  return (arr as IncidentMeta[]).filter((i) => !!i && typeof (i as IncidentMeta).incidentId === "string");
}

export async function getIncident(id: string): Promise<IncidentBundle | null> {
  const res = await fetch(`${API_BASE}/incidents/${id}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) await failWith(res);
  return res.json();
}

// NEW — Step Functions execution history for an incident. Throws if the route isn't
// deployed yet (API Gateway answers 403 for unknown routes); callers fall back to DynamoDB.
export async function getExecution(id: string): Promise<ExecutionView | null> {
  const res = await fetch(`${API_BASE}/incidents/${id}/execution`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) await failWith(res);
  return res.json();
}

// NEW — approve/deny from the dashboard. Resolves the pending task token server-side.
export async function decideIncident(id: string, action: "approve" | "deny") {
  const res = await fetch(`${API_BASE}/incidents/${id}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) await failWith(res);
  return res.json() as Promise<{ incidentId: string; decision: "approved" | "denied"; decidedAt: string }>;
}
