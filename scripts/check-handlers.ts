// Offline check of the two new Lambda handlers with the AWS SDK clients stubbed out.
// Run:  npx tsx scripts/check-handlers.ts
process.env.SERVICE_GRAPH_TABLE = "g";
process.env.DEPLOY_EVENTS_TABLE = "d";
process.env.INCIDENTS_TABLE = "i";
process.env.STATE_MACHINE_ARN = "arn:aws:states:ap-south-1:111122223333:stateMachine:IncidentResponseDay3";
process.env.AWS_REGION = "ap-south-1";
process.env.AWS_XRAY_CONTEXT_MISSING = "IGNORE_ERROR";

import assert from "node:assert/strict";
import { SFNClient } from "@aws-sdk/client-sfn";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const sfnCalls: Array<{ name: string; input: any }> = [];
const ddbCalls: Array<{ name: string; input: any }> = [];
let approvalRow: any;
let metaRow: any;
let sfnError: string | undefined;

(SFNClient.prototype as any).send = async function (cmd: any) {
  const name = cmd.constructor.name;
  sfnCalls.push({ name, input: cmd.input });
  if (name === "SendTaskSuccessCommand" || name === "SendTaskFailureCommand") {
    if (sfnError) throw Object.assign(new Error("dead token"), { name: sfnError });
    return {};
  }
  if (name === "ListExecutionsCommand") {
    return { executions: [
      { executionArn: "arn:exec:old", startDate: new Date("2026-09-20T09:00:00Z") },
      { executionArn: "arn:exec:target", startDate: new Date("2026-09-20T10:00:01Z") },
    ] };
  }
  if (name === "DescribeExecutionCommand") {
    const arn = cmd.input.executionArn;
    return {
      executionArn: arn, name: arn, status: "RUNNING", startDate: new Date("2026-09-20T10:00:01Z"),
      input: JSON.stringify({ service: "inventory", detectedAt: arn === "arn:exec:target" ? "2026-09-20T10:00:00Z" : "2026-09-20T09:00:00Z" }),
    };
  }
  if (name === "GetExecutionHistoryCommand") {
    return { events: [{ id: 1, type: "ExecutionStarted", timestamp: new Date("2026-09-20T10:00:01Z") }] };
  }
  throw new Error("unexpected sfn command " + name);
};
(DynamoDBDocumentClient.prototype as any).send = async function (cmd: any) {
  const name = cmd.constructor.name;
  ddbCalls.push({ name, input: cmd.input });
  if (name === "GetCommand") return { Item: cmd.input.Key.SK === "APPROVAL" ? approvalRow : metaRow };
  return {};
};

const ev = (id: string, body?: unknown) => ({
  headers: { origin: "http://localhost:3000" },
  pathParameters: { id },
  body: body === undefined ? undefined : JSON.stringify(body),
}) as any;

async function main() {
  const { handler: decide } = await import("../server/src/features/approval/decisionHandler");
  const { handler: getExecution } = await import("../server/src/features/incidents/executionHandler");

  // --- decision: validation + state guards
  assert.equal((await decide(ev("inc-1", { action: "nope" }))).statusCode, 400);
  approvalRow = undefined;
  assert.equal((await decide(ev("inc-1", { action: "approve" }))).statusCode, 404);
  approvalRow = { status: "approved" };
  assert.equal((await decide(ev("inc-1", { action: "approve" }))).statusCode, 409);
  assert.equal(sfnCalls.length, 0, "no SendTask* call when the request is not pending");

  // --- decision: approve
  approvalRow = { status: "pending", taskToken: "TOKEN+/=", diagnosis: { rootCauseService: "inventory", rankedCandidates: [{ service: "inventory" }] } };
  const res = await decide(ev("inc-1", { action: "approve" }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers!["Access-Control-Allow-Origin"], "http://localhost:3000");
  const send = sfnCalls.find((c) => c.name === "SendTaskSuccessCommand")!;
  assert.equal(send.input.taskToken, "TOKEN+/=", "token comes from DynamoDB, not the browser");
  const out = JSON.parse(send.input.output);
  assert.deepEqual(Object.keys(out).sort(), ["approved", "decidedAt", "incidentId", "rankedCandidates", "rootCauseService"]);
  assert.equal(out.approved, true);
  const upd = ddbCalls.find((c) => c.name === "UpdateCommand")!;
  assert.equal(upd.input.ExpressionAttributeValues[":status"], "approved");

  // --- decision: deny
  sfnCalls.length = 0;
  approvalRow = { status: "pending", taskToken: "T", diagnosis: {} };
  assert.equal((await decide(ev("inc-1", { action: "deny" }))).statusCode, 200);
  assert.equal(sfnCalls[0].name, "SendTaskFailureCommand");
  assert.equal(sfnCalls[0].input.error, "ApprovalDenied");

  // --- decision: expired token surfaces as 410, and the row is NOT marked decided
  ddbCalls.length = 0;
  sfnError = "TaskTimedOut";
  approvalRow = { status: "pending", taskToken: "T", diagnosis: {} };
  assert.equal((await decide(ev("inc-1", { action: "approve" }))).statusCode, 410);
  assert.equal(ddbCalls.filter((c) => c.name === "UpdateCommand").length, 0);
  sfnError = undefined;

  // --- execution: matches the right execution by detectedAt, then serves from cache
  metaRow = { incidentId: "inc-1", detectedAt: "2026-09-20T10:00:00Z", createdAt: "2026-09-20T10:00:02Z" };
  sfnCalls.length = 0;
  const r1 = await getExecution(ev("inc-1"));
  assert.equal(r1.statusCode, 200);
  const body = JSON.parse(r1.body);
  assert.equal(body.executionArn, "arn:exec:target");
  assert.equal(body.events.length, 1);
  assert.match(body.consoleUrl, /^https:\/\/ap-south-1\.console\.aws\.amazon\.com\/states\//);
  sfnCalls.length = 0;
  await getExecution(ev("inc-1"));
  assert.ok(!sfnCalls.some((c) => c.name === "ListExecutionsCommand"), "second call is served from the ARN cache");

  metaRow = undefined;
  assert.equal((await getExecution(ev("missing"))).statusCode, 404);

  console.log("handler checks passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
