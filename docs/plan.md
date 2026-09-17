# plan.md — Day 1 Execution Plan for AI Agents

**Repo state:** empty. **Stack:** TypeScript/Node backend (AWS Lambda), Next.js frontend, AWS CDK for infra, everything else AWS-native (API Gateway, DynamoDB, X-Ray, CloudWatch, EventBridge, Step Functions, Bedrock — later days).

This document is written to be handed to an AI coding agent (Claude Code or similar) running locally, with repo write access and AWS CLI credentials already configured. It only covers **Day 1** scope per `ROADMAP.md`. Do not implement Day 2+ features (fault injection ranking logic, Bedrock diagnosis, Step Functions, remediation) — stub them at most as empty feature folders. Scope creep here costs Day 1 the thing it actually needs to prove: **real Lambdas, real API Gateway, real X-Ray trace, real DynamoDB tables.**

---

## 0. Why these tech choices

- **AWS CDK (TypeScript)** for infra, not Serverless Framework/SAM/Terraform: it's TypeScript, so backend devs and IaC share one language, one repo, one type system. It also makes "Built on AWS" trivially demonstrable — the entire infra is defined in code that's part of the submission.
- **npm workspaces monorepo**, not separate repos: `server`, `web`, and `infra` need to share types (`Incident`, `GraphNode`, `ServiceName`) without publishing packages mid-hackathon.
- **esbuild** for Lambda bundling: fastest TS→JS bundle step, and CDK's `NodejsFunction` construct uses it natively — zero extra config.
- **Feature-based, not layer-based, `/server` structure**: this system is a set of narrow verticals (gateway, orders, inventory, graph, incidents, deploy-events) that barely share logic. A `controllers/ services/ models/` split would force you to jump three folders to read one feature end-to-end, which is friction you cannot afford on a 3.5-day clock. Each feature folder is self-contained: handler + business logic + repository + types, colocated.

---

## 1. Full repo structure

```
builds/
├── package.json                     # npm workspaces root
├── tsconfig.base.json                # shared compiler options, extended by each workspace
├── .gitignore
├── .env.example
├── README.md
├── ROADMAP.md                        # already exists
├── plan.md                           # this file
│
├── infra/                            # AWS CDK app — the only place infra is defined
│   ├── package.json
│   ├── cdk.json
│   ├── tsconfig.json
│   ├── bin/
│   │   └── infra.ts                  # CDK app entrypoint
│   └── lib/
│       ├── self-healing-infra-stack.ts
│       ├── tables.ts                 # DynamoDB table constructs
│       ├── lambdas.ts                # NodejsFunction constructs, one per feature handler
│       └── api-gateway.ts            # REST API + routes → gateway Lambda
│
├── server/                           # backend Lambda source, feature-based
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── features/
│       │   ├── gateway/
│       │   │   ├── handler.ts
│       │   │   └── types.ts
│       │   ├── orders/
│       │   │   ├── handler.ts
│       │   │   └── types.ts
│       │   ├── inventory/
│       │   │   ├── handler.ts
│       │   │   ├── faultInjection.ts
│       │   │   └── types.ts
│       │   ├── deploy-events/
│       │   │   ├── webhookHandler.ts
│       │   │   ├── deployEventsRepository.ts
│       │   │   └── types.ts
│       │   ├── graph/
│       │   │   ├── buildGraphHandler.ts        # stub only — Day 2
│       │   │   ├── graphRepository.ts          # implement now, used Day 1 to seed static edges
│       │   │   └── types.ts
│       │   ├── incidents/                      # empty stub folder — Day 2
│       │   ├── diagnosis/                      # empty stub folder — Day 3
│       │   └── remediation/                    # empty stub folder — Day 3
│       ├── shared/
│       │   ├── aws/
│       │   │   ├── dynamoClient.ts
│       │   │   └── xray.ts
│       │   ├── http/
│       │   │   └── responses.ts                # standard API Gateway response shape helper
│       │   └── logger.ts
│       └── config/
│           └── env.ts                          # typed env var access, fails fast if missing
│
├── web/                               # Next.js — scaffold now, build out Day 4
│   └── (standard `create-next-app` App Router output; leave default until Day 4)
│
└── packages/
    └── shared-types/                  # types imported by both server/ and web/
        ├── package.json
        └── src/
            └── index.ts               # Incident, GraphNode, GraphEdge, ServiceName, DeployEvent
```

---

## 2. Bootstrap commands (run in order)

```bash
# 1. root + workspaces
git init
npm init -y
npm pkg set workspaces[0]="server" workspaces[1]="infra" workspaces[2]="web" workspaces[3]="packages/shared-types"

# 2. shared-types package
mkdir -p packages/shared-types/src
cd packages/shared-types && npm init -y && npm pkg set name="@shi/shared-types" main="src/index.ts" && cd ../..

# 3. server workspace
mkdir -p server/src/{features/{gateway,orders,inventory,deploy-events,graph,incidents,diagnosis,remediation},shared/{aws,http},config}
cd server && npm init -y
npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb aws-xray-sdk-core
npm install -D typescript @types/aws-lambda esbuild
cd ..

# 4. infra workspace (CDK)
mkdir infra && cd infra
npx cdk init app --language typescript
npm install aws-cdk-lib constructs
cd ..
npx cdk bootstrap   # once per AWS account/region

# 5. web workspace (Next.js — scaffold only, revisit Day 4)
npx create-next-app@latest web --typescript --app --no-tailwind --eslint --src-dir --import-alias "@/*"
```

Add `tsconfig.base.json` at repo root:

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  }
}
```

Each workspace's `tsconfig.json` does `"extends": "../tsconfig.base.json"`.

---

## 3. Shared types (`packages/shared-types/src/index.ts`)

Write these now — every feature below imports from here instead of redefining shapes.

```typescript
export type ServiceName = "gateway" | "orders" | "inventory";

export interface GraphNode {
  service: ServiceName;
}

export interface GraphEdge {
  from: ServiceName;
  to: ServiceName;
  lastSeenAt: string; // ISO timestamp, updated by BuildGraph (Day 2)
}

export interface DeployEvent {
  service: ServiceName;
  timestamp: string; // ISO
  version: string;
  diffSummary: string;
}

export interface OrderRequest {
  orderId: string;
  sku: string;
  quantity: number;
}

export interface InventoryCheckResult {
  sku: string;
  available: boolean;
  quantityOnHand: number;
}
```

---

## 4. Shared server utilities

**`server/src/shared/aws/dynamoClient.ts`**

```typescript
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const base = new DynamoDBClient({});
export const ddb = DynamoDBDocumentClient.from(base, {
  marshallOptions: { removeUndefinedValues: true },
});
```

**`server/src/shared/aws/xray.ts`**

```typescript
import AWSXRay from "aws-xray-sdk-core";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

// Call this once per Lambda entrypoint file, before constructing any AWS SDK client,
// so every downstream call (DynamoDB, HTTP) shows up as a child span in the trace.
export function patchAwsSdkForTracing() {
  AWSXRay.captureAWSv3Client(new DynamoDBClient({}));
}

// Wrap an outbound HTTP call (gateway → orders → inventory) as its own subsegment
// so the causal chain is visible in the X-Ray trace, not just in logs.
export async function traced<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const segment = AWSXRay.getSegment();
  const subsegment = segment?.addNewSubsegment(name);
  try {
    return await fn();
  } catch (err) {
    subsegment?.addError(err as Error);
    throw err;
  } finally {
    subsegment?.close();
  }
}
```

**`server/src/shared/http/responses.ts`**

```typescript
import { APIGatewayProxyResult } from "aws-lambda";

export function ok(body: unknown): APIGatewayProxyResult {
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export function fail(statusCode: number, message: string): APIGatewayProxyResult {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: message }) };
}
```

**`server/src/config/env.ts`**

```typescript
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  serviceGraphTable: required("SERVICE_GRAPH_TABLE"),
  deployEventsTable: required("DEPLOY_EVENTS_TABLE"),
  incidentsTable: required("INCIDENTS_TABLE"),
  ordersFunctionUrl: process.env.ORDERS_FUNCTION_URL ?? "",
  inventoryFunctionUrl: process.env.INVENTORY_FUNCTION_URL ?? "",
  injectFault: process.env.INJECT_FAULT === "true",
};
```

Using Lambda Function URLs (not internal API Gateway routes) for `gateway → orders` and `orders → inventory` keeps Day 1 simple — one public API Gateway route in front of `gateway` only, direct HTTPS calls between the other two. This is a deliberate Day 1 simplification; revisit only if the demo needs it.

> **Known gap — Function URL auth vs. plain `fetch()`:** the CDK code in §10 sets `authType: FunctionUrlAuthType.AWS_IAM` on the `orders` and `inventory` Function URLs, but the `fetch()` calls in §6/§7 are unsigned — IAM-authed Function URLs require SigV4-signed requests, so as written this 403s. Two ways to resolve it: (a) fastest, switch those two Function URLs' auth type to `NONE` — via console (`aws-console-setup-guide.md` §0) or by changing `FunctionUrlAuthType.AWS_IAM` to `FunctionUrlAuthType.NONE` in `infra/lib/lambdas.ts` and redeploying — acceptable since these URLs are never advertised publicly and the only real entry point is the API Gateway route in front of `gateway`; or (b) keep `AWS_IAM` and sign the internal `fetch()` calls with a SigV4 helper (e.g. `aws4fetch`), which is the correct long-term fix but is extra Day 1 work for no demo-visible benefit. Pick (a) for the hackathon.

---

## 5. Feature: `inventory` (deepest node — build bottom-up)

**`server/src/features/inventory/types.ts`**

```typescript
export interface InventoryCheckRequest {
  sku: string;
  quantity: number;
}
```

**`server/src/features/inventory/faultInjection.ts`**

```typescript
import { env } from "../../config/env";

// Day 1: stub that always returns healthy. Day 2 wires this to the toggleable
// fault behavior described in ROADMAP.md §2 (latency / thrown error on ~30% of requests).
export async function maybeInjectFault(): Promise<void> {
  if (!env.injectFault) return;
  // Day 2 implementation goes here. Do not implement the 30%-probability logic yet —
  // Day 1's only job is to prove the request path works with the flag OFF.
}
```

**`server/src/features/inventory/handler.ts`**

```typescript
import { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { ok, fail } from "../../shared/http/responses";
import { maybeInjectFault } from "./faultInjection";
import { InventoryCheckRequest } from "./types";

patchAwsSdkForTracing();

export async function handler(event: APIGatewayProxyEventV2, _context: Context) {
  try {
    const body: InventoryCheckRequest = JSON.parse(event.body ?? "{}");
    await maybeInjectFault();

    // Day 1: hardcoded stock table, no DynamoDB read yet — the point of Day 1
    // is the trace and the deploy, not real inventory data.
    const result = { sku: body.sku, available: true, quantityOnHand: 42 };
    return ok(result);
  } catch (err) {
    return fail(500, (err as Error).message);
  }
}
```

**API pseudocode — inventory contract**

```
POST /internal (invoked via Lambda Function URL from orders)
Request:  { sku: string, quantity: number }
Response: { sku: string, available: boolean, quantityOnHand: number }
Errors:   500 { error: string }
```

---

## 6. Feature: `orders`

**`server/src/features/orders/handler.ts`**

```typescript
import { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { patchAwsSdkForTracing, traced } from "../../shared/aws/xray";
import { ok, fail } from "../../shared/http/responses";
import { env } from "../../config/env";
import { OrderRequest } from "@shi/shared-types";

patchAwsSdkForTracing();

export async function handler(event: APIGatewayProxyEventV2, _context: Context) {
  try {
    const body: OrderRequest = JSON.parse(event.body ?? "{}");

    const inventoryResult = await traced("call-inventory", async () => {
      const res = await fetch(env.inventoryFunctionUrl, {
        method: "POST",
        body: JSON.stringify({ sku: body.sku, quantity: body.quantity }),
      });
      if (!res.ok) throw new Error(`inventory returned ${res.status}`);
      return res.json();
    });

    return ok({ orderId: body.orderId, status: "confirmed", inventoryResult });
  } catch (err) {
    return fail(502, (err as Error).message);
  }
}
```

**API pseudocode — orders contract**

```
POST / (invoked via Lambda Function URL from gateway)
Request:  { orderId: string, sku: string, quantity: number }
Response: { orderId: string, status: "confirmed", inventoryResult: InventoryCheckResult }
Errors:   502 { error: string }   // when inventory call fails or times out
```

---

## 7. Feature: `gateway` (only public entrypoint, sits behind API Gateway)

**`server/src/features/gateway/handler.ts`**

```typescript
import { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { patchAwsSdkForTracing, traced } from "../../shared/aws/xray";
import { ok, fail } from "../../shared/http/responses";
import { env } from "../../config/env";

patchAwsSdkForTracing();

export async function handler(event: APIGatewayProxyEventV2, _context: Context) {
  try {
    const body = JSON.parse(event.body ?? "{}");

    const orderResult = await traced("call-orders", async () => {
      const res = await fetch(env.ordersFunctionUrl, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`orders returned ${res.status}`);
      return res.json();
    });

    return ok(orderResult);
  } catch (err) {
    return fail(502, (err as Error).message);
  }
}
```

**API pseudocode — end-to-end public contract**

```
POST https://{api-id}.execute-api.{region}.amazonaws.com/prod/orders
Request:  { orderId: string, sku: string, quantity: number }
Response: { orderId: string, status: "confirmed", inventoryResult: { sku, available, quantityOnHand } }

Call chain (each hop its own X-Ray subsegment):
  API Gateway → gateway Lambda
      → [traced: call-orders] → orders Lambda
          → [traced: call-inventory] → inventory Lambda
```

---

## 8. Feature: `deploy-events`

**DynamoDB schema — `DeployEvents` table**

```
PK = SERVICE#<serviceName>       e.g. SERVICE#inventory
SK = DEPLOY#<isoTimestamp>       e.g. DEPLOY#2026-09-17T10:22:00Z
Attributes: version (string), diffSummary (string)
```

**`server/src/features/deploy-events/deployEventsRepository.ts`**

```typescript
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../shared/aws/dynamoClient";
import { env } from "../../config/env";
import { DeployEvent } from "@shi/shared-types";

export async function recordDeployEvent(event: DeployEvent): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: env.deployEventsTable,
      Item: {
        PK: `SERVICE#${event.service}`,
        SK: `DEPLOY#${event.timestamp}`,
        version: event.version,
        diffSummary: event.diffSummary,
      },
    })
  );
}
```

**`server/src/features/deploy-events/webhookHandler.ts`**

```typescript
import { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { ok, fail } from "../../shared/http/responses";
import { recordDeployEvent } from "./deployEventsRepository";
import { DeployEvent } from "@shi/shared-types";

patchAwsSdkForTracing();

export async function handler(event: APIGatewayProxyEventV2, _context: Context) {
  try {
    const body: DeployEvent = JSON.parse(event.body ?? "{}");
    await recordDeployEvent(body);
    return ok({ recorded: true });
  } catch (err) {
    return fail(500, (err as Error).message);
  }
}
```

Day 1: invoke this manually with the AWS CLI once per Lambda you deploy, to seed a real deploy record — don't wire an actual CI trigger yet.

```bash
aws lambda invoke \
  --function-name DeployEventsWebhook \
  --payload '{"body":"{\"service\":\"inventory\",\"timestamp\":\"2026-09-17T10:22:00Z\",\"version\":\"v1\",\"diffSummary\":\"initial deploy\"}"}' \
  --cli-binary-format raw-in-base64-out \
  out.json
```

---

## 9. Feature: `graph` (repository only — building the graph is Day 2)

**DynamoDB schema — `ServiceGraph` table (single-table adjacency list)**

```
PK = SERVICE#<name>              e.g. SERVICE#gateway
SK = EDGE#<targetName>           e.g. EDGE#orders     (this row means gateway CALLS orders)
Attributes: lastSeenAt (ISO string)
```

**`server/src/features/graph/graphRepository.ts`**

```typescript
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
```

Day 1: seed the two known static edges (`gateway→orders`, `orders→inventory`) by calling `upsertEdge` once manually or via a throwaway script — this is enough for `LocalizeRootCause` to walk on Day 2. Do not build `buildGraphHandler.ts` (X-Ray trace parsing) yet; leave it an empty file with a `// Day 2` comment.

---

## 10. Infra — AWS CDK

**`infra/lib/tables.ts`**

```typescript
import { Table, AttributeType, BillingMode } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

export function createTables(scope: Construct) {
  const serviceGraph = new Table(scope, "ServiceGraphTable", {
    tableName: "ServiceGraph",
    partitionKey: { name: "PK", type: AttributeType.STRING },
    sortKey: { name: "SK", type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
  });

  const deployEvents = new Table(scope, "DeployEventsTable", {
    tableName: "DeployEvents",
    partitionKey: { name: "PK", type: AttributeType.STRING },
    sortKey: { name: "SK", type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
  });

  const incidents = new Table(scope, "IncidentsTable", {
    tableName: "Incidents",
    partitionKey: { name: "PK", type: AttributeType.STRING },
    sortKey: { name: "SK", type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
  });

  return { serviceGraph, deployEvents, incidents };
}
```

**`infra/lib/lambdas.ts`**

```typescript
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime, Tracing, FunctionUrlAuthType } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import { Duration } from "aws-cdk-lib";

interface LambdasProps {
  serviceGraph: Table;
  deployEvents: Table;
  incidents: Table;
}

export function createLambdas(scope: Construct, tables: LambdasProps) {
  const commonEnv = {
    SERVICE_GRAPH_TABLE: tables.serviceGraph.tableName,
    DEPLOY_EVENTS_TABLE: tables.deployEvents.tableName,
    INCIDENTS_TABLE: tables.incidents.tableName,
  };

  const inventoryFn = new NodejsFunction(scope, "InventoryFunction", {
    entry: "../server/src/features/inventory/handler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,          // <-- X-Ray on
    timeout: Duration.seconds(10),
    environment: { ...commonEnv, INJECT_FAULT: "false" },
  });
  const inventoryUrl = inventoryFn.addFunctionUrl({ authType: FunctionUrlAuthType.AWS_IAM });

  const ordersFn = new NodejsFunction(scope, "OrdersFunction", {
    entry: "../server/src/features/orders/handler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    timeout: Duration.seconds(10),
    environment: { ...commonEnv, INVENTORY_FUNCTION_URL: inventoryUrl.url },
  });
  const ordersUrl = ordersFn.addFunctionUrl({ authType: FunctionUrlAuthType.AWS_IAM });

  const gatewayFn = new NodejsFunction(scope, "GatewayFunction", {
    entry: "../server/src/features/gateway/handler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    timeout: Duration.seconds(10),
    environment: { ...commonEnv, ORDERS_FUNCTION_URL: ordersUrl.url },
  });

  const deployEventsWebhookFn = new NodejsFunction(scope, "DeployEventsWebhookFunction", {
    entry: "../server/src/features/deploy-events/webhookHandler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    environment: commonEnv,
  });

  tables.serviceGraph.grantReadWriteData(gatewayFn);
  tables.deployEvents.grantReadWriteData(deployEventsWebhookFn);

  return { gatewayFn, ordersFn, inventoryFn, deployEventsWebhookFn };
}
```

**`infra/lib/api-gateway.ts`**

```typescript
import { RestApi, LambdaIntegration } from "aws-cdk-lib/aws-apigateway";
import { Construct } from "constructs";
import { IFunction } from "aws-cdk-lib/aws-lambda";

export function createApi(scope: Construct, gatewayFn: IFunction) {
  const api = new RestApi(scope, "PublicApi", {
    restApiName: "self-healing-infra-api",
    deployOptions: { tracingEnabled: true }, // X-Ray on API Gateway stage too
  });

  const orders = api.root.addResource("orders");
  orders.addMethod("POST", new LambdaIntegration(gatewayFn));

  return api;
}
```

**`infra/lib/self-healing-infra-stack.ts`**

```typescript
import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { createTables } from "./tables";
import { createLambdas } from "./lambdas";
import { createApi } from "./api-gateway";

export class SelfHealingInfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const tables = createTables(this);
    const lambdas = createLambdas(this, tables);
    createApi(this, lambdas.gatewayFn);
  }
}
```

**`infra/bin/infra.ts`**

```typescript
#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { SelfHealingInfraStack } from "../lib/self-healing-infra-stack";

const app = new App();
new SelfHealingInfraStack(app, "SelfHealingInfraStack");
```

Deploy:

```bash
cd infra
npx cdk deploy
# note the printed API Gateway URL — this is the endpoint for the Day 1 demo checkpoint
```

---

## 11. Day 1 checklist (execute top to bottom)

- [x] Run all bootstrap commands in §2
- [x] Write shared types (§3), shared server utils (§4)
- [x] Implement `inventory` handler + fault-injection stub (§5)
- [x] Implement `orders` handler (§6)
- [x] Implement `gateway` handler (§7)
- [x] Implement `deploy-events` repository + webhook handler (§8)
- [x] Implement `graph` repository only, no build logic yet (§9)
- [x] Write CDK stack: tables, lambdas with `Tracing.ACTIVE`, API Gateway with `tracingEnabled: true` (§10)
- [x] `cdk bootstrap` (once) → `cdk deploy`
- [x] Manually invoke the deploy-events webhook once per service to seed real `DeployEvents` rows (§8)
- [x] Manually call `upsertEdge` twice to seed `gateway→orders` and `orders→inventory` (§9)
- [x] Hit the API Gateway `/orders` endpoint with `curl` and a JSON body matching `OrderRequest`
- [x] Open the X-Ray console → confirm a 3-segment trace (`gateway → orders → inventory`) for that request
- [x] Confirm all three `DynamoDB` tables exist and are queryable in the console
- [x] Commit with a message that says what got proven, not just what got written — e.g. `Day 1: gateway→orders→inventory chain deployed, X-Ray trace confirmed end-to-end`

**Definition of done (matches ROADMAP.md's Day 1 demo checkpoint):** hitting the gateway endpoint produces a successful response, and the X-Ray console shows a real 3-span trace for that request. Nothing about ranking, diagnosis, or remediation needs to exist yet.

---

## 12. Guardrails — do not build yet

Explicitly out of scope for Day 1, even if it looks like "just one more function":
- Fault-injection probability logic (`faultInjection.ts` stays a no-op stub)
- `BuildGraph` Lambda / X-Ray trace parsing
- `LocalizeRootCause` heuristic
- Bedrock / diagnosis anything
- Step Functions state machine
- Remediation or verify-outcome logic
- Next.js UI beyond the default scaffold

If any of these feel necessary to make Day 1 "feel complete," that's scope creep — Day 1's only job is proving the infra is real and traced.

## Prerequisite fix for Day 2 — propagate the X-Ray trace ID across Lambda-to-Lambda calls

**Do this first.** `BuildGraph` (Section 7) only works if a single trace ID actually spans all three Lambda invocations. Right now `orders/handler.ts` and `gateway/handler.ts` call the downstream Function URL with plain `fetch()` and no trace header. The AWS X-Ray SDK only patches the AWS SDK v3 client (`captureAWSv3Client` in `xray.ts`) — it does **not** patch `fetch`/`undici`, so each downstream Lambda invocation currently starts its **own** root trace instead of continuing the caller's. If this shipped in Day 1's test, it means the "3-segment trace" you saw was probably three separate traces that happen to run back-to-back, not one causally-linked trace with subsegments. Fix it now, before writing anything that parses trace data.

Add a small helper and use it in both `gateway/handler.ts` and `orders/handler.ts`:

**`server/src/shared/aws/xray.ts`** — add:
```typescript
// Lambda sets this env var per-invocation to the trace ID the current
// invocation belongs to. Forward it as a header so the downstream
// Lambda's own X-Ray instrumentation joins the same trace instead of
// minting a new root segment.
export function traceHeaders(): Record<string, string> {
  const traceId = process.env._X_AMZN_TRACE_ID;
  return traceId ? { "X-Amzn-Trace-Id": traceId } : {};
}
```

**`server/src/features/orders/handler.ts`** — update the fetch call:
```typescript
const res = await fetch(env.inventoryFunctionUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...traceHeaders() },
  body: JSON.stringify({ sku: body.sku, quantity: body.quantity }),
});
```
(same pattern for `gateway/handler.ts` calling `env.ordersFunctionUrl`)

Redeploy (`cd infra && npx cdk deploy`), re-run the Day 1 `curl` test, and re-check the X-Ray console: you should now see **one trace** with `call-orders` and `call-inventory` subsegments that each contain a nested segment for the downstream Lambda's own execution — not two/three disconnected traces. Confirm this before moving on; every downstream section assumes it.

---
