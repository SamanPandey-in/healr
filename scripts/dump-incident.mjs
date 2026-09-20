// scripts/dump-incident.js
// Usage: node scripts/dump-incident.js <incidentId> [tableName]
// Reads the six SK rows for one incident and prints a compact, readable summary —
// the kind of thing you'd screenshot for the blog post too.
// tableName defaults to INCIDENTS_TABLE env var, or pass it as second arg.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = process.argv[3] || process.env.INCIDENTS_TABLE || "Incidents";
if (!TABLE_NAME) {
  console.error("Usage: node scripts/dump-incident.js <incidentId> <tableName>");
  console.error("  tableName: the Incidents DynamoDB table name (or set INCIDENTS_TABLE env var)");
  process.exit(1);
}
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

async function main(incidentId) {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": `INCIDENT#${incidentId}` },
  }));

  const bySk = Object.fromEntries((res.Items ?? []).map((i) => [i.SK, i]));

  console.log(`Incident ${incidentId}`);
  console.log(`  status:       ${bySk.META?.status}`);
  console.log(`  root cause:   ${bySk.DIAGNOSIS?.rootCauseService}`);
  console.log(`  confidence:   ${bySk.DIAGNOSIS?.confidence}`);
  console.log(`  summary:      ${bySk.DIAGNOSIS?.summary}`);
  console.log(`  cited ids:    ${(bySk.DIAGNOSIS?.citedEvidenceIds ?? []).join(", ")}`);
  console.log(`  approved:     ${bySk.APPROVAL?.status} at ${bySk.APPROVAL?.decidedAt}`);
  console.log(`  remediation:  ${bySk.REMEDIATION?.revertedFromVersion} -> ${bySk.REMEDIATION?.revertedToVersion}`);
  console.log(`  recovered:    ${bySk.VERIFICATION?.recovered} (before=${bySk.VERIFICATION?.faultCountBefore}, after=${bySk.VERIFICATION?.faultCountAfter})`);
}

main(process.argv[2]);
