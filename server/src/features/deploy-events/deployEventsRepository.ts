import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../shared/aws/dynamoClient";
import { env } from "../../config/env";
import { DeployEvent } from "@shi/shared-types";

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