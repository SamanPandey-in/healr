# ROADMAP.md — Self-Healing Infra, Hackathon Cut
### WeMakeDevs "First Commit" — Sept 17–20, 2026 — Ship It track

This is the hackathon-scoped version of the full [[AI-Native Self-Healing Infra]] spec. The full spec assumed weeks; you have ~3.5 days. Everything below is chosen to survive contact with the judging rubric: **works end-to-end > architecturally pure**.

---

## 0. Hackathon analysis (read once, then don't re-litigate this)

**Track: Ship It.** Bigger prize (₹2,00,000 + $3,000 credits vs ₹1,50,000 + $2,000), and its listed tool set — Lambda, API Gateway, DynamoDB, S3, Bedrock, EventBridge, Step Functions — is almost a checklist for what this project needs anyway. Building It (local-only, Strands/Cedar/LocalStack) would mean throwing away the "deployed, real infra" story that makes this project credible in the first place.

**Mandatory constraint:** you must use an AWS service (or AWS open-source project) to win a prize at all. This reprioritizes every technical decision in the original doc — see Section 2.

**Scoring weights that change what you build, in order of leverage:**
1. **Execution** ("does it work, not perfect") — this is why the roadmap below cuts to a single, narrow, fully-working loop rather than a broad partial one.
2. **Built on AWS** — using *more* of the Ship It list (not fewer services) directly helps here, as long as each one is load-bearing, not decorative.
3. **Idea & Impact** — frame this as *your own* pain: you've operated Dreamer for real deployments and had to manually root-cause outages. That's a lived problem, not a hypothetical one — use it in the pitch and the video.
4. **Learning** — explicitly narrate what's new to you (X-Ray, Bedrock invocation, Step Functions callback pattern, causal reasoning over a dependency graph) in the video/blog. This is free points if you say it out loud; don't leave it implicit.
5. **Demo video** — there is no live demo. The video *is* the submission's face. Script and record it, don't improvise it at 11pm on Sunday.

**Logistics to close out before Day 1 starts (do this in the next few hours, not tomorrow):**
- AWS Builder Center account + Builder ID (required to compete)
- Claim the $100 AWS credit code
- **Request Bedrock model access for a Claude model now.** Access approval isn't always instant — this is the one dependency that can silently block your Day 3 if you leave it late.
- Register the team on the event page; if solo, note that explicitly in your submission (teams of 1–4 are both fine)
- Have your GitHub repo created and pushed-to once before Thursday, even if it's just a README — "First Commit" as a literal first commit, timestamped before the event, is a bad look; make your real first commit *after* the event opens

---

## 1. The one-sentence pitch to lock in now

> "I run production infra for freelance clients (Dreamer). When something breaks, I spend the first 20 minutes just figuring out *which* service actually caused it, not just which one is currently on fire. This automates that: it builds a live dependency graph of a running system, points at the actual upstream cause of an incident (not just the loudest symptom), explains it in plain English with cited evidence, and asks permission before fixing it."

Use this framing, not the "AI-native self-healing infra for placement panels" framing — it's the same project, but this version answers "what real problem does this solve for you" directly, which is what Idea/Impact is scored on.

---

## 2. What must change from the original spec, and why

| Original spec | Hackathon cut | Why |
|---|---|---|
| Neo4j graph store | **DynamoDB**, single-table adjacency-list design (`PK=SERVICE#x`, `SK=EDGE#y`) | Neo4j is infra you have to stand up, secure, and pay for in a weekend, and it isn't on the AWS mandatory-service list. DynamoDB *is*, and an adjacency list is enough graph for 3–5 services. |
| OTel Collector + Jaeger/Tempo + Prometheus + Loki | **AWS X-Ray** (traces, gives you parent/child span causality for free on Lambda/API Gateway) + **CloudWatch** (metrics, logs, alarms) | Four self-hosted observability services is a weekend of yak-shaving on its own. X-Ray + CloudWatch is zero-infra, native to Lambda, and is itself an AWS service you get "Built on AWS" credit for. |
| Kubernetes + Chaos Mesh / Toxiproxy | **A fault-injection Lambda** — an env-var-toggled function that deliberately throws errors, sleeps to simulate latency, or returns malformed responses, invoked on demand | You will not stand up a K8s cluster and Chaos Mesh correctly before Sunday. A toggleable fault Lambda gives you the same ground-truth-labeled incident you need for the demo, in an afternoon instead of a day. |
| Python PC-algorithm / Granger causal discovery service | **A single Lambda implementing a topology-constrained temporal-precedence heuristic**: given an anomaly on node D, walk backward along `DEPENDS_ON` edges in DynamoDB, and rank upstream nodes by how tightly their deploy/error-onset timestamp precedes D's anomaly onset, restricted to nodes actually on a call path to D | The real PC algorithm is a multi-day implementation and eval effort on its own — it's the "months" part of the original scope. The heuristic below is still principled (it's explicitly *not* "rank by who errors most," it uses graph structure + causal ordering), still beats the naive baseline, and is honestly describable in the video as "MVP causal localization, PC-algorithm-style constrained search is the next step." Judges reward honesty about scope more than they penalize a simplified method. |
| Claude API direct | **Amazon Bedrock** (Claude model) for the RAG diagnosis step | Direct API calls to Anthropic don't count toward "Built on AWS." Bedrock hosts Claude — same model capability, now it's a scored AWS service. |
| Custom Slack-webhook approval UI | **Step Functions `waitForTaskToken` callback pattern** — the state machine pauses at the remediation step, a link (emailed via SES or just printed for the demo) resumes it | This is a first-class, well-documented AWS pattern for exactly "pause a workflow for human approval" — it's less code than building your own approval service, and it's a highlighted Ship It tool (Step Functions). |
| Full React dashboard with live graph viz | **A minimal static page (S3-hosted, or even just terminal/CLI output for the recording)** showing: current graph, the flagged incident, the diagnosis text, an approve/deny link | Frontend polish is real effort for zero judging leverage beyond "Best UI," which is a stretch prize, not the target. Spend that time on the loop actually working instead. |
| 6-service demo app, multi-fault-type matrix | **3 services** (`gateway` → `orders` → `inventory`), Lambda + API Gateway, one fault type (induced latency/error in `inventory`) proven end-to-end | Matches "narrow and working" over "broad and partial." Add a second fault type only if Day 3 finishes early. |

**What stays the same:** the four-stage shape (ingest → localize → diagnose → remediate), the `ChatAgent`-style structured/cited-output discipline for the RAG step (still non-negotiable — an ungrounded diagnosis is worse than none), and the human-approval-before-action safety stance (still non-negotiable, and now it's also the thing that shows off Step Functions).

---

## 3. Architecture (hackathon version)

```
gateway Lambda → orders Lambda → inventory Lambda   (API Gateway in front of gateway)
        │              │               │
        └──────────────┴───────────────┘
                 X-Ray traces + CloudWatch metrics/logs
                        │
              CloudWatch Alarm (error rate / latency on inventory)
                        │
                    EventBridge rule
                        │
                        ▼
        Step Functions state machine: "IncidentResponse"
        ┌─────────────────────────────────────────────┐
        │ 1. BuildGraph Lambda                         │
        │    → parses X-Ray trace graph + DynamoDB     │
        │      deploy-event log → writes/refreshes     │
        │      Service/Edge items in DynamoDB          │
        │                                               │
        │ 2. LocalizeRootCause Lambda                  │
        │    → topology-constrained temporal heuristic │
        │    → writes ranked candidates + evidence      │
        │      pointers to DynamoDB                     │
        │                                               │
        │ 3. DiagnoseWithBedrock Lambda                │
        │    → retrieves logs/spans/deploy diff for     │
        │      top candidate, calls Bedrock (Claude)    │
        │    → structured cited incident report         │
        │                                               │
        │ 4. RequestApproval (waitForTaskToken)        │
        │    → emails/prints approval link              │
        │    → PAUSES here until human responds         │
        │                                               │
        │ 5. Remediate Lambda (on approval)            │
        │    → e.g. revert inventory Lambda alias to    │
        │      previous version                          │
        │                                               │
        │ 6. VerifyOutcome Lambda                       │
        │    → checks CloudWatch metrics post-action,   │
        │      logs before/after, closes incident        │
        └─────────────────────────────────────────────┘

S3: stores deploy artifacts + demo-video assets
DynamoDB: ServiceGraph table, DeployEvents table, Incidents table
```

---

## 4. Day-by-day plan

### Day 1 — Thursday, Sept 17: skeleton + real deploy
**Goal:** three Lambdas deployed behind API Gateway, X-Ray on, DynamoDB tables created, one real request flowing gateway→orders→inventory with a visible trace.
- Stand up `gateway`, `orders`, `inventory` Lambdas (Node/TS or Python, whichever you're faster in)
- API Gateway in front of `gateway`; enable X-Ray active tracing on all three functions
- Create DynamoDB tables: `ServiceGraph`, `DeployEvents`, `Incidents`
- Deploy-event webhook: a tiny Lambda triggered on each deploy (or manually invoked at first) that writes `{service, timestamp, version, diff_summary}` into `DeployEvents`
- **Demo checkpoint:** hit the gateway endpoint, see a 3-span trace in X-Ray, see the request succeed end-to-end. Nothing clever yet — just prove the real infra is real.

### Day 2 — Friday, Sept 18: anomaly + localization + fault injection
**Goal:** you can deliberately break `inventory`, get an Incident record, and get a *ranked* root-cause list back that correctly points at `inventory`'s bad deploy, not just "inventory is unhealthy."
- CloudWatch Alarm on `inventory` error rate/latency → EventBridge rule → triggers Step Functions execution
- `BuildGraph` Lambda: pull recent X-Ray trace summaries, derive `CALLS` edges, upsert into `ServiceGraph`
- Fault-injection Lambda/flag: an env var (`INJECT_FAULT=true`) on `inventory` that adds latency or throws on ~30% of requests, toggleable without a redeploy if possible (env var update via CLI is fine)
- `LocalizeRootCause` Lambda: implement the temporal-precedence-over-topology heuristic (Section 2, row 3) — this is the one piece of real "hard part" work, budget the most focused hours of the whole event here
- **Demo checkpoint:** toggle the fault, trigger the alarm, watch the state machine run through steps 1–2, see `inventory` (or its most recent deploy) come out top-ranked with an evidence trail (which edges/timestamps supported the ranking) — not just "the one with the worst metric."

### Day 3 — Saturday, Sept 19 (optional Bangalore day for feedback/mentors)
**Goal:** the full loop closes, including the human-approval pause and remediation.
- `DiagnoseWithBedrock` Lambda: retrieve the top candidate's logs + deploy diff, call Bedrock (Claude) with a structured-output prompt that forces every claim to carry a citation (span ID / log line / deploy version) — validate citations exist before accepting the output
- `RequestApproval` step using `waitForTaskToken`; simplest viable approval channel (a printed/emailed link that calls back into a small Lambda with `SendTaskSuccess`)
- `Remediate` Lambda: on approval, revert `inventory`'s Lambda alias to the previous version (this is a genuinely reversible, low-risk action — keep it to this for the demo)
- `VerifyOutcome` Lambda: re-check CloudWatch metrics for `inventory` over a short window post-remediation, log before/after, close the Incident record
- If you're in Bangalore: use the AWS team's presence and project-feedback slot specifically to sanity-check the Bedrock prompt/citation design and the Step Functions callback wiring — those are the two pieces most likely to have a dumb bug eating your Sunday
- **Demo checkpoint:** full loop, start to finish, on camera-ready infra: inject fault → alarm fires → graph builds → localization ranks correctly → Bedrock diagnosis with citations → approval link → click approve → remediation fires → metrics recover → incident closes.

### Day 4 — Sunday, Sept 20: polish, video, submission
**Goal:** submitted, on time, with a video that actually shows the loop.
- Minimal static page (or clean terminal recording) showing: graph state, incident, diagnosis text with citations, approve button/link
- **Record the 3-minute demo video** — script it before recording:
  - 0:00–0:20 — the problem, in your own words (the Dreamer-outage framing)
  - 0:20–0:50 — architecture in one breath, naming the AWS services used
  - 0:50–2:20 — the actual run: inject fault → incident → localization → diagnosis → approval → remediation → recovery (screen-recorded, not narrated-only)
  - 2:20–2:50 — what you learned (X-Ray, Bedrock, Step Functions callback pattern, causal localization) and what you'd build next (real PC-algorithm-based localization, broader fault matrix)
  - 2:50–3:00 — close
- Write the AWS Builder Center blog post (problem, stack, what fought back) — top-5 blog prize is free upside for ~30 minutes of writing you'd do anyway
- Double-check the mandatory-AWS-service checklist is explicit in your submission text: Lambda, API Gateway, DynamoDB, X-Ray, CloudWatch, EventBridge, Step Functions, Bedrock — name all of them, don't make judges hunt for it
- Submit with margin before the deadline, not at the buzzer

---

## 5. Cut list if you're behind schedule

In order of what to drop first if Saturday arrives and the full loop isn't closing yet:
1. Drop the frontend polish entirely — terminal/CLI output + a screen recording of DynamoDB/Step Functions console is enough for the video
2. Drop `VerifyOutcome`'s pretty before/after comparison — a single CloudWatch screenshot showing the metric recover is enough
3. Drop the second fault type / extra services — one clean fault-to-fix loop beats two half-working ones
4. Never drop: the approval gate before remediation, and the citation-checking on the Bedrock output — these are the two things that make it "safe self-healing" instead of "a script that reverts a Lambda," and they're cheap relative to how much of the Idea/Impact + Execution score they carry
