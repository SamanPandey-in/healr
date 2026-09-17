export interface CreateIncidentInput {
  service: string;
  alarmName: string;
  detectedAt: string;
}

// Step Functions passes this shape between CreateIncident → BuildGraph → LocalizeRootCause
export interface IncidentResponseState {
  incidentId: string;
  service: string;
  detectedAt: string;
}