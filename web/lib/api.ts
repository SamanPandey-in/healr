const API_BASE = process.env.NEXT_PUBLIC_API_BASE!;

export async function armDemo() {
  const res = await fetch(`${API_BASE}/demo/arm`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ armed: boolean; version: string }>;
}

export async function triggerOrder(orderId: string) {
  return fetch(`${API_BASE}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, sku: "SKU-123", quantity: 2 }),
  });
}

export async function listIncidents() {
  const res = await fetch(`${API_BASE}/incidents`, { cache: "no-store" });
  return res.json();
}

export async function getIncident(id: string) {
  const res = await fetch(`${API_BASE}/incidents/${id}`, { cache: "no-store" });
  if (res.status === 404) return null;
  return res.json();
}
