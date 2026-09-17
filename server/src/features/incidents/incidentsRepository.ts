import { randomUUID } from "crypto";
import { PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../shared/aws/dynamoClient";
import { env } from "../../config/env";
import { Incident, LocalizationResult, ServiceName } from "@shi/shared-types";

export async function createIncident(
  service: ServiceName,
  alarmName: string,
  detectedAt: string
): Promise<Incident> {
  const incident: Incident = {
    incidentId: randomUUID(),
    service,
    alarmName,
    detectedAt,
    status: "open",
    createdAt: new Date().toISOString(),
  };
  await ddb.send(
    new PutCommand({
      TableName: env.incidentsTable,
      Item: { PK: `INCIDENT#${incident.incidentId}`, SK: "META", ...incident },
    })
  );
  return incident;
}

export async function saveLocalizationResult(result: LocalizationResult): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: env.incidentsTable,
      Item: { PK: `INCIDENT#${result.incidentId}`, SK: "LOCALIZATION", ...result },
    })
  );
  await ddb.send(
    new PutCommand({
      TableName: env.incidentsTable,
      Item: {
        PK: `INCIDENT#${result.incidentId}`,
        SK: "META",
        status: "localized",
      },
    })
  );
}

export async function getIncident(incidentId: string): Promise<Record<string, unknown> | undefined> {
  const res = await ddb.send(
    new GetCommand({ TableName: env.incidentsTable, Key: { PK: `INCIDENT#${incidentId}`, SK: "META" } })
  );
  return res.Item;
}