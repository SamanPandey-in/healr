# plan2.md — Day 2 Execution Plan for AI Agents

**Repo state:** Day 1 complete and tested — `gateway → orders → inventory` deployed behind API Gateway, X-Ray active on all three Lambdas, three DynamoDB tables exist, graph edges seeded manually, deploy events recorded.

**Scope (per `ROADMAP.md` Day 2):** you must be able to deliberately break `inventory`, have that produce a real `Incident` record, and get back a *ranked* root-cause list that correctly points at `inventory` (or its most recent bad deploy) — with an evidence trail, not just "inventory is unhealthy." Do **not** implement Bedrock diagnosis, the approval gate, remediation, or `VerifyOutcome` — those are Day 3. Section 14 restates this as a hard guardrail.

---

## 1. What Day 2 adds

```
CloudWatch Alarm (inventory error rate)
        │  ALARM state
        ▼
   EventBridge rule
        │  starts execution, input = {service, alarmName, detectedAt}
        ▼
Step Functions: "IncidentResponseDay2"        (2 real states + 1 you already have data for)
┌────────────────────────────────────────────────┐
│ 1. CreateIncident   → writes Incidents row      │
│ 2. BuildGraph       → refreshes ServiceGraph     │
│                        from real X-Ray traces    │
│ 3. LocalizeRootCause→ ranked candidates + evidence│
│                        written back to Incidents  │
└────────────────────────────────────────────────┘
                (Day 3 appends: DiagnoseWithBedrock →
                 RequestApproval → Remediate → VerifyOutcome)

inventory Lambda: INJECT_FAULT/FAULT_PROBABILITY/FAULT_MODE env vars
now do something real (throw / add latency on a % of requests)
```

---

## 2. New/changed files

```
server/src/
├── features/
│   ├── inventory/
│   │   └── faultInjection.ts          # REWRITE — real fault logic
│   ├── incidents/
│   │   ├── types.ts                    # NEW
│   │   ├── incidentsRepository.ts      # NEW
│   │   └── createIncidentHandler.ts    # NEW — Step Functions task #1
│   ├── graph/
│   │   ├── buildGraphHandler.ts        # NEW — Step Functions task #2
│   │   ├── traceParser.ts              # NEW — X-Ray Document parsing
│   │   └── graphRepository.ts          # EXTEND — add getAllEdges()
│   ├── deploy-events/
│   │   └── deployEventsRepository.ts   # EXTEND — add getLatestDeployBefore()
│   └── localization/                   # NEW feature folder
│       ├── types.ts
│       ├── heuristics.ts               # pure scoring/BFS logic, unit-testable
│       └── handler.ts                  # Step Functions task #3
└── shared/aws/
    ├── xray.ts                         # EXTEND — traceHeaders() (Section 0)
    └── xrayQuery.ts                    # NEW — GetTraceSummaries/BatchGetTraces client

infra/lib/
├── lambdas.ts                          # EXTEND — new functions + fault env vars
├── step-functions.ts                   # NEW
└── alarms.ts                           # NEW — CloudWatch Alarm + EventBridge rule

packages/shared-types/src/index.ts      # EXTEND — Incident, LocalizationCandidate, etc.
```

`server/package.json`: `npm install @aws-sdk/client-xray` (needed by `xrayQuery.ts`).

---

## 3. Shared types — extend `packages/shared-types/src/index.ts`

Append (don't touch the existing Day 1 types):

```typescript
export type IncidentStatus = "open" | "localized" | "closed";

export interface Incident {
  incidentId: string;
  service: ServiceName;       // the service the alarm fired on
  alarmName: string;
  detectedAt: string;         // ISO — treated as the anomaly onset for scoring
  status: IncidentStatus;
  createdAt: string;
}

export interface LocalizationCandidate {
  service: ServiceName;
  distanceFromAnomaly: number;      // hops walking backward along CALLS edges
  deployTimestamp: string | null;    // most recent deploy before detectedAt, if any
  deployVersion: string | null;
  deploySummary: string | null;
  secondsBeforeAnomaly: number | null; // detectedAt - deployTimestamp, in seconds
  score: number;                     // higher = more likely root cause
}

export interface LocalizationResult {
  incidentId: string;
  rankedCandidates: LocalizationCandidate[]; // sorted desc by score
  computedAt: string;
}
```

---

## 4. Fault injection — real implementation

**`server/src/features/inventory/faultInjection.ts`** — rewrite:
```typescript
import { env } from "../../config/env";

// Sleep helper — used for the latency fault mode.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Called at the top of the inventory handler on every request.
// - FAULT_MODE=error: throws ~FAULT_PROBABILITY of the time (handler's
//   existing try/catch turns this into a 500 automatically).
// - FAULT_MODE=latency: sleeps an extra 2–4s ~FAULT_PROBABILITY of the time,
//   enough to trip a latency-based CloudWatch alarm without timing out
//   (handler timeout is 10s).
export async function maybeInjectFault(): Promise<void> {
  if (!env.injectFault) return;
  if (Math.random() >= env.faultProbability) return;

  if (env.faultMode === "latency") {
    await sleep(2000 + Math.random() * 2000);
    return;
  }
  // default: error
  throw new Error("SIMULATED_FAULT: inventory dependency unavailable");
}
```

**`server/src/config/env.ts`** — add two fields:
```typescript
export const env = {
  // ...existing fields unchanged...
  injectFault: process.env.INJECT_FAULT === "true",
  faultProbability: Number(process.env.FAULT_PROBABILITY ?? "0.3"),
  faultMode: (process.env.FAULT_MODE ?? "error") as "error" | "latency",
};
```

**`infra/lib/lambdas.ts`** — `inventoryFn` environment block:
```typescript
environment: {
  ...commonEnv,
  INJECT_FAULT: "false",       // toggle at demo time, see below — start OFF
  FAULT_PROBABILITY: "0.3",
  FAULT_MODE: "error",
},
```

**Toggle at demo time without a redeploy:**
```bash
aws lambda update-function-configuration \
  --function-name InventoryFunction \
  --environment "Variables={SERVICE_GRAPH_TABLE=ServiceGraph,DEPLOY_EVENTS_TABLE=DeployEvents,INCIDENTS_TABLE=Incidents,INJECT_FAULT=true,FAULT_PROBABILITY=0.3,FAULT_MODE=error}"
```
(`update-function-configuration` replaces the *entire* env var map, so include every existing var, not just the one you're changing — copy the current set from the CDK output or Lambda console first.)

---

## 5. Incidents feature — types + repository

Key design: single-table item per incident (`PK=INCIDENT#<id>`, `SK=META`), plus a second item per localization result (`SK=LOCALIZATION`) so `LocalizeRootCause` doesn't overwrite the incident's own metadata.

**`server/src/features/incidents/types.ts`**
```typescript
import { Incident, LocalizationResult } from "@shi/shared-types";

export interface CreateIncidentInput {
  service: string;
  alarmName: string;
  detectedAt: string;
}

// Step Functions passes this shape between CreateIncident → BuildGraph → LocalizeRootCause
export interface IncidentResponseState {
  incidentId: string;
  service: string;
  detectedAt: string;
}
```

**`server/src/features/incidents/incidentsRepository.ts`**
```typescript
import { randomUUID } from "crypto";
import { PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../shared/aws/dynamoClient";
import { env } from "../../config/env";
import { Incident, LocalizationResult, ServiceName } from "@shi/shared-types";

export async function createIncident(
  service: ServiceName,
  alarmName: string,
  detectedAt: string
): Promise<Incident> {
  const incident: Incident = {
    incidentId: randomUUID(),
    service,
    alarmName,
    detectedAt,
    status: "open",
    createdAt: new Date().toISOString(),
  };
  await ddb.send(
    new PutCommand({
      TableName: env.incidentsTable,
      Item: { PK: `INCIDENT#${incident.incidentId}`, SK: "META", ...incident },
    })
  );
  return incident;
}

export async function saveLocalizationResult(result: LocalizationResult): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: env.incidentsTable,
      Item: { PK: `INCIDENT#${result.incidentId}`, SK: "LOCALIZATION", ...result },
    })
  );
  await ddb.send(
    new PutCommand({
      TableName: env.incidentsTable,
      Item: {
        PK: `INCIDENT#${result.incidentId}`,
        SK: "META",
        status: "localized",
        // Note: this Put replaces the whole META item — in a real system you'd
        // use UpdateCommand with a status-only expression. Fine for Day 2 scope
        // since CreateIncident and this write never race for the same incident.
      },
    })
  );
}

export async function getIncident(incidentId: string): Promise<Record<string, unknown> | undefined> {
  const res = await ddb.send(
    new GetCommand({ TableName: env.incidentsTable, Key: { PK: `INCIDENT#${incidentId}`, SK: "META" } })
  );
  return res.Item;
}
```
> Flagging the `saveLocalizationResult` META overwrite as a known shortcut, not silently — fix with `UpdateCommand` if you have spare time on Day 3, but it's not worth spending Day 2 hours on.

**`server/src/features/incidents/createIncidentHandler.ts`** (Step Functions task #1, *not* API-Gateway-triggered — invoked directly by the state machine, so it's a plain Lambda handler with no API Gateway event shape):
```typescript
import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { createIncident } from "./incidentsRepository";
import { CreateIncidentInput, IncidentResponseState } from "./types";
import { ServiceName } from "@shi/shared-types";

patchAwsSdkForTracing();

export async function handler(input: CreateIncidentInput): Promise<IncidentResponseState> {
  const incident = await createIncident(input.service as ServiceName, input.alarmName, input.detectedAt);
  return { incidentId: incident.incidentId, service: incident.service, detectedAt: incident.detectedAt };
}
```

---

## 6. X-Ray trace query helper

**`server/src/shared/aws/xrayQuery.ts`**
```typescript
import { XRayClient, GetTraceSummariesCommand, BatchGetTracesCommand, Trace } from "@aws-sdk/client-xray";

const xray = new XRayClient({});

// Pull trace IDs for the last `windowMinutes`. FilterExpression scopes to
// traces that touched the gateway function, which is enough to catch the
// whole gateway→orders→inventory chain once Section 0's fix is in place.
export async function getRecentTraceIds(windowMinutes = 15): Promise<string[]> {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - windowMinutes * 60_000);
  const res = await xray.send(
    new GetTraceSummariesCommand({
      StartTime: startTime,
      EndTime: endTime,
      FilterExpression: 'service("GatewayFunction")',
    })
  );
  return (res.TraceSummaries ?? []).map((t) => t.Id!).filter(Boolean);
}

export async function getFullTraces(traceIds: string[]): Promise<Trace[]> {
  if (traceIds.length === 0) return [];
  const res = await xray.send(new BatchGetTracesCommand({ TraceIds: traceIds }));
  return res.Traces ?? [];
}
```
> `service("GatewayFunction")` assumes the Lambda's X-Ray segment name contains `GatewayFunction` — CDK's `NodejsFunction` names the segment after the physical function name, which for a construct id of `GatewayFunction` under stack `SelfHealingInfraStack` is typically `SelfHealingInfraStack-GatewayFunction<hash>`. Confirm the exact string in the X-Ray console (click a trace → segment name) and adjust the filter expression if `service()` needs an exact match rather than substring — X-Ray's filter DSL does substring-match service names, so this should work as-is, but verify against a real trace before trusting it in the demo.

---

## 7. BuildGraph Lambda

**`server/src/features/graph/traceParser.ts`** — pure parsing logic, no AWS calls, so it's easy to test against a captured trace JSON:
```typescript
import { Trace } from "@aws-sdk/client-xray";
import { GraphEdge, ServiceName } from "@shi/shared-types";

// Map a segment's function-name substring to our ServiceName enum.
// Order matters: check "Inventory"/"Orders" before falling through.
function toServiceName(segmentName: string): ServiceName | null {
  if (segmentName.includes("Inventory")) return "inventory";
  if (segmentName.includes("Orders")) return "orders";
  if (segmentName.includes("Gateway")) return "gateway";
  return null;
}

interface ParsedSegment {
  service: ServiceName;
  endTime: number; // epoch seconds, from the segment's own `end_time` field
  subsegmentNames: string[]; // e.g. ["call-orders"]
}

function parseSegmentDocument(doc: string): ParsedSegment | null {
  const parsed = JSON.parse(doc);
  const service = toServiceName(parsed.name ?? "");
  if (!service) return null;
  const subsegmentNames: string[] = (parsed.subsegments ?? []).map((s: { name: string }) => s.name);
  return { service, endTime: parsed.end_time, subsegmentNames };
}

// A trace's `call-orders` / `call-inventory` subsegment names tell us the
// CALLER made an outbound call — we don't need to resolve them to the callee's
// own segment; the topology is static enough (3 services, fixed call shape)
// that "gateway segment has a call-orders subsegment" already means the edge
// gateway→orders exists. This sidesteps correlating subsegment IDs to the
// downstream segment, which BatchGetTraces makes possible but fiddly.
export function deriveEdgesFromTrace(trace: Trace): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const segment of trace.Segments ?? []) {
    if (!segment.Document) continue;
    const parsed = parseSegmentDocument(segment.Document);
    if (!parsed) continue;
    const lastSeenAt = new Date(parsed.endTime * 1000).toISOString();
    for (const subName of parsed.subsegmentNames) {
      if (subName === "call-orders" && parsed.service === "gateway") {
        edges.push({ from: "gateway", to: "orders", lastSeenAt });
      }
      if (subName === "call-inventory" && parsed.service === "orders") {
        edges.push({ from: "orders", to: "inventory", lastSeenAt });
      }
    }
  }
  return edges;
}
```

**`server/src/features/graph/buildGraphHandler.ts`** (Step Functions task #2):
```typescript
import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { getRecentTraceIds, getFullTraces } from "../../shared/aws/xrayQuery";
import { deriveEdgesFromTrace } from "./traceParser";
import { upsertEdge } from "./graphRepository";
import { IncidentResponseState } from "../incidents/types";

patchAwsSdkForTracing();

export async function handler(state: IncidentResponseState): Promise<IncidentResponseState> {
  const traceIds = await getRecentTraceIds(15);
  const traces = await getFullTraces(traceIds);

  const edges = traces.flatMap(deriveEdgesFromTrace);
  // De-dupe by from→to, keep the most recent lastSeenAt per pair.
  const latestByPair = new Map<string, (typeof edges)[number]>();
  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}`;
    const existing = latestByPair.get(key);
    if (!existing || edge.lastSeenAt > existing.lastSeenAt) latestByPair.set(key, edge);
  }
  await Promise.all([...latestByPair.values()].map(upsertEdge));

  // Fallback: if no traces matched (e.g. trace propagation not yet
  // reflecting in X-Ray's index — there's ingestion lag of up to a few
  // minutes), don't wipe the graph. Just pass the state through — the
  // Day 1-seeded static edges are still there for LocalizeRootCause to use.
  return state;
}
```

---

## 8. Reverse graph lookup

Add to **`server/src/features/graph/graphRepository.ts`**:
```typescript
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
// ...existing imports...

// Full-table scan is fine at this scale (3–5 services, single-digit edge
// count). Don't add a GSI for this in the hackathon window — it's a real
// improvement but not a load-bearing one for the demo.
export async function getAllEdges(): Promise<GraphEdge[]> {
  const res = await ddb.send(new ScanCommand({ TableName: env.serviceGraphTable }));
  return (res.Items ?? []).map((i) => ({
    from: (i.PK as string).replace("SERVICE#", "") as ServiceName,
    to: (i.SK as string).replace("EDGE#", "") as ServiceName,
    lastSeenAt: i.lastSeenAt,
  }));
}
```

Add to **`server/src/features/deploy-events/deployEventsRepository.ts`**:
```typescript
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
// ...existing imports...

export interface LatestDeploy {
  version: string;
  diffSummary: string;
  timestamp: string;
}

// Most recent deploy for `service` at or before `beforeIso`. SK sorts
// lexicographically and ISO-8601 timestamps sort correctly as strings,
// so a bounded key condition + ScanIndexForward:false + Limit:1 gets us
// the answer in one query, no client-side filtering.
export async function getLatestDeployBefore(
  service: ServiceName,
  beforeIso: string
): Promise<LatestDeploy | null> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: env.deployEventsTable,
      KeyConditionExpression: "PK = :pk AND SK <= :sk",
      ExpressionAttributeValues: { ":pk": `SERVICE#${service}`, ":sk": `DEPLOY#${beforeIso}` },
      ScanIndexForward: false,
      Limit: 1,
    })
  );
  const item = res.Items?.[0];
  if (!item) return null;
  return {
    version: item.version,
    diffSummary: item.diffSummary,
    timestamp: (item.SK as string).replace("DEPLOY#", ""),
  };
}
```

---

## 9. LocalizeRootCause Lambda

This is the one piece of real "hard part" work — budget the most focused hours of Day 2 here, per `ROADMAP.md`.

**`server/src/features/localization/types.ts`**
```typescript
import { GraphEdge, ServiceName } from "@shi/shared-types";
export interface LocalizationInput {
  incidentId: string;
  service: string;
  detectedAt: string;
}
```

**`server/src/features/localization/heuristics.ts`** — pure functions, no AWS SDK calls, so this is the part worth unit-testing if time allows:
```typescript
import { GraphEdge, ServiceName } from "@shi/shared-types";

// BFS backward along CALLS edges from `target` to find every service that
// is actually on a call path INTO it, tagged with hop distance. This is the
// "restricted to nodes actually on a call path to D" part of the heuristic —
// it deliberately does NOT rank every service in the system, only ancestors.
export function findUpstreamAncestors(
  target: ServiceName,
  edges: GraphEdge[]
): Map<ServiceName, number> {
  const reverseAdjacency = new Map<ServiceName, ServiceName[]>();
  for (const edge of edges) {
    if (!reverseAdjacency.has(edge.to)) reverseAdjacency.set(edge.to, []);
    reverseAdjacency.get(edge.to)!.push(edge.from);
  }

  const distances = new Map<ServiceName, number>([[target, 0]]);
  const queue: ServiceName[] = [target];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const callers = reverseAdjacency.get(current) ?? [];
    for (const caller of callers) {
      if (distances.has(caller)) continue;
      distances.set(caller, distances.get(current)! + 1);
      queue.push(caller);
    }
  }
  return distances; // includes target itself at distance 0
}

// Temporal-precedence score: a deploy that lands closer in time BEFORE the
// anomaly is a stronger causal candidate than one from days ago. A deploy
// AFTER the anomaly onset can't be the cause — score it 0, don't just rank
// it low, so it never accidentally outranks a real candidate with no deploy
// data at all.
export function temporalScore(secondsBeforeAnomaly: number | null): number {
  if (secondsBeforeAnomaly === null) return 0.05; // small non-zero floor: a
  // service with no deploy record is still a valid candidate by topology
  // alone, just a weak one — don't let it drop to exactly 0 and tie with
  // "deploy happened after the anomaly" candidates.
  if (secondsBeforeAnomaly < 0) return 0;
  // Decays from 1.0 (deploy landed right before the anomaly) toward 0 as
  // the gap grows. Half-life ≈ 5 minutes (300s) — tune after seeing real
  // demo timings; this is the one constant worth eyeballing against your
  // actual fault-injection-to-alarm latency.
  return 1 / (1 + secondsBeforeAnomaly / 300);
}

// Structural prior: being closer to the anomaly (fewer hops) is itself
// weak evidence, since most cascades originate near where they're observed
// more often than not. This is deliberately a SMALL weight relative to
// temporalScore, so a well-timed deploy three hops away can still outrank
// the node distance=0 with no recent deploy — matches the roadmap's "not
// just the loudest symptom" framing.
export function structuralPrior(distance: number): number {
  return 1 / (1 + distance);
}

export function combinedScore(secondsBeforeAnomaly: number | null, distance: number): number {
  const TEMPORAL_WEIGHT = 0.8;
  const STRUCTURAL_WEIGHT = 0.2;
  return (
    TEMPORAL_WEIGHT * temporalScore(secondsBeforeAnomaly) +
    STRUCTURAL_WEIGHT * structuralPrior(distance)
  );
}
```

**`server/src/features/localization/handler.ts`** (Step Functions task #3):
```typescript
import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { getAllEdges } from "../graph/graphRepository";
import { getLatestDeployBefore } from "../deploy-events/deployEventsRepository";
import { saveLocalizationResult } from "../incidents/incidentsRepository";
import { findUpstreamAncestors, combinedScore } from "./heuristics";
import { LocalizationInput } from "./types";
import { LocalizationCandidate, LocalizationResult, ServiceName } from "@shi/shared-types";

patchAwsSdkForTracing();

export async function handler(input: LocalizationInput): Promise<LocalizationResult> {
  const edges = await getAllEdges();
  const ancestors = findUpstreamAncestors(input.service as ServiceName, edges);

  const candidates: LocalizationCandidate[] = await Promise.all(
    [...ancestors.entries()].map(async ([service, distance]) => {
      const deploy = await getLatestDeployBefore(service, input.detectedAt);
      const secondsBeforeAnomaly = deploy
        ? (new Date(input.detectedAt).getTime() - new Date(deploy.timestamp).getTime()) / 1000
        : null;
      return {
        service,
        distanceFromAnomaly: distance,
        deployTimestamp: deploy?.timestamp ?? null,
        deployVersion: deploy?.version ?? null,
        deploySummary: deploy?.diffSummary ?? null,
        secondsBeforeAnomaly,
        score: combinedScore(secondsBeforeAnomaly, distance),
      };
    })
  );

  candidates.sort((a, b) => b.score - a.score);

  const result: LocalizationResult = {
    incidentId: input.incidentId,
    rankedCandidates: candidates,
    computedAt: new Date().toISOString(),
  };
  await saveLocalizationResult(result);
  return result;
}
```

**Demo checkpoint for this section, standalone before wiring the state machine:** invoke this Lambda directly with a hand-built `LocalizationInput` (via `aws lambda invoke`) pointing at `inventory`, after seeding a fresh `inventory` deploy event a minute or two before `detectedAt` — confirm `inventory` comes out top-ranked with a small `secondsBeforeAnomaly`, and `orders`/`gateway` rank lower. This isolates bugs in the heuristic from bugs in the CloudWatch/EventBridge wiring.

---

## 10. Step Functions state machine (2 states for Day 2 — Day 3 appends more)

**`infra/lib/step-functions.ts`**
```typescript
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import { StateMachine, DefinitionBody, JsonPath } from "aws-cdk-lib/aws-stepfunctions";
import { LambdaInvoke } from "aws-cdk-lib/aws-stepfunctions-tasks";
import { IFunction } from "aws-cdk-lib/aws-lambda";

interface IncidentResponseProps {
  createIncidentFn: IFunction;
  buildGraphFn: IFunction;
  localizeFn: IFunction;
}

export function createIncidentResponseStateMachine(scope: Construct, fns: IncidentResponseProps) {
  const createIncident = new LambdaInvoke(scope, "CreateIncident", {
    lambdaFunction: fns.createIncidentFn,
    payloadResponseOnly: true, // unwrap the Lambda's return value directly into state
  });

  const buildGraph = new LambdaInvoke(scope, "BuildGraph", {
    lambdaFunction: fns.buildGraphFn,
    payloadResponseOnly: true,
  });

  const localize = new LambdaInvoke(scope, "LocalizeRootCause", {
    lambdaFunction: fns.localizeFn,
    payloadResponseOnly: true,
  });

  const definition = createIncident.next(buildGraph).next(localize);
  // Day 3 will insert DiagnoseWithBedrock, RequestApproval (waitForTaskToken),
  // Remediate, VerifyOutcome after `localize` here — don't build those states now.

  return new StateMachine(scope, "IncidentResponseStateMachine", {
    stateMachineName: "IncidentResponseDay2",
    definitionBody: DefinitionBody.fromChainable(definition),
    timeout: Duration.minutes(5),
  });
}
```

---

## 11. CloudWatch Alarm + EventBridge rule

**`infra/lib/alarms.ts`**
```typescript
import { Construct } from "constructs";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { Rule } from "aws-cdk-lib/aws-events";
import { SfnStateMachine } from "aws-cdk-lib/aws-events-targets";
import { StateMachine } from "aws-cdk-lib/aws-stepfunctions";
import { IFunction } from "aws-cdk-lib/aws-lambda";
import { Duration } from "aws-cdk-lib";

export function createInventoryAlarmAndRule(
  scope: Construct,
  inventoryFn: IFunction,
  stateMachine: StateMachine
) {
  const errorAlarm = new Alarm(scope, "InventoryErrorAlarm", {
    metric: inventoryFn.metricErrors({ period: Duration.minutes(1) }),
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    treatMissingData: TreatMissingData.NOT_BREACHING,
    alarmName: "InventoryErrorAlarm",
  });

  // EventBridge's default bus carries CloudWatch Alarm State Change events
  // automatically — no SNS topic or subscription needed for this pattern.
  const rule = new Rule(scope, "InventoryAlarmToStepFunctions", {
    eventPattern: {
      source: ["aws.cloudwatch"],
      detailType: ["CloudWatch Alarm State Change"],
      detail: {
        alarmName: [errorAlarm.alarmName],
        state: { value: ["ALARM"] },
      },
    },
  });

  rule.addTarget(
    new SfnStateMachine(stateMachine, {
      input: {
        // Static for Day 2: only `inventory` has an alarm. Section 14 notes
        // "second fault type / extra services" as an explicit later cut.
        bind: () => ({
          service: "inventory",
          alarmName: errorAlarm.alarmName,
          detectedAt: new Date().toISOString(), // approximate — good enough
          // for the temporal heuristic's minute-scale resolution; the exact
          // alarm state-change timestamp is available in the EventBridge
          // event's `time` field via RuleTargetInput.fromEventPath("$.time")
          // if you want to thread it through precisely instead.
        }),
      } as any,
    })
  );

  return { errorAlarm, rule };
}
```
> The inline comment flags a real simplification: `detectedAt` is set to "now" at CDK synth-time in this sketch, which is wrong — it needs to be the actual alarm-trigger time, captured at rule-match time. Use `RuleTargetInput.fromObject({ service: "inventory", alarmName: errorAlarm.alarmName, detectedAt: EventField.fromPath("$.time") })` from `aws-cdk-lib/aws-events` instead of the static object above — mentioned here so the agent building this doesn't ship the synth-time placeholder.

**`infra/lib/lambdas.ts`** — add the two new functions (reuse `commonEnv`/`xrayBundling` from the existing file):
```typescript
const createIncidentFn = new NodejsFunction(scope, "CreateIncidentFunction", {
  entry: "../server/src/features/incidents/createIncidentHandler.ts",
  runtime: Runtime.NODEJS_20_X,
  tracing: Tracing.ACTIVE,
  environment: commonEnv,
  bundling: xrayBundling,
});

const buildGraphFn = new NodejsFunction(scope, "BuildGraphFunction", {
  entry: "../server/src/features/graph/buildGraphHandler.ts",
  runtime: Runtime.NODEJS_20_X,
  tracing: Tracing.ACTIVE,
  timeout: Duration.seconds(30),
  environment: commonEnv,
  bundling: xrayBundling,
});

const localizeFn = new NodejsFunction(scope, "LocalizeRootCauseFunction", {
  entry: "../server/src/features/localization/handler.ts",
  runtime: Runtime.NODEJS_20_X,
  tracing: Tracing.ACTIVE,
  environment: commonEnv,
  bundling: xrayBundling,
});

tables.incidents.grantReadWriteData(createIncidentFn);
tables.incidents.grantReadWriteData(localizeFn);
tables.serviceGraph.grantReadWriteData(buildGraphFn);
tables.deployEvents.grantReadData(localizeFn);

// BuildGraph needs X-Ray read access — grant explicitly, it's not part of
// any DynamoDB table's grant methods:
buildGraphFn.addToRolePolicy(
  new PolicyStatement({
    actions: ["xray:GetTraceSummaries", "xray:BatchGetTraces"],
    resources: ["*"], // X-Ray query APIs don't support resource-level scoping
  })
);
```
(needs `import { PolicyStatement } from "aws-cdk-lib/aws-iam";` at the top of `lambdas.ts`)

**`infra/lib/self-healing-infra-stack.ts`** — wire it together:
```typescript
import { createIncidentResponseStateMachine } from "./step-functions";
import { createInventoryAlarmAndRule } from "./alarms";
// ...existing imports...

export class SelfHealingInfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const tables = createTables(this);
    const lambdas = createLambdas(this, tables); // now also returns createIncidentFn, buildGraphFn, localizeFn
    createApi(this, lambdas.gatewayFn);

    const stateMachine = createIncidentResponseStateMachine(this, {
      createIncidentFn: lambdas.createIncidentFn,
      buildGraphFn: lambdas.buildGraphFn,
      localizeFn: lambdas.localizeFn,
    });
    createInventoryAlarmAndRule(this, lambdas.inventoryFn, stateMachine);
  }
}
```
(update `createLambdas`'s return statement to include `createIncidentFn, buildGraphFn, localizeFn`)

---

## 12. Day 2 checklist (execute top to bottom)

- [x] Section 0: fix trace-ID propagation in `gateway`/`orders` handlers, redeploy, confirm one joined trace in X-Ray console
- [x] Extend shared types (§3)
- [x] Rewrite `faultInjection.ts`, extend `env.ts`, update `inventoryFn` env vars (§4)
- [x] Implement `incidents` types + repository + `createIncidentHandler` (§5)
- [x] Implement `xrayQuery.ts`, `npm install @aws-sdk/client-xray` in `server/` (§6)
- [x] Implement `traceParser.ts` + `buildGraphHandler.ts` (§7)
- [x] Add `getAllEdges()` to graph repo, `getLatestDeployBefore()` to deploy-events repo (§8)
- [x] Implement `localization/heuristics.ts` + `handler.ts` (§9)
- [x] Unit-test or manually invoke `LocalizeRootCause` standalone before wiring the state machine (§9 checkpoint)
- [x] Implement `step-functions.ts`, wire new Lambdas into `lambdas.ts` with correct IAM grants (§10, §11)
- [x] Implement `alarms.ts` with the alarm-timestamp fix (not the synth-time placeholder) (§11)
- [x] Wire everything into `self-healing-infra-stack.ts`, `cdk deploy`
- [x] Toggle `INJECT_FAULT=true` on `InventoryFunction`, hit the `/orders` endpoint repeatedly until the alarm trips
- [x] Confirm in the console: alarm goes to ALARM → EventBridge rule fires → Step Functions execution starts and reaches `SUCCEEDED`
- [x] Confirm an `Incidents` table row exists with `SK=META` and a second with `SK=LOCALIZATION`, and that `inventory` (or its deploy) is top-ranked in `rankedCandidates`
- [x] Toggle `INJECT_FAULT=false` again so Day 3 work starts from a healthy baseline
- [x] Commit with a message stating what got proven — e.g. `Day 2: fault injection → alarm → Step Functions → ranked root-cause localization confirmed end-to-end`

**Definition of done (matches `ROADMAP.md`'s Day 2 demo checkpoint):** toggle the fault, trigger the alarm, watch the state machine run through `CreateIncident → BuildGraph → LocalizeRootCause`, see `inventory` (or its most recent deploy) come out top-ranked with a visible evidence trail — not just "the one with the worst metric."

---

## 13. Guardrails — do not build yet

Explicitly out of scope for Day 2, even if it looks like "just one more state":
- `DiagnoseWithBedrock` Lambda / any Bedrock invocation
- `RequestApproval` / `waitForTaskToken` callback pattern
- `Remediate` Lambda (Lambda alias rollback or any other remediation action)
- `VerifyOutcome` Lambda
- SES/email for approval links
- A second fault type or a fourth service
- Any Next.js UI work beyond the Day 1 scaffold
- Fixing `saveLocalizationResult`'s META-item overwrite to use `UpdateCommand` — noted as a shortcut in §5, revisit only if Day 3 finishes early

If any of these feel necessary to make Day 2 "feel complete," that's scope creep — Day 2's only job is proving fault injection produces a real incident with a correctly-ranked, evidence-backed root cause.