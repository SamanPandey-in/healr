export type Service = "gateway" | "orders" | "inventory";
export type IncidentStatus = "open" | "localized" | "diagnosed" | "remediated" | "closed";
export type StepStatus = "pending" | "running" | "waiting" | "succeeded" | "failed";

export interface IncidentMeta {
  incidentId: string;
  service: Service;
  alarmName: string;
  detectedAt: string;
  createdAt: string;
  status: IncidentStatus;
}

export interface Candidate {
  service: Service;
  distanceFromAnomaly: number;
  deployTimestamp: string | null;
  deployVersion: string | null;
  deploySummary: string | null;
  secondsBeforeAnomaly: number | null;
  score: number;
}

export interface Localization { incidentId: string; rankedCandidates: Candidate[]; computedAt: string }

export interface Diagnosis {
  incidentId: string;
  rootCauseService: Service;
  summary: string;
  citedEvidenceIds: string[];
  confidence: number;
  rankedCandidates: Candidate[];
  generatedAt: string;
}

export interface Approval {
  incidentId: string;
  status: "pending" | "approved" | "denied";
  approveLink?: string;
  denyLink?: string;
  decidedAt?: string;
  diagnosis?: Diagnosis;
}

export interface Remediation {
  incidentId: string;
  service: Service;
  action: string;
  revertedFromVersion: string;
  revertedToVersion: string;
  remediatedAt: string;
}

export interface Verification {
  incidentId: string;
  service: Service;
  faultCountBefore: number;
  faultCountAfter: number;
  recovered: boolean;
  verifiedAt: string;
}

// GET /incidents/{id} returns the DynamoDB rows keyed by sort key.
export interface IncidentBundle {
  META?: IncidentMeta;
  LOCALIZATION?: Localization;
  DIAGNOSIS?: Diagnosis;
  APPROVAL?: Approval;
  REMEDIATION?: Remediation;
  VERIFICATION?: Verification;
}

// GET /incidents/{id}/execution — mirrors server/src/features/incidents/executionView.ts
export interface ExecutionStep {
  name: string;
  status: Exclude<StepStatus, "pending">;
  enteredAt: string;
  exitedAt?: string;
  durationMs?: number;
  attempts: number;
  waitingOn?: "callback" | "timer";
  input?: unknown;
  output?: unknown;
  error?: string;
  cause?: string;
}

export interface ExecutionEvent { id: number; type: string; timestamp: string; state?: string }

export interface ExecutionView {
  executionArn: string;
  name?: string;
  status: string; // RUNNING | SUCCEEDED | FAILED | TIMED_OUT | ABORTED
  startDate: string;
  stopDate?: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  consoleUrl: string;
  steps: ExecutionStep[];
  events: ExecutionEvent[];
}

// One row in the pipeline UI: static definition + whatever the execution reported.
export interface ViewStep extends Partial<Omit<ExecutionStep, "status">> {
  name: string;
  label: string;
  blurb: string;
  aws: string;
  timerSeconds?: number;
  status: StepStatus;
  attempts: number;
}
