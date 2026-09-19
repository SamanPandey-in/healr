# Video Script — 5-Minute Demo: AI-Native Self-Healing Infrastructure

**Total runtime:** 5:00
**Format:** Screen recording + voiceover. Terminal and AWS console visible throughout.
**Tone:** Honest, technical, fast-paced. Not a sales pitch — a walkthrough.

---

## Beat 1 — The Problem (0:00 – 0:40)

**[Screen: terminal or simple slide with the three-service diagram]**

> "I run production infrastructure for freelance clients. When something breaks at 2 AM, the hardest part isn't fixing it — it's figuring out *which* service actually caused it. You get an alarm, you start tailing logs, you cross-reference deploy timestamps, and 20 minutes later you're still triaging while your client's users are staring at a broken page.
>
> What if the system could do that for you? Not just detect that something is wrong, but walk the dependency graph, find the upstream service that likely caused it, explain its reasoning with cited evidence, ask you before touching anything, and then fix it automatically?"

---

## Beat 2 — Architecture Overview (0:40 – 1:30)

**[Screen: draw or show the architecture diagram — gateway -> orders -> inventory, with CloudWatch, Step Functions, and the four-stage pipeline]**

> "Here's what I built. Three microservices — a gateway, an orders service, and an inventory service — running on Lambda behind API Gateway. They call each other over Function URLs, and every call is traced end-to-end with X-Ray.
>
> The pipeline has four stages:
>
> **Ingest** — a CloudWatch alarm watches a custom metric. When it fires, EventBridge triggers a Step Functions state machine.
>
> **Localize** — this is the hard part. The system pulls the live call graph from X-Ray traces, walks it backward from the alarming service, and scores each upstream candidate using a temporal-precedence heuristic. Deployed recently and upstream of the failure? High score. Deployed after the anomaly? Zero — it can't be the cause.
>
> **Diagnose** — sends the ranked candidates and evidence to an LLM. The model must cite specific evidence IDs — alarm data, graph distances, deploy timestamps — and a validation gate rejects any diagnosis that cites nothing real.
>
> **Remediate** — rolls back the faulty Lambda's alias to a known-good version. But only after a human clicks approve.
>
> Seven AWS services: Lambda, API Gateway, DynamoDB, X-Ray, CloudWatch, EventBridge, and Step Functions."

**[Pause 2 seconds for the diagram to sink in]**

---

## Beat 3 — The Bedrock-to-Gemini Pivot (1:30 – 2:00)

**[Screen: show `server/src/shared/llm/geminiClient.ts` and `server/src/shared/aws/bedrockClient.ts` side by side]**

> "One thing that fought back: I originally wired the diagnosis step through Amazon Bedrock — that's what the hackathon track highlights, and Bedrock's Converse API with Structured Outputs is what the initial plan was built around. But Bedrock model access on my AWS account didn't clear in time to unblock Day 3.
>
> So I re-pointed that one call site at the Gemini API instead. Same evidence, same citation-grounding contract, same `converseText(systemPrompt, userPrompt, jsonSchema)` function signature — different provider underneath. The Bedrock client and IAM grant are still in the repo, untouched, not deleted. One import line changed in the diagnosis handler. That's the blast radius.
>
> The engineering lesson: isolate your LLM provider behind one function signature. Then swapping providers is a one-line diff."

---

## Beat 4 — The Live Demo (2:00 – 4:00)

**[Screen: terminal with `scripts/record-demo.sh` as the run-sheet]**

### 4a — Healthy Baseline (2:00 – 2:15)

> "Let me show it working. First, a healthy request — fault injection is off."

**[Run: `curl -s -X POST "$API_URL/orders" -H "Content-Type: application/json" -d '{"orderId":"demo-healthy-001","sku":"SKU-123","quantity":2}' | jq .`]**

> "Clean response. Orders checked inventory, everything's fine."

### 4b — Inject Faults (2:15 – 2:40)

> "Now I've pointed the inventory Lambda's alias at a version with fault injection enabled — 50% error rate. Let's hit it six times."

**[Run: the for-loop from `record-demo.sh` — 6 requests, ~1 second apart]**

> "You can see the 502s coming back. The inventory service is throwing `SIMULATED_FAULT` errors."

### 4c — Alarm Fires (2:40 – 3:00)

> "CloudWatch needs about 60 seconds to evaluate the alarm. Let me switch to the console."

**[Screen: CloudWatch console — Alarms — InventoryErrorAlarm transitions from OK to ALARM]**

> "There it is. ALARM state. This fires the EventBridge rule, which triggers the Step Functions state machine."

### 4d — Localization + Diagnosis (3:00 – 3:20)

> "Let's look at the Step Functions console."

**[Screen: Step Functions — IncidentResponseDay3 execution, RUNNING state]**

> "It's already past BuildGraph and LocalizeRootCause. If I check DynamoDB..."

**[Screen: DynamoDB console — Incidents table, query by PK]**

> "Six rows for this incident. META shows 'diagnosed'. LOCALIZATION has the ranked candidates — inventory at the top, distance zero, most recent deploy. DIAGNOSIS has the LLM's output: root cause is inventory, confidence 0.95, with three cited evidence IDs — the alarm, the graph edge, and the deploy event."

### 4e — Human Approval Gate (3:20 – 3:40)

> "Step Functions is now paused at RequestApproval — waiting for a human. The approval link is in CloudWatch Logs."

**[Screen: CloudWatch Logs — RequestApprovalFunction — find INCIDENT_APPROVAL_REQUIRED line]**

> "Here's the approve link. I'll open it."

**[Run: `curl -s "$APPROVE_LINK"]`**

> "Approved. Step Functions resumes — Remediate rolls back the inventory alias to the previous version, waits 60 seconds for metrics to settle, then VerifyOutcome checks the fault metric."

### 4f — Recovery (3:40 – 4:00)

**[Screen: Step Functions — execution reaches SUCCEEDED]**

> "SUCCEEDED. Let me verify the rollback."

**[Screen: Lambda console — InventoryFunction — Aliases — `live` now points at the previous version]**

> "The `live` alias rolled back. The fault is gone. No redeployment — just an alias swap."

---

## Beat 5 — What I Learned + What's Next (4:00 – 4:40)

**[Screen: terminal or a simple text slide]**

> "What I learned building this:
>
> **X-Ray trace propagation** — getting the trace ID across Lambda-to-Lambda HTTP calls was the first thing that broke and the last thing I'd think about. The `traceHeaders()` helper that forwards `_X_AMZN_TRACE_ID` as an HTTP header is 10 lines of code but without it, you get isolated traces and the graph builder sees nothing.
>
> **Causal localization is genuinely hard** — the PC algorithm is the real answer, but a topology-constrained temporal-precedence heuristic gets you 80% of the way. The key insight: if a deploy happened *after* the anomaly, it can't be the cause. That simple rule eliminates most false positives.
>
> **LLM citation grounding** — the JSON Schema enum constraint forces the model to cite real evidence IDs, but the runtime validation gate is what catches silent failures. An ungrounded diagnosis is worse than none.
>
> **Step Functions waitForTaskToken** — this is the real human-in-the-loop pattern. No custom UI, no webhook server. The state machine just pauses, and a URL click resumes it. It's the cleanest approval gate I've seen.
>
> What's next: real PC-algorithm-style causal discovery, a broader fault matrix, and getting Bedrock access sorted so both LLM providers are pluggable — since the Bedrock client is still in the repo for exactly that."

---

## Beat 6 — Close (4:40 – 5:00)

**[Screen: repo URL or a clean terminal]**

> "The repo is public. Everything runs on AWS — Lambda, API Gateway, DynamoDB, X-Ray, CloudWatch, EventBridge, Step Functions. The full incident lifecycle — detect, localize, diagnose, approve, remediate, verify — closes in under three minutes.
>
> Thanks for watching."

---

## Production Notes

- **Total curl calls on camera:** 7 (1 healthy + 6 fault-injected + 1 approval)
- **AWS consoles to show:** CloudWatch (alarm), Step Functions (execution), DynamoDB (incident records), Lambda (alias rollback)
- **Key timing constraint:** The 60-second alarm evaluation is the longest dead wait — use it to show the architecture diagram or narrate the localization algorithm
- **Audio:** Voiceover only, no background music
- **Resolution:** 1920x1080, terminal font size large enough for screen recording
