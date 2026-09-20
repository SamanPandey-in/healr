# plan4.md — Day 4 Execution Plan for AI Agents (Sunday, Sept 20)

**Repo state going into Day 4:** Day 1–3 complete and fully tested. `docs/TEST_DAY3_2.md`
shows all 23 checklist items passed against the **Gemini** diagnosis path (`docs/TEST_DAY3.md`
is the older Bedrock-path test doc — kept for history, no longer the source of truth). The
full loop — inject fault → alarm fires → graph builds → localization ranks correctly →
**Gemini** diagnosis with citations → approval link → click approve → remediation fires →
metrics recover → incident closes — is proven end-to-end on real deployed infra.

**Scope (per `docs/ROADMAP (1).md` Day 4):** polish, record the demo video, write the blog
post, submit. **No more feature code.** If anything here tempts you to touch `server/src/` or
`infra/lib/` beyond a one-line demo-safety tweak (§2), stop — that's scope creep on a
submission day. Section 7 restates this as a hard guardrail.

---

## 0. The one thing every other section depends on: the Bedrock → Gemini story

You are not hiding the swap. You are narrating it, because the roadmap's own scoring notes
(`ROADMAP (1).md` §0, weight #4 "Learning") explicitly reward saying out loud what fought you
and what you did about it. Don't leave this implicit in the video or blog — say it in one or
two sentences, in both places, using this framing:

> "I originally wired the diagnosis step through Amazon Bedrock — that's what the Ship It
> track's tool list highlights, and Bedrock's Converse API with Structured Outputs is what
> `docs/bedrock-guide.md` and `docs/plan3.md` were built around. Bedrock model access on this
> AWS account didn't clear in time to unblock Day 3, so I re-pointed that one call site at the
> Gemini API instead — same evidence, same citation-grounding contract, same
> `converseText(systemPrompt, userPrompt, jsonSchema)` shape, different provider underneath.
> `docs/gemini-migartion.md` has the full before/after."

**Why this matters for the submission checklist (§6), not just narrative color:** the mandatory
constraint is "you must use an AWS service... to win a prize at all" (`ROADMAP (1).md` §0), not
"every component must be AWS." The system still runs on **Lambda, API Gateway, DynamoDB, X-Ray,
CloudWatch, EventBridge, and Step Functions** — seven AWS services, untouched by the swap
(`docs/gemini-migartion.md` §0's blast-radius table confirms nothing else moved). Bedrock drops
off the "services used in the shipped system" list; it does NOT drop off the "services this
project engaged with" list, because the Bedrock client, IAM grant, and Day-3 plan for it still
exist in the repo (`server/src/shared/aws/bedrockClient.ts`, `infra/lib/bedrockAccess.ts`) —
untouched, not deleted, per `gemini-migartion.md`'s explicit design choice. That's a true,
checkable claim: say it that way, not as "we used 8 AWS services."

**One judgment call flagged, not resolved for you:** whether to mention Gemini by name in the
submission, or describe it generically as "an external LLM API, swapped in when Bedrock access
didn't clear." Either is honest. Naming it is more concrete and more consistent with the "cite
your evidence" ethos the project itself is built on — that's the default this plan uses
throughout — but if you'd rather keep the pitch AWS-service-dense and mention the swap only in
the "what fought back" beat, that's a legitimate call too. Don't relitigate it per-section; pick
once before you touch §4/§5 and stay consistent.

---

## 1. Day 4 checklist (execute top to bottom)

- [ ] §2: run the pre-recording safety pass (fresh "bad" version, confirm alarm resets)
- [ ] §3: run `scripts/record-demo.sh` once dry, fix anything that doesn't match the script
- [ ] §3: record the actual screen capture using the script as your run-sheet
- [ ] §4 (optional, only if §3 finishes with time to spare): static incident-summary page
- [ ] §5: cut the 3-minute video to the script's timing beats, narrate the Bedrock→Gemini pivot
- [ ] §6: write and post the AWS Builder Center blog post
- [ ] §7: run the submission checklist, including the corrected AWS-services list
- [ ] Submit with margin before the deadline, not at the buzzer

---

## 2. Pre-recording safety pass (do this before touching a recorder)

You need a **guaranteed-fresh** fault-triggering run on camera — not a stale alias state from
the last `TEST_DAY3_2.md` pass. Follow `TEST_DAY3_2.md` §21's rule: don't just flip
`INJECT_FAULT` back to the same value, change something else too, or CDK may not publish a new
version.

```bash
cd infra
# confirm GEMINI_API_KEY is exported in this shell before any cdk deploy
echo "${GEMINI_API_KEY:?GEMINI_API_KEY not set — export it first, see docs/gemini-migartion.md §5}"
```

In `infra/lib/lambdas.ts`, bump the fault probability slightly so this is a genuinely new
published version (not a no-op deploy):

```diff
- environment: { ...commonEnv, INJECT_FAULT: "true", FAULT_PROBABILITY: "0.3", FAULT_MODE: "error" },
+ environment: { ...commonEnv, INJECT_FAULT: "true", FAULT_PROBABILITY: "0.5", FAULT_MODE: "error" },
```

Higher probability = fewer curl calls needed on camera before you get a 502 to trip the alarm —
worth it for a clean take.

```bash
npx cdk deploy
```

Confirm in the Lambda console (`InventoryFunction` → Aliases → `live`) that it now points at
the freshly-published "bad" version before you start recording. This is the one manual
console check worth doing by hand rather than scripting — a wrong alias target silently ruins
the whole take.

---

## 3. Demo recording script — `scripts/record-demo.sh` (NEW)

This is your run-sheet **and** the thing your screen recorder is pointed at. Per
`ROADMAP (1).md`'s Day-4 goal ("clean terminal recording" is an explicitly acceptable
alternative to a frontend) and §5 of the cut list ("terminal/CLI output... is enough for the
video"), this plan defaults to a scripted terminal recording rather than building a static
page — §4 covers the page as an optional stretch only if time allows.

Create it:

```bash
mkdir -p scripts
```

```bash
#!/usr/bin/env bash
# scripts/record-demo.sh
# Run-sheet for the Day 4 demo recording. Each step prints a banner so the
# recording has clear beat markers to cut to in editing (see plan4.md §5's
# timing table). Fill in API_URL from your `cdk deploy` / API Gateway console
# output before running.
set -euo pipefail

API_URL="${API_URL:?Set API_URL to your API Gateway invoke URL, e.g. https://xxxx.execute-api.ap-south-1.amazonaws.com/prod}"

banner() { echo; echo "=================================================="; echo "  $1"; echo "=================================================="; echo; }

banner "1/6 — HEALTHY REQUEST (fault OFF baseline, if you re-ran §6 of TEST_DAY3_2.md before this)"
curl -s -X POST "${API_URL}/orders" \
  -H "Content-Type: application/json" \
  -d '{"orderId":"demo-healthy-001","sku":"SKU-123","quantity":2}' | jq .

banner "2/6 — INJECTING FAULT (inventory alias already on the 'bad' version per plan4.md §2)"
for i in $(seq 1 6); do
  echo "--- request $i ---"
  curl -s -X POST "${API_URL}/orders" \
    -H "Content-Type: application/json" \
    -d "{\"orderId\":\"demo-fault-$i\",\"sku\":\"SKU-123\",\"quantity\":2}" | jq . || true
  sleep 1
done

banner "3/6 — WAITING FOR CLOUDWATCH ALARM (~60-90s) — cut to CloudWatch console here"
echo "Switch the recording to: CloudWatch console -> Alarms -> InventoryErrorAlarm"
echo "Waiting 90s for evaluation..."
sleep 90

banner "4/6 — CUT TO STEP FUNCTIONS CONSOLE"
echo "Show: IncidentResponseDay3 execution, RUNNING, paused at RequestApproval"
echo "Then: CloudWatch Logs -> RequestApprovalFunction -> INCIDENT_APPROVAL_REQUIRED line"
echo "Copy the approveLink from that log line now."
read -rp "Paste the approveLink here to open it and continue recording: " APPROVE_LINK

banner "5/6 — OPENING APPROVAL LINK"
curl -s "${APPROVE_LINK}"
echo
echo "Switch back to Step Functions console: watch Remediate -> WaitForMetricsToSettle -> VerifyOutcome -> SUCCEEDED"

banner "6/6 — DUMP FINAL INCIDENT RECORD (for the on-screen DynamoDB beat)"
echo "Run: node scripts/dump-incident.js <incidentId>   (see plan4.md §3.1)"
echo "Or show it live in the DynamoDB console -> Incidents table, query by PK."

banner "DONE — cut to InventoryFunction -> Aliases -> live, confirm it rolled back to the pre-fault version"
```

```bash
chmod +x scripts/record-demo.sh
```

Run it once **without** the recorder on to make sure your `API_URL`, `jq`, and timing all
actually work on your machine before the take that matters.

### 3.1 Optional pretty-print helper — `scripts/dump-incident.js` (NEW, pseudocode)

Nice-to-have for a clean on-screen summary instead of raw DynamoDB console JSON. Skip this if
§3's live console walkthrough is enough — it's not required for `ROADMAP (1).md`'s Day 4
checkpoint.

```javascript
// scripts/dump-incident.js
// Usage: node scripts/dump-incident.mjs 19f50e40-e293-4d22-9e68-54cbb546cf94
// Reads the six SK rows for one incident and prints a compact, readable summary —
// the kind of thing you'd screenshot for the blog post too.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = process.env.INCIDENTS_TABLE; // set from `cdk deploy` output / console
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

async function main(incidentId) {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": `INCIDENT#${incidentId}` },
  }));

  const bySk = Object.fromEntries((res.Items ?? []).map((i) => [i.SK, i]));

  console.log(`Incident ${incidentId}`);
  console.log(`  status:       ${bySk.META?.status}`);
  console.log(`  root cause:   ${bySk.DIAGNOSIS?.rootCauseService}`);
  console.log(`  confidence:   ${bySk.DIAGNOSIS?.confidence}`);
  console.log(`  summary:      ${bySk.DIAGNOSIS?.summary}`);
  console.log(`  cited ids:    ${(bySk.DIAGNOSIS?.citedEvidenceIds ?? []).join(", ")}`);
  console.log(`  approved:     ${bySk.APPROVAL?.status} at ${bySk.APPROVAL?.decidedAt}`);
  console.log(`  remediation:  ${bySk.REMEDIATION?.revertedFromVersion} -> ${bySk.REMEDIATION?.revertedToVersion}`);
  console.log(`  recovered:    ${bySk.VERIFICATION?.recovered} (before=${bySk.VERIFICATION?.faultCountBefore}, after=${bySk.VERIFICATION?.faultCountAfter})`);
}

main(process.argv[2]);
```

This needs `@aws-sdk/lib-dynamodb` — if it's not already a `server/` dependency, run it with
`npx` against a one-off script rather than adding a new top-level dependency for a demo-only
tool: `cd server && npx tsx ../scripts/dump-incident.js <incidentId>` (adjust import syntax to
plain `require` if you'd rather not pull in `tsx`).

---

## 4. Optional stretch — static incident-summary page (only if §3 leaves you time)

`ROADMAP (1).md`'s own Day 1 table lists this as `S3-hosted, or even just terminal/CLI output`
— treat it as genuinely optional. If you do it, keep it to a single static HTML file, no
build step, fetching one incident's data via a **new, narrowly-scoped** read-only Function URL
(don't reuse `approveHandlerFn` — that one calls `SendTaskSuccess`, wrong blast radius for a
public read endpoint).

**Pseudocode for the read endpoint** (if you build it — new file
`server/src/features/incidents/getIncidentHandler.ts`, new Function URL in `lambdas.ts`, GET
only, no auth needed for a demo-only unlisted URL, same tradeoff already accepted for
`approveHandlerFn`):

```typescript
// server/src/features/incidents/getIncidentHandler.ts (NEW, only if you build §4)
import { APIGatewayProxyEventV2 } from "aws-lambda";
import { getIncident } from "./incidentsRepository"; // extend repo with a query-all-SKs helper
                                                       // if getIncident() only returns META today

export async function handler(event: APIGatewayProxyEventV2) {
  const incidentId = event.queryStringParameters?.incidentId;
  if (!incidentId) return { statusCode: 400, body: "Missing incidentId" };
  const incident = await getIncident(incidentId); // returns META + all child rows, CORS open
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(incident),
  };
}
```

**Static page** (`docs/demo-page/index.html` — open locally with `?url=<function-url>` or
upload to an S3 static-website bucket if you want it truly hosted):

```html
<!doctype html>
<html>
<head><meta charset="utf-8"><title>Self-Healing Infra — Incident Demo</title></head>
<body style="font-family: system-ui; max-width: 640px; margin: 2rem auto;">
  <h1>Incident Summary</h1>
  <div id="out">Loading…</div>
  <script>
    const params = new URLSearchParams(location.search);
    const base = params.get("url"); // the Function URL from §4's handler
    const incidentId = params.get("incidentId");
    fetch(`${base}?incidentId=${incidentId}`)
      .then((r) => r.json())
      .then((data) => {
        document.getElementById("out").innerHTML = `
          <p><b>Status:</b> ${data.META?.status}</p>
          <p><b>Root cause:</b> ${data.DIAGNOSIS?.rootCauseService}</p>
          <p><b>Diagnosis:</b> ${data.DIAGNOSIS?.summary}</p>
          <p><b>Confidence:</b> ${data.DIAGNOSIS?.confidence}</p>
          <p><b>Approved:</b> ${data.APPROVAL?.status}</p>
          <p><b>Recovered:</b> ${data.VERIFICATION?.recovered}</p>
        `;
      })
      .catch((e) => (document.getElementById("out").textContent = "Error: " + e));
  </script>
</body>
</html>
```

If §3's recording is already solid, skip this entirely — don't let a stretch goal eat time
from §5/§6, which are not optional.

---

## 5. Demo video — script and timing (record after §2 and §3 are rehearsed once)

Per `ROADMAP (1).md` Day 4: script it before recording, don't improvise at the buzzer. Timing
below is the roadmap's own breakdown, with the Gemini beat folded into 0:20–0:50 rather than
bolted on separately — it's part of the architecture explanation, not an apology.

| Time | Beat | Notes |
|---|---|---|
| 0:00–0:20 | The problem, in your own words | Dreamer-outage framing from `ROADMAP (1).md` §1 — "I spend the first 20 minutes just figuring out *which* service actually caused it." |
| 0:20–0:50 | Architecture in one breath, naming AWS services **+ the Gemini pivot** | Name Lambda, API Gateway, DynamoDB, X-Ray, CloudWatch, EventBridge, Step Functions explicitly. One sentence on Bedrock→Gemini using §0's framing — say it plainly, don't rush past it apologetically. |
| 0:50–2:20 | The actual run — screen-recorded, not narrated-only | This is `scripts/record-demo.sh`'s six beats: inject fault → alarm → localization → **Gemini** diagnosis with citations → approval click → remediation → recovery. Cut between terminal and the AWS consoles at each banner. |
| 2:20–2:50 | What you learned + what's next | X-Ray, LLM-invocation-with-structured-outputs (name it generically or as Gemini per your §0 call), Step Functions callback pattern, causal localization heuristic. Next: real PC-algorithm-style localization, broader fault matrix, and — genuinely — getting Bedrock access sorted so both providers are pluggable, since `bedrockClient.ts` is still in the repo for exactly that. |
| 2:50–3:00 | Close | Repo link, one line restating the pitch. |

---

## 6. AWS Builder Center blog post — outline

Reuse the same honest framing from §0. Suggested structure (write your own prose — this is a
skeleton, not a draft to paste verbatim):

1. **The problem** — same Dreamer-outage framing as the video's 0:00–0:20.
2. **The stack** — the four-stage shape (ingest → localize → diagnose → remediate), and the
   full AWS service list actually used: Lambda, API Gateway, DynamoDB, X-Ray, CloudWatch,
   EventBridge, Step Functions.
3. **What fought back** — this is where the Bedrock→Gemini swap belongs, and it's a genuinely
   good "what fought back" story, not a footnote: model access approval turned out to be the
   one dependency the roadmap itself flagged as a risk (`ROADMAP (1).md` §0: "Access approval
   isn't always instant — this is the one dependency that can silently block your Day 3 if you
   leave it late") — and it did. Link `docs/gemini-migartion.md` if the post is technical
   enough for readers who'd want the diff. Mention the `converseText()` seam explicitly — it's
   the actual engineering lesson (isolate your LLM-provider call behind one function signature)
   more than "which provider" is.
4. **The causal-localization heuristic** — the one piece of real "hard part" work
   (`ROADMAP (1).md` §2, row 3); explain the topology-constrained temporal-precedence approach
   in plain terms.
5. **The safety stance** — human-approval-before-action via Step Functions `waitForTaskToken`,
   and the citation-grounding check in `diagnosis/handler.ts` (`DIAGNOSIS_NOT_GROUNDED`) — "an
   ungrounded diagnosis is worse than none" is a good, quotable line already in your own repo's
   comments.
6. **What's next** — same beats as the video's 2:20–2:50, slightly expanded.

---

## 7. Submission checklist — corrected for the Gemini swap

Don't just copy `ROADMAP (1).md`'s original checklist verbatim — it still says "Bedrock." Use
this corrected version:

- [ ] AWS services actually running in the shipped system, named explicitly in the submission
      text: **Lambda, API Gateway, DynamoDB, X-Ray, CloudWatch, EventBridge, Step Functions**
      (seven — satisfies the mandatory "must use an AWS service" constraint on its own)
- [ ] One explicit sentence on the Bedrock→Gemini pivot and why (§0), in both the video and the
      blog post — not buried, not omitted
- [ ] Repo link works and is public
- [ ] `docs/gemini-migartion.md` and `docs/TEST_DAY3_2.md` are pushed — they're your evidence
      trail for the pivot story, same "cite your evidence" spirit as the project itself
- [ ] Demo video is 3 minutes, follows §5's beats, screen-recorded not narrated-only
- [ ] Blog post published to AWS Builder Center (§6)
- [ ] Team registration confirmed (solo noted explicitly, per `ROADMAP (1).md` §0)
- [ ] Submitted with margin before the deadline

---

## 8. Guardrails — do not build on Day 4

- No new features, no touching `LocalizeRootCause`, `Remediate`, `VerifyOutcome`, or the
  Step Functions definition — Day 3's loop is tested and proven; re-opening it now risks
  breaking your one clean demo take
- No second fault type, no fourth service
- Don't re-attempt Bedrock access mid-day to "fix" the pivot — the pivot IS the story now
  (§0); reverting at this point only costs you the one thing (a tested, working loop) you
  cannot re-earn before the deadline
- §4 (static page) is optional and cuts first if you're behind — see §4's own note
