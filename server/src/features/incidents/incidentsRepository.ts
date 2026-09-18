import { randomUUID } from "crypto";
import { PutCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../shared/aws/dynamoClient";
import { env } from "../../config/env";
import { Incident, LocalizationResult, DiagnosisResult, RemediationResult, VerificationResult, ServiceName } from "@shi/shared-types";

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
  // UpdateCommand patches only `status`, leaving incidentId/service/alarmName/
  // detectedAt/createdAt intact — a PutCommand here would replace the whole
  // item and wipe everything CreateIncident wrote.
  await ddb.send(
    new UpdateCommand({
      TableName: env.incidentsTable,
      Key: { PK: `INCIDENT#${result.incidentId}`, SK: "META" },
      UpdateExpression: "SET #status = :status",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":status": "localized" },
    })
  );
}

export async function getIncident(incidentId: string): Promise<Record<string, unknown> | undefined> {
  const res = await ddb.send(
    new GetCommand({ TableName: env.incidentsTable, Key: { PK: `INCIDENT#${incidentId}`, SK: "META" } })
  );
  return res.Item;
}

export async function saveDiagnosis(diagnosis: DiagnosisResult): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: env.incidentsTable,
    Item: { PK: `INCIDENT#${diagnosis.incidentId}`, SK: "DIAGNOSIS", ...diagnosis },
  }));
  await ddb.send(new UpdateCommand({
    TableName: env.incidentsTable,
    Key: { PK: `INCIDENT#${diagnosis.incidentId}`, SK: "META" },
    UpdateExpression: "SET #status = :status",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":status": "diagnosed" },
  }));
}

export async function saveApproval(record: {
  incidentId: string;
  taskToken: string;
  status: "pending";
  diagnosis: DiagnosisResult;
}): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: env.incidentsTable,
    Item: { PK: `INCIDENT#${record.incidentId}`, SK: "APPROVAL", ...record },
  }));
}

export async function getApproval(incidentId: string): Promise<Record<string, unknown> | undefined> {
  const res = await ddb.send(new GetCommand({
    TableName: env.incidentsTable,
    Key: { PK: `INCIDENT#${incidentId}`, SK: "APPROVAL" },
  }));
  return res.Item;
}

export async function markApprovalDecided(incidentId: string, status: "approved" | "denied"): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: env.incidentsTable,
    Key: { PK: `INCIDENT#${incidentId}`, SK: "APPROVAL" },
    UpdateExpression: "SET #status = :status, decidedAt = :decidedAt",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":status": status, ":decidedAt": new Date().toISOString() },
  }));
}

export async function saveRemediation(result: RemediationResult): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: env.incidentsTable,
    Item: { PK: `INCIDENT#${result.incidentId}`, SK: "REMEDIATION", ...result },
  }));
  await ddb.send(new UpdateCommand({
    TableName: env.incidentsTable,
    Key: { PK: `INCIDENT#${result.incidentId}`, SK: "META" },
    UpdateExpression: "SET #status = :status",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":status": "remediated" },
  }));
}

export async function saveVerification(result: VerificationResult): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: env.incidentsTable,
    Item: { PK: `INCIDENT#${result.incidentId}`, SK: "VERIFICATION", ...result },
  }));
  await ddb.send(new UpdateCommand({
    TableName: env.incidentsTable,
    Key: { PK: `INCIDENT#${result.incidentId}`, SK: "META" },
    UpdateExpression: "SET #status = :status",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":status": "closed" },
  }));
}