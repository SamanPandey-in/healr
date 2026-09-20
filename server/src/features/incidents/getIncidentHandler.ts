import { APIGatewayProxyEventV2 } from "aws-lambda";
import { getFullIncident } from "./incidentsRepository";
import { ok, fail } from "../../shared/http/responses";

export async function handler(event: APIGatewayProxyEventV2) {
  const incidentId = event.pathParameters?.id;
  if (!incidentId) return fail(400, "Missing incident id");
  const incident = await getFullIncident(incidentId);
  if (!incident.META) return fail(404, "Incident not found");
  return ok(incident);
}
