export type ServiceName = "gateway" | "orders" | "inventory";

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