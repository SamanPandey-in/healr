export type ServiceName = "gateway" | "orders" | "inventory";

export type IncidentStatus = "open" | "localized" | "diagnosed" | "remediated" | "closed";

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
  rankedCandidates: LocalizationCandidate[];
  computedAt: string;
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

export interface DiagnosisResult {
  incidentId: string;
  rootCauseService: ServiceName;
  summary: string;
  citedEvidenceIds: string[];
  confidence: number;
  rankedCandidates: LocalizationCandidate[];
  generatedAt: string;
}

export interface ApprovalOutcome {
  incidentId: string;
  approved: boolean;
  rootCauseService: ServiceName;
  rankedCandidates: LocalizationCandidate[];
  decidedAt: string;
}

export interface RemediationResult {
  incidentId: string;
  service: ServiceName;
  action: "lambda-alias-rollback";
  revertedFromVersion: string;
  revertedToVersion: string;
  remediatedAt: string;
}

export interface VerificationResult {
  incidentId: string;
  service: ServiceName;
  faultCountBefore: number;
  faultCountAfter: number;
  recovered: boolean;
  verifiedAt: string;
}
