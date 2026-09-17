import { PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
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

export async function getAllEdges(): Promise<GraphEdge[]> {
  const res = await ddb.send(new ScanCommand({ TableName: env.serviceGraphTable }));
  return (res.Items ?? []).map((i) => ({
    from: (i.PK as string).replace("SERVICE#", "") as ServiceName,
    to: (i.SK as string).replace("EDGE#", "") as ServiceName,
    lastSeenAt: i.lastSeenAt,
  }));
}