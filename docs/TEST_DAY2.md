# Day 2 Manual Test Document

## Pre-requisites
- AWS CLI configured with credentials: `aws configure`
- CDK bootstrap completed: `cdk bootstrap`
- Stack deployed: `cdk deploy`
- Day 1 tests passed (see TEST_DAY1.md)

---

## 1. Verify New DynamoDB Items

After deployment, go to DynamoDB Console and confirm all three tables still exist:
- `ServiceGraph`
- `DeployEvents`
- `Incidents`

The `Incidents` table should be empty initially (populated when an alarm triggers).

---

## 2. Verify New Lambda Functions

Go to AWS Lambda Console and confirm these new functions exist:

| Function | Description |
|----------|-------------|
| `SelfHealingInfraStack-CreateIncidentFunction*` | Step Functions task #1 |
| `SelfHealingInfraStack-BuildGraphFunction*` | Step Functions task #2 |
| `SelfHealingInfraStack-LocalizeRootCauseFunction*` | Step Functions task #3 |

Each function should have:
- Runtime: Node.js 20.x
- X-Ray tracing: Active
- Environment variables: `SERVICE_GRAPH_TABLE`, `DEPLOY_EVENTS_TABLE`, `INCIDENTS_TABLE`

---

## 3. Verify Step Functions State Machine

Go to AWS Step Functions Console:
1. Find the state machine named `IncidentResponseDay2`
2. Verify it has 3 states:
   - `CreateIncident` → `BuildGraph` → `LocalizeRootCause`

The execution flow should be:
```
CreateIncident (Lambda)
    ↓
BuildGraph (Lambda)
    ↓
LocalizeRootCause (Lambda)
```

---

## 4. Verify CloudWatch Alarm

Go to CloudWatch Console → Alarms:
1. Find `InventoryErrorAlarm`
2. It should be in `OK` state initially
3. Threshold: `>= 1` error
4. Evaluation periods: 1

---

## 5. Seed Graph Edges (Day 1 Edges)

Ensure the graph edges from Day 1 exist. If not, seed them via the webhook:

```bash
aws lambda invoke \
  --function-name DeployEventsWebhook \
  --payload '{"body":"{\"service\":\"gateway\",\"timestamp\":\"2026-09-17T10:00:00Z\",\"version\":\"v1.0.0\",\"diffSummary\":\"initial deploy\"}"}' \
  --cli-binary-format raw-in-base64-out \
  out.json

aws lambda invoke \
  --function-name DeployEventsWebhook \
  --payload '{"body":"{\"service\":\"orders\",\"timestamp\":\"2026-09-17T10:00:00Z\",\"version\":\"v1.0.0\",\"diffSummary\":\"initial deploy\"}"}' \
  --cli-binary-format raw-in-base64-out \
  out.json

aws lambda invoke \
  --function-name DeployEventsWebhook \
  --payload '{"body":"{\"service\":\"inventory\",\"timestamp\":\"2026-09-17T10:00:00Z\",\"version\":\"v1.0.0\",\"diffSummary\":\"initial deploy\"}"}' \
  --cli-binary-format raw-in-base64-out \
  out.json
```

Verify in the `ServiceGraph` table:
- PK: `SERVICE#gateway`, SK: `EDGE#orders`
- PK: `SERVICE#orders`, SK: `EDGE#inventory`

---

## 6. Seed a Deploy Event for Inventory

Create a deploy event for `inventory` that occurred just before the expected alarm time. This is critical for the temporal heuristic to rank inventory as root cause.

```bash
aws lambda invoke \
  --function-name "SelfHealingInfraStack-DeployEventsWebhookFunctionB-PDlenJXiWw1e" \
  --payload '{"body":"{\"service\":\"inventory\",\"timestamp\":\"2026-09-17T15:00:00Z\",\"version\":\"v2.1.0\",\"diffSummary\":\"added fault injection\"}"}' \
  --cli-binary-format raw-in-base64-out \
  out.json
```

Verify in `DeployEvents` table:
- PK: `SERVICE#inventory`, SK: `DEPLOY#2026-09-17T15:00:00Z`

---

## 7. Test Healthy End-to-End Flow

Verify the system still works normally with fault injection OFF:

```bash
curl -X POST "https://{api-id}.execute-api.ap-south-1.amazonaws.com/prod/orders" \
  -H "Content-Type: application/json" \
  -d '{"orderId":"order-test-001","sku":"SKU-123","quantity":2}'
```

Expected response:
```json
{
  "orderId": "order-test-001",
  "status": "confirmed",
  "inventoryResult": {
    "sku": "SKU-123",
    "available": true,
    "quantityOnHand": 42
  }
}
```

Verify alarm stays in `OK` state.

---

## 8. Enable Fault Injection

Toggle fault injection ON by updating the Lambda configuration:

```bash
aws lambda update-function-configuration \
  --function-name "SelfHealingInfraStack-InventoryFunction7E1DD6ED-i4Q2WwRZuJsH" \
  --environment "Variables={SERVICE_GRAPH_TABLE=ServiceGraph,DEPLOY_EVENTS_TABLE=DeployEvents,INCIDENTS_TABLE=Incidents,ORDERS_FUNCTION_URL="https://key.lambda-url.ap-south-1.on.aws",INVENTORY_FUNCTION_URL="https://key.lambda-url.ap-south-1.on.aws/",INJECT_FAULT=true,FAULT_PROBABILITY=0.3,FAULT_MODE=error}"
```

> **Important:** Replace `*` with the actual function name from the Lambda console. You must include ALL existing environment variables, not just the one you're changing.

Verify the environment variables are set correctly in the Lambda console.

---

## 9. Trigger the Alarm

Send multiple requests to trip the alarm (need at least 1 error in 1 minute):

```bash
# Send 5 requests rapidly - some should fail
for i in {1..5}; do
  curl -X POST https://18uvd9zfhe.execute-api.ap-south-1.amazonaws.com/prod/orders \
    -H "Content-Type: application/json" \
    -d "{\"orderId\":\"order-fault-$i\",\"sku\":\"SKU-123\",\"quantity\":2}"
  sleep 1
done
```

Some requests should return 502 errors with:
```json
{"error":"SIMULATED_FAULT: inventory dependency unavailable"}
```

Wait ~1-2 minutes for CloudWatch to evaluate the alarm.

---

## 10. Verify Alarm Fires

Go to CloudWatch Console → Alarms:
1. `InventoryErrorAlarm` should now be in `ALARM` state
2. Check the alarm history for the state change

---

## 11. Verify EventBridge Rule Triggers Step Functions

Go to EventBridge Console → Rules:
1. Find `InventoryAlarmToStepFunctions` rule
2. Check the invocations tab - it should show recent invocations

Go to Step Functions Console → Executions:
1. Find a recent execution of `IncidentResponseDay2`
2. Verify it reached `SUCCEEDED` status
3. Check each state's input/output:
   - `CreateIncident` → returns `{incidentId, service, detectedAt}`
   - `BuildGraph` → passes through the state
   - `LocalizeRootCause` → returns `{incidentId, rankedCandidates, computedAt}`

---

## 12. Verify Incident Created in DynamoDB

Go to DynamoDB Console → `Incidents` table:

You should see TWO items for the new incident:
1. **META item:**
   - PK: `INCIDENT#<uuid>`
   - SK: `META`
   - Fields: `incidentId`, `service: "inventory"`, `alarmName`, `detectedAt`, `status: "localized"`, `createdAt`

2. **LOCALIZATION item:**
   - PK: `INCIDENT#<uuid>`
   - SK: `LOCALIZATION`
   - Fields: `incidentId`, `rankedCandidates[]`, `computedAt`

---

## 13. Verify Root Cause Ranking

Inspect the `rankedCandidates` in the LOCALIZATION item. The expected ranking:

1. **inventory** - Should be top-ranked (distance: 0, most recent deploy before anomaly)
2. **orders** - Should rank lower (distance: 1, older or no deploy)
3. **gateway** - Should rank lowest (distance: 2, oldest or no deploy)

Each candidate should have:
- `service`: Service name
- `distanceFromAnomaly`: 0 for inventory, 1 for orders, 2 for gateway
- `deployTimestamp`: ISO timestamp of most recent deploy (or null)
- `deployVersion`: Version string (or null)
- `deploySummary`: Description of deploy changes (or null)
- `secondsBeforeAnomaly`: Time between deploy and alarm (null if no deploy)
- `score`: Numeric score (higher = more likely root cause)

---

## 14. Verify X-Ray Trace Propagation

Go to X-Ray Console → Traces:
1. Find a trace for the fault-injected request
2. Verify it shows a single causal trace across all 3 Lambda invocations:
   - Gateway → Orders → Inventory
3. All segments should be linked (not separate root traces)

---

## 15. Disable Fault Injection (Reset)

After testing, toggle fault injection OFF:

```bash
aws lambda update-function-configuration \
  --function-name SelfHealingInfraStack-InventoryFunction* \
  --environment "Variables={SERVICE_GRAPH_TABLE=ServiceGraph,DEPLOY_EVENTS_TABLE=DeployEvents,INCIDENTS_TABLE=Incidents,ORDERS_FUNCTION_URL=<orders-url>,INVENTORY_FUNCTION_URL=<inventory-url>,INJECT_FAULT=false,FAULT_PROBABILITY=0.3,FAULT_MODE=error}"
```

Send a test request to verify healthy responses return:
```json
{
  "orderId": "order-test-reset",
  "status": "confirmed",
  "inventoryResult": {
    "sku": "SKU-123",
    "available": true,
    "quantityOnHand": 42
  }
}
```

---

## 16. Summary Checklist

- [ ] Three Lambda functions created (CreateIncident, BuildGraph, LocalizeRootCause)
- [ ] Step Functions state machine `IncidentResponseDay2` exists with 3 states
- [ ] CloudWatch alarm `InventoryErrorAlarm` created
- [ ] EventBridge rule triggers Step Functions on ALARM state
- [ ] Healthy requests work with fault injection OFF
- [ ] Fault injection ON produces errors on ~30% of requests
- [ ] Alarm transitions from OK → ALARM after errors
- [ ] Step Functions execution reaches SUCCEEDED
- [ ] Incident record created with SK=META (status: "localized")
- [ ] Localization record created with SK=LOCALIZATION
- [ ] `inventory` ranked as top root cause (distance: 0, recent deploy)
- [ ] X-Ray trace shows single causal trace across all 3 Lambdas
- [ ] Fault injection toggled back OFF for clean state

## Definition of Done (matches ROADMAP.md Day 2 demo checkpoint)

Toggle the fault, trigger the alarm, watch the state machine run through `CreateIncident → BuildGraph → LocalizeRootCause`, see `inventory` (or its most recent deploy) come out top-ranked with a visible evidence trail — not just "the one with the worst metric."
