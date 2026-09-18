# Bedrock in this project — what it is, how it's wired in, and what to do in the console

Companion to `plan3.md`. That doc gets Day 3's code written and deployed; this doc explains
the one piece of it that's genuinely new territory (Amazon Bedrock) and walks through the
console steps that come **after** `cdk deploy` — the parts that are console clicks, not code.

---

## 1. What Amazon Bedrock actually is

Amazon Bedrock is AWS's managed hosting layer for foundation models — Anthropic's Claude,
Meta's Llama, Amazon's own Nova models, and others — all reachable through one API, billed
through your AWS account, and governed by IAM instead of separate API keys per vendor.

For this project, the reason to go through Bedrock instead of calling a model vendor's API
directly is entirely about the hackathon's scoring rubric, not a technical limitation of either
option: the "Ship It" track requires the submission be built on an AWS service to be prize-
eligible at all, and Bedrock is explicitly on that track's tool list. A direct API call to the
model vendor would get the same output but wouldn't count toward "Built on AWS."
`ROADMAP.md` §2 spells this out as the reason for going through Bedrock at all.

**Model used in this project: Qwen3-235B-A22B-Instruct-2507** (`qwen.qwen3-235b-a22b-2507-v1:0`
on Bedrock), not Claude. This doc originally targeted a Claude model reached through a Global
cross-Region inference profile; that's no longer the case — see §2 below for why the switch
also removes a whole category of setup (no inference profile, no 3-statement IAM policy). It's
an open-weight, non-reasoning ("Instruct", not "Thinking") model that AWS added to Bedrock's
serverless model catalog, priced and licensed independently of Anthropic's models — verify
current pricing on the model's page in the Bedrock console before you rely on a number from
memory, since third-party aggregator pricing pages can lag the console.

Practically, the two integration models differ like this:

| | Direct vendor API | Amazon Bedrock |
|---|---|---|
| Auth | Vendor-specific API key | IAM role/policy (no separate key to rotate or leak) |
| Billing | Vendor invoice | Rolls into your AWS bill |
| Where it runs | Vendor's infrastructure | Vendor's model weights, served through AWS's infrastructure |
| Counts toward "Built on AWS" | No | Yes |

---

## 2. How it's wired into THIS app

There is exactly **one** call site: `DiagnoseWithBedrockFunction` (`server/src/features/
diagnosis/handler.ts`, via `server/src/shared/aws/bedrockClient.ts`). Nothing else in the
codebase talks to Bedrock.

```
LocalizeRootCause output (ranked candidates + evidence)
        │
        ▼
DiagnoseWithBedrock Lambda (ap-south-1)
        │  builds a fixed EVIDENCE list, then calls bedrock-runtime.Converse()
        │  using model id "qwen.qwen3-235b-a22b-2507-v1:0" — directly in
        │  ap-south-1, no inference profile involved (see below)
        ▼
Amazon Bedrock, In-Region (ap-south-1)
        │  request AND token generation both stay in ap-south-1 — this
        │  model is hosted there natively, unlike the Claude model this
        │  project originally targeted (see "Data residency" in §3)
        ▼
Bedrock Structured Outputs enforces a JSON Schema on the response
(outputConfig.textFormat) — citedEvidenceIds is constrained to an `enum` of
exactly the evidence ids sent in THIS request, so the model can't emit an id
that doesn't exist in the schema-valid case
        ▼
Qwen3-235B-A22B-Instruct-2507 generates a schema-conformant JSON diagnosis
        ▼
DiagnoseWithBedrock Lambda still validates every cited id actually exists in
the evidence list it sent (defense-in-depth, see below) — if none do, it
throws and fails the Lambda rather than let an ungrounded diagnosis continue
to the approval step
```

**Why a plain model id works here, and no inference profile is needed:** `ap-south-1` (Mumbai)
hosts `qwen.qwen3-235b-a22b-2507-v1:0` as a Regional, directly-invokable on-demand model — check
the Bedrock console's **Model access** page in `ap-south-1`; it should show this model as
directly requestable/invokable, not something you reach only through a `global.*` or geo
inference-profile id. (The Claude model this project originally targeted needed a Global
cross-Region inference profile from `ap-south-1` — that whole category of setup, and the
3-statement IAM policy it required, goes away with this model. If you ever add a Claude call
back in alongside this one, that older section of IAM/plumbing is what you'd need again — it
isn't reproduced here since this doc now assumes Qwen3 as the only model in the diagnosis path.)

**Model id naming, so you don't second-guess it mid-build:** AWS's Bedrock model catalog lists
this model under the display name "Qwen3-235B-A22B-Instruct-2507" — that's Qwen's non-reasoning
("Instruct") release, distinct from a separate "Thinking" variant elsewhere in Qwen's lineup.
The Bedrock model card for `qwen.qwen3-235b-a22b-2507-v1:0` also lists "Reasoning: Supported" as
a capability — that describes the model's *ability* to emit a reasoning/thinking content block
if you explicitly turn it on via a `reasoningConfig`-style field, not something enabled by
default. `bedrockClient.ts` never sets that field, so you should be invoking the plain
instruction-following behavior — but see the "leave thinking mode off" note below for why the
client code stays defensive about this anyway.

**Why the Converse API, not raw `InvokeModel`:** `Converse` gives a model-agnostic
request/response shape (`messages`, `system`, `inferenceConfig`) instead of a vendor-specific
native request body format, and returns token usage in a consistent shape. For a single-call,
single-model use case like this one either works; `Converse` is simply less code. It's also the
API surface Bedrock's Structured Outputs feature hooks into (next section) — `InvokeModel`
supports structured outputs too, but under a differently-named field (`response_format` /
`output_config.format` depending on model family), so `Converse`'s `outputConfig.textFormat`
is the more consistent one to reach for.

**Leave thinking/reasoning mode off.** Don't add a `reasoningConfig`/`thinking` field to the
`ConverseCommand` call. Turning it on would (a) add latency to every diagnosis for no benefit
here — this is a short structured-extraction task, not a task that needs visible step-by-step
reasoning, (b) reportedly need different sampling parameters (temperature/top_p) than the
non-thinking mode to perform well, which `bedrockClient.ts` doesn't currently set up, and (c)
would add a `reasoningContent` block to the response's content array ahead of the actual text
block — which is exactly why `bedrockClient.ts` searches the content array for the first block
that has a `text` field instead of assuming `content[0]` is always the answer.

**Why structured JSON + a citation-validation gate, and not a free-text diagnosis:** this is
the project's core safety stance (`ROADMAP.md`: "an ungrounded diagnosis is worse than none"),
not a Bedrock-specific requirement — but the *mechanism* is stronger now than a prompt
instruction alone. `evidenceBuilder.ts` constructs a fixed, enumerable list of evidence ids from
what `LocalizeRootCause` already computed (deploy versions/timestamps, graph distance, the
alarm that fired). `diagnosis/schema.ts` builds a JSON Schema, fresh per request, whose
`citedEvidenceIds` field is an `enum` of exactly those ids and whose `rootCauseService` field is
an `enum` of exactly the service names present in the evidence — passed to Bedrock via
`outputConfig.textFormat` (Bedrock's **Structured Outputs** feature, confirmed supported for
this model on the `bedrock-runtime` endpoint). When that constraint is actually applied,
citing an id that doesn't exist isn't just discouraged, it's outside the space of valid
responses. `diagnosis/handler.ts` *still* checks every returned citation against the list it
sent, though — that check is no longer the primary defense, it's insurance for the one failure
mode structured outputs can't cover: if `outputConfig` silently fails to apply (for example, an
older `@aws-sdk/client-bedrock-runtime` that doesn't know the field and drops it), Bedrock falls
back to plain prompt-following, and the model is free to hallucinate again. Keep the runtime
check in place for exactly that reason — a hallucinated root cause should still fail loudly (a
failed Step Functions execution) instead of silently reaching the human-approval step looking
legitimate.

---

## 3. What to take care of

- **Model access is still a separate, per-account approval step from IAM permissions**, even
  though this model needs no inference profile. Having the right IAM policy does nothing if the
  account hasn't been granted access to the model itself. Check **Bedrock console → Model
  access** in `ap-south-1` and confirm `Qwen3-235B-A22B-2507` (or whatever display name the
  console currently uses — AWS names its Qwen catalog entries slightly differently across
  console surfaces) shows **Access granted**, not "Available to request." For a third-party
  open-weight serverless model like this one, the access step is typically a click-through
  license (EULA) acceptance rather than Anthropic's more detailed use-case-description form,
  and tends to resolve faster — but "typically" isn't "always"; verify it's actually granted in
  the console before Day 3 rather than assuming it went through instantly.

- **The IAM policy is one statement, not three — because there's no cross-Region routing to
  authorize.** `infra/lib/bedrockAccess.ts` (`plan3.md` §11) now grants `bedrock:InvokeModel` on
  a single Regional foundation-model ARN (`arn:aws:bedrock:ap-south-1::foundation-model/qwen...`
  — no account id in that ARN; Bedrock's serverless foundation models are AWS/vendor-owned
  resources, not per-account ones). If you get an `AccessDeniedException` here, it's almost
  always the model-access grant above, not a missing IAM statement — there's no 3-part CRIS
  policy left to have gotten partially wrong.

- **Quotas are the regular per-Region Bedrock quotas — no separate "Global" quota to hunt for.**
  If you're rehearsing repeatedly and hit `ThrottlingException`, check **Service Quotas console
  → Amazon Bedrock** in `ap-south-1` and look for this model's on-demand requests-per-minute /
  tokens-per-minute quota directly; you don't need the "Global Cross-region model inference"
  quota category this project's Claude version needed.

- **Don't carry over Claude's token-accounting multiplier assumption.** The "5 output tokens of
  quota per actual output token" burndown some Claude models use on Bedrock is specific to those
  models' published quota tables — it isn't a general Bedrock behavior. Check this model's own
  entry on the Service Quotas page if you want to estimate what a demo rehearsal costs against
  quota; don't assume any particular multiplier without looking.

- **Data residency is now simpler, and worth mentioning in the demo video as an improvement, not
  just a caveat.** Because this model is invoked In-Region rather than through Global
  cross-Region inference, the request and the generated text both stay in `ap-south-1` — nothing
  about this call routes outside India. If your demo narration previously had to disclose that
  diagnosis text could be generated abroad (the Claude/Global-CRIS version of this doc), that
  disclosure no longer applies to this call; you can instead note that swapping in an In-Region
  model tightened the data-residency story, which is a legitimate, specific thing to say in the
  "what I learned" segment `ROADMAP.md` Day 4's script scores.

- **Latency should have less cross-call variance than a cross-Region-routed call did**, since
  there's no routing-to-wherever-has-capacity step. `DiagnoseWithBedrockFunction`'s Lambda
  timeout is still set to 60s (`plan3.md` §12) — that's more headroom than this call is likely to
  need now, but there's no strong reason to shrink it before you've actually watched a few real
  invocations' latency in CloudWatch.

- **The citation-validation gate is still the actual safety mechanism — don't relax it under
  time pressure.** Structured Outputs' `enum` constraint (§2) makes it much harder for the model
  to cite a nonexistent id when the constraint is actually applied, but "much harder" isn't
  "structurally impossible if something upstream misconfigures the request." If you're tempted
  to "just accept the diagnosis even if citations don't fully match" to get a demo run working,
  don't — that's the one non-negotiable line item `ROADMAP.md` calls out explicitly, and it's
  cheap relative to what it protects against.

- **Verify `outputConfig` is actually in your installed SDK's types before assuming it's wired
  up.** Bedrock's Structured Outputs field on the Converse API (`outputConfig.textFormat`) is a
  newer addition than the base `ConverseCommand` shape; some pinned versions of
  `@aws-sdk/client-bedrock-runtime` may not yet type it, which would make TypeScript reject it
  (or, worse, an `as any` cast could let it through as a silently-ignored unknown field at
  runtime). Check `tsc`'s output when you add it, and — separately — confirm via a real
  invocation that the response is actually schema-conformant (e.g. deliberately break the schema
  once and confirm Bedrock returns a 400 rather than just ignoring it) rather than trusting that
  passing the field did anything.

- **`DiagnoseWithBedrockFunction`'s JSON parsing still strips ` ```json ` fences defensively —
  keep it, but understand why it's now a fallback, not the main safety net.** With Structured
  Outputs correctly applied, the response should already be bare, schema-conformant JSON with no
  markdown fencing. The stripping logic stays in place for the same reason the citation check
  does: if `outputConfig` didn't actually apply, the model reverts to plain instruction-following
  and could re-introduce a fenced response the way the original Claude/prompt-only version of
  this pipeline sometimes did.

---

## 4. After `cdk deploy` (Day 3) — what to do in the AWS Console

1. **Confirm the region.** Top-right region selector must say Asia Pacific (Mumbai)
   `ap-south-1` — same as every other console step in this project.

2. **Bedrock → Model access.** Confirm `Qwen3-235B-A22B-2507` shows access as granted for your
   account. If it's still "Pending" or "Available to request," you cannot proceed past this
   point — the `DiagnoseWithBedrock` Lambda will fail every invocation with an access error
   until this clears. This should have been requested back in `ROADMAP.md`'s Day-0 logistics,
   but verify here regardless.

3. **Bedrock → Base models (or wherever your console surfaces the model catalog) → Qwen3-235B-
   A22B-2507.** Confirm the model id shown matches `qwen.qwen3-235b-a22b-2507-v1:0` (what
   `BEDROCK_MODEL_ID` should be set to) and that `ap-south-1` is listed as In-Region for it —
   this is also where you'd catch it if AWS has changed the id string since this doc was
   written. There's no separate **Inference profiles** step to check here, unlike the Claude
   path this project originally used — this model doesn't go through one.

4. **CloudFormation → your stack → Outputs**, or just read the terminal output from `cdk
   deploy` itself: find `ApproveFunctionUrl`. You don't need this for the automated part of the
   loop, but you'll want it handy — it's the base URL that the printed approve/deny links in
   `RequestApprovalFunction`'s logs are built from, useful for manually testing the callback
   Lambda in isolation before running the full state machine.

5. **Lambda console → confirm the five new functions exist:** `DiagnoseWithBedrockFunction`,
   `RequestApprovalFunction`, `ApproveHandlerFunction`, `RemediateFunction`,
   `VerifyOutcomeFunction`. Click into `DiagnoseWithBedrockFunction` → **Configuration →
   Environment variables** and confirm `BEDROCK_MODEL_ID` is set to the value you expect.

6. **Lambda console → `InventoryFunction` → Versions tab.** Confirm at least one published
   version exists (not just `$LATEST`) and that the **Aliases** tab shows `live` pointing at
   it. If you only see `$LATEST` and no alias, the `cdk deploy` that should have introduced
   `Alias`/`currentVersion` (`plan3.md` §12) didn't take effect — redeploy before continuing;
   `Remediate` has nothing to roll back to otherwise.

7. **Step Functions console → state machines.** Confirm `IncidentResponseDay3` exists (the name
   changed from `IncidentResponseDay2`) and that its graph shows all seven states in order:
   `CreateIncident → BuildGraph → LocalizeRootCause → DiagnoseWithBedrock → RequestApproval →
   Remediate → WaitForMetricsToSettle → VerifyOutcome`.

8. **Arm the fault and trigger a run** — follow `plan3.md` §15's test-setup steps exactly (they
   involve two separate `cdk deploy`s, one "good" and one "bad," so `Remediate` has a real
   previous version to revert to). Then hit `/orders` until `InventoryErrorAlarm` trips.

9. **Step Functions console → Executions.** Click the new execution. Watch it progress; when it
   reaches `RequestApproval`, the execution status stays `Running` with that state highlighted
   — this is the pause, not a stall. Give it a few seconds after `DiagnoseWithBedrock` before
   expecting this, since that step includes the Bedrock round-trip.

10. **CloudWatch Logs → `/aws/lambda/RequestApprovalFunction`.** Find the most recent
    `INCIDENT_APPROVAL_REQUIRED` log line; copy the `approveLink` value out of it.

11. **Open the `approveLink` in a browser.** You should see a plain "Approved" HTML response.
    Back in the Step Functions console, the execution should now show `RequestApproval` as
    succeeded and progress into `Remediate`.

12. **Watch it finish.** `Remediate → WaitForMetricsToSettle (60s) → VerifyOutcome →
    SUCCEEDED`. If it instead fails at `Remediate` with `NO_PREVIOUS_VERSION`, you skipped the
    two-step "good then bad" publish order in `plan3.md` §15 — there's nothing to roll back to
    yet.

13. **DynamoDB console → `Incidents` table.** Query by the incident's `PK` and confirm rows for
    `META` (status `closed`), `LOCALIZATION`, `DIAGNOSIS`, `APPROVAL` (status `approved`),
    `REMEDIATION`, `VERIFICATION` all exist.

14. **Lambda console → `InventoryFunction` → Aliases → `live`.** Confirm it now points at the
    earlier ("good") version number again, not the version it pointed to right before you
    clicked approve.

15. **(Optional) CloudWatch → Settings → Model invocation logging.** 
    Turning this on gives you the **Gen AI Observability → Model Invocations**
    dashboard — invocation count, latency, token usage — which is a nice, low-effort visual for
    the "what I learned" / architecture segment of the demo video (`ROADMAP.md` Day 4 script).
    Choose CloudWatch Logs as the destination and let it create a new service role; this is a
    few clicks, not a code change.

16. **Reset for another rehearsal run.** The alias is back at the "good" version, `INJECT_FAULT`
    is still `"true"` in the CDK source from your earlier deploy — you need a genuinely NEW
    "bad" published version to have something fresh to roll back to next time. The
    straightforward way: toggle `FAULT_MODE` or `FAULT_PROBABILITY` to a different value (any
    change to `InventoryFunction`'s config triggers a new published version on `cdk deploy`,
    same mechanism as before) and redeploy. Don't just flip `INJECT_FAULT` back and forth
    between the same two values repeatedly — CDK may treat that as reverting to a version that
    already exists rather than publishing a new one; a small env var change guarantees a fresh
    version every time if you're unsure.

---

If something here disagrees with what the console or SDK actually shows you, trust the
console/SDK — this doc, like `plan3.md` §13's note on `waitForTaskToken` output shape, is a
best-effort account written from documentation, not from having run this exact stack yet.
