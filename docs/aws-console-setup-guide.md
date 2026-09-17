# AWS Console Setup Guide — Day 1 & Day 2

Companion to `plan.md`. That doc gets the code written and deployed via CDK; this doc is the **console-side walkthrough** — verifying what CDK created, wiring the parts that are faster to click together than to codify mid-hackathon (alarms, EventBridge, Step Functions), and connecting all of it back to the Lambdas/tables from Day 1.

Do this **after** `cdk deploy` has run at least once (Day 1 CDK stack from `plan.md` §10 is live).

---

## 0. Before you start: one real bug to fix first

In `plan.md`, `gateway` and `orders` call downstream Function URLs with plain `fetch()`, but the CDK code sets `authType: FunctionUrlAuthType.AWS_IAM` on those URLs. IAM-authed Function URLs require SigV4-signed requests — a bare `fetch()` will get a `403`. You have two options; for a hackathon, take the console one:

**Fix via console (fast, do this now):**
1. Open the **Lambda console** → **Functions** → `OrdersFunction`
2. **Configuration** tab → **Function URL** (left sidebar) → **Edit**
3. Set **Auth type** to **NONE** → **Save**
4. Repeat steps 2–3 for `InventoryFunction`

This makes the internal `gateway→orders→inventory` hops work with plain `fetch()`, exactly as coded. Trade-off: those two Function URLs become unauthenticated — acceptable because they're never advertised publicly and the only real entry point is the API Gateway route in front of `gateway`. Don't ship this pattern past the hackathon; the correct fix later is SigV4-signing the internal calls (e.g. with `aws4fetch`) and keeping `AWS_IAM` auth.

---

## Part A — Day 1: Verify & Connect

### A1. Confirm region
Top-right region selector in the console must match whatever region you ran `cdk deploy` in (check `infra/cdk.json` / your `AWS_REGION` env var). Every step below assumes you're in that same region.

### A2. Lambda console — confirm the four functions
**Lambda → Functions**, confirm you see:
- `GatewayFunction`
- `OrdersFunction`
- `InventoryFunction`
- `DeployEventsWebhookFunction`

Click into `InventoryFunction` → **Configuration → Monitoring and operations tools** → confirm **AWS X-Ray: Active tracing** shows enabled (this came from `Tracing.ACTIVE` in CDK). Repeat spot-check on `OrdersFunction` and `GatewayFunction`.

Click **Configuration → Function URL** on `OrdersFunction` and `InventoryFunction` — copy each URL, you'll want them for manual testing.

### A3. DynamoDB console — confirm tables, seed the graph edges
**DynamoDB → Tables**, confirm `ServiceGraph`, `DeployEvents`, `Incidents` all exist with partition key `PK` and sort key `SK` (String, String).

Seed the two static edges the localization heuristic will walk on Day 2:

1. Open `ServiceGraph` table → **Explore table items** → **Create item**
2. Item 1: `PK = SERVICE#gateway`, `SK = EDGE#orders`, add attribute `lastSeenAt` (String) = current ISO timestamp
3. Item 2: `PK = SERVICE#orders`, `SK = EDGE#inventory`, same `lastSeenAt` attribute
4. **Create item** on each

### A4. Seed a DeployEvent via Lambda console test
Instead of the CLI invoke in `plan.md` §8, you can do this from the console:

1. **Lambda → Functions → `DeployEventsWebhookFunction`** → **Test** tab
2. **Create new event**, name it `seed-deploy`, paste:
   ```json
   {
     "body": "{\"service\":\"inventory\",\"timestamp\":\"2026-09-17T10:22:00Z\",\"version\":\"v1\",\"diffSummary\":\"initial deploy\"}"
   }
   ```
3. **Test** → confirm `200` response with `{"recorded": true}`
4. Repeat with `service: "orders"` and `service: "gateway"` so all three have a baseline deploy record

Check **DynamoDB → `DeployEvents` → Explore table items** — you should see three new rows.

### A5. API Gateway console — find the invoke URL, test the route
1. **API Gateway → APIs → `self-healing-infra-api`**
2. Left sidebar → **Resources** → confirm `/orders` → `POST` exists and its integration target is `GatewayFunction`
3. Click the `POST` method → **Test** tab → paste a request body:
   ```json
   { "orderId": "ord-1", "sku": "sku-123", "quantity": 2 }
   ```
   → **Test** → confirm you get a `200` with an `inventoryResult` in the body
4. Left sidebar → **Stages** → `prod` (or whatever stage CDK deployed) → copy the **Invoke URL** at the top — this is your real public endpoint

Confirm the same request works from your terminal against the real deployed endpoint, not just the console's test harness:

```bash
curl -X POST "<invoke-url>/orders" \
  -H "Content-Type: application/json" \
  -d '{"orderId":"ord-1","sku":"sku-123","quantity":2}'
```

### A6. X-Ray console — confirm the real trace
1. **CloudWatch → X-Ray traces → Traces** (X-Ray moved under the CloudWatch console; look for "X-Ray traces" in the left nav)
2. Set the time range to "last 5 minutes", find the trace for your curl request
3. Open it — confirm **three segments**: `GatewayFunction`, `OrdersFunction`, `InventoryFunction`, and that `OrdersFunction`'s segment contains a `call-inventory` subsegment, `GatewayFunction`'s contains a `call-orders` subsegment (these come from the `traced()` helper in `plan.md` §4)
4. **X-Ray traces → Service map** — confirm you see three connected nodes with edges matching the call chain

This is the literal Day 1 "demo checkpoint" from `ROADMAP.md` — a real trace, not a log line claiming one.

### A7. CloudWatch Logs — sanity check
**CloudWatch → Log groups**, confirm `/aws/lambda/GatewayFunction`, `/aws/lambda/OrdersFunction`, `/aws/lambda/InventoryFunction` each have a recent log stream with your test request's output.

---

## Part B — Day 2: Console Setup

Day 2 adds two new Lambdas (`BuildGraph`, `LocalizeRootCause`), a CloudWatch Alarm, an EventBridge rule, and a starter Step Functions state machine. Build these bottom-up: Lambdas first, then the state machine that calls them, then the alarm and rule that trigger the state machine.

### B1. Create `BuildGraphFunction` (console, inline code)

This pulls X-Ray's own computed service graph (via `GetServiceGraph`, no manual trace parsing needed) and upserts edges into `ServiceGraph`.

1. **Lambda → Create function → Author from scratch**
2. Name: `BuildGraphFunction`, Runtime: **Node.js 20.x**
3. **Create function**
4. In the **Code** tab, replace `index.mjs` contents with:

```javascript
import { XRayClient, GetServiceGraphCommand } from "@aws-sdk/client-xray";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const xray = new XRayClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async () => {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 10 * 60 * 1000); // last 10 minutes

  const result = await xray.send(
    new GetServiceGraphCommand({ StartTime: startTime, EndTime: endTime })
  );

  const edges = [];
  for (const service of result.Services ?? []) {
    const from = service.Name;
    for (const edge of service.Edges ?? []) {
      const target = (result.Services ?? []).find((s) => s.ReferenceId === edge.ReferenceId);
      if (!target) continue;
      edges.push({ from, to: target.Name, lastSeenAt: new Date().toISOString() });
    }
  }

  for (const edge of edges) {
    await ddb.send(
      new PutCommand({
        TableName: process.env.SERVICE_GRAPH_TABLE,
        Item: { PK: `SERVICE#${edge.from}`, SK: `EDGE#${edge.to}`, lastSeenAt: edge.lastSeenAt },
      })
    );
  }

  return { edgesWritten: edges.length };
};
```

5. **Deploy**
6. **Configuration → Environment variables → Edit → Add**: `SERVICE_GRAPH_TABLE` = `ServiceGraph` → **Save**
7. **Configuration → Permissions** → click the execution role link → **Add permissions → Create inline policy** → JSON tab, paste:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": "xray:GetServiceGraph", "Resource": "*" },
       { "Effect": "Allow", "Action": "dynamodb:PutItem", "Resource": "arn:aws:dynamodb:*:*:table/ServiceGraph" }
     ]
   }
   ```
   Name it `BuildGraphPermissions` → **Create policy**

### B2. Create `LocalizeRootCauseFunction` (console, inline code)

Given an anomalous service, walk `ServiceGraph` backward, check each candidate's most recent `DeployEvents` timestamp, and rank by proximity to the anomaly's onset time — the topology-constrained temporal heuristic from `ROADMAP.md` §2.

1. **Lambda → Create function → Author from scratch**, name `LocalizeRootCauseFunction`, Node.js 20.x
2. Code (`index.mjs`):

```javascript
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// All edges point downstream (from -> to). To find upstream candidates for
// an anomalous service, scan every SERVICE#* partition's edges and keep
// the ones whose target is the anomalous service.
async function findUpstreamCandidates(anomalousService) {
  const allServices = ["gateway", "orders", "inventory"]; // static for Day 2; graph-driven discovery is a later improvement
  const candidates = [];
  for (const svc of allServices) {
    const res = await ddb.send(
      new QueryCommand({
        TableName: process.env.SERVICE_GRAPH_TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": `SERVICE#${svc}`, ":prefix": "EDGE#" },
      })
    );
    for (const item of res.Items ?? []) {
      if (item.SK === `EDGE#${anomalousService}`) candidates.push(svc);
    }
  }
  return candidates;
}

async function mostRecentDeploy(service) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: process.env.DEPLOY_EVENTS_TABLE,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": `SERVICE#${service}` },
      ScanIndexForward: false, // newest SK first
      Limit: 1,
    })
  );
  return res.Items?.[0] ?? null;
}

export const handler = async (event) => {
  const anomalousService = event.anomalousService ?? "inventory";
  const anomalyOnset = new Date(event.anomalyOnset ?? Date.now());

  const upstreamCandidates = await findUpstreamCandidates(anomalousService);
  const allCandidates = [anomalousService, ...upstreamCandidates]; // include the node itself

  const ranked = [];
  for (const service of allCandidates) {
    const deploy = await mostRecentDeploy(service);
    const deployTime = deploy ? new Date(deploy.SK.replace("DEPLOY#", "")) : null;
    const precedesOnset = deployTime && deployTime <= anomalyOnset;
    const gapMs = precedesOnset ? anomalyOnset.getTime() - deployTime.getTime() : Infinity;
    ranked.push({ service, deployVersion: deploy?.version ?? null, gapMs });
  }

  ranked.sort((a, b) => a.gapMs - b.gapMs); // smallest gap = deploy closest before the anomaly = top suspect

  const incidentId = randomUUID();
  await ddb.send(
    new PutCommand({
      TableName: process.env.INCIDENTS_TABLE,
      Item: {
        PK: `INCIDENT#${incidentId}`,
        SK: "META",
        anomalousService,
        status: "LOCALIZED",
        rankedCandidates: ranked,
        createdAt: new Date().toISOString(),
      },
    })
  );

  return { incidentId, rankedCandidates: ranked };
};
```

3. **Deploy**
4. **Environment variables**: `SERVICE_GRAPH_TABLE` = `ServiceGraph`, `DEPLOY_EVENTS_TABLE` = `DeployEvents`, `INCIDENTS_TABLE` = `Incidents`
5. **Permissions** → inline policy for `dynamodb:Query` and `dynamodb:PutItem` on the `ServiceGraph`, `DeployEvents`, and `Incidents` table ARNs (same pattern as B1 step 7)

### B3. Turn on fault injection

This assumes you've already implemented the real probability logic in `faultInjection.ts` locally (per `plan.md` §5's guardrail — that logic is Day 2 work, not Day 1) and redeployed with `cdk deploy`. Once redeployed:

1. **Lambda → `InventoryFunction` → Configuration → Environment variables → Edit**
2. Set `INJECT_FAULT` = `true` → **Save**

Flip it back to `false` the same way once you're done demoing a broken run.

### B4. Create the Step Functions state machine

1. **Step Functions → State machines → Create state machine**
2. Choose **Write your workflow in code**, type **Standard**
3. Paste this Amazon States Language definition (Day 2 scope only — steps 3–6 from `ROADMAP.md`'s architecture are added Day 3):

```json
{
  "Comment": "IncidentResponse - Day 2 scope: build graph, localize root cause",
  "StartAt": "BuildGraph",
  "States": {
    "BuildGraph": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": {
        "FunctionName": "BuildGraphFunction"
      },
      "ResultPath": "$.buildGraphResult",
      "Next": "LocalizeRootCause"
    },
    "LocalizeRootCause": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": {
        "FunctionName": "LocalizeRootCauseFunction",
        "Payload": {
          "anomalousService.$": "$.anomalousService",
          "anomalyOnset.$": "$.anomalyOnset"
        }
      },
      "ResultPath": "$.localizeResult",
      "End": true
    }
  }
}
```

4. Name it `IncidentResponseStateMachine` → **Create state machine** (accept the auto-created execution role — it needs `lambda:InvokeFunction` on both functions; the wizard grants this automatically when you reference them by name in the definition, but double check under **IAM → Roles → StepFunctions-IncidentResponseStateMachine-role**)
5. Test it manually first: **Start execution** → input:
   ```json
   { "anomalousService": "inventory", "anomalyOnset": "2026-09-18T10:00:00Z" }
   ```
   → confirm the execution graph goes green on both states, and check **DynamoDB → Incidents** for the new item

### B5. Create the CloudWatch Alarm on `InventoryFunction`

1. **CloudWatch → Alarms → All alarms → Create alarm**
2. **Select metric → Lambda → By Function Name → `InventoryFunction` → Errors**
3. Statistic: `Sum`, Period: `1 minute`
4. Condition: `Greater/Equal` threshold `1`, for `1` out of `1` datapoint
5. Next — skip the SNS notification step (EventBridge listens to the alarm's state change natively, no SNS topic required)
6. Name it `InventoryErrorAlarm` → **Create alarm**

### B6. Create the EventBridge rule → Step Functions target

1. **EventBridge → Rules → Create rule**
2. Name: `IncidentTriggerRule`, Event bus: `default`, Rule type: **Rule with an event pattern**
3. Event pattern → **Event source: AWS services**, **Service: CloudWatch**, **Event type: CloudWatch Alarm State Change**
4. Switch to the JSON editor for precision, use:
   ```json
   {
     "source": ["aws.cloudwatch"],
     "detail-type": ["CloudWatch Alarm State Change"],
     "resources": ["arn:aws:cloudwatch:<region>:<account-id>:alarm:InventoryErrorAlarm"],
     "detail": { "state": { "value": ["ALARM"] } }
   }
   ```
   (fill in your region/account id — visible in the alarm's ARN on its detail page)
5. Target: **AWS service → Step Functions state machine → `IncidentResponseStateMachine`**
6. Configure input: **Constant (matching JSON text)**:
   ```json
   { "anomalousService": "inventory", "anomalyOnset": "<<aws.events.event.ingestion-time>>" }
   ```
   (EventBridge input transformer syntax — if the console's constant-input box doesn't accept the placeholder directly, use **Input transformer** instead, mapping `$.time` from the alarm event to `anomalyOnset`)
7. Let the console auto-create the IAM role for EventBridge to call `states:StartExecution` → **Create rule**

### B7. Test the full Day 2 loop

```bash
# turn fault injection on (B3), then generate enough traffic to trip the alarm
for i in $(seq 1 20); do
  curl -X POST "<api-gateway-invoke-url>/orders" \
    -H "Content-Type: application/json" \
    -d '{"orderId":"ord-'"$i"'","sku":"sku-123","quantity":1}'
done
```

If you don't want to wait for real traffic to trip the alarm, force it for a faster demo:

```bash
aws cloudwatch set-alarm-state \
  --alarm-name InventoryErrorAlarm \
  --state-value ALARM \
  --state-reason "manual trigger for demo"
```

Then check, in order:
1. **CloudWatch → Alarms → `InventoryErrorAlarm`** — state is `In alarm`
2. **EventBridge → Rules → `IncidentTriggerRule` → Monitoring** tab — invocation count incremented
3. **Step Functions → `IncidentResponseStateMachine` → Executions** — a new execution appears, both states green
4. **DynamoDB → `Incidents`** — a new item with `rankedCandidates`, and confirm `inventory` (or whichever service has the most recent preceding deploy) sorts to the top

That's the Day 2 demo checkpoint from `ROADMAP.md`: fault → alarm → rule → state machine → ranked candidates in DynamoDB, no manual step in between.

---

## Quick reference — what exists where after Day 2

| Resource | Created by | Name |
|---|---|---|
| Lambda | CDK (Day 1) | `GatewayFunction`, `OrdersFunction`, `InventoryFunction`, `DeployEventsWebhookFunction` |
| Lambda | Console (Day 2) | `BuildGraphFunction`, `LocalizeRootCauseFunction` |
| DynamoDB | CDK (Day 1) | `ServiceGraph`, `DeployEvents`, `Incidents` |
| API Gateway | CDK (Day 1) | `self-healing-infra-api` → `POST /orders` |
| CloudWatch Alarm | Console (Day 2) | `InventoryErrorAlarm` |
| EventBridge Rule | Console (Day 2) | `IncidentTriggerRule` |
| Step Functions | Console (Day 2) | `IncidentResponseStateMachine` (2 states; Day 3 adds Diagnose/Approval/Remediate/Verify) |

Everything in the Day 2 row was created by hand in the console, not in CDK — fine for hackathon speed, but if you want the submission repo to reflect the *whole* deployed system as code (worth a line in the blog post/video re: "Built on AWS" completeness), budget 30–60 minutes on Day 4 to either run `cdk import` against these resources or hand-write the equivalent CDK constructs from what's already live.
