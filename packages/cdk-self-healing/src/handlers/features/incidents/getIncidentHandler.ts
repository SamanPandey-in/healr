import { APIGatewayProxyEventV2 } from "aws-lambda";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../shared/aws/dynamoClient";
import { env } from "../../config/env";
import { ok, fail } from "../../shared/http/responses";

export async function handler(event: APIGatewayProxyEventV2) {
  const incidentId = event.pathParameters?.id;
  if (!incidentId) return fail(400, "Missing incident id");

  const res = await ddb.send(new QueryCommand({
    TableName: env.incidentsTable,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": "INCIDENT#" + incidentId },
  }));
  const bySk = Object.fromEntries((res.Items ?? []).map((i) => [i.SK, i]));
  if (!bySk.META) return fail(404, "Incident not found");
  return ok(bySk);
}
