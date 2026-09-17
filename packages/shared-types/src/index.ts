export type ServiceName = "gateway" | "orders" | "inventory";

export type IncidentStatus = "open" | "localized" | "closed";

export interface Incident {
  incidentId: string;
  service: ServiceName;
  alarmName: string;
  detectedAt: string;
  status: IncidentStatus;
  createdAt: string;
}

export interface LocalizationCandidate {
  service: ServiceName;
  distanceFromAnomaly: number;
  deployTimestamp: string | null;
  deployVersion: string | null;
  deploySummary: string | null;
  secondsBeforeAnomaly: number | null;
  score: number;
}

export interface LocalizationResult {
  incidentId: string;
  rankedCandidates: LocalizationCandidate[]; // sorted desc by score
  computedAt: string;
}

export interface GraphNode {
  service: ServiceName;
}

export interface GraphEdge {
  from: ServiceName;
  to: ServiceName;
  lastSeenAt: string;
}

export interface DeployEvent {
  service: ServiceName;
  timestamp: string;
  version: string;
  diffSummary: string;
}

export interface OrderRequest {
  orderId: string;
  sku: string;
  quantity: number;
}

export interface InventoryCheckResult {
  sku: string;
  available: boolean;
  quantityOnHand: number;
}