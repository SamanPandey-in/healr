# @shi/cdk-self-healing

A CDK construct that adds **automated causal root-cause analysis and self-healing** to any Lambda function you deploy with AWS CDK. When your Lambda's error rate breaches a CloudWatch alarm, a Step Functions state machine automatically: builds a service graph from X-Ray traces, localizes the root cause using graph topology + deploy recency, asks Gemini for a cited diagnosis, waits for human approval via a URL, then rolls your Lambda alias back to the last known-good version.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Full Integration Guide](#full-integration-guide)
- [What Gets Deployed](#what-gets-deployed)
- [How the Self-Healing Loop Works](#how-the-self-healing-loop-works)
- [Props Reference](#props-reference)
- [Stack Outputs](#stack-outputs)
- [API Reference](#api-reference)
- [Wiring CI/CD Deploy Events](#wiring-cicd-deploy-events)
- [Custom Alarm Configuration](#custom-alarm-configuration)
- [Using with an Existing CDK App](#using-with-an-existing-cdk-app)
- [Troubleshooting](#troubleshooting)
- [Known Limitations](#known-limitations)
- [Roadmap](#roadmap)
- [License](#license)

---

## Prerequisites

- **AWS CDK v2** (`aws-cdk-lib >= 2.269.0`) -- your existing CDK app
- **A Lambda function** already defined in your CDK stack, fronted by a **Lambda Alias** (the construct moves this alias between versions during remediation)
- **Node.js 20+** runtime for the Lambda functions
- **A Gemini API key** -- the construct uses Google Gemini for LLM-powered diagnosis (get one at https://aistudio.google.com/apikey)
- **X-Ray tracing enabled** on your Lambda functions -- the graph-building step reads X-Ray traces to discover service call paths

If your Lambda does not emit custom CloudWatch metrics yet, the construct creates a default alarm on the `InjectedFault` metric. For production use, configure the `alarm` prop to point at your real error metric (see [Custom Alarm Configuration](#custom-alarm-configuration)).

---

## Installation

```bash
npm install @shi/cdk-self-healing
```

The package has **peer dependencies** on `aws-cdk-lib` and `constructs` -- it uses whatever versions your CDK app already has installed. No version conflicts.

Optional companion package for reporting deploy events from CI:

```bash
npm install @shi/agent
```

---

## Quick Start

Given an existing CDK stack that deploys a Lambda with an alias:

```typescript
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Alias, Runtime, Tracing } from "aws-cdk-lib/aws-lambda";
import { SelfHealingInfra } from "@shi/cdk-self-healing";

export class MyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. Your existing Lambda
    const myFn = new NodejsFunction(this, "MyFunction", {
      entry: "src/handler.ts",
      runtime: Runtime.NODEJS_20_X,
      tracing: Tracing.ACTIVE,  // required -- the construct reads X-Ray traces
    });

    // 2. An alias pointing at the current version
    const myAlias = new Alias(this, "MyFunctionLive", {
      aliasName: "live",
      version: myFn.currentVersion,
    });

    // 3. Add self-healing -- this is the only new code
    const healing = new SelfHealingInfra(this, "Healing", {
      protectedAlias: myAlias,
      geminiApiKey: process.env.GEMINI_API_KEY!,
    });

    // 4. Surface the URLs as stack outputs
    new cdk.CfnOutput(this, "DeployWebhookUrl", { value: healing.deployWebhookUrl });
    new cdk.CfnOutput(this, "IncidentsApiUrl", { value: healing.incidentsApiUrl });
    new cdk.CfnOutput(this, "ApproveUrl", { value: healing.approveFunctionUrl });
  }
}
```

Deploy:

```bash
export GEMINI_API_KEY="your-key-here"
npx cdk deploy
```

After deploy, the stack outputs show three URLs:
- **DeployWebhookUrl** -- POST deploy events here from your CI
- **IncidentsApiUrl** -- GET incident history from your dashboard
- **ApproveUrl** -- click this to approve or deny a remediation when an incident fires

---

## Full Integration Guide

### Step 1: Ensure your Lambda has an Alias

The construct protects a Lambda by moving its **alias** between versions. Your function must already be fronted by an alias:

```typescript
const fn = new NodejsFunction(this, "MyFn", { /* ... */ });
const alias = new Alias(this, "MyFnLive", {
  aliasName: "live",
  version: fn.currentVersion,
});
```

The construct does **not** create the alias for you -- it assumes the alias already exists and points at a version.

### Step 2: Enable X-Ray Tracing

The graph-building step reads X-Ray traces to discover how services call each other. Your Lambda (and any upstream services) must have active tracing enabled:

```typescript
const fn = new NodejsFunction(this, "MyFn", {
  tracing: Tracing.ACTIVE,  // <-- this
});
```

### Step 3: Instantiate the Construct

```typescript
const healing = new SelfHealingInfra(this, "Healing", {
  protectedAlias: alias,
  geminiApiKey: process.env.GEMINI_API_KEY!,
});
```

### Step 4: Expose the Output URLs

```typescript
new CfnOutput(this, "DeployWebhookUrl", { value: healing.deployWebhookUrl });
new CfnOutput(this, "IncidentsApiUrl", { value: healing.incidentsApiUrl });
new CfnOutput(this, "ApproveUrl", { value: healing.approveFunctionUrl });
```

### Step 5: Wire Your CI to Report Deploys (Optional but Recommended)

The localization step correlates incidents with recent deploys. Without deploy-event data, it can only use graph topology (less accurate). Install `@shi/agent` and call `recordDeploy` after each deployment:

```bash
npm install @shi/agent
```

```typescript
// In your CI pipeline, after cdk deploy succeeds:
import { recordDeploy } from "@shi/agent";

await recordDeploy(process.env.DEPLOY_WEBHOOK_URL!, {
  service: "my-service",
  version: process.env.GIT_SHA!,  // commit hash, Docker tag, etc.
});
```

### Step 6: Deploy

```bash
export GEMINI_API_KEY="your-key-here"
npx cdk deploy
```

### Step 7: Test It

Trigger an error in your Lambda (or wait for a real one). When the CloudWatch alarm breaches, the state machine fires automatically. You will see:

1. An incident appears in `GET /incidents`
2. The state machine localizes the root cause and saves a diagnosis
3. An approval URL is logged to CloudWatch (and visible in the incident record)
4. Click the approval URL to approve -- the alias rolls back to the previous version
5. Verification checks that faults dropped to zero

---

## What Gets Deployed

The construct creates these resources in your AWS account:

### DynamoDB Tables

| Table | Purpose | Key Schema |
|-------|---------|------------|
| **ServiceGraph** | Stores service-to-service call edges derived from X-Ray traces | `PK=SERVICE#<name>, SK=EDGE#<target>` |
| **DeployEvents** | Records deploy events reported by your CI | `PK=SERVICE#<name>, SK=DEPLOY#<timestamp>` |
| **Incidents** | Stores the full incident lifecycle (meta, localization, diagnosis, approval, remediation, verification) | `PK=INCIDENT#<id>, SK=<stage>` |

All tables use on-demand billing (PAY_PER_REQUEST) -- no capacity planning needed.

### Lambda Functions

| Function | Purpose | Timeout |
|----------|---------|---------|
| **CreateIncidentFunction** | Creates an incident record when the state machine starts | 10s |
| **BuildGraphFunction** | Fetches recent X-Ray traces and derives service call edges | 30s |
| **LocalizeRootCauseFunction** | Ranks candidate root causes using graph topology + deploy recency scoring | 10s |
| **DiagnoseFunction** | Calls Gemini with evidence list, returns cited diagnosis | 60s |
| **RequestApprovalFunction** | Saves approval record, logs approve/deny links | 10s |
| **ApproveHandlerFunction** | HTTP handler for the approval URL -- sends task success/failure to Step Functions | 10s |
| **RemediateFunction** | Rolls the protected alias back to the previous published version | 10s |
| **VerifyOutcomeFunction** | Queries CloudWatch metrics before/after remediation to confirm recovery | 10s |
| **DeployEventsWebhookFunction** | Records deploy events from your CI | 10s |
| **GetIncidentFunction** | Returns full incident details (all stages) | 10s |
| **ListIncidentsFunction** | Returns the 20 most recent incidents | 10s |

All functions have X-Ray active tracing enabled and `aws-xray-sdk-core` bundled.

### Step Functions State Machine

The pipeline executes these steps in order:

```
CreateIncident -> BuildGraph -> LocalizeRootCause -> DiagnoseWithGemini
    -> RequestApproval (WAIT_FOR_TASK_TOKEN, 30min timeout)
    -> Remediate -> WaitForMetricsToSettle (60s) -> VerifyOutcome
```

The state machine has a 40-minute overall timeout.

### CloudWatch Alarm + EventBridge Rule

- **Alarm**: Monitors a CloudWatch metric (default: `InjectedFault` in `SelfHealingInfra/Inventory` namespace). Breach triggers the state machine.
- **EventBridge Rule**: Listens for `CloudWatch Alarm State Change` events matching the alarm name and routes them to the state machine.

### API Gateway

A REST API with three endpoints:

| Method | Path | Handler | Purpose |
|--------|------|---------|---------|
| `POST` | `/webhook` | DeployEventsWebhookFunction | Receives deploy events from CI |
| `GET` | `/incidents` | ListIncidentsFunction | Lists recent incidents |
| `GET` | `/incidents/{id}` | GetIncidentFunction | Returns full incident details |

CORS is enabled for all origins.

---

## How the Self-Healing Loop Works

### 1. Alarm Fires

When your Lambda's error metric breaches the CloudWatch alarm threshold, EventBridge captures the alarm state change and triggers the Step Functions state machine with:

```json
{
  "service": "live",
  "alarmName": "MyAlarm",
  "detectedAt": "2026-09-19T10:30:00Z"
}
```

### 2. Incident Created

A new incident record is created in DynamoDB with status `open`. Each incident gets a unique UUID.

### 3. Service Graph Built

The construct fetches the last 15 minutes of X-Ray traces, parses segment/subsegment names to derive service-to-service call edges, deduplicates by from-to pair keeping the most recent timestamp, and upserts to the ServiceGraph table. This graph is the foundation for root-cause localization.

### 4. Root Cause Localized

The localization step:
1. Reads all edges from the ServiceGraph table
2. Performs BFS backward from the alarming service to find all upstream ancestors (services on a call path into it)
3. For each ancestor, queries the DeployEvents table for the most recent deploy before the alarm timestamp
4. Scores each candidate using a weighted formula: **80% temporal proximity** (deploy closer to alarm = higher score) + **20% structural distance** (fewer hops = higher score)
5. Ranks candidates by combined score, saves the result

### 5. Gemini Diagnosis

The diagnosis step:
1. Builds a numbered evidence list from: the alarm name, graph distances for each candidate, and deploy details (version, timestamp, diff summary)
2. Sends the evidence to Gemini with a system prompt instructing it to act as an SRE diagnosis assistant
3. Gemini returns: `rootCauseService`, `confidence` (0-1), `summary` (2-4 sentences), and `citedEvidenceIds`
4. The construct validates that at least one citation matches a known evidence ID -- if not, the diagnosis is rejected as hallucinated
5. Saves the diagnosis to DynamoDB

### 6. Human Approval

The state machine pauses and waits for a human to click an approval URL. The URL contains a Step Functions task token. Two things happen:
- The approval record is saved to DynamoDB with status `pending`
- Approve/deny links are logged to CloudWatch Logs and stored in the incident record

When someone clicks **approve**: `SendTaskSuccess` is called, the state machine continues to remediation.
When someone clicks **deny**: `SendTaskFailure` is called, the state machine terminates.

The approval step has a 30-minute timeout -- if nobody clicks, the incident stays in `AWAITING_APPROVAL` status.

### 7. Remediation (Alias Rollback)

The remediation step:
1. Gets the current version the alias points at
2. Lists all published versions of the function
3. Finds the version immediately before the current one
4. Calls `UpdateAlias` to move the alias to that previous version

This is the same operation `cdk deploy` performs when it publishes a new version and updates the alias. The difference is that this rollback is triggered by the self-healing loop, not by a human running `cdk deploy`.

If there is no previous version to roll back to (the function has only one published version), the step throws an error.

### 8. Verification

After a 60-second wait (for CloudWatch metrics to settle), the verification step:
1. Queries the `InjectedFault` metric for a 5-minute window before remediation
2. Queries the same metric for a 5-minute window after remediation
3. Sets `recovered: true` if the fault count after is zero

The verification result is saved to DynamoDB and the incident status moves to `closed`.

---

## Props Reference

```typescript
interface SelfHealingInfraProps {
  /** The Lambda alias to protect. The construct wires remediation to move this alias
   *  between Lambda versions on rollback. */
  protectedAlias: Alias;

  /** Gemini API key for the diagnosis step. */
  geminiApiKey: string;

  /** Gemini model ID. Defaults to "gemini-2.5-flash". */
  geminiModelId?: string;

  /** CloudWatch alarm configuration. If omitted, a default error-rate alarm is created
   *  on the protected function's InjectedFault metric. */
  alarm?: {
    metricNamespace: string;
    metricName: string;
    threshold: number;
  };
}
```

| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `protectedAlias` | `Alias` | Yes | -- | The Lambda alias this construct protects. Must already exist and point at a version. |
| `geminiApiKey` | `string` | Yes | -- | Gemini API key. The construct passes this to the diagnosis Lambda as an environment variable. For production, consider using Secrets Manager or SSM SecureString instead of a plain prop. |
| `geminiModelId` | `string` | No | `"gemini-2.5-flash"` | Gemini model to use for diagnosis. Any Gemini model that supports structured JSON output works. |
| `alarm` | `object` | No | See below | Custom alarm configuration. If omitted, monitors the `InjectedFault` metric in the `SelfHealingInfra/Inventory` namespace with threshold 1. |

Default alarm config (when `alarm` is omitted):

```typescript
{
  metricNamespace: "SelfHealingInfra/Inventory",
  metricName: "InjectedFault",
  threshold: 1,
}
```

---

## Stack Outputs

The construct exposes these as both public properties and `CfnOutput` resources:

| Output | Property | Description |
|--------|----------|-------------|
| `DeployWebhookUrl` | `healing.deployWebhookUrl` | POST deploy events here from your CI pipeline |
| `IncidentsApiUrl` | `healing.incidentsApiUrl` | Base URL for the incidents read API |
| `ApproveFunctionUrl` | -- (CfnOutput only) | The Function URL for the approval handler -- click to approve or deny |

Access the properties in your CDK code:

```typescript
const healing = new SelfHealingInfra(this, "Healing", { /* ... */ });

// Use in another construct or stack
new lambda.Function(this, "Reporter", {
  // ...
  environment: {
    DEPLOY_WEBHOOK_URL: healing.deployWebhookUrl,
  },
});
```

---

## API Reference

### POST /webhook

Reports a deploy event to the construct's DeployEvents table. The localization step reads this data to correlate incidents with recent deploys.

**Request body:**

```json
{
  "service": "my-service",
  "version": "abc123",
  "timestamp": "2026-09-19T10:00:00Z",
  "diffSummary": "Fixed null check in order handler"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `service` | `string` | Yes | Service name (must match the name used in your service graph) |
| `version` | `string` | Yes | Deploy version (commit hash, Docker tag, semver, etc.) |
| `timestamp` | `string` | Yes | ISO 8601 timestamp of the deploy |
| `diffSummary` | `string` | No | Human-readable summary of what changed (included in diagnosis evidence) |

**Response:**

```json
{ "recorded": true }
```

### GET /incidents

Lists the 20 most recent incidents.

**Response:**

```json
[
  {
    "PK": "INCIDENT#abc-123",
    "SK": "META",
    "incidentId": "abc-123",
    "service": "inventory",
    "alarmName": "InventoryErrorAlarm",
    "status": "diagnosed",
    "createdAt": "2026-09-19T10:30:00Z"
  }
]
```

### GET /incidents/{id}

Returns all records for a specific incident (META, LOCALIZATION, DIAGNOSIS, APPROVAL, REMEDIATION, VERIFICATION). Each key is present only if the incident has progressed past that stage.

**Response:**

```json
{
  "META": { "incidentId": "abc-123", "status": "remediated", "..." : "..." },
  "LOCALIZATION": { "rankedCandidates": ["..."], "..." : "..." },
  "DIAGNOSIS": { "rootCauseService": "orders", "confidence": 0.85, "summary": "...", "citedEvidenceIds": ["EVIDENCE#DEPLOY#orders#v3"] },
  "APPROVAL": { "status": "approved", "decidedAt": "..." },
  "REMEDIATION": { "action": "lambda-alias-rollback", "revertedFromVersion": "7", "revertedToVersion": "6" },
  "VERIFICATION": { "recovered": true, "faultCountBefore": 5, "faultCountAfter": 0 }
}
```

---

## Wiring CI/CD Deploy Events

The `@shi/agent` package provides a single function for reporting deploys:

```typescript
import { recordDeploy } from "@shi/agent";

await recordDeploy(webhookUrl, {
  service: "my-service",
  version: "abc123",
  deployedAt: "2026-09-19T10:00:00Z",  // optional, defaults to now
});
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `webhookUrl` | `string` | Yes | The `deployWebhookUrl` output from the construct |
| `event.service` | `string` | Yes | Service name |
| `event.version` | `string` | Yes | Deploy version |
| `event.deployedAt` | `string` | No | ISO 8601 timestamp (defaults to `new Date().toISOString()`) |

**Example: GitHub Actions**

```yaml
- name: Deploy
  run: npx cdk deploy --require-approval never

- name: Report deploy
  run: |
    npx ts-node -e "
      import { recordDeploy } from '@shi/agent';
      recordDeploy('${{ steps.outputs.deploy-webhook-url }}', {
        service: 'my-service',
        version: '${{ github.sha }}',
      });
    "
```

**Example: After cdk deploy in a script**

```bash
#!/bin/bash
set -e
npx cdk deploy --require-approval never --outputs-file cdk-outputs.json

WEBHOOK_URL=$(cat cdk-outputs.json | jq -r '.MyStack.DeployWebhookUrl')
node -e "
  const { recordDeploy } = require('@shi/agent');
  recordDeploy('$WEBHOOK_URL', {
    service: 'my-service',
    version: '$(git rev-parse HEAD)',
  });
"
```

---

## Custom Alarm Configuration

By default, the construct creates an alarm on the `InjectedFault` metric. For production use, point it at your real error metric:

```typescript
const healing = new SelfHealingInfra(this, "Healing", {
  protectedAlias: myAlias,
  geminiApiKey: process.env.GEMINI_API_KEY!,
  alarm: {
    metricNamespace: "MyApp/MyService",
    metricName: "Errors",
    threshold: 10,  // alarm after 10 errors in 1 minute
  },
});
```

You can also use a metric from an existing alarm. The alarm just needs to fire an EventBridge event with `state.value: ["ALARM"]` -- any CloudWatch alarm does this automatically.

---

## Using with an Existing CDK App

If you already have a CDK app with Lambda functions, adding self-healing is typically 10 lines of code:

```typescript
import { SelfHealingInfra } from "@shi/cdk-self-healing";

// In your existing stack constructor, after your Lambda + Alias are defined:

const healing = new SelfHealingInfra(this, "SelfHealing", {
  protectedAlias: yourExistingAlias,
  geminiApiKey: process.env.GEMINI_API_KEY!,
});

new CfnOutput(this, "DeployWebhookUrl", { value: healing.deployWebhookUrl });
new CfnOutput(this, "IncidentsApiUrl", { value: healing.incidentsApiUrl });
```

That is the complete integration. The construct creates all supporting infrastructure independently -- it does not modify your existing Lambda, IAM roles, or any other resources.

---

## Troubleshooting

### "Missing required env var: GEMINI_API_KEY"

Set the environment variable before running `cdk deploy`:

```bash
export GEMINI_API_KEY="your-key-here"
npx cdk deploy
```

### Lambda build errors during cdk deploy

The construct uses `NodejsFunction` which bundles with esbuild. If you see build errors:

1. Ensure esbuild is installed: `npm install -D esbuild`
2. Check that the handler source files are not excluded by `.gitignore` or `.npmignore`
3. The construct bundles `aws-xray-sdk-core` as a node module -- this is handled automatically

### Alarm does not trigger the state machine

Verify:
1. The alarm is in the same AWS account and region as the state machine
2. The EventBridge rule is enabled (check the EventBridge console -> Rules)
3. The alarm state change event matches the rule's pattern (alarm name must match exactly)

### Remediation throws "NO_PREVIOUS_VERSION"

Your Lambda function has only one published version. The remediation step needs at least two published versions to roll back. Deploy your function at least twice before testing the self-healing loop.

### Approval URL returns "already approved/denied"

The approval URL can only be used once. If someone already clicked it, the incident record is updated and subsequent clicks are no-ops.

---

## Known Limitations

- **Single protected function per construct instance** -- v0.1 supports one `protectedAlias` per `SelfHealingInfra` instance. To protect multiple functions, create multiple instances.
- **Lambda-only remediation** -- the remediation step uses `lambda:UpdateAlias`, which only works for Lambda functions. Other compute (ECS, EC2) is not supported yet.
- **Gemini for diagnosis** -- the construct uses Google Gemini by default. Swapping to another LLM provider requires modifying the diagnosis handler.
- **Plain-text API key** -- `geminiApiKey` is passed as a construct prop (visible in CDK context). For production, use Secrets Manager or SSM SecureString.
- **Single-region** -- all resources are created in the same region as your CDK stack. Cross-region support is not implemented.
- **No automated rollback on failed remediation** -- if the alias rollback itself fails (e.g., the previous version has been deleted), the state machine errors out. There is no automatic retry or fallback.

---

## Roadmap

- **v0.2**: Support N protected functions per construct instance
- **v0.3**: Multi-runtime agents (containers/ECS, not just Lambda) -- the causal-localization and diagnosis logic does not care what compute the graph nodes run on; only the remediation step (`lambda:UpdateAlias`) is Lambda-specific
- **v0.4**: Secrets Manager / SSM for `geminiApiKey` instead of a plain construct prop
- **v0.5**: Automated smoke test on every publish (deploy to a throwaway account, force an error, verify the loop completes)

---

## License

MIT
