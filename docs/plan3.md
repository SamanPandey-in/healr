# plan3.md — Day 3 Execution Plan for AI Agents

**Repo state:** Day 1 and Day 2 complete and tested — `gateway → orders → inventory` deployed
behind API Gateway, X-Ray active, fault injection working, `InventoryErrorAlarm` →
EventBridge → Step Functions (`IncidentResponseDay2`) runs `CreateIncident → BuildGraph →
LocalizeRootCause` and correctly ranks `inventory` (or its bad deploy) as the top root-cause
candidate with an evidence trail.

**Scope (per `ROADMAP.md` Day 3):** close the loop. Add `DiagnoseWithBedrock` (structured,
cited diagnosis via Amazon Bedrock), `RequestApproval` (Step Functions `waitForTaskToken`
human-approval gate), `Remediate` (revert `inventory`'s Lambda alias to its previous version),
and `VerifyOutcome` (re-check CloudWatch metrics post-remediation, close the incident). Do
**not** build the frontend/static page, the demo video, the blog post, a second fault type, or
SES email — those are Day 4 or explicit cuts. Section 15 restates this as a hard guardrail.

Read `docs/bedrock-guide.md` (companion doc, written after this plan) before touching
`bedrockClient.ts` — it covers *why* Bedrock is invoked the specific way it is here
(a plain, In-Region model id for Qwen3-235B-A22B-2507, plus Structured Outputs for the
JSON shape) and will save you an `AccessDeniedException` detour.

---

## 0. Before you start

- **Request Bedrock model access now if you haven't** (Model access page, Bedrock console,
  `ap-south-1`) for **Qwen3-235B-A22B-2507** (`qwen.qwen3-235b-a22b-2507-v1:0`). This is an
  open-weight third-party model, so access is normally a click-through EULA rather than
  Anthropic's use-case-description form, and tends to resolve faster — but confirm it actually
  shows **Access granted** before Day 3 rather than assuming a fast approval. Unlike the Claude
  model this plan originally targeted, this one is hosted directly (In-Region) in `ap-south-1` —
  no inference-profile indirection, see `docs/bedrock-guide.md` §2.
- Decide the approval channel now, don't relitigate mid-build: **CloudWatch Logs only** (no
  SES). This matches the roadmap's "simplest viable approval channel" and its own cut list.
  You'll tail/read the approval link out of `RequestApprovalFunction`'s log group during the
  demo.
- The `inventory` remediation target needs **two published Lambda versions** to roll back
  between (a "good" one and a "bad" one). Day 1/2 deploys did not publish versions. §10 below
  introduces versioning + an alias; §14's test checklist tells you exactly when to trigger the
  second (bad) publish so there's something to roll back to.

---

## 1. What Day 3 adds

```
...LocalizeRootCause (Day 2, unchanged)
        │  LocalizationResult { incidentId, rankedCandidates, computedAt }
        ▼
┌───────────────────────────────────────────────────────────────────┐
│ 4. DiagnoseWithBedrock                                              │
│    → builds a fixed EVIDENCE list from rankedCandidates + the       │
│      original alarm (no raw log/trace store exists — this IS the    │
│      evidence)                                                      │
│    → calls Amazon Bedrock (Qwen3-235B-A22B-Instruct-2507, invoked   │
│      directly in ap-south-1 — this model IS a plain regional        │
│      on-demand model there, no inference profile needed) with a     │
│      JSON-Schema-constrained Structured Outputs request (the        │
│      schema's citedEvidenceIds enum only allows ids actually sent)  │
│    → REJECTS the diagnosis if it cites zero evidence ids that       │
│      actually exist — fails the Lambda rather than pass junk on;    │
│      this is defense-in-depth on top of the schema, not the only    │
│      check (see docs/bedrock-guide.md §2-3)                         │
└───────────────────────────────────────────────────────────────────┘
        │  DiagnosisResult { incidentId, rootCauseService, summary,
        │                    citedEvidenceIds, confidence,
        │                    rankedCandidates, generatedAt }
        ▼
┌───────────────────────────────────────────────────────────────────┐
│ 5. RequestApproval  (Step Functions waitForTaskToken — PAUSES here) │
│    → prints an approve link + deny link (with the task token) to    │
│      CloudWatch Logs                                                │
│    → a human opens the link → hits `ApproveHandler` (separate       │
│      Function URL, NOT part of the state machine) → SendTaskSuccess │
│      or SendTaskFailure resumes/fails the execution                 │
└───────────────────────────────────────────────────────────────────┘
        │  ApprovalOutcome { incidentId, approved, rootCauseService,
        │                    rankedCandidates, decidedAt }
        ▼
┌───────────────────────────────────────────────────────────────────┐
│ 6. Remediate                                                        │
│    → looks up inventory's Lambda alias "live", finds the published  │
│      version immediately before the alias's current version,       │
│      points the alias back at it (UpdateAlias)                      │
└───────────────────────────────────────────────────────────────────┘
        │  RemediationResult { incidentId, service, action,
        │                      revertedFromVersion, revertedToVersion,
        │                      remediatedAt }
        ▼
   Wait 60s (let CloudWatch metrics settle)
        ▼
┌───────────────────────────────────────────────────────────────────┐
│ 7. VerifyOutcome                                                    │
│    → sums the InjectedFault EMF metric before/after remediatedAt    │
│    → writes a VERIFICATION record, sets Incident status = "closed"  │
└───────────────────────────────────────────────────────────────────┘
```

**Important state-shape note:** every `LambdaInvoke` in this chain uses
`payloadResponseOnly: true` (except `RequestApproval`, see §12), which means each Lambda's
return value **replaces** the entire state — nothing from earlier steps survives unless a
later Lambda explicitly re-fetches it (via `getIncident(incidentId)`) or an earlier Lambda
explicitly re-returns it (this is why `DiagnoseWithBedrock` re-includes `rankedCandidates` in
its own output — `Remediate` needs `rootCauseService` down the line and would otherwise lose
it).

---

## 2. New/changed files

```
server/src/
├── shared/aws/
│   └── bedrockClient.ts                 # NEW — Converse API wrapper
├── features/
│   ├── diagnosis/
│   │   ├── evidenceBuilder.ts           # NEW
│   │   ├── schema.ts                    # NEW — Bedrock Structured Outputs JSON Schema
│   │   ├── prompt.ts                    # NEW
│   │   └── handler.ts                   # NEW (fills the Day-1 .gitkeep) — task #4
│   ├── approval/                        # NEW feature folder
│   │   ├── requestApprovalHandler.ts    # task #5 (waitForTaskToken side)
│   │   └── approveHandler.ts            # standalone Function URL — the callback side
│   ├── remediation/
│   │   └── handler.ts                   # NEW (fills the Day-1 .gitkeep) — task #6
│   ├── verification/                    # NEW feature folder
│   │   └── handler.ts                   # task #7
│   └── incidents/
│       └── incidentsRepository.ts       # EXTEND — 6 new functions, see §6
└── config/env.ts                        # EXTEND

packages/shared-types/src/index.ts       # EXTEND — DiagnosisResult, ApprovalOutcome,
                                          #          RemediationResult, VerificationResult,
                                          #          widen IncidentStatus

infra/lib/
├── bedrockAccess.ts                     # NEW — the 3-statement global-CRIS IAM policy
├── lambdas.ts                           # REWRITE — 5 new functions, inventory alias+versioning
├── step-functions.ts                    # REWRITE — Day 3 states appended
└── self-healing-infra-stack.ts          # EXTEND — wiring + CfnOutput for the approval URL
```

`server/package.json`: `npm install @aws-sdk/client-bedrock-runtime @aws-sdk/client-sfn
@aws-sdk/client-lambda @aws-sdk/client-cloudwatch`

Install the latest `@aws-sdk/client-bedrock-runtime`, not whatever your lockfile happens to
already pin — Structured Outputs' `outputConfig` field on `ConverseCommand` (§4) is newer than
the base Converse shape, and an older pinned version may not type it. Check `tsc` after adding
it rather than assuming either way.

---

## 3. Shared types — extend `packages/shared-types/src/index.ts`

Append (and widen `IncidentStatus` in place):

```typescript
export type IncidentStatus = "open" | "localized" | "diagnosed" | "remediated" | "closed";

export interface DiagnosisResult {
  incidentId: string;
  rootCauseService: ServiceName;
  summary: string;
  citedEvidenceIds: string[];       // validated — subset of the ids offered to the model
  confidence: number;                // model-reported, 0–1
  rankedCandidates: LocalizationCandidate[]; // carried forward so Remediate knows the target
  generatedAt: string;
}

export interface ApprovalOutcome {
  incidentId: string;
  approved: boolean;
  rootCauseService: ServiceName;
  rankedCandidates: LocalizationCandidate[];
  decidedAt: string;
}

export interface RemediationResult {
  incidentId: string;
  service: ServiceName;
  action: "lambda-alias-rollback";
  revertedFromVersion: string;
  revertedToVersion: string;
  remediatedAt: string;
}

export interface VerificationResult {
  incidentId: string;
  service: ServiceName;
  faultCountBefore: number;
  faultCountAfter: number;
  recovered: boolean;
  verifiedAt: string;
}
```

---

## 4. Bedrock client — `server/src/shared/aws/bedrockClient.ts` (NEW)

```typescript
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import AWSXRay from "aws-xray-sdk-core";

// Plain, In-Region foundation-model id — NOT an inference-profile id.
// ap-south-1 hosts Qwen3-235B-A22B-2507 as a Regional on-demand model
// directly, unlike the Claude model this project originally targeted (which
// needed a `global.*` inference profile from this region). See
// docs/bedrock-guide.md §2 before changing this.
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "qwen.qwen3-235b-a22b-2507-v1:0";

// Patch this specific client instance directly, rather than relying on
// xray.ts's patchAwsSdkForTracing() helper (that helper patches a throwaway
// DynamoDBClient it creates and discards — it doesn't actually instrument
// the ddb client used elsewhere in this repo; worth a fix later, out of
// scope for Day 3). Patching the real client we call is the correct pattern.
const client = new BedrockRuntimeClient({});
AWSXRay.captureAWSv3Client(client as any);

export interface ConverseTextResult {
  text: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
}

// jsonSchema, when provided, is sent as Bedrock's Structured Outputs
// constraint (Converse API's `outputConfig.textFormat`) rather than relying
// only on the system prompt asking nicely for JSON. Build the schema fresh
// per call (see diagnosis/schema.ts) so fields like citedEvidenceIds can be
// constrained to an `enum` of exactly what THIS request's evidence list
// contains.
export async function converseText(
  systemPrompt: string,
  userPrompt: string,
  jsonSchema?: Record<string, unknown>
): Promise<ConverseTextResult> {
  const response = await client.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: systemPrompt }],
      messages: [{ role: "user", content: [{ text: userPrompt }] }],
      inferenceConfig: { maxTokens: 1024, temperature: 0.2 },
      ...(jsonSchema
        ? {
            // NOTE: `outputConfig` is a newer field on ConverseCommand than
            // some pinned `@aws-sdk/client-bedrock-runtime` versions type —
            // check `tsc` before assuming the `as any` below is needed, and
            // remove it once your installed version has real types for this.
            // See docs/bedrock-guide.md §3 for how to confirm it's actually
            // being enforced rather than silently dropped.
            outputConfig: {
              textFormat: {
                type: "json_schema",
                structure: { jsonSchema: { name: "diagnosis", schema: jsonSchema, strict: true } },
              },
            } as any,
          }
        : {}),
    })
  );
  // Never assume content[0] is the answer. Qwen3-235B-A22B-2507 supports an
  // optional reasoning/thinking mode (not enabled here — see
  // docs/bedrock-guide.md §2), which, if it were ever turned on, would add a
  // reasoningContent block ahead of the text block. Find the text block
  // explicitly instead.
  const content = response.output?.message?.content ?? [];
  const block = content.find((b) => b && "text" in b);
  const text = block && "text" in block ? (block.text ?? "") : "";
  return {
    text,
    stopReason: response.stopReason,
    inputTokens: response.usage?.inputTokens,
    outputTokens: response.usage?.outputTokens,
  };
}
```

---

## 5. Diagnosis feature

**`server/src/features/diagnosis/evidenceBuilder.ts`** (NEW):
```typescript
import { LocalizationCandidate } from "@shi/shared-types";

export interface Evidence {
  id: string;
  text: string;
}

// Builds a fixed, enumerable evidence list from what LocalizeRootCause + the
// original incident already know. Bedrock is REQUIRED to cite only ids from
// this list — this is what makes citation-checking possible without a real
// log/trace store to point back into (Day 3 hackathon cut, ROADMAP §2).
export function buildEvidence(alarmName: string, candidates: LocalizationCandidate[]): Evidence[] {
  const evidence: Evidence[] = [
    { id: `EVIDENCE#ALARM#${alarmName}`, text: `CloudWatch alarm '${alarmName}' entered ALARM state.` },
  ];
  for (const c of candidates) {
    evidence.push({
      id: `EVIDENCE#GRAPH#${c.service}`,
      text: `'${c.service}' is ${c.distanceFromAnomaly} call-hop(s) upstream of the alarming service in the current ServiceGraph.`,
    });
    if (c.deployVersion) {
      evidence.push({
        id: `EVIDENCE#DEPLOY#${c.service}#${c.deployVersion}`,
        text: `'${c.service}' deployed version ${c.deployVersion} at ${c.deployTimestamp}, ${c.secondsBeforeAnomaly}s before the alarm. Diff: ${c.deploySummary ?? "n/a"}.`,
      });
    }
  }
  return evidence;
}
```

**`server/src/features/diagnosis/schema.ts`** (NEW):
```typescript
import { Evidence } from "./evidenceBuilder";
import { ServiceName } from "@shi/shared-types";

// Bedrock Structured Outputs schema for the diagnosis response — built fresh
// per request so citedEvidenceIds and rootCauseService are constrained by
// `enum` to values that actually exist in THIS request's evidence list. This
// is the primary grounding mechanism now (docs/bedrock-guide.md §2);
// diagnosis/handler.ts's post-hoc id check is defense-in-depth on top of it,
// not the only check — see that doc for why both still matter.
export function buildDiagnosisSchema(evidence: Evidence[], serviceNames: ServiceName[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["rootCauseService", "confidence", "summary", "citedEvidenceIds"],
    properties: {
      rootCauseService: { type: "string", enum: serviceNames },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      summary: { type: "string" },
      citedEvidenceIds: {
        type: "array",
        items: { type: "string", enum: evidence.map((e) => e.id) },
        minItems: 1,
      },
    },
  };
}
```

**`server/src/features/diagnosis/prompt.ts`** (NEW):
```typescript
import { Evidence } from "./evidenceBuilder";

// The JSON shape itself is now enforced by Bedrock Structured Outputs
// (schema.ts) rather than resting entirely on this instruction — but the
// prompt still does real work: it's what tells the model WHICH evidence
// items actually support a good answer, and what to do when they don't
// (drop confidence, say so) rather than just picking a schema-valid but
// unsupported answer.
export const SYSTEM_PROMPT = `You are an SRE incident-diagnosis assistant for a 3-service
system (gateway -> orders -> inventory). You will be given a numbered EVIDENCE list, each
item with a stable id. Diagnose the root cause using ONLY the evidence provided — do not
invent services, deploys, or timestamps that are not in the list.

Your response's shape is enforced separately — focus on content, not formatting:
- "rootCauseService": the service the evidence actually points to.
- "confidence": 0 to 1.
- "summary": 2-4 sentences, plain English, and every claim in it must be traceable to at
  least one id in "citedEvidenceIds".
- "citedEvidenceIds": only ids that genuinely support "summary" — citing an id just to have
  more than one doesn't help; cite what actually supports the claim.

If you cannot support a confident root-cause claim with the given evidence, set "confidence"
below 0.3 and say so in "summary" rather than fabricating support. You still must cite at
least one evidence id — pick the one your low-confidence summary is closest to, and say in
the summary why it's not enough on its own.`;

export function buildUserPrompt(evidence: Evidence[]): string {
  const list = evidence.map((e, i) => `${i + 1}. [${e.id}] ${e.text}`).join("\n");
  return `EVIDENCE:\n${list}\n\nProduce the JSON diagnosis now.`;
}
```

**`server/src/features/diagnosis/handler.ts`** (NEW — fills the Day-1 `.gitkeep`):
```typescript
import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { converseText } from "../../shared/aws/bedrockClient";
import { buildEvidence } from "./evidenceBuilder";
import { buildDiagnosisSchema } from "./schema";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt";
import { getIncident, saveDiagnosis } from "../incidents/incidentsRepository";
import { LocalizationResult, DiagnosisResult, ServiceName } from "@shi/shared-types";

patchAwsSdkForTracing();

// Defense-in-depth, not a workaround for a known bug: with Structured
// Outputs enforcing the schema (bedrockClient.ts / schema.ts), a fenced
// response shouldn't happen. Keep stripping it anyway — if outputConfig
// silently failed to apply (see docs/bedrock-guide.md §3), the model falls
// back to plain prompt-following and a fence can reappear.
function parseModelJson(raw: string): any {
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

export async function handler(input: LocalizationResult): Promise<DiagnosisResult> {
  const incident = await getIncident(input.incidentId);
  const alarmName = (incident?.alarmName as string) ?? "unknown-alarm";

  const evidence = buildEvidence(alarmName, input.rankedCandidates);
  const allowedIds = new Set(evidence.map((e) => e.id));
  const serviceNames = Array.from(new Set(input.rankedCandidates.map((c) => c.service)));

  const { text } = await converseText(
    SYSTEM_PROMPT,
    buildUserPrompt(evidence),
    buildDiagnosisSchema(evidence, serviceNames)
  );
  const parsed = parseModelJson(text);

  const rawCitations: string[] = Array.isArray(parsed.citedEvidenceIds) ? parsed.citedEvidenceIds : [];
  const validCitations = rawCitations.filter((id) => allowedIds.has(id));

  // Citation-checking gate (ROADMAP §2, non-negotiable): an ungrounded
  // diagnosis is worse than none. The schema's `enum` on citedEvidenceIds
  // (schema.ts) already makes an out-of-list id nearly impossible when
  // Structured Outputs is actually being enforced — this check is what
  // catches the case where it silently wasn't (see docs/bedrock-guide.md
  // §3). If the model cited zero ids that actually exist in the evidence we
  // gave it, fail the Lambda rather than pass junk to RequestApproval. Step
  // Functions surfaces this as a FAILED execution.
  if (validCitations.length === 0) {
    throw new Error(
      `DIAGNOSIS_NOT_GROUNDED: model returned ${rawCitations.length} citation(s), 0 matched known evidence ids`
    );
  }

  const result: DiagnosisResult = {
    incidentId: input.incidentId,
    rootCauseService: parsed.rootCauseService as ServiceName,
    summary: String(parsed.summary ?? ""),
    citedEvidenceIds: validCitations,
    confidence: Number(parsed.confidence ?? 0),
    rankedCandidates: input.rankedCandidates, // carried forward — Remediate needs the target
    generatedAt: new Date().toISOString(),
  };
  await saveDiagnosis(result);
  return result;
}
```

---

## 6. Incidents repository — extend `incidentsRepository.ts`

Add these six functions (don't touch `createIncident`/`saveLocalizationResult`/`getIncident`).
Each `save*` bumps `Incidents`' `META` item status, same pattern `saveLocalizationResult`
already uses:

```typescript
import { DiagnosisResult, RemediationResult, VerificationResult } from "@shi/shared-types";

export async function saveDiagnosis(diagnosis: DiagnosisResult): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: env.incidentsTable,
    Item: { PK: `INCIDENT#${diagnosis.incidentId}`, SK: "DIAGNOSIS", ...diagnosis },
  }));
  await ddb.send(new UpdateCommand({
    TableName: env.incidentsTable,
    Key: { PK: `INCIDENT#${diagnosis.incidentId}`, SK: "META" },
    UpdateExpression: "SET #status = :status",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":status": "diagnosed" },
  }));
}

export async function saveApproval(record: {
  incidentId: string;
  taskToken: string;
  status: "pending";
  diagnosis: DiagnosisResult;
}): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: env.incidentsTable,
    Item: { PK: `INCIDENT#${record.incidentId}`, SK: "APPROVAL", ...record },
  }));
}

export async function getApproval(incidentId: string): Promise<Record<string, unknown> | undefined> {
  const res = await ddb.send(new GetCommand({
    TableName: env.incidentsTable,
    Key: { PK: `INCIDENT#${incidentId}`, SK: "APPROVAL" },
  }));
  return res.Item;
}

export async function markApprovalDecided(incidentId: string, status: "approved" | "denied"): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: env.incidentsTable,
    Key: { PK: `INCIDENT#${incidentId}`, SK: "APPROVAL" },
    UpdateExpression: "SET #status = :status, decidedAt = :decidedAt",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":status": status, ":decidedAt": new Date().toISOString() },
  }));
}

export async function saveRemediation(result: RemediationResult): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: env.incidentsTable,
    Item: { PK: `INCIDENT#${result.incidentId}`, SK: "REMEDIATION", ...result },
  }));
  await ddb.send(new UpdateCommand({
    TableName: env.incidentsTable,
    Key: { PK: `INCIDENT#${result.incidentId}`, SK: "META" },
    UpdateExpression: "SET #status = :status",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":status": "remediated" },
  }));
}

export async function saveVerification(result: VerificationResult): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: env.incidentsTable,
    Item: { PK: `INCIDENT#${result.incidentId}`, SK: "VERIFICATION", ...result },
  }));
  await ddb.send(new UpdateCommand({
    TableName: env.incidentsTable,
    Key: { PK: `INCIDENT#${result.incidentId}`, SK: "META" },
    UpdateExpression: "SET #status = :status",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":status": "closed" },
  }));
}
```

---

## 7. Approval feature

**`server/src/features/approval/requestApprovalHandler.ts`** (NEW — Step Functions task #5,
the side that dispatches and returns immediately; it does NOT call back into Step Functions
itself):
```typescript
import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { saveApproval } from "../incidents/incidentsRepository";
import { DiagnosisResult } from "@shi/shared-types";
import { env } from "../../config/env";

patchAwsSdkForTracing();

interface RequestApprovalEvent {
  taskToken: string;
  diagnosis: DiagnosisResult;
}

export async function handler(event: RequestApprovalEvent): Promise<{ dispatched: true }> {
  const { taskToken, diagnosis } = event;
  await saveApproval({ incidentId: diagnosis.incidentId, taskToken, status: "pending", diagnosis });

  const base = env.approveFunctionUrl.replace(/\/$/, "");
  const approveLink = `${base}?incidentId=${diagnosis.incidentId}&token=${encodeURIComponent(taskToken)}&action=approve`;
  const denyLink = `${base}?incidentId=${diagnosis.incidentId}&token=${encodeURIComponent(taskToken)}&action=deny`;

  // Hackathon approval channel (ROADMAP §2: "a printed/emailed link"). This
  // just logs to CloudWatch — tail the RequestApprovalFunction log group
  // during the demo. SES is explicitly cut; see §15. NOTE the tradeoff: the
  // task token is effectively a bearer credential for resuming this one
  // execution, sitting in plaintext in CloudWatch Logs — fine for
  // demonstrating the approval-gate PATTERN, not something to ship as-is.
  console.log(JSON.stringify({
    message: "INCIDENT_APPROVAL_REQUIRED",
    incidentId: diagnosis.incidentId,
    rootCauseService: diagnosis.rootCauseService,
    summary: diagnosis.summary,
    confidence: diagnosis.confidence,
    approveLink,
    denyLink,
  }));

  return { dispatched: true };
}
```

**`server/src/features/approval/approveHandler.ts`** (NEW — standalone Function URL, GET
request from the link above; this is a separate Lambda, not a Step Functions task):
```typescript
import { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } from "@aws-sdk/client-sfn";
import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { getApproval, markApprovalDecided } from "../incidents/incidentsRepository";

patchAwsSdkForTracing();
const sfn = new SFNClient({});

export async function handler(event: APIGatewayProxyEventV2, _context: Context) {
  const qs = event.queryStringParameters ?? {};
  const { incidentId, token, action } = qs;
  if (!incidentId || !token || !action) {
    return { statusCode: 400, body: "Missing incidentId, token or action" };
  }

  const approval = await getApproval(incidentId);
  // Idempotency: Step Functions itself rejects a second SendTaskSuccess/
  // Failure for the same token, but checking first gives a friendlier
  // response than a raw AWS error on a double-click or a two-tab open.
  if (approval?.status && approval.status !== "pending") {
    return { statusCode: 200, headers: { "Content-Type": "text/html" }, body: `<p>This incident was already ${approval.status}.</p>` };
  }

  const diagnosis = approval?.diagnosis as { rootCauseService?: string; rankedCandidates?: unknown } | undefined;

  if (action === "approve") {
    await sfn.send(new SendTaskSuccessCommand({
      taskToken: token,
      output: JSON.stringify({
        incidentId,
        approved: true,
        rootCauseService: diagnosis?.rootCauseService,
        rankedCandidates: diagnosis?.rankedCandidates,
        decidedAt: new Date().toISOString(),
      }),
    }));
    await markApprovalDecided(incidentId, "approved");
    return { statusCode: 200, headers: { "Content-Type": "text/html" }, body: "<h1>Approved</h1><p>Remediation is proceeding.</p>" };
  }

  // NOTE: without a Catch on the RequestApproval state, SendTaskFailure ends
  // the WHOLE execution as FAILED (not a graceful "closed, no action"). For
  // a hackathon demo this is fine — a denied incident is visibly distinct
  // from a successful one in the Step Functions console. A nicer UX (Catch
  // → an UpdateIncidentStatus state) is an explicit Day-4-or-later cut, §15.
  await sfn.send(new SendTaskFailureCommand({ taskToken: token, error: "ApprovalDenied", cause: "Human denied remediation" }));
  await markApprovalDecided(incidentId, "denied");
  return { statusCode: 200, headers: { "Content-Type": "text/html" }, body: "<h1>Denied</h1><p>No remediation action was taken.</p>" };
}
```

---

## 8. Remediation — `server/src/features/remediation/handler.ts` (NEW, fills the `.gitkeep`)

```typescript
import { LambdaClient, ListVersionsByFunctionCommand, UpdateAliasCommand, GetAliasCommand } from "@aws-sdk/client-lambda";
import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { saveRemediation } from "../incidents/incidentsRepository";
import { env } from "../../config/env";
import { ApprovalOutcome, RemediationResult, ServiceName } from "@shi/shared-types";

patchAwsSdkForTracing();
const lambdaClient = new LambdaClient({});

// Day 3 hackathon scope (ROADMAP §2/§4): only `inventory` has a real,
// low-risk rollback target — "one clean fault-to-fix loop", not a generic
// multi-service remediator. Extend this map later if needed.
const REMEDIABLE_FUNCTIONS: Partial<Record<ServiceName, { functionName: string; aliasName: string }>> = {
  inventory: { functionName: env.inventoryFunctionName, aliasName: env.inventoryAliasName },
};

export async function handler(input: ApprovalOutcome): Promise<RemediationResult> {
  if (!input.approved) {
    throw new Error(`REMEDIATION_NOT_APPROVED: incident ${input.incidentId}`);
  }
  const target = REMEDIABLE_FUNCTIONS[input.rootCauseService];
  if (!target) {
    throw new Error(`NO_REMEDIATION_TARGET: no rollback configured for service '${input.rootCauseService}'`);
  }

  const alias = await lambdaClient.send(new GetAliasCommand({ FunctionName: target.functionName, Name: target.aliasName }));
  const currentVersion = alias.FunctionVersion!;

  const versions = await lambdaClient.send(new ListVersionsByFunctionCommand({ FunctionName: target.functionName }));
  // Published versions only, sorted ascending numerically. $LATEST is never
  // a rollback target — its code can change without a version bump.
  const published = (versions.Versions ?? [])
    .map((v) => v.Version!)
    .filter((v) => v !== "$LATEST")
    .sort((a, b) => Number(a) - Number(b));

  const currentIndex = published.indexOf(currentVersion);
  const previousVersion = currentIndex > 0 ? published[currentIndex - 1] : null;
  if (!previousVersion) {
    throw new Error(
      `NO_PREVIOUS_VERSION: ${target.functionName} alias '${target.aliasName}' is already at ` +
      `its oldest published version (${currentVersion}) — nothing to roll back to. Either the ` +
      `fault was introduced in the FIRST published deploy, or you haven't published a second ` +
      `one yet — see plan3.md §14's test setup.`
    );
  }

  await lambdaClient.send(new UpdateAliasCommand({
    FunctionName: target.functionName,
    Name: target.aliasName,
    FunctionVersion: previousVersion,
  }));

  const result: RemediationResult = {
    incidentId: input.incidentId,
    service: input.rootCauseService,
    action: "lambda-alias-rollback",
    revertedFromVersion: currentVersion,
    revertedToVersion: previousVersion,
    remediatedAt: new Date().toISOString(),
  };
  await saveRemediation(result);
  return result;
}
```

**Why this is a *real* fix, not just a demo prop:** a Lambda version snapshots both code AND
configuration (including environment variables) at publish time. If version N was published
with `INJECT_FAULT=false` and version N+1 with `INJECT_FAULT=true`, pointing the alias back at
N doesn't just "look like" a rollback — invocations through the alias actually run with
`INJECT_FAULT=false` again. The fault genuinely stops. This is why §14's test setup insists on
publishing the "good" version before the "bad" one, in that order.

---

## 9. Verification — `server/src/features/verification/handler.ts` (NEW)

```typescript
import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { saveVerification } from "../incidents/incidentsRepository";
import { RemediationResult, VerificationResult } from "@shi/shared-types";

patchAwsSdkForTracing();
const cw = new CloudWatchClient({});
const WINDOW_MINUTES = 5;

async function faultCountInWindow(startIso: string, endIso: string): Promise<number> {
  const res = await cw.send(new GetMetricDataCommand({
    StartTime: new Date(startIso),
    EndTime: new Date(endIso),
    MetricDataQueries: [{
      Id: "faults",
      MetricStat: {
        Metric: { Namespace: "SelfHealingInfra/Inventory", MetricName: "InjectedFault" },
        Period: WINDOW_MINUTES * 60,
        Stat: "Sum",
      },
      ReturnData: true,
    }],
  }));
  const values = res.MetricDataResults?.[0]?.Values ?? [];
  return values.reduce((sum, v) => sum + v, 0);
}

export async function handler(input: RemediationResult): Promise<VerificationResult> {
  const beforeStart = new Date(new Date(input.remediatedAt).getTime() - WINDOW_MINUTES * 60_000).toISOString();
  const afterEnd = new Date().toISOString(); // "now" — the preceding Wait state (step-functions.ts) already gave the metric time to settle

  const [faultCountBefore, faultCountAfter] = await Promise.all([
    faultCountInWindow(beforeStart, input.remediatedAt),
    faultCountInWindow(input.remediatedAt, afterEnd),
  ]);

  const result: VerificationResult = {
    incidentId: input.incidentId,
    service: input.service,
    faultCountBefore,
    faultCountAfter,
    recovered: faultCountAfter === 0,
    verifiedAt: new Date().toISOString(),
  };
  await saveVerification(result);
  return result;
}
```

---

## 10. `env.ts` — extend

```typescript
export const env = {
  // ...existing fields unchanged...
  bedrockModelId: process.env.BEDROCK_MODEL_ID ?? "qwen.qwen3-235b-a22b-2507-v1:0",
  approveFunctionUrl: process.env.APPROVE_FUNCTION_URL ?? "",
  inventoryFunctionName: process.env.INVENTORY_FUNCTION_NAME ?? "",
  inventoryAliasName: process.env.INVENTORY_ALIAS_NAME ?? "live",
};
```

---

## 11. Infra: Bedrock IAM — `infra/lib/bedrockAccess.ts` (NEW)

```typescript
import { IFunction } from "aws-cdk-lib/aws-lambda";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Stack } from "aws-cdk-lib";
import { Construct } from "constructs";

export const DEFAULT_BEDROCK_MODEL_ID = "qwen.qwen3-235b-a22b-2507-v1:0";

// Single-statement grant for an In-Region on-demand model. Unlike the Claude
// model this project originally targeted, Qwen3-235B-A22B-2507 is hosted
// directly in ap-south-1 (docs/bedrock-guide.md §2/§Regional availability) —
// no Global cross-Region inference profile, so none of the old 3-statement
// CRIS policy is needed. Foundation-model ARNs for Bedrock's serverless
// models don't carry an account id — they're AWS/vendor-owned resources,
// not per-account ones.
export function grantBedrockInvoke(scope: Construct, fn: IFunction, modelId = DEFAULT_BEDROCK_MODEL_ID) {
  const region = Stack.of(scope).region;
  fn.addToRolePolicy(new PolicyStatement({
    sid: "GrantQwenInRegionModelInvoke",
    actions: ["bedrock:InvokeModel"],
    resources: [`arn:aws:bedrock:${region}::foundation-model/${modelId}`],
  }));
}
```

---

## 12. Infra: `lambdas.ts` — REWRITE

Add the inventory alias/versioning (needed for §8's rollback) and five new functions. Full
file (extends the Day 2 version — keep everything already there, this is additive):

```typescript
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime, Tracing, FunctionUrlAuthType, Alias } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import { Duration } from "aws-cdk-lib";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { grantBedrockInvoke, DEFAULT_BEDROCK_MODEL_ID } from "./bedrockAccess";

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
  const xrayBundling = { nodeModules: ["aws-xray-sdk-core"] };

  const inventoryFn = new NodejsFunction(scope, "InventoryFunction", {
    entry: "../server/src/features/inventory/handler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    timeout: Duration.seconds(10),
    environment: { ...commonEnv, INJECT_FAULT: "false", FAULT_PROBABILITY: "0.3", FAULT_MODE: "error" },
    bundling: xrayBundling,
  });

  // NEW: publish a version on every deploy, and point a stable alias at it.
  // Remediate (§8) rolls this alias back to the version published just
  // before a "bad" deploy — this is the whole remediation mechanism.
  const inventoryAlias = new Alias(scope, "InventoryLiveAlias", {
    aliasName: "live",
    version: inventoryFn.currentVersion,
  });
  // CHANGED from Day 2: the Function URL now lives on the ALIAS, not the
  // function directly — orders must call through the alias so that an
  // alias rollback actually changes which code/config handles requests.
  const inventoryUrl = inventoryAlias.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });

  const ordersFn = new NodejsFunction(scope, "OrdersFunction", {
    entry: "../server/src/features/orders/handler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    timeout: Duration.seconds(10),
    environment: { ...commonEnv, INVENTORY_FUNCTION_URL: inventoryUrl.url },
    bundling: xrayBundling,
  });
  const ordersUrl = ordersFn.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });

  const gatewayFn = new NodejsFunction(scope, "GatewayFunction", {
    entry: "../server/src/features/gateway/handler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    timeout: Duration.seconds(10),
    environment: { ...commonEnv, ORDERS_FUNCTION_URL: ordersUrl.url },
    bundling: xrayBundling,
  });

  const deployEventsWebhookFn = new NodejsFunction(scope, "DeployEventsWebhookFunction", {
    entry: "../server/src/features/deploy-events/webhookHandler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    environment: commonEnv,
    bundling: xrayBundling,
  });

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

  // ---------------------------------------------------------------- Day 3

  const diagnoseFn = new NodejsFunction(scope, "DiagnoseWithBedrockFunction", {
    entry: "../server/src/features/diagnosis/handler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    timeout: Duration.seconds(60), // headroom for Bedrock generation; likely
                                    // more than needed for an In-Region call
                                    // (no cross-Region routing here) — leave
                                    // it until you've watched real latency
    environment: { ...commonEnv, BEDROCK_MODEL_ID: DEFAULT_BEDROCK_MODEL_ID },
    bundling: xrayBundling,
  });
  grantBedrockInvoke(scope, diagnoseFn);

  // ApproveHandler is created BEFORE RequestApprovalFunction because the
  // latter needs the former's Function URL as an env var.
  const approveHandlerFn = new NodejsFunction(scope, "ApproveHandlerFunction", {
    entry: "../server/src/features/approval/approveHandler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    environment: commonEnv,
    bundling: xrayBundling,
  });
  // Unauthenticated Function URL, same accepted tradeoff as the internal
  // orders/inventory URLs (see docs/aws-console-setup-guide.md Part 0):
  // it's a one-off clicked link, never advertised beyond the incident log.
  const approveHandlerUrl = approveHandlerFn.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });
  approveHandlerFn.addToRolePolicy(new PolicyStatement({
    actions: ["states:SendTaskSuccess", "states:SendTaskFailure"],
    resources: ["*"], // these two actions don't support resource-level scoping
  }));

  const requestApprovalFn = new NodejsFunction(scope, "RequestApprovalFunction", {
    entry: "../server/src/features/approval/requestApprovalHandler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    environment: { ...commonEnv, APPROVE_FUNCTION_URL: approveHandlerUrl.url },
    bundling: xrayBundling,
  });

  const remediateFn = new NodejsFunction(scope, "RemediateFunction", {
    entry: "../server/src/features/remediation/handler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    environment: {
      ...commonEnv,
      INVENTORY_FUNCTION_NAME: inventoryFn.functionName,
      INVENTORY_ALIAS_NAME: inventoryAlias.aliasName,
    },
    bundling: xrayBundling,
  });
  remediateFn.addToRolePolicy(new PolicyStatement({
    actions: ["lambda:GetAlias", "lambda:UpdateAlias", "lambda:ListVersionsByFunction"],
    resources: [inventoryFn.functionArn, `${inventoryFn.functionArn}:*`],
  }));

  const verifyOutcomeFn = new NodejsFunction(scope, "VerifyOutcomeFunction", {
    entry: "../server/src/features/verification/handler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    environment: commonEnv,
    bundling: xrayBundling,
  });
  verifyOutcomeFn.addToRolePolicy(new PolicyStatement({
    actions: ["cloudwatch:GetMetricData"],
    resources: ["*"], // CloudWatch metric read APIs don't support resource-level scoping
  }));

  // ---------------------------------------------------------- grants

  tables.serviceGraph.grantReadWriteData(gatewayFn);
  tables.deployEvents.grantReadWriteData(deployEventsWebhookFn);
  tables.incidents.grantReadWriteData(createIncidentFn);
  tables.incidents.grantReadWriteData(localizeFn);
  tables.serviceGraph.grantReadWriteData(buildGraphFn);
  tables.serviceGraph.grantReadData(localizeFn);
  tables.deployEvents.grantReadData(localizeFn);
  tables.incidents.grantReadWriteData(diagnoseFn);
  tables.incidents.grantReadWriteData(requestApprovalFn);
  tables.incidents.grantReadWriteData(approveHandlerFn);
  tables.incidents.grantReadWriteData(remediateFn);
  tables.incidents.grantReadWriteData(verifyOutcomeFn);

  buildGraphFn.addToRolePolicy(new PolicyStatement({
    actions: ["xray:GetTraceSummaries", "xray:BatchGetTraces"],
    resources: ["*"],
  }));

  return {
    gatewayFn, ordersFn, inventoryFn, deployEventsWebhookFn,
    createIncidentFn, buildGraphFn, localizeFn,
    diagnoseFn, requestApprovalFn, approveHandlerFn, remediateFn, verifyOutcomeFn,
    approveHandlerUrl: approveHandlerUrl.url,
  };
}
```

---

## 13. Infra: `step-functions.ts` — REWRITE

```typescript
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import {
  StateMachine, DefinitionBody, JsonPath, IntegrationPattern, TaskInput, Wait, WaitTime,
} from "aws-cdk-lib/aws-stepfunctions";
import { LambdaInvoke } from "aws-cdk-lib/aws-stepfunctions-tasks";
import { IFunction } from "aws-cdk-lib/aws-lambda";

interface IncidentResponseProps {
  createIncidentFn: IFunction;
  buildGraphFn: IFunction;
  localizeFn: IFunction;
  diagnoseFn: IFunction;
  requestApprovalFn: IFunction;
  remediateFn: IFunction;
  verifyOutcomeFn: IFunction;
}

export function createIncidentResponseStateMachine(scope: Construct, fns: IncidentResponseProps) {
  const createIncident = new LambdaInvoke(scope, "CreateIncident", { lambdaFunction: fns.createIncidentFn, payloadResponseOnly: true });
  const buildGraph = new LambdaInvoke(scope, "BuildGraph", { lambdaFunction: fns.buildGraphFn, payloadResponseOnly: true });
  const localize = new LambdaInvoke(scope, "LocalizeRootCause", { lambdaFunction: fns.localizeFn, payloadResponseOnly: true });

  const diagnose = new LambdaInvoke(scope, "DiagnoseWithBedrock", {
    lambdaFunction: fns.diagnoseFn,
    payloadResponseOnly: true,
    // Bedrock generation can take a few seconds; the Lambda's own 60s
    // timeout (lambdas.ts) is the real ceiling — this just needs to not be
    // shorter than that.
  });

  const requestApproval = new LambdaInvoke(scope, "RequestApproval", {
    lambdaFunction: fns.requestApprovalFn,
    integrationPattern: IntegrationPattern.WAIT_FOR_TASK_TOKEN,
    payload: TaskInput.fromObject({
      taskToken: JsonPath.taskToken,
      diagnosis: JsonPath.entirePayload,
    }),
    // How long the execution waits for a human to click approve/deny before
    // the whole thing FAILS as timed out. 30 min is generous for a live
    // demo where you click it within seconds — tune down before recording
    // so a forgotten click doesn't leave an execution hanging.
    taskTimeout: { seconds: Duration.minutes(30).toSeconds() } as any,
  });
  // VERIFY THIS in the Step Functions console after your first real run:
  // `payloadResponseOnly` governs a normal request/response LambdaInvoke's
  // output shape and is irrelevant here — the STATE's actual output is
  // whatever `output` ApproveHandler passes to SendTaskSuccess (see
  // approveHandler.ts, which sends a plain ApprovalOutcome object). If
  // Remediate's input arrives wrapped differently than plan3.md §3 assumes,
  // adjust remediation/handler.ts's input parsing to match what you
  // actually observe — this is the one integration point in this whole plan
  // that hasn't been run yet, flagged so you don't waste time assuming the
  // doc is definitely right here.

  const remediate = new LambdaInvoke(scope, "Remediate", { lambdaFunction: fns.remediateFn, payloadResponseOnly: true });
  const settle = new Wait(scope, "WaitForMetricsToSettle", { time: WaitTime.duration(Duration.seconds(60)) });
  const verify = new LambdaInvoke(scope, "VerifyOutcome", { lambdaFunction: fns.verifyOutcomeFn, payloadResponseOnly: true });

  const definition = createIncident
    .next(buildGraph)
    .next(localize)
    .next(diagnose)
    .next(requestApproval)
    .next(remediate)
    .next(settle)
    .next(verify);

  return new StateMachine(scope, "IncidentResponseStateMachine", {
    stateMachineName: "IncidentResponseDay3",
    definitionBody: DefinitionBody.fromChainable(definition),
    timeout: Duration.minutes(40), // was 5 in Day 2 — the approval wait alone can eat 30
  });
}
```
> If your installed `aws-cdk-lib` version rejects the `taskTimeout` cast above (the exact prop
> name/shape for a task-token timeout has shifted across CDK versions), use whichever of
> `timeout: Duration.minutes(30)` or a `taskTimeout: Timeout.duration(...)` your version's
> `LambdaInvoke` type actually accepts — check the type definitions (`tsc` will tell you) rather
> than guessing; both exist in different CDK releases for this exact purpose.

---

## 14. Infra: `self-healing-infra-stack.ts` — extend

```typescript
import { Stack, StackProps, CfnOutput } from "aws-cdk-lib";
import { Construct } from "constructs";
import { createTables } from "./tables";
import { createLambdas } from "./lambdas";
import { createApi } from "./api-gateway";
import { createIncidentResponseStateMachine } from "./step-functions";
import { createInventoryAlarmAndRule } from "./alarms";

export class SelfHealingInfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const tables = createTables(this);
    const lambdas = createLambdas(this, tables);
    createApi(this, lambdas.gatewayFn);

    const stateMachine = createIncidentResponseStateMachine(this, {
      createIncidentFn: lambdas.createIncidentFn,
      buildGraphFn: lambdas.buildGraphFn,
      localizeFn: lambdas.localizeFn,
      diagnoseFn: lambdas.diagnoseFn,
      requestApprovalFn: lambdas.requestApprovalFn,
      remediateFn: lambdas.remediateFn,
      verifyOutcomeFn: lambdas.verifyOutcomeFn,
    });
    createInventoryAlarmAndRule(this, lambdas.inventoryFn, stateMachine);

    new CfnOutput(this, "ApproveFunctionUrl", { value: lambdas.approveHandlerUrl });
  }
}
```

`cdk deploy` prints `ApproveFunctionUrl` in its Outputs — you don't need to hunt for it in the
Lambda console (though you can; see `docs/bedrock-guide.md` §4).

---

## 15. Day 3 checklist (execute top to bottom)

- [ ] §0: confirm Bedrock model access for Qwen3-235B-A22B-2507, decide on log-only approval channel
- [ ] Extend shared types (§3)
- [ ] `npm install @aws-sdk/client-bedrock-runtime @aws-sdk/client-sfn @aws-sdk/client-lambda @aws-sdk/client-cloudwatch` in `server/`
- [ ] Implement `bedrockClient.ts` (§4)
- [ ] Implement `diagnosis/evidenceBuilder.ts`, `prompt.ts`, `handler.ts` (§5)
- [ ] Extend `incidentsRepository.ts` with the six new functions (§6)
- [ ] Implement `approval/requestApprovalHandler.ts` and `approveHandler.ts` (§7)
- [ ] Implement `remediation/handler.ts` (§8)
- [ ] Implement `verification/handler.ts` (§9)
- [ ] Extend `env.ts` (§10)
- [ ] Implement `bedrockAccess.ts` — single in-region grant, no CRIS (§11)
- [ ] Rewrite `lambdas.ts` — inventory alias/versioning, 5 new functions, all grants (§12)
- [ ] Rewrite `step-functions.ts` — Day 3 states appended (§13)
- [ ] Extend `self-healing-infra-stack.ts` + `CfnOutput` (§14)
- [ ] `cdk deploy`
- [ ] **Test setup — publish the "good" version, then the "bad" one, in this order:**
  1. Confirm `InventoryFunction`'s env still has `INJECT_FAULT=false` (it does, from `lambdas.ts`)
     and `cdk deploy` has run at least once since the alias was introduced — this publishes
     version N as the current "good" one, with `live` pointing at it.
  2. Change `INJECT_FAULT` to `"true"` in `lambdas.ts` and `cdk deploy` again — this publishes
     version N+1 as the "bad" one; because CDK's `inventoryAlias` is wired to
     `inventoryFn.currentVersion`, the alias moves to N+1 automatically on this deploy.
  3. Hit the `/orders` endpoint repeatedly until `InventoryErrorAlarm` trips.
- [ ] Confirm in the console: alarm → EventBridge → `IncidentResponseDay3` execution starts
- [ ] Confirm the execution reaches `RequestApproval` and PAUSES (status: `RUNNING`, current
      state `RequestApproval`) — check `RequestApprovalFunction`'s CloudWatch Logs for the
      `INCIDENT_APPROVAL_REQUIRED` line with `approveLink`/`denyLink`
- [ ] Open the `approveLink` in a browser — confirm it returns "Approved" HTML
- [ ] Confirm the execution resumes and reaches `SUCCEEDED` through `Remediate → WaitForMetricsToSettle → VerifyOutcome`
- [ ] Confirm in DynamoDB `Incidents` table: rows for `META` (status=`closed`), `LOCALIZATION`,
      `DIAGNOSIS`, `APPROVAL` (status=`approved`), `REMEDIATION`, `VERIFICATION`
- [ ] Confirm in Lambda console: `InventoryFunction` → **Aliases** → `live` now points back at
      version N (not N+1)
- [ ] Set `INJECT_FAULT` back to `"true"` only when you're ready to re-run the demo — re-arming
      requires publishing a NEW bad version after whatever the alias currently points to, same
      two-step pattern as above
- [ ] Commit with a message stating what got proven — e.g. `Day 3: Bedrock diagnosis with
      citation-checking → human approval gate → Lambda alias rollback → verified recovery,
      confirmed end-to-end`

**Definition of done (matches `ROADMAP.md`'s Day 3 demo checkpoint):** inject fault → alarm
fires → graph builds → localization ranks correctly → Bedrock diagnosis with citations →
approval link → click approve → remediation fires → metrics recover → incident closes.

---

## 16. Guardrails — do not build yet

Explicitly out of scope for Day 3, even if it looks like "just one more thing":
- SES/email for the approval link — log-only, per §0
- A graceful "denied → closed without action" path (Catch on `RequestApproval`) — denial
  currently just fails the execution, which is an acceptable, visibly-distinct outcome for the
  demo
- A second fault type, a fourth service, or remediation targets beyond `inventory`
- The static page / terminal-output polish, the demo video, and the AWS Builder Center blog
  post — all Day 4
- Fixing `xray.ts`'s throwaway-client tracing gap (noted in §4) — real, but pre-existing and
  out of scope for closing the loop
- Retrying/backoff tuning on the Bedrock call beyond the AWS SDK v3 client's own defaults —
  only revisit if you actually see `ThrottlingException` during rehearsal
