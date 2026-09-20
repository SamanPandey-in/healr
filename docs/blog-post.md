# Building an AI-Native Self-Healing Infrastructure on AWS

**How a 3-service microservice system detects faults, finds the root cause with a causal heuristic, gets an LLM to explain it with cited evidence, asks a human for permission, and fixes itself — all in under three minutes.**

---

## The Problem

I run production infrastructure for freelance clients. When something breaks, the first 20 minutes aren't spent fixing it — they're spent figuring out *which* service actually caused it. You get a CloudWatch alarm, you start tailing logs, you cross-reference deploy timestamps with error spikes, you check the dependency graph in your head, and you're still triaging while your client's users are staring at a broken page.

The core pain point isn't "things break." It's "I don't know *why* they broke, and finding out is slow, manual, and error-prone."

What if the system could do that for you?

---

## The Architecture

The system is built around three microservices — a gateway, an orders service, and an inventory service — running on AWS Lambda behind API Gateway. They call each other synchronously over Lambda Function URLs, and every call is traced end-to-end with AWS X-Ray.

The self-healing pipeline has four stages:

```
CloudWatch Alarm
  → EventBridge rule
    → Step Functions state machine:
        1. BuildGraph       (pull live topology from X-Ray traces)
        2. LocalizeRootCause (causal heuristic — temporal precedence + topology)
        3. DiagnoseWithLLM  (structured output with mandatory citations)
        4. RequestApproval   (pauses — human clicks approve/deny)
        5. Remediate         (Lambda alias rollback to previous version)
        6. VerifyOutcome     (check metrics, confirm recovery)
```

Seven AWS services are in the production path: **Lambda, API Gateway, DynamoDB, X-Ray, CloudWatch, EventBridge, and Step Functions.**

---

## Stage 1: Ingest — Detecting the Fault

The fault-injection mechanism lives inside the inventory Lambda. When enabled via environment variable (`INJECT_FAULT=true`), it randomly throws errors or injects latency on a configurable percentage of requests. Crucially, these faults are *caught inside the handler* — they return HTTP 500 responses, not unhandled exceptions. That means Lambda's built-in `Errors` metric won't fire.

So the system emits its own custom metric using CloudWatch Embedded Metric Format (EMF). A structured `console.log` line in the inventory handler writes to namespace `SelfHealingInfra/Inventory`, metric `InjectedFault`. The CloudWatch alarm watches this metric — one breach in one 1-minute evaluation period, and the alarm fires.

An EventBridge rule catches the alarm state change and triggers the Step Functions state machine with the service name, alarm name, and the exact timestamp from the CloudWatch event (not the rule evaluation time — this matters for the localization heuristic later).

**Key design decision:** The alarm uses a custom EMF metric rather than Lambda's native error metric. This is because application-level fault injection (caught exceptions returning 500s) doesn't register as a Lambda invocation failure. The EMF approach requires zero additional IAM permissions — it's just a specially formatted log line that CloudWatch automatically ingests.

---

## Stage 2: Localize — Finding the Root Cause

This is the hard part, and the part I spent the most time on.

The goal: given an alarm on the inventory service, determine which upstream service most likely caused the failure. In a three-service chain (`gateway → orders → inventory`), the answer is almost always "inventory itself" — but in a real system with shared dependencies, fan-in, and async paths, it's not that simple.

The algorithm is a **topology-constrained temporal-precedence heuristic**:

1. **BFS backward** from the alarming service along the call graph edges (reversed). This gives you all upstream ancestors with their hop distances.

2. **For each ancestor**, query DynamoDB for the most recent deploy event before the alarm timestamp. This tells you "when was this service last changed?"

3. **Score each candidate** with two signals:
   - **Temporal score (80% weight):** How close in time was the deploy to the anomaly? Uses exponential decay with a ~5-minute half-life. Deployed *after* the anomaly? Score is exactly zero — it can't be the cause. No deploy data? Small non-zero floor (0.05) so the candidate isn't completely eliminated.
   - **Structural score (20% weight):** Hop distance from the alarming service. Closer is weakly more likely. Formula: `1 / (1 + distance)`.

4. **Sort descending** by combined score. The top candidate is the most likely root cause.

The call graph itself is built dynamically from X-Ray traces. The `BuildGraph` step queries X-Ray for recent traces, parses the segment documents to extract service-to-service call edges (using subsegment names like `call-orders` and `call-inventory`), and upserts them into a DynamoDB adjacency list. If X-Ray hasn't ingested traces yet (latency), the handler doesn't wipe the graph — pre-seeded static edges remain available.

**The key insight:** A deploy that happened *after* the anomaly can never be the cause. That single rule — temporal precedence — eliminates most false positives. The topology score is there as a tiebreaker, not the primary signal.

This isn't a PC-algorithm or a full causal discovery system. It's a principled heuristic that's honest about what it is. But it works: in every test run, it correctly ranked inventory as the top candidate when inventory was the faulty service.

---

## Stage 3: Diagnose — LLM with Cited Evidence

Once the localization step ranks candidates, the diagnosis step sends the evidence to an LLM and asks it to explain the root cause.

The evidence is structured as a fixed list with deterministic IDs:

- `EVIDENCE#ALARM#InventoryErrorAlarm` — the triggering alarm
- `EVIDENCE#GRAPH#inventory` — graph distance (0 hops from anomaly)
- `EVIDENCE#DEPLOY#inventory#42` — deploy version, timestamp, and diff summary

The LLM receives a system prompt instructing it to:
- Diagnose using ONLY the provided evidence
- Never invent services, deploys, or timestamps
- Set confidence below 0.3 if evidence is insufficient
- Always cite at least one evidence ID

The output is constrained by a JSON Schema with `enum` constraints on `citedEvidenceIds` — the model can only cite IDs that actually exist in the evidence list. This is enforced at the API level by Bedrock's Structured Outputs (and equivalently by Gemini's `responseSchema`).

But the system doesn't stop there. After the LLM responds, a runtime validation gate filters the returned citations against the allowed set. If zero valid citations remain, the handler throws `DIAGNOSIS_NOT_GROUNDED` — a hard failure that prevents the state machine from proceeding with an ungrounded diagnosis.

**The principle:** An ungrounded diagnosis is worse than none. If the model can't point to specific evidence for its conclusion, the system should fail loudly rather than silently propagate a guess.

---

## Stage 4: Approve — Human-in-the-Loop

Before any automated action, the system pauses and asks a human.

Step Functions' `waitForTaskToken` integration pattern handles this cleanly. The `RequestApproval` step returns a task token, constructs an approve/deny URL (a public Function URL on a separate Lambda), and logs it to CloudWatch. The state machine pauses — for up to 30 minutes — until a human clicks one of the links.

The approval Lambda is idempotent: double-clicks are handled gracefully, returning "already approved" or "already denied" HTML. On approve, it calls `SendTaskSuccess` with the diagnosis data as output. On deny, it calls `SendTaskFailure` with an `ApprovalDenied` error.

**Why this matters:** The roadmap's cut list explicitly says "never drop the approval gate before remediation." This is the line between a useful automation and a dangerous one. The system can find the root cause and propose a fix — but it won't act without a human saying yes.

---

## Stage 5: Remediate — Lambda Alias Rollback

On approval, the `Remediate` step rolls back the inventory Lambda's `live` alias to the previous published version.

Here's why this works as a real fix: Lambda version snapshots capture both code *and* configuration, including environment variables. When the "bad" version was published with `INJECT_FAULT=true`, that flag is baked into the version. Rolling back to the previous version (which had `INJECT_FAULT=false`) genuinely changes the behavior — the fault injection stops.

The remediation Lambda:
1. Reads the current alias target via `GetAlias`
2. Lists all published versions via `ListVersionsByFunction`
3. Finds the version immediately before the current one
4. Updates the alias to point at that version via `UpdateAlias`

No redeployment. No code push. Just an alias swap that retires the faulty version.

---

## Stage 6: Verify — Confirming Recovery

After remediation, the system waits 60 seconds for CloudWatch metrics to propagate, then checks the `InjectedFault` metric. It counts faults in two windows: the 5 minutes before remediation, and the time since remediation. If the post-remediation fault count is zero, the incident is marked `closed` with `recovered: true`.

---

## What Fought Back: The Bedrock-to-Gemini Pivot

I originally wired the diagnosis step through Amazon Bedrock — that's what the hackathon track highlights, and Bedrock's Converse API with Structured Outputs is what the initial plan was built around. Bedrock model access on my AWS account didn't clear in time to unblock Day 3.

So I re-pointed that one call site at the Gemini API instead. Same evidence, same citation-grounding contract, same `converseText(systemPrompt, userPrompt, jsonSchema)` function signature — different provider underneath.

The blast radius was minimal:
- **Changed:** One import line in `diagnosis/handler.ts`
- **New:** `geminiClient.ts` (REST fetch with API key), `geminiAccess.ts` (CDK validation)
- **Untouched:** Every other Lambda, every DynamoDB table, every Step Functions state, the Bedrock client and IAM grant (kept in the repo for instant rollback)

The engineering lesson isn't "use Gemini over Bedrock." It's **isolate your LLM provider behind one function signature.** Then swapping providers is a one-line diff, not a rewrite. The `converseText()` seam — same parameters, same return shape, different backend — is the actual design pattern worth extracting from this project.

The Bedrock client (`server/src/shared/aws/bedrockClient.ts`) and its IAM policy (`infra/lib/bedrockAccess.ts`) are still in the repo, untouched, not deleted. That's a true, checkable claim: the system engaged with Bedrock, and the path to using it is intact.

---

## The Causal-Localization Heuristic in Plain Terms

Imagine you're an on-call engineer. An alarm fires on the inventory service. What do you check first?

You'd think: "What changed recently?" If inventory was deployed 3 minutes ago, that's suspicious. If orders was deployed 10 minutes ago and it calls inventory, that's also suspicious but less so. If gateway was deployed an hour ago, probably not the cause.

The heuristic formalizes that intuition:
- **Temporal proximity** (80% weight): A recent deploy is a strong signal. Exponential decay means a deploy 5 minutes ago scores much higher than one 30 minutes ago.
- **Topological proximity** (20% weight): Being closer on the call graph is a weak signal. One hop away is slightly more likely than three hops away.
- **Hard exclusion**: A deploy after the anomaly gets zero. It's physically impossible for a future event to cause a past failure.

This isn't causal discovery. It's a principled heuristic that catches the most common failure mode (bad deploy) with high precision. The roadmap calls for PC-algorithm-style causal discovery as a next step — that's real future work.

---

## What's Next

- **Real causal discovery:** Replace the temporal-precedence heuristic with a PC-algorithm implementation that can handle shared dependencies and async call paths
- **Broader fault matrix:** Add latency injection, memory pressure, and dependency failures beyond the current error-mode toggle
- **Bedrock access sorted:** Get the original Bedrock path working so both LLM providers are pluggable — the client is in the repo for exactly that
- **Multi-service expansion:** Move beyond the 3-service demo to a more realistic topology

---

## Tech Stack

| Layer | Technology |
|---|---|
| Compute | AWS Lambda (Node.js 20) |
| API | AWS API Gateway (REST) |
| Data | Amazon DynamoDB (single-table design, 3 tables) |
| Tracing | AWS X-Ray (active tracing on all Lambdas) |
| Monitoring | Amazon CloudWatch (custom EMF metrics, alarms) |
| Orchestration | AWS Step Functions (8-state state machine) |
| Event Routing | Amazon EventBridge |
| LLM | Gemini 2.5 Flash (migrated from Amazon Bedrock Qwen3) |
| IaC | AWS CDK (TypeScript) |

---

## Resources

- **Repo:** [github.com/SamanPandey-in/healr](https://github.com/SamanPandey-in/healr)
- **Migration docs:** `docs/gemini-migartion.md` — full before/after of the Bedrock→Gemini swap
- **Test evidence:** `docs/TEST_DAY3_2.md` — 17/17 checklist items passed, end-to-end
- **Roadmap:** `docs/ROADMAP (1).md` — day-by-day execution plan and scoring criteria
