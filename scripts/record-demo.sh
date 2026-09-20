#!/usr/bin/env bash
# scripts/record-demo.sh
# Run-sheet for the Day 4 demo recording. Each step prints a banner so the
# recording has clear beat markers to cut to in editing (see plan4.md §5's
# timing table). Fill in API_URL from your `cdk deploy` / API Gateway console
# output before running.
set -euo pipefail

API_URL="${API_URL:?Set API_URL to your API Gateway invoke URL, e.g. https://xxxx.execute-api.ap-south-1.amazonaws.com/prod}"

banner() { echo; echo "=================================================="; echo "  $1"; echo "=================================================="; echo; }

banner "1/6 — HEALTHY REQUEST"
curl -s -X POST "${API_URL}/orders" \
  -H "Content-Type: application/json" \
  -d '{"orderId":"demo-healthy-001","sku":"SKU-123","quantity":2}' | jq .

banner "2/6 — INJECTING FAULT"
for i in $(seq 1 6); do
  echo "--- request $i ---"
  curl -s -X POST "${API_URL}/orders" \
    -H "Content-Type: application/json" \
    -d "{\"orderId\":\"demo-fault-$i\",\"sku\":\"SKU-123\",\"quantity\":2}" | jq . || true
  sleep 1
done

banner "3/6 — WAITING FOR CLOUDWATCH ALARM (~60-90s) — cut to CloudWatch console here"
echo "Switch the recording to: CloudWatch console -> Alarms -> InventoryErrorAlarm"
echo "Waiting 90s for evaluation..."
sleep 90

banner "4/6 — CUT TO STEP FUNCTIONS CONSOLE"
echo "Show: IncidentResponseDay3 execution, RUNNING, paused at RequestApproval"
echo "Then: CloudWatch Logs -> RequestApprovalFunction -> INCIDENT_APPROVAL_REQUIRED line"
echo "Copy the approveLink from that log line now."
read -rp "Paste the approveLink here to open it and continue recording: " APPROVE_LINK

banner "5/6 — OPENING APPROVAL LINK"
curl -s "${APPROVE_LINK}"
echo
echo "Switch back to Step Functions console: watch Remediate -> WaitForMetricsToSettle -> VerifyOutcome -> SUCCEEDED"

banner "6/6 — DUMP FINAL INCIDENT RECORD (for the on-screen DynamoDB beat)"
echo "Run: node scripts/dump-incident.js <incidentId>   (see plan4.md §3.1)"
echo "Or show it live in the DynamoDB console -> Incidents table, query by PK."

banner "DONE — cut to InventoryFunction -> Aliases -> live, confirm it rolled back to the pre-fault version"
