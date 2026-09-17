# Day 1 Manual Test Document

## Pre-requisites
- AWS CLI configured with credentials: `aws configure`
- CDK bootstrap completed: `cdk bootstrap`
- Stack deployed: `cdk deploy`

## 1. Verify DynamoDB Tables
Go to AWS DynamoDB Console and confirm three tables exist:
- `ServiceGraph`
- `DeployEvents`
- `Incidents`

Each table should have:
- PK (partition key): String type
- SK (sort key): String type
- PAY_PER_REQUEST billing mode

## 2. Seed Graph Edges (Repository)
Run the following to upsert the two static edges:

```bash
# Gateway → Orders
node -e "
const { upsertEdge } = require('./infra/lib/self-healing-infra-stack');
const { ddb } = require('./server/src/shared/aws/dynamoClient');
const { env } = require('./server/src/config/env');

upsertEdge({
  from: 'gateway',
  to: 'orders',
  lastSeenAt: new Date().toISOString()
});
"

# Orders → Inventory
node -e "
const { upsertEdge } = require('./infra/lib/self-healing-infra-stack');
const { ddb } = require('./server/src/shared/aws/dynamoClient');
const { env } = require('./server/src/config/env');

upsertEdge({
  from: 'orders',
  to: 'inventory',
  lastSeenAt: new Date().toISOString()
});
"
```

Or use the AWS CLI (after deploying):
```bash
# DeployEventsWebhook function needs to be invoked per service
aws lambda invoke \
  --function-name DeployEventsWebhook \
  --payload '{"body":"{\"service\":\"gateway\",\"timestamp\":\"2026-09-17T10:22:00Z\",\"version\":\"v1\",\"diffSummary\":\"initial deploy\"}"}' \
  --cli-binary-format raw-in-base64-out \
  out.json
```

## 3. Test API Gateway Endpoint

After deployment, note the API Gateway URL from the output:
```
PublicApiEndpointEA3E4599: https://{api-id}.execute-api.{region}.amazonaws.com/prod/orders
```

Test the end-to-end chain with curl:

```bash
curl -X POST https://{api-id}.execute-api.{region}.amazonaws.com/prod/orders \
  -H "Content-Type: application/json" \
  -d '{"orderId":"order-001","sku":"SKU-123","quantity":2}'
```

Expected successful response:
```json
{
  "orderId": "order-001",
  "status": "confirmed",
  "inventoryResult": {
    "sku": "SKU-123",
    "available": true,
    "quantityOnHand": 42
  }
}
```

## 4. Verify X-Ray Trace (3-Segment Trace)

Open the X-Ray Console and confirm:

A trace was recorded for the above `curl` request with exactly 3 segments (subsegments):

1. **gateway** - The API Gateway → Gateway Lambda entry point
2. **orders** - Gateway Lambda → Orders Lambda (via `call-orders` subsegment)
3. **inventory** - Orders Lambda → Inventory Lambda (via `call-inventory` subsegment)

Each span should show:
- `AWS/XRAY` segment format
- Correct service names matching the flow
- No errors in any segment

## 5. Verify Deploy Events in DynamoDB

After running the curl test, check the `DeployEvents` table in DynamoDB Console. There should be a new row with:
- PK: `SERVICE#gateway` (or whichever service triggered the deploy)
- SK: `DEPLOY#2026-09-17T10:22:00Z` (ISO timestamp)
- version: e.g., `v1`
- diffSummary: e.g., `initial deploy`

You can also invoke the webhook manually:
```bash
aws lambda invoke \
  --function-name DeployEventsWebhook \
  --payload '{"body":"{\"service\":\"inventory\",\"timestamp\":\"2026-09-17T10:22:00Z\",\"version\":\"v1\",\"diffSummary\":\"initial deploy\"}"}' \
  --cli-binary-format raw-in-base64-out \
  out.json
```

Then check the DeployEvents table for the recorded entry.

## 6. Verify Fault Injection is OFF

The `injectFault` env var is set to `"false"` by default in the CDK stack. Verify that:
- The inventory handler returns `available: true, quantityOnHand: 42` for any valid request
- No 30% fault injection is occurring (this is Day 2 functionality)

## 7. Summary Checklist

[X] Three DynamoDB tables created and queryable
[X] API Gateway deployed with `/orders` POST endpoint
[X] End-to-end request returns successful response
[X] X-Ray console shows 3-span trace (gateway → orders → inventory)
[X] DeployEvents table has at least one record
[X] Graph edges seeded (gateway→orders, orders→inventory)
[X] Fault injection flag is OFF (healthy responses)

## Definition of Done (matches ROADMAP.md Day 1 demo checkpoint)

Hitting the gateway endpoint produces a successful response, AND the X-Ray console shows a real 3-span trace for that request. Nothing about ranking, diagnosis, or remediation needs to exist yet.