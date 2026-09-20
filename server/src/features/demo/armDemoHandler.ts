import { APIGatewayProxyEventV2 } from "aws-lambda";
import { LambdaClient, UpdateFunctionConfigurationCommand, GetFunctionConfigurationCommand,
         PublishVersionCommand, UpdateAliasCommand } from "@aws-sdk/client-lambda";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../shared/aws/dynamoClient";
import { ok, fail } from "../../shared/http/responses";
import { env } from "../../config/env";

const lambda = new LambdaClient({});
const LOCK_PK = "DEMO#lock";
const LOCK_TTL_SECONDS = 10 * 60;

async function pollUntilUpdated(functionName: string, tries = 15): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const cfg = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: functionName }));
    if (cfg.LastUpdateStatus === "Successful") return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Timed out waiting for Lambda config update to settle");
}

export async function handler(event: APIGatewayProxyEventV2) {
  const origin = event.headers?.origin ?? event.headers?.Origin;
  if (!env.inventoryFunctionName) throw new Error("Missing INVENTORY_FUNCTION_NAME");

  const now = Math.floor(Date.now() / 1000);
  try {
    await ddb.send(new PutCommand({
      TableName: env.incidentsTable,
      Item: { PK: LOCK_PK, SK: "META", expiresAt: now + LOCK_TTL_SECONDS, armedAt: now },
      ConditionExpression: "attribute_not_exists(PK) OR expiresAt < :now",
      ExpressionAttributeValues: { ":now": now },
    }));
  } catch {
    return fail(409, "A demo is already running — wait a couple of minutes and try again.", origin);
  }

  await lambda.send(new UpdateFunctionConfigurationCommand({
    FunctionName: env.inventoryFunctionName,
    Environment: { Variables: { INJECT_FAULT: "true", FAULT_PROBABILITY: "0.6", FAULT_MODE: "error",
      SERVICE_GRAPH_TABLE: env.serviceGraphTable, DEPLOY_EVENTS_TABLE: env.deployEventsTable,
      INCIDENTS_TABLE: env.incidentsTable } },
  }));
  await pollUntilUpdated(env.inventoryFunctionName);

  const published = await lambda.send(new PublishVersionCommand({ FunctionName: env.inventoryFunctionName }));
  await lambda.send(new UpdateAliasCommand({
    FunctionName: env.inventoryFunctionName,
    Name: env.inventoryAliasName,
    FunctionVersion: published.Version,
  }));

  return ok({ armed: true, version: published.Version }, origin);
}
