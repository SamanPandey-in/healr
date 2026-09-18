# Day 3 Manual Test Document

## Pre-requisites
- AWS CLI configured with credentials: `aws configure`
- CDK bootstrap completed: `cdk bootstrap`
- Stack deployed: `cdk deploy` (Day 3 version)
- Day 1 and Day 2 tests passed (see TEST_DAY1.md, TEST_DAY2.md)
- **Bedrock model access granted** for `Qwen3-235B-A22B-2507` (`qwen.qwen3-235b-a22b-2507-v1:0`) in `ap-south-1` (Bedrock Console → Model access → confirm "Access granted", not "Available to request")

---

## 1. Verify New Lambda Functions

Go to AWS Lambda Console and confirm these new functions exist (Day 3 adds 5):

| Function | Description |
|----------|-------------|
| `SelfHealingInfraStack-DiagnoseWithBedrockFunction*` | Step Functions task #4 — Bedrock diagnosis |
| `SelfHealingInfraStack-RequestApprovalFunction*` | Step Functions task #5 — dispatches approval link |
| `SelfHealingInfraStack-ApproveHandlerFunction*` | Standalone Function URL — human callback |
| `SelfHealingInfraStack-RemediateFunction*` | Step Functions task #6 — Lambda alias rollback |
| `SelfHealingInfraStack-VerifyOutcomeFunction*` | Step Functions task #7 — post-remediation verification |

Each function should have:
- Runtime: Node.js 20.x
- X-Ray tracing: Active

Additional checks:
- `DiagnoseWithBedrockFunction` → Configuration → Environment variables → confirm `BEDROCK_MODEL_ID` is set
- `ApproveHandlerFunction` → has a **Function URL** (check Configuration → Function URLs)
- `RemediateFunction` → Configuration → Environment variables → confirm `INVENTORY_FUNCTION_NAME` and `INVENTORY_ALIAS_NAME` are set

---

## 2. Verify Inventory Alias and Versioning

Go to Lambda Console → `InventoryFunction`:
1. **Versions tab** — at least one published version should exist (not just `$LATEST`)
2. **Aliases tab** — `live` alias should exist and point at the published version

If no alias exists, run `cdk deploy` once to publish the initial version.

---

## 3. Verify Step Functions State Machine

Go to AWS Step Functions Console:
1. Find the state machine named `IncidentResponseDay3` (name changed from `IncidentResponseDay2`)
2. Verify it has 8 states in this order:

```
CreateIncident (Lambda)
    ↓
BuildGraph (Lambda)
    ↓
LocalizeRootCause (Lambda)
    ↓
DiagnoseWithBedrock (Lambda)
    ↓
RequestApproval (Lambda — WAIT_FOR_TASK_TOKEN)
    ↓
Remediate (Lambda)
    ↓
WaitForMetricsToSettle (Wait — 60s)
    ↓
VerifyOutcome (Lambda)
```

The state machine timeout should be 40 minutes.

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

## 6. Publish the "Good" Version (Fault OFF)

This step publishes version N of `InventoryFunction` with `INJECT_FAULT=false`. This is the version Remediate will roll back **to**.

1. Confirm `INJECT_FAULT` is `"false"` in `infra/lib/lambdas.ts` (it is by default from `cdk deploy`)
2. Deploy:
   ```bash
   cd infra
   npx cdk deploy
   ```
3. Verify in Lambda Console → `InventoryFunction` → **Aliases** → `live` points at a published version (e.g. version N)

---

## 7. Seed a Deploy Event for Inventory

Create a deploy event for `inventory` that occurred just before the expected alarm time:

```bash
aws lambda invoke \
  --function-name "SelfHealingInfraStack-DeployEventsWebhookFunctionB-PDlenJXiWw1e" \
  --payload '{"body":"{\"service\":\"inventory\",\"timestamp\":\"2026-09-18T10:21:17.521Z\",\"version\":\"v2.1.0\",\"diffSummary\":\"added fault injection\"}"}' \
  --cli-binary-format raw-in-base64-out \
  out.json
```

Verify in `DeployEvents` table:
- PK: `SERVICE#inventory`, SK: `DEPLOY#2026-09-18T14:00:00Z`

---

## 8. Test Healthy End-to-End Flow

Verify the system still works normally with fault injection OFF:

```bash
curl -X POST "https://18uvd9zfhe.execute-api.ap-south-1.amazonaws.com/prod/orders" \
  -H "Content-Type: application/json" \
  -d '{"orderId":"order-test-101","sku":"SKU-333","quantity":3}'
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

## 9. Publish the "Bad" Version (Fault ON)

This step publishes version N+1 with `INJECT_FAULT=true`. CDK's `inventoryAlias` moves to this version automatically.

1. Change `INJECT_FAULT` to `"true"` in `infra/lib/lambdas.ts`:
   ```typescript
   environment: { ...commonEnv, INJECT_FAULT: "true", FAULT_PROBABILITY: "0.3", FAULT_MODE: "error" },
   ```
2. Deploy:
   ```bash
   cd infra
   npx cdk deploy
   ```
3. Verify in Lambda Console → `InventoryFunction` → **Aliases** → `live` now points at version N+1

---

## 10. Trigger the Alarm

Send multiple requests to trip the alarm (need at least 1 error in 1 minute):

```bash
for i in {1..5}; do
  curl -X POST "https://18uvd9zfhe.execute-api.ap-south-1.amazonaws.com/prod/orders" \
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

## 11. Verify Alarm Fires and Execution Starts

Go to CloudWatch Console → Alarms:
1. `InventoryErrorAlarm` should now be in `ALARM` state

Go to Step Functions Console → Executions:
1. Find a recent execution of `IncidentResponseDay3`
2. Verify the execution is `RUNNING` and has progressed past `CreateIncident`, `BuildGraph`, `LocalizeRootCause`, `DiagnoseWithBedrock`

---

## 12. Verify Diagnosis (Bedrock)

The `DiagnoseWithBedrock` step should have completed successfully. Check in the Step Functions console:

1. Click the execution → `DiagnoseWithBedrock` state → Output
2. Verify it contains:
   - `incidentId`
   - `rootCauseService` — should be `"inventory"`
   - `summary` — a 2-4 sentence diagnosis
   - `citedEvidenceIds` — array with at least 1 evidence id (e.g. `EVIDENCE#ALARM#InventoryErrorAlarm`, `EVIDENCE#GRAPH#inventory`, etc.)
   - `confidence` — number between 0 and 1
   - `rankedCandidates` — the candidates list carried forward

If this step fails with `DIAGNOSIS_NOT_GROUNDED`, the model cited zero valid evidence ids — check Bedrock model access and the `ConverseCommand` call in CloudWatch Logs for `DiagnoseWithBedrockFunction`.

---

## 13. Verify Execution Pauses at RequestApproval

The execution should now be in `RUNNING` status with current state `RequestApproval`.

This is the human-approval gate — the execution is paused waiting for a human to click approve/deny.

---

## 14. Find the Approval Link

Go to CloudWatch Console → Log Groups → `/aws/lambda/RequestApprovalFunction`:
1. Find the most recent log entry containing `INCIDENT_APPROVAL_REQUIRED`
2. Copy the `approveLink` value from the JSON log line

Example log line:
```json
{
  "message": "INCIDENT_APPROVAL_REQUIRED",
  "incidentId": "...",
  "rootCauseService": "inventory",
  "summary": "...",
  "confidence": 0.85,
  "approveLink": "https://{approve-function-url}/?incidentId=...&token=...&action=approve",
  "denyLink": "https://{approve-function-url}/?incidentId=...&token=...&action=deny"
}
```

---

## 15. Click the Approve Link

1. Open the `approveLink` in a browser
2. You should see: `<h1>Approved</h1><p>Remediation is proceeding.</p>`
3. If you see "This incident was already approved", you double-clicked — that's fine, it's idempotent

---

## 16. Verify Execution Resumes and Completes

Go back to the Step Functions Console → Executions:
1. The execution should now show `RequestApproval` as succeeded
2. It should progress through: `Remediate` → `WaitForMetricsToSettle` (60s pause) → `VerifyOutcome`
3. Final status should be `SUCCEEDED`

If `Remediate` fails with `NO_PREVIOUS_VERSION`, you skipped step 9 (the two-step good-then-bad publish). Go back and deploy both versions in order.

---

## 17. Verify Incident Created in DynamoDB

Go to DynamoDB Console → `Incidents` table. Query by the incident's PK. You should see **six items**:

| SK | Key Fields |
|----|------------|
| `META` | `incidentId`, `service: "inventory"`, `status: "closed"` |
| `LOCALIZATION` | `incidentId`, `rankedCandidates[]`, `computedAt` |
| `DIAGNOSIS` | `incidentId`, `rootCauseService`, `summary`, `citedEvidenceIds[]`, `confidence`, `generatedAt` |
| `APPROVAL` | `incidentId`, `status: "approved"`, `decidedAt` |
| `REMEDIATION` | `incidentId`, `service`, `action: "lambda-alias-rollback"`, `revertedFromVersion`, `revertedToVersion`, `remediatedAt` |
| `VERIFICATION` | `incidentId`, `service`, `faultCountBefore`, `faultCountAfter`, `recovered: true`, `verifiedAt` |

Verify the `META` item status transitioned through: `open` → `localized` → `diagnosed` → `remediated` → `closed`.

---

## 18. Verify Alias Rollback

Go to Lambda Console → `InventoryFunction` → **Aliases** → `live`:
1. It should now point at version N (the "good" version), not N+1 (the "bad" one)
2. This confirms Remediate successfully rolled back the alias

---

## 19. Verify X-Ray Trace Propagation

Go to X-Ray Console → Traces:
1. Find a trace for the fault-injected request
2. Verify it shows a single causal trace across all Lambda invocations
3. The Bedrock call from `DiagnoseWithBedrockFunction` should also appear as a subsegment

---

## 20. Verify ApproveHandler IAM Permissions

The `ApproveHandlerFunction` should have IAM permissions for:
- `states:SendTaskSuccess` and `states:SendTaskFailure` on `*`
- Read/write access to the `Incidents` DynamoDB table

Check in the Lambda Console → Configuration → Permissions → Execution role → Policy summary.

---

## 21. Reset for Another Run (Optional)

To re-run the demo:

1. The alias is back at version N (good). You need a NEW "bad" version to roll back from.
2. Toggle `INJECT_FAULT` back to `"true"` in `lambdas.ts` and change something else (e.g. `FAULT_PROBABILITY` to `"0.4"`) to guarantee a fresh published version.
3. Run `npx cdk deploy` — this publishes version N+2 (the new bad one), alias moves to it.
4. Repeat steps 10-18.

> **Important:** Don't just flip `INJECT_FAULT` back and forth between the same two values — CDK may treat that as reverting to an existing version rather than publishing a new one. A small env var change guarantees a fresh version every time.

---

## 22. Summary Checklist

- [ ] Bedrock model access granted for `Qwen3-235B-A22B-2507` in `ap-south-1`
- [ ] 5 new Lambda functions created and configured
- [ ] `InventoryFunction` has a `live` alias with at least 2 published versions
- [ ] Step Functions state machine `IncidentResponseDay3` exists with 8 states
- [ ] CloudWatch alarm `InventoryErrorAlarm` created
- [ ] Healthy requests work with fault injection OFF
- [ ] "Good" version (N) published with `INJECT_FAULT=false`
- [ ] "Bad" version (N+1) published with `INJECT_FAULT=true`, alias moved to it
- [ ] Alarm fires after fault-injected requests
- [ ] Execution reaches `RequestApproval` and PAUSES
- [ ] `INCIDENT_APPROVAL_REQUIRED` log line with `approveLink` visible in CW Logs
- [ ] Approve link returns "Approved" HTML
- [ ] Execution resumes and reaches `SUCCEEDED`
- [ ] DynamoDB has all 6 rows: META (closed), LOCALIZATION, DIAGNOSIS, APPROVAL (approved), REMEDIATION, VERIFICATION
- [ ] `InventoryFunction` alias `live` rolled back to version N
- [ ] X-Ray trace shows single causal trace across all Lambdas including Bedrock call
- [ ] Alias rolled back to previous (good) version

## Definition of Done (matches ROADMAP.md Day 3 demo checkpoint)

Inject fault → alarm fires → graph builds → localization ranks correctly → Bedrock diagnosis with citations → approval link → click approve → remediation fires → metrics recover → incident closes. The `InventoryFunction` alias `live` is back at the pre-fault version, and all six DynamoDB record types confirm a complete, evidence-backed, human-approved, automated remediation loop.
