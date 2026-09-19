export interface CreateIncidentInput {
  service: string;
  alarmName: string;
  detectedAt: string;
}

export interface IncidentResponseState {
  incidentId: string;
  service: string;
  detectedAt: string;
}
