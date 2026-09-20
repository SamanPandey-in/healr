import { APIGatewayProxyEventV2 } from "aws-lambda";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../shared/aws/dynamoClient";
import { env } from "../../config/env";
import { ok } from "../../shared/http/responses";

export async function handler(event: APIGatewayProxyEventV2) {
  const origin = event.headers?.origin ?? event.headers?.Origin;
  const res = await ddb.send(new ScanCommand({
    TableName: env.incidentsTable,
    FilterExpression: "SK = :sk",
    ExpressionAttributeValues: { ":sk": "META" },
    Limit: 100,
  }));
  const items = (res.Items ?? []).sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return ok(items.slice(0, 20), origin);
}
