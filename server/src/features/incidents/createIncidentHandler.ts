import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { createIncident } from "./incidentsRepository";
import { CreateIncidentInput, IncidentResponseState } from "./types";
import { ServiceName } from "@shi/shared-types";

patchAwsSdkForTracing();

export async function handler(input: CreateIncidentInput): Promise<IncidentResponseState> {
  const incident = await createIncident(input.service as ServiceName, input.alarmName, input.detectedAt);
  return { incidentId: incident.incidentId, service: incident.service, detectedAt: incident.detectedAt };
}