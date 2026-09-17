import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../shared/aws/dynamoClient";
import { env } from "../../config/env";
import { GraphEdge, ServiceName } from "@shi/shared-types";

export async function upsertEdge(edge: GraphEdge): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: env.serviceGraphTable,
      Item: {
        PK: `SERVICE#${edge.from}`,
        SK: `EDGE#${edge.to}`,
        lastSeenAt: edge.lastSeenAt,
      },
    })
  );
}

export async function getOutboundEdges(service: ServiceName): Promise<GraphEdge[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: env.serviceGraphTable,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": `SERVICE#${service}`, ":prefix": "EDGE#" },
    })
  );
  return (res.Items ?? []).map((i) => ({
    from: service,
    to: i.SK.replace("EDGE#", "") as ServiceName,
    lastSeenAt: i.lastSeenAt,
  }));
}