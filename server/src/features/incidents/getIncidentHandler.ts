// server/src/features/incidents/getIncidentHandler.ts
import { APIGatewayProxyEventV2 } from "aws-lambda";
import { getIncident } from "./incidentsRepository";

export async function handler(event: APIGatewayProxyEventV2) {
  const incidentId = event.queryStringParameters?.incidentId;
  if (!incidentId) return { statusCode: 400, body: "Missing incidentId" };
  const incident = await getIncident(incidentId);
  if (!incident) return { statusCode: 404, body: "Incident not found" };
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(incident),
  };
}
