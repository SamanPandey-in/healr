import { APIGatewayProxyEventV2 } from "aws-lambda";
import { getFullIncident } from "./incidentsRepository";
import { ok, fail } from "../../shared/http/responses";

export async function handler(event: APIGatewayProxyEventV2) {
  const origin = event.headers?.origin ?? event.headers?.Origin;
  const incidentId = event.pathParameters?.id;
  if (!incidentId) return fail(400, "Missing incident id", origin);
  const incident = await getFullIncident(incidentId);
  if (!incident.META) return fail(404, "Incident not found", origin);
  return ok(incident, origin);
}
