# plan6.md — Packaging as an installable SDK (`npm i @shi/...`), 2 days out

## 0. Read this before writing any code — priority order for your remaining 2 days

You now have three plans in flight (`plan4.md` submission, `plan5.md` public live app,
`plan6.md` — this one). With 2 days left, do them in **this** order and cut from the bottom if
you run short, not the top:

1. **`plan4.md`** — the recorded video + blog post. This is the actual submission. Non-negotiable.
2. **This doc, §1–§5, MVP scope only** — a real, installable, publicly npm-published package,
   even if it only supports exactly one protected function. This is the higher-leverage move
   for judging and for your resume than `plan5.md`: "here's a video of it working" is good,
   "here's a video of it working, AND `npm i @shi/cdk-self-healing` installs it into *your* AWS
   account" is a different category of submission. It's also genuinely reusable across your
   other portfolio projects afterward.
3. **`plan5.md`** — the public Next.js demo app. Cut this first if the 2 days get tight. A
   packaged SDK with a README example is a stronger artifact than a live demo button, and it's
   less work.

Don't try to do all three fully. Say so explicitly in the submission if you only finish 1 and 2.

---

## 1. What's realistically buildable in 2 days, and what to explicitly call "future work"

Be honest about this distinction in the video/blog rather than overselling it, because a judge
who clicks through and it doesn't match the claim costs you more than a clearly-scoped v0.1:

**Buildable now — "point this at a Lambda function you're already deploying with CDK":**
a CDK construct library that a developer with their own CDK app adds as a dependency,
instantiates against one or more of their own Lambda functions, and `cdk deploy`s — which
provisions the graph tables, the localization/diagnosis/approval/remediation/verification
Lambdas, the Step Functions state machine, the CloudWatch alarms, and wires them to the
caller's function automatically, in the caller's own AWS account. This is exactly what your
existing `infra/lib/*.ts` already does, generalized from "hardcoded to `InventoryFunction`" to
"parameterized over whatever function the consumer passes in." That's a refactor, not new
invention — very achievable in the time you have.

**NOT buildable in 2 days, say so as roadmap instead:** true zero-config "npm install and it
just works on any app, any language, any host" — that's the Datadog-agent/Sentry-SDK level of
product (auto-instrumentation across runtimes, multi-cloud, a hosted control plane). Claiming
that now and shipping the CDK-construct version is a gap a technical judge will notice. Claiming
"v0.1: works with any AWS Lambda function behind a CDK-managed alias; broader runtime/language
support is the obvious next step" is accurate, still impressive, and costs you nothing.

---

## 2. Two packages, not one

- **`@shi/cdk-self-healing`** — the infra construct. Consumer's own CDK app depends on it,
  imports one class, deploys it into their own account. This is the "goldmine" part — it does
  the AWS-console auto-configuration you're describing, because CDK constructs are *precisely*
  "reusable code that provisions real AWS resources when someone else deploys it."
- **`@shi/agent`** — a thin, optional runtime helper. Consumer's Lambda handler (or Next.js API
  route) imports it to (a) get X-Ray tracing patched automatically and (b) report deploy events
  to the construct's ingest endpoint, which is what lets causal localization work across their
  services. Genuinely optional — the construct works without it, just with less rich graph data.

Both live under `packages/` in the existing workspace (you already have the convention —
`packages/shared-types` is `@shi/shared-types`). Confirm the `shi` npm org name is actually free
before you build around it:

```bash
npm org ls shi 2>&1 | head -5   # or just try `npm access ls-packages` after logging in,
                                  # or visit https://www.npmjs.com/org/shi
npm login                        # if you don't already have an npm account, create one now —
                                  # this is a same-day, zero-cost step, do it first
```

If `shi` is taken, pick a fallback (`@self-healing-infra/*`, `@samanp/*`) and use it consistently
— don't discover the name collision after you've written docs referencing the wrong one.

---

## 3. Refactoring `infra/lib` into a construct (`packages/cdk-self-healing/`)

### 3.1 The core generalization: parameterize what's hardcoded today

Today, `remediateFn` and `armDemoFn` (per `plan5.md`) are wired to one specific function via
`INVENTORY_FUNCTION_NAME`/`INVENTORY_ALIAS_NAME`. For v0.1, keep the "one protected function"
scope (don't try to support N functions with a mapping table in 2 days — that's real
multi-tenancy complexity), but make that one function a **prop**, not a hardcoded entry point.

```typescript
// packages/cdk-self-healing/src/self-healing-infra.ts (NEW)
import { Construct } from "constructs";
import { IFunction, Alias } from "aws-cdk-lib/aws-lambda";
import { Table } from "aws-cdk-lib/aws-dynamodb";
// ... plus the existing createLambdas/createApi/createStateMachine helpers, moved here
// verbatim from infra/lib, with the hardcoded pieces replaced per the diff below

export interface SelfHealingInfraProps {
  /** The function to protect. Must already be fronted by an Alias — this construct
   *  performs remediation by moving that alias between Lambda versions, it does not
   *  create the alias for you (yet — see plan6.md §7 roadmap). */
  protectedAlias: Alias;
  /** Gemini API key for the diagnosis step. Consider AWS Secrets Manager / SSM
   *  SecureString instead of a plain prop in a real v0.2 — plain prop is the fastest
   *  path to a working v0.1. */
  geminiApiKey: string;
  geminiModelId?: string;
  /** CloudWatch alarm this construct should react to. If omitted, the construct
   *  creates a default error-rate alarm on protectedAlias's underlying function. */
  alarm?: { metricNamespace: string; metricName: string; threshold: number };
}

export class SelfHealingInfra extends Construct {
  public readonly deployWebhookUrl: string; // consumer's CI posts deploy events here
  public readonly incidentsApiUrl: string;  // for their own dashboard/agent to read incidents

  constructor(scope: Construct, id: string, props: SelfHealingInfraProps) {
    super(scope, id);
    // 1. create the three DynamoDB tables (verbatim from infra/lib/tables.ts)
    // 2. create localize/diagnose/approve/remediate/verify Lambdas (verbatim from
    //    infra/lib/lambdas.ts), but remediateFn's IAM grant + env vars now point at
    //    props.protectedAlias.functionArn / props.protectedAlias.aliasName instead of
    //    the hardcoded inventoryFn/inventoryAlias
    // 3. create the alarm from props.alarm, or a sensible default if omitted
    // 4. create the Step Functions state machine (verbatim from infra/lib/state-machine.ts)
    // 5. expose deployWebhookUrl and incidentsApiUrl as public readonly outputs
  }
}
```

This is mechanical work — move files, change three or four hardcoded references to
`props.protectedAlias`, and expose outputs — not a rewrite. Budget it as "an afternoon," not "a
day," if you're honest with yourself about how much of `infra/lib` is already correct as-is.

### 3.2 What the consumer's own CDK app looks like

This is the artifact that actually sells the "goldmine" pitch — put this verbatim in the
package's README:

```typescript
// someone else's infra/lib/my-stack.ts
import { SelfHealingInfra } from "@shi/cdk-self-healing";

// ... their existing stack, already deploying their own Lambda + Alias ...
const myAlias = new Alias(this, "MyServiceLive", { aliasName: "live", version: myFn.currentVersion });

new SelfHealingInfra(this, "Healing", {
  protectedAlias: myAlias,
  geminiApiKey: process.env.GEMINI_API_KEY!,
});
```

```bash
npm i @shi/cdk-self-healing
cdk deploy
```

That `cdk deploy` is the entire "automatically configured in their AWS console" step — CDK
creates every table, Lambda, alarm, and state machine in **their** account, because that's what
CDK constructs are for. There's no separate "auto-config" mechanism to build; the mechanism is
CDK itself, which you already know how to use.

### 3.3 Packaging (`packages/cdk-self-healing/package.json`)

```json
{
  "name": "@shi/cdk-self-healing",
  "version": "0.1.0",
  "description": "Drop-in causal-RCA self-healing infra for any CDK-managed Lambda function.",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": { "build": "tsc -p tsconfig.build.json", "prepublishOnly": "npm run build" },
  "peerDependencies": { "aws-cdk-lib": "^2.269.0", "constructs": "^10.5.0" },
  "devDependencies": { "aws-cdk-lib": "^2.269.0", "constructs": "^10.5.0", "typescript": "^5" },
  "license": "MIT",
  "publishConfig": { "access": "public" }
}
```

Two things that differ from `packages/shared-types`'s current setup, both required for a public
npm package (internal workspace packages can get away without them, published ones can't):
`aws-cdk-lib`/`constructs` as **peerDependencies** (so the consumer's own CDK version is used,
not a bundled copy — mismatched CDK versions in the same app cause hard-to-debug errors), and an
actual `tsc` build step producing `dist/*.js` + `.d.ts` (a consumer can't `import` from raw
`.ts` the way your internal workspaces do via `main: src/index.ts`).

```bash
cd packages/cdk-self-healing
npm run build
npm publish   # after `npm login`; publishConfig.access=public makes a scoped package free
```

---

## 4. The optional runtime agent (`packages/agent/`)

Minimal v0.1 — a couple of exported functions, not a full auto-instrumentation library:

```typescript
// packages/agent/src/index.ts (NEW)
import { captureAWSv3Client } from "aws-xray-sdk-core"; // same tracing patch your handlers already use

export function patchTracing<T>(client: T): T {
  return captureAWSv3Client(client as any);
}

/** Call this once per deploy (e.g. from a CI step, or on cold start with a version guard)
 *  so causal localization has deploy-event data to correlate against. */
export async function recordDeploy(webhookUrl: string, event: { service: string; version: string; deployedAt?: string }) {
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...event, deployedAt: event.deployedAt ?? new Date().toISOString() }),
  });
}
```

Consumer usage:

```typescript
// their CI pipeline, right after `cdk deploy`
import { recordDeploy } from "@shi/agent";
await recordDeploy(process.env.HEALING_DEPLOY_WEBHOOK_URL!, { service: "my-service", version: process.env.GIT_SHA! });
```

`HEALING_DEPLOY_WEBHOOK_URL` is the `deployWebhookUrl` output from §3.1's construct — surface it
in the README as a CDK stack output (`new CfnOutput(this, "DeployWebhookUrl", { value:
healing.deployWebhookUrl })`) so consumers can wire their CI to it without reading source.

Package it the same way as §3.3 (own `package.json`, `dist` build, `npm publish`), no
peerDependencies needed here since it has no CDK dependency.

---

## 5. Validation before you claim this works — do this on a throwaway AWS account/sandbox, not your own stack

Don't let "works on my machine, in my one stack, that I've been testing all week" be the only
evidence behind a public "install this into your account" claim.

```bash
mkdir /tmp/shi-smoke-test && cd /tmp/shi-smoke-test
npx cdk init app --language typescript
npm i @shi/cdk-self-healing
# write a 5-line stack: one toy Lambda + Alias, then `new SelfHealingInfra(...)`
npx cdk deploy
```

- [ ] Deploy succeeds cleanly in a **different** AWS account (or at minimum a separate CDK app
      in the same account) with zero manual console clicks
- [ ] The construct's tables/alarms/state machine appear exactly as expected
- [ ] Manually invoking the toy Lambda with a forced error trips the alarm, runs the loop, and
      the toy function's alias rolls back — the same loop as `TEST_DAY3_2.md`, now proven
      portable
- [ ] `npm i @shi/agent`, call `recordDeploy()` once, confirm it lands in the deploy-events table

If you only get through a partial version of this checklist before the deadline, say precisely
which parts you validated in the submission rather than implying the whole thing is
battle-tested — "deploys cleanly into a fresh account; end-to-end loop confirmed manually,
automated smoke test still in progress" is a fine, honest thing to write.

---

## 6. Folding this into the submission without inflating `plan4.md`'s script

Add one line to the video's 2:20–2:50 "what's next" beat (already in `plan4.md` §5) and one
paragraph to the blog post's "what's next" section (§6) — don't restructure either:

> "The whole thing is also packaged as a CDK construct — `npm i @shi/cdk-self-healing`, point it
> at a Lambda you're already deploying, `cdk deploy`, and this same causal-diagnosis-plus-
> approval-gated-remediation loop runs on your infra, in your account. [repo/npm link]"

That's the whole addition. Resist rewriting the video script around this — it's a strong closing
beat, not a new topic.

---

## 7. Honest v0.2+ roadmap (write this down once, reuse it in the blog's "what's next")

- Support N protected functions per construct instance, not just one
- Multi-runtime agents (containers/ECS, not just Lambda) — the causal-localization and
  diagnosis logic doesn't actually care what compute the graph nodes run on; only the
  remediation step (`lambda:UpdateAlias`) is Lambda-specific today
- Secrets Manager / SSM for `geminiApiKey` instead of a plain construct prop
- A real automated smoke test (§5's checklist, in CI, on every package publish) instead of a
  manual one-off run
