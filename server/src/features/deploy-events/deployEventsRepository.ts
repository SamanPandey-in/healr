import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../shared/aws/dynamoClient";
import { env } from "../../config/env";
import { DeployEvent, ServiceName } from "@shi/shared-types";

export async function recordDeployEvent(event: DeployEvent): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: env.deployEventsTable,
      Item: {
        PK: `SERVICE#${event.service}`,
        SK: `DEPLOY#${event.timestamp}`,
        version: event.version,
        diffSummary: event.diffSummary,
      },
    })
  );
}

export interface LatestDeploy {
  version: string;
  diffSummary: string;
  timestamp: string;
}

// Most recent deploy for `service` at or before `beforeIso`. SK sorts
// lexicographically and ISO-8601 timestamps sort correctly as strings,
// so a bounded key condition + ScanIndexForward:false + Limit:1 gets us
// the answer in one query, no client-side filtering.
export async function getLatestDeployBefore(
  service: ServiceName,
  beforeIso: string
): Promise<LatestDeploy | null> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: env.deployEventsTable,
      KeyConditionExpression: "PK = :pk AND SK <= :sk",
      ExpressionAttributeValues: { ":pk": `SERVICE#${service}`, ":sk": `DEPLOY#${beforeIso}` },
      ScanIndexForward: false,
      Limit: 1,
    })
  );
  const item = res.Items?.[0];
  if (!item) return null;
  return {
    version: item.version,
    diffSummary: item.diffSummary,
    timestamp: (item.SK as string).replace("DEPLOY#", ""),
  };
}