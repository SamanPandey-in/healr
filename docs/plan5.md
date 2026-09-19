# plan5.md — Live Demo App: Next.js + AWS Amplify + builds.samanp.xyz

## 0. What this is, and what it isn't

`plan4.md` covers the **judged submission artifact**: a screen-recorded video of the tested
Day-3/4 loop, driven from your terminal. That doesn't change and doesn't depend on anything in
this doc — submit it on schedule regardless of how far you get here.

This doc covers a **separate, additive thing**: a public Next.js app at
`https://builds.samanp.xyz` that lets anyone click a button, watch a real incident happen on
your live AWS infra, watch Gemini diagnose it with citations, click Approve, and watch it heal —
self-serve, repeatable, no terminal required. This is portfolio value on top of the submission,
not a replacement for it.

**Everything below is additive.** Nothing in `server/src/features/{localization,diagnosis,
approval,remediation,verification}` or `infra/lib/state-machine.ts` changes. The tested Day-3
loop (`docs/TEST_DAY3_2.md`) stays byte-for-byte what it was. §1 explains why that's possible.

---

## 1. The one real design problem: arming the fault without a `cdk deploy`

Right now, "arm a fault" means: edit `FAULT_PROBABILITY` in `infra/lib/lambdas.ts`, run
`npx cdk deploy`, which publishes a new Lambda version and moves the `live` alias to it
(`plan4.md` §2). A public website obviously can't shell out to `cdk deploy` per visitor click.

The fix is **not** to change how fault injection or remediation work (that would mean touching
`remediation/handler.ts`'s alias-rollback logic — tested, working, in the video — right before
a deadline, which `plan4.md` §8 already tells you not to do). The fix is to replicate what
`cdk deploy` does, but via three direct SDK calls from a new Lambda instead of a full stack
redeploy:

```
UpdateFunctionConfiguration(InventoryFunction, env={INJECT_FAULT:"true", ...})
  -> poll GetFunctionConfiguration until LastUpdateStatus == "Successful"
PublishVersion(InventoryFunction)
  -> returns a new numbered version, e.g. "7"
UpdateAlias(InventoryFunction, name="live", functionVersion="7")
```

This is exactly what `cdk deploy` produced under the hood. `remediateFn` already has
`lambda:GetAlias` / `lambda:UpdateAlias` / `lambda:ListVersionsByFunction` on this exact function
(`infra/lib/lambdas.ts`) and already knows how to roll the alias back to the previous version —
it doesn't know or care whether that version was published by `cdk deploy` or by this new
Lambda. So the whole Day-3 remediation path works on the first real self-serve run, untested-ly
different only in **who** called `PublishVersion`.

---

## 2. New backend pieces (all additive)

### 2.1 `server/src/features/demo/armDemoHandler.ts` (NEW)

```typescript
import { LambdaClient, UpdateFunctionConfigurationCommand, GetFunctionConfigurationCommand,
         PublishVersionCommand, UpdateAliasCommand } from "@aws-sdk/client-lambda";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../shared/aws/ddb"; // reuse the existing shared doc client
import { ok, fail } from "../../shared/http/responses";
import { env } from "../../config/env";

const lambda = new LambdaClient({});
const LOCK_PK = "DEMO#lock";
const LOCK_TTL_SECONDS = 10 * 60; // one armed demo "owns" the infra for 10 min, generous
                                    // given the loop takes ~2-3 min end to end

async function pollUntilUpdated(functionName: string, tries = 15): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const cfg = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: functionName }));
    if (cfg.LastUpdateStatus === "Successful") return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Timed out waiting for Lambda config update to settle");
}

export async function handler() {
  // Concurrency guard: refuse a second arm while one is still in flight, so two
  // simultaneous site visitors don't stomp on each other's incident. A DynamoDB
  // conditional put with a TTL item is enough for demo-scale traffic — no need
  // for anything heavier here.
  const now = Math.floor(Date.now() / 1000);
  try {
    await ddb.send(new PutCommand({
      TableName: env.incidentsTable,
      Item: { PK: LOCK_PK, SK: "META", expiresAt: now + LOCK_TTL_SECONDS, armedAt: now },
      ConditionExpression: "attribute_not_exists(PK) OR expiresAt < :now",
      ExpressionAttributeValues: { ":now": now },
    }));
  } catch {
    return fail(409, "A demo is already running — wait a couple of minutes and try again.");
  }

  await lambda.send(new UpdateFunctionConfigurationCommand({
    FunctionName: env.inventoryFunctionName,
    Environment: { Variables: { INJECT_FAULT: "true", FAULT_PROBABILITY: "0.6", FAULT_MODE: "error",
      SERVICE_GRAPH_TABLE: env.serviceGraphTable, DEPLOY_EVENTS_TABLE: env.deployEventsTable,
      INCIDENTS_TABLE: env.incidentsTable } },
  }));
  await pollUntilUpdated(env.inventoryFunctionName);

  const published = await lambda.send(new PublishVersionCommand({ FunctionName: env.inventoryFunctionName }));
  await lambda.send(new UpdateAliasCommand({
    FunctionName: env.inventoryFunctionName,
    Name: env.inventoryAliasName,
    FunctionVersion: published.Version,
  }));

  return ok({ armed: true, version: published.Version });
}
```

Note the `SERVICE_GRAPH_TABLE`/`DEPLOY_EVENTS_TABLE`/`INCIDENTS_TABLE` re-declared inside the new
`Environment.Variables` — `UpdateFunctionConfiguration`'s `Environment` field **replaces** the
whole env var set, it doesn't merge, so this Lambda needs to know and re-send the inventory
function's existing common env vars too. Pull those three names from `env.ts` the same way the
rest of the codebase does, don't hardcode strings twice.

**New IAM grant needed** (in `lambdas.ts`, alongside the existing `remediateFn` grant on the same
function):

```typescript
armDemoFn.addToRolePolicy(new PolicyStatement({
  actions: ["lambda:UpdateFunctionConfiguration", "lambda:GetFunctionConfiguration",
            "lambda:PublishVersion", "lambda:UpdateAlias"],
  resources: [inventoryFn.functionArn, `${inventoryFn.functionArn}:*`],
}));
tables.incidents.grantReadWriteData(armDemoFn); // for the lock item
```

### 2.2 `server/src/features/incidents/getIncidentHandler.ts` (NEW — promotes `plan4.md` §4's
optional sketch to required, since the live app needs it)

The existing `getIncident()` in `incidentsRepository.ts` only reads the `META` row
(`Key: { PK, SK: "META" }`). The frontend needs the diagnosis, approval, and verification rows
too, so extend the repository rather than duplicating query logic in the handler:

```typescript
// incidentsRepository.ts — ADD, don't replace getIncident()
export async function getFullIncident(incidentId: string) {
  const res = await ddb.send(new QueryCommand({
    TableName: env.incidentsTable,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": `INCIDENT#${incidentId}` },
  }));
  const bySk = Object.fromEntries((res.Items ?? []).map((i) => [i.SK, i]));
  return bySk; // { META, DIAGNOSIS, APPROVAL, REMEDIATION, VERIFICATION } — any may be absent
               // depending on how far the incident has progressed; frontend treats each as optional
}
```

```typescript
// getIncidentHandler.ts
import { APIGatewayProxyEventV2 } from "aws-lambda";
import { getFullIncident } from "./incidentsRepository";
import { ok, fail } from "../../shared/http/responses";

export async function handler(event: APIGatewayProxyEventV2) {
  const incidentId = event.pathParameters?.id;
  if (!incidentId) return fail(400, "Missing incident id");
  const incident = await getFullIncident(incidentId);
  if (!incident.META) return fail(404, "Incident not found");
  return ok(incident);
}
```

### 2.3 `server/src/features/incidents/listIncidentsHandler.ts` (NEW)

No GSI exists for "recent incidents by time" — adding one is a real infra change for a
nice-to-have list view. At demo scale (dozens to low hundreds of items, not millions), a bounded
`Scan` filtered to `META` rows is the right-sized tool, not a premature GSI:

```typescript
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../shared/aws/ddb";
import { env } from "../../config/env";
import { ok } from "../../shared/http/responses";

export async function handler() {
  const res = await ddb.send(new ScanCommand({
    TableName: env.incidentsTable,
    FilterExpression: "SK = :sk",
    ExpressionAttributeValues: { ":sk": "META" },
    Limit: 100, // scan limit, not result limit — fine at current table size, revisit if it grows
  }));
  const items = (res.Items ?? []).sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return ok(items.slice(0, 20));
}
```

---

## 3. Infra changes

### 3.1 `infra/lib/lambdas.ts` — add three functions, following the existing pattern exactly

```typescript
const armDemoFn = new NodejsFunction(scope, "ArmDemoFunction", {
  entry: "../server/src/features/demo/armDemoHandler.ts",
  runtime: Runtime.NODEJS_20_X,
  tracing: Tracing.ACTIVE,
  timeout: Duration.seconds(30),
  environment: { ...commonEnv, INVENTORY_FUNCTION_NAME: inventoryFn.functionName,
    INVENTORY_ALIAS_NAME: inventoryAlias.aliasName },
  bundling: xrayBundling,
});
// IAM grants from §2.1 go here

const getIncidentFn = new NodejsFunction(scope, "GetIncidentFunction", {
  entry: "../server/src/features/incidents/getIncidentHandler.ts",
  runtime: Runtime.NODEJS_20_X, tracing: Tracing.ACTIVE, environment: commonEnv, bundling: xrayBundling,
});

const listIncidentsFn = new NodejsFunction(scope, "ListIncidentsFunction", {
  entry: "../server/src/features/incidents/listIncidentsHandler.ts",
  runtime: Runtime.NODEJS_20_X, tracing: Tracing.ACTIVE, environment: commonEnv, bundling: xrayBundling,
});

tables.incidents.grantReadData(getIncidentFn);
tables.incidents.grantReadData(listIncidentsFn);
```

Add all three to the function's return object at the bottom of `createLambdas()` so
`infra/bin/*.ts` (or wherever the stack wires functions to `createApi`) can reach them.

### 3.2 `infra/lib/api-gateway.ts` — add routes + turn CORS on for the whole API

The existing `/orders` resource has no CORS configured — fine when only your terminal called it,
not fine once a browser at a different origin (`builds.samanp.xyz`) calls it with `fetch()`.
Enable it once at the `RestApi` level rather than per-resource:

```typescript
import { RestApi, LambdaIntegration, Cors } from "aws-cdk-lib/aws-apigateway";
import { Construct } from "constructs";
import { IFunction } from "aws-cdk-lib/aws-lambda";

export function createApi(scope: Construct, gatewayFn: IFunction, armDemoFn: IFunction,
                           getIncidentFn: IFunction, listIncidentsFn: IFunction) {
  const api = new RestApi(scope, "PublicApi", {
    restApiName: "self-healing-infra-api",
    deployOptions: { tracingEnabled: true },
    defaultCorsPreflightOptions: {
      allowOrigins: ["https://builds.samanp.xyz", "http://localhost:3000"],
      allowMethods: Cors.ALL_METHODS,
    },
  });

  const orders = api.root.addResource("orders");
  orders.addMethod("POST", new LambdaIntegration(gatewayFn));

  const demo = api.root.addResource("demo");
  demo.addResource("arm").addMethod("POST", new LambdaIntegration(armDemoFn));

  const incidents = api.root.addResource("incidents");
  incidents.addMethod("GET", new LambdaIntegration(listIncidentsFn));
  incidents.addResource("{id}").addMethod("GET", new LambdaIntegration(getIncidentFn));

  return api;
}
```

Update the `createApi(...)` call site to pass the three new functions through.

### 3.3 Approve/Deny from the browser — no CORS change needed

`approveHandlerFn` stays on its existing Function URL. Don't add CORS there — just don't use
`fetch()` for it from the frontend. A plain navigation avoids the CORS question entirely:

```tsx
<a href={`${approveUrl}?token=...&decision=approve`} target="_blank" rel="noreferrer">
  Approve remediation
</a>
```

If you'd rather keep the user on-page, `fetch(url, { mode: "no-cors" })` also works for a
fire-and-forget GET where you don't need to read the response body — the incident detail page's
own polling (§4.4) will pick up the resulting state change a few seconds later regardless.

---

## 4. The Next.js app (`web/`)

### 4.1 Scaffold, at the repo root (sibling to `server/` and `infra/`)

```bash
npx create-next-app@latest web --typescript --tailwind --app --no-src-dir
cd web
```

### 4.2 `web/lib/api.ts` — one place for every backend call

```typescript
const API_BASE = process.env.NEXT_PUBLIC_API_BASE!; // e.g. https://xxxx.execute-api.<region>.amazonaws.com/prod

export async function armDemo() {
  const res = await fetch(`${API_BASE}/demo/arm`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ armed: boolean; version: string }>;
}

export async function triggerOrder(orderId: string) {
  return fetch(`${API_BASE}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, sku: "SKU-123", quantity: 2 }),
  });
}

export async function listIncidents() {
  const res = await fetch(`${API_BASE}/incidents`, { cache: "no-store" });
  return res.json();
}

export async function getIncident(id: string) {
  const res = await fetch(`${API_BASE}/incidents/${id}`, { cache: "no-store" });
  if (res.status === 404) return null;
  return res.json();
}
```

### 4.3 `web/app/page.tsx` — landing page: pitch + trigger + live list (sketch)

```tsx
"use client";
import { useEffect, useState } from "react";
import { armDemo, triggerOrder, listIncidents } from "@/lib/api";

export default function Home() {
  const [incidents, setIncidents] = useState<any[]>([]);
  const [status, setStatus] = useState("idle");

  useEffect(() => {
    const poll = setInterval(() => listIncidents().then(setIncidents), 4000);
    listIncidents().then(setIncidents);
    return () => clearInterval(poll);
  }, []);

  async function handleTrigger() {
    setStatus("arming");
    await armDemo();
    setStatus("firing requests");
    for (let i = 0; i < 6; i++) {
      await triggerOrder(`demo-${Date.now()}-${i}`);
      await new Promise((r) => setTimeout(r, 800));
    }
    setStatus("waiting for the alarm to trip (~60-90s)");
  }

  return (
    <main>
      {/* architecture blurb goes here — reuse plan4.md §6's pitch language */}
      <button onClick={handleTrigger} disabled={status !== "idle" && status !== "waiting for the alarm to trip (~60-90s)"}>
        Trigger a live incident
      </button>
      <p>{status}</p>
      <ul>
        {incidents.map((i) => (
          <li key={i.incidentId}><a href={`/incidents/${i.incidentId}`}>{i.incidentId} — {i.status}</a></li>
        ))}
      </ul>
    </main>
  );
}
```

Handle the 409 from `armDemo()` (another visitor's run still in flight, §2.1's lock) by showing
"a demo is already running, here's its incident page" rather than a raw error — look up the
active incident via `listIncidents()` and link to it.

### 4.4 `web/app/incidents/[id]/page.tsx` — detail page with polling (sketch)

```tsx
"use client";
import { useEffect, useState } from "react";
import { getIncident } from "@/lib/api";

export default function IncidentPage({ params }: { params: { id: string } }) {
  const [incident, setIncident] = useState<any>(null);

  useEffect(() => {
    const poll = setInterval(() => getIncident(params.id).then(setIncident), 3000);
    getIncident(params.id).then(setIncident);
    return () => clearInterval(poll);
  }, [params.id]);

  if (!incident) return <p>Loading…</p>;

  return (
    <main>
      <h1>Incident {params.id}</h1>
      <p>Status: {incident.META?.status}</p>
      {incident.DIAGNOSIS && (
        <section>
          <h2>Diagnosis (Gemini)</h2>
          <p>{incident.DIAGNOSIS.summary}</p>
          <p>Root cause: {incident.DIAGNOSIS.rootCauseService} ({incident.DIAGNOSIS.confidence})</p>
          <p>Cited evidence: {incident.DIAGNOSIS.citedEvidenceIds?.join(", ")}</p>
        </section>
      )}
      {incident.META?.status === "AWAITING_APPROVAL" && (
        <a href={incident.APPROVAL?.approveLink} target="_blank" rel="noreferrer">Approve remediation</a>
      )}
      {incident.VERIFICATION && <p>Recovered: {String(incident.VERIFICATION.recovered)}</p>}
    </main>
  );
}
```

`incident.APPROVAL?.approveLink` assumes `requestApprovalHandler.ts` already persists the
approve link onto the incident record (check — if it currently only logs it per
`scripts/record-demo.sh` §4/§3, add that one field to the `APPROVAL` `PutCommand` so the frontend
can read it back instead of needing the CloudWatch Logs line).

### 4.5 Env vars

`web/.env.local` (local dev):
```
NEXT_PUBLIC_API_BASE=https://xxxx.execute-api.ap-south-1.amazonaws.com/prod
```

Same variable gets set again in the Amplify Console (§5.3) for the deployed build — Next.js
inlines `NEXT_PUBLIC_*` vars at build time, so it must be present wherever the build runs, not
just locally.

---

## 5. Deploying to AWS Amplify Hosting, on `builds.samanp.xyz`

Amplify Hosting over Vercel/Netlify for one concrete reason beyond convenience: it's an AWS
service, and `plan4.md` §0/§7 already flagged that the Gemini swap costs you Bedrock on the
"services used" list — putting the frontend on Amplify instead of a non-AWS host is the one easy
way to add a service back rather than subtract another.

### 5.1 Repo layout

Keep `web/` as a subfolder of the existing monorepo (simplest — one repo, one source of truth).
Amplify supports monorepos via an explicit **app root directory** setting (§5.3).

### 5.2 `web/amplify.yml` (NEW — build spec)

```yaml
version: 1
applications:
  - appRoot: web
    frontend:
      phases:
        preBuild:
          commands:
            - npm ci
        build:
          commands:
            - npm run build
      artifacts:
        baseDirectory: .next
        files:
          - "**/*"
      cache:
        paths:
          - node_modules/**/*
```

### 5.3 Amplify Console steps

1. Amplify Console → **Create new app** → **Host web app** → connect GitHub → authorize → pick
   this repo and the branch you want deployed (e.g. `main`).
2. **App settings → Monorepo**: set the app root to `web` so Amplify only builds that subfolder.
3. **Environment variables**: add `NEXT_PUBLIC_API_BASE` (the deployed API Gateway invoke URL —
   get it from `cdk deploy`'s stack output or the API Gateway console, **Stages → prod → Invoke
   URL**).
4. Save and deploy. Amplify gives you a default URL like
   `https://main.<app-id>.amplifyapp.com` — confirm the whole app works there first, before
   touching DNS.

### 5.4 Custom domain: `builds.samanp.xyz`

1. In the Amplify app → **Domain management** → **Add domain** → enter `samanp.xyz` as the root,
   then map the `main` branch to the `builds` subdomain (Amplify lets you assign a branch to any
   subdomain of a domain you add — you don't need to host the whole `samanp.xyz` zone in Route 53
   for this to work).
2. Amplify shows you one or more DNS records to add — typically a validation `CNAME`/`TXT` for
   the SSL certificate, plus a `CNAME` for `builds` pointing at an Amplify-managed target. **Add
   these at wherever `samanp.xyz`'s DNS is actually managed** (Cloudflare, Namecheap, GoDaddy,
   Route 53 — whichever it is; the record values are the same regardless of provider, only the
   UI for adding them differs). If you don't remember offhand where the zone lives, `whois
   samanp.xyz` or checking the nameservers will tell you.
3. Wait for Amplify to show the domain as **Available** (SSL validated) — this can take anywhere
   from a couple of minutes to a few hours depending on DNS propagation and your provider's TTL.
   Don't block the hackathon submission on this step; it's independent of `plan4.md`.
4. Once live, `https://builds.samanp.xyz` serves the same build as the Amplify default URL, with
   Amplify's auto-provisioned ACM certificate over HTTPS.

---

## 6. End-to-end test checklist for the live app

- [ ] `POST {API_BASE}/demo/arm` from a REST client returns `{ armed: true, version: "N" }`, and
      the `InventoryFunction`'s `live` alias in the console now points at version `N`
- [ ] A second `POST /demo/arm` while the first is still active returns `409`
- [ ] Visiting `builds.samanp.xyz`, clicking **Trigger a live incident**, watching the incidents
      list pick up a new row within ~10s
- [ ] Opening that incident's detail page shows status progressing:
      `OPEN` → (localization) → `DIAGNOSED` → `AWAITING_APPROVAL` → `REMEDIATED` → `VERIFIED`
- [ ] The Gemini diagnosis text and cited evidence IDs render correctly
- [ ] Clicking **Approve remediation** moves the incident to `REMEDIATED` within the polling
      interval
- [ ] `VERIFICATION.recovered` becomes `true`, and the `InventoryFunction` `live` alias has
      rolled back to the pre-fault version — same outcome `TEST_DAY3_2.md` already verified, now
      reachable from a public URL instead of a terminal

---

## 7. Guardrails and known limitations (be upfront about these, don't silently ship around them)

- **Abuse/cost surface:** this is a public, unauthenticated button that calls
  `UpdateFunctionConfiguration`/`PublishVersion` on your infra and fires Bedrock-replacement
  (Gemini) API calls per run. The lock in §2.1 stops concurrent runs but not rapid sequential
  ones. If this stays up long-term, add an API Gateway usage plan with a low rate limit
  (`api.addUsagePlan(...)` with `throttle: { rateLimit: 1, burstLimit: 2 }` on the `/demo/arm`
  resource) rather than leaving it fully open.
- **This is genuinely new, untested surface** (`armDemoHandler.ts`, the two read handlers, CORS
  config) sitting next to genuinely tested surface (everything from `plan4.md`). Run the full
  checklist in §6 yourself before calling `builds.samanp.xyz` "live" anywhere in your submission
  or resume — don't let an untested new Lambda be the first thing a recruiter clicks.
- **Timeline:** none of this needs to land before the hackathon deadline. `plan4.md`'s recorded
  video is the submission. Treat this doc as parallel/post-submission polish work you can pick up
  once the video and blog post are actually shipped.
